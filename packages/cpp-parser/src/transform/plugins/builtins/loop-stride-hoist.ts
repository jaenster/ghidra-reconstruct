/**
 * Recover an invariant byte stride before a zero-initialized do loop. Ghidra
 * prints `offset += step * 4` inside several client/server missile loops; the
 * original computes that stride before initializing the offset. Keeping it in
 * the loop changes VC8's instruction order even when it moves the multiply out.
 *
 * Only uniquely declared, nonvolatile 32-bit scalars qualify. The step has a
 * defined value at the insertion point, never escapes, and its only occurrence
 * in the loop is the final increment. A separate unsigned temporary preserves
 * the target's 32-bit arithmetic without speculatively overflowing a signed
 * product before a call or an early exit. The step itself is never modified.
 * Other uses must consume its value through proven primitive operations;
 * unknown conversions/operators may retain an implicit reference. Existing
 * snapshot type tables prove member reads when they participate in those uses.
 */
import { NodeKind, isExpression } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CommaExpr, CompoundStmt, ConditionalExpr, CStyleCastExpr, DeclStmt, DoWhileStmt,
  ExprStmt, Expression, FunctionDecl, Identifier, IntegerLiteralExpr,
  MemberExpr, ParameterDecl, PostfixExpr, Statement, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { Decl, Expr, Stmt, Type } from '../../../ast/factory.js';
import { findNodesByKind, getChildren, traverseAST } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, updateNode, cloneNode } from '../../transformer.js';
import { buildFunctionFlow, ENTRY_DEF, type FunctionFlow } from '../../cfg/index.js';
import type { PluginOptions, TransformPlugin } from '../types.js';
import { createExprShape } from './expr-shape.js';
import { shapeOfNode, type TypeShape } from './call-arg-cast.js';

export interface LoopStrideHoistOptions extends PluginOptions {
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  fieldTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
}

const WORDS = new Set(['int', 'signed int', 'unsigned int', 'signed', 'unsigned', 'int32_t', 'uint32_t']);
const SCALARS = new Set([...WORDS, 'bool', 'char', 'signed char', 'unsigned char',
  'short', 'short int', 'signed short', 'signed short int', 'unsigned short', 'unsigned short int',
  'long', 'long int', 'signed long', 'signed long int', 'unsigned long', 'unsigned long int',
  'long long', 'long long int', 'unsigned long long', 'unsigned long long int',
  '__int64', 'unsigned __int64', 'float', 'double', 'long double', 'wchar_t',
  'int8_t', 'uint8_t', 'int16_t', 'uint16_t', 'int64_t', 'uint64_t']);
const unwrap = (e: Expression): Expression => {
  let x = e;
  while (x.kind === NodeKind.ParenExpr) x = (x as { expression: Expression }).expression;
  return x;
};
const nameOf = (e: Expression): string | null => {
  const x = unwrap(e);
  return x.kind === NodeKind.Identifier ? (x as Identifier).name : null;
};
function mentions(root: ASTNode, name: string): number {
  // A field or qualified name with the same spelling is not the local.
  if (root.kind === NodeKind.MemberExpr) return mentions((root as MemberExpr).object, name);
  if (root.kind === NodeKind.QualifiedId) return 0;
  if (root.kind === NodeKind.Identifier) return (root as Identifier).name === name ? 1 : 0;
  return getChildren(root).reduce((count, child) => count + mentions(child, name), 0);
}
function zeroTarget(s: Statement): string | null {
  let name: string | null = null, value: Expression | null = null;
  if (s.kind === NodeKind.ExprStmt) {
    const a = unwrap((s as ExprStmt).expression);
    if (a.kind !== NodeKind.AssignExpr || (a as AssignExpr).operator !== '=') return null;
    name = nameOf((a as AssignExpr).left); value = (a as AssignExpr).right;
  } else if (s.kind === NodeKind.DeclStmt) {
    const ds = (s as DeclStmt).declarations;
    if (ds.length !== 1 || ds[0].kind !== NodeKind.VariableDecl) return null;
    const v = ds[0] as VariableDecl;
    if (v.specifiers.length || !v.initializer || v.initializer.kind === NodeKind.InitListExpr) return null;
    name = v.name.name; value = v.initializer;
  }
  if (!value) return null;
  const x = unwrap(value);
  return x.kind === NodeKind.IntegerLiteral && (x as IntegerLiteralExpr).value === 0n ? name : null;
}

/** Rebuild only the path to a replacement, keeping the CFG's statement identities. */
function replaceNode(root: ASTNode, target: ASTNode, replacement: ASTNode): ASTNode {
  if (root === target) return replacement;
  for (const [key, value] of Object.entries(root)) {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const child = value[i];
        if (!child || typeof child !== 'object' || !('kind' in child)) continue;
        const changed = replaceNode(child as ASTNode, target, replacement);
        if (changed !== child) {
          const items = value.slice(); items[i] = changed;
          return { ...root, [key]: items } as ASTNode;
        }
      }
    } else if (value && typeof value === 'object' && 'kind' in value) {
      const changed = replaceNode(value as ASTNode, target, replacement);
      if (changed !== value) return { ...root, [key]: changed } as ASTNode;
    }
  }
  return root;
}

function rewrite(fn: FunctionDecl, options: LoopStrideHoistOptions): CompoundStmt | null {
  if (!fn.body || !findNodesByKind(fn.body, NodeKind.DoWhileStmt).length) return null;
  const nodes = [...traverseAST(fn.body)];
  if (nodes.some(n => [NodeKind.GotoStmt, NodeKind.LabelStmt, NodeKind.LambdaExpr, NodeKind.AsmDecl, NodeKind.NewExpr].includes(n.kind))) return null;
  const types = new Map<string, TypeNode>(), parameters = new Set<string>(), duplicates = new Set<string>();
  const add = (name: string, type: TypeNode) => {
    if (types.has(name)) duplicates.add(name);
    types.set(name, type);
  };
  for (const p of fn.parameters) {
    const param = p as ParameterDecl;
    if (param.name) { add(param.name.name, param.type); parameters.add(param.name.name); }
  }
  for (const n of nodes) if (n.kind === NodeKind.VariableDecl) {
    const v = n as VariableDecl;
    add(v.name.name, v.type);
    if (v.specifiers.length) duplicates.add(v.name.name);
  }
  const word = (name: string) => {
    const t = types.get(name);
    return !!t && !duplicates.has(name) && WORDS.has(emit(t as never).trim().replace(/^const\s+/, ''));
  };
  const resolve = (name: string) => options.typedefTargets?.[name];
  const primitive = (s: TypeShape | null) => !!s && (s.stars > 0 || SCALARS.has(s.base));
  const primitiveType = (type: TypeNode) => primitive(shapeOfNode(type, 0, resolve));
  const shape = createExprShape(types, { ...options, resolve });
  const primitiveName = (name: string | null) => name !== null && !duplicates.has(name)
    && types.has(name) && primitiveType(types.get(name)!);
  // Primitive syntax alone is not an escape proof: constructors, casts and
  // overloaded operators can bind an int& without an explicit & or CallExpr.
  // Only operations over proven scalar values may consume the step by value.
  const valueOnly = (expression: Expression, step: string): boolean => {
    const e = unwrap(expression);
    if (e.kind === NodeKind.Identifier) return primitiveName((e as Identifier).name);
    if (e.kind === NodeKind.MemberExpr || e.kind === NodeKind.QualifiedId) return primitive(shape(e));
    if ([NodeKind.IntegerLiteral, NodeKind.FloatingLiteral, NodeKind.CharLiteral, NodeKind.BoolLiteral, NodeKind.NullptrLiteral].includes(e.kind)) return true;
    if (e.kind === NodeKind.UnaryExpr || e.kind === NodeKind.PostfixExpr) {
      const u = e as UnaryExpr | PostfixExpr;
      return !['&', '*'].includes(u.operator) && valueOnly(u.operand, step);
    }
    if (e.kind === NodeKind.BinaryExpr) {
      const b = e as BinaryExpr;
      return valueOnly(b.left, step) && valueOnly(b.right, step);
    }
    if (e.kind === NodeKind.ConditionalExpr) {
      const c = e as ConditionalExpr;
      return valueOnly(c.condition, step) && valueOnly(c.thenExpr, step) && valueOnly(c.elseExpr, step);
    }
    if (e.kind === NodeKind.CommaExpr) return (e as CommaExpr).expressions.every(x => valueOnly(x, step));
    if (e.kind === NodeKind.CStyleCastExpr || e.kind === NodeKind.StaticCastExpr) {
      const c = e as CStyleCastExpr;
      return (primitiveType(c.type) || emit(c.type as never).trim() === 'void') && valueOnly(c.expression, step);
    }
    if (e.kind === NodeKind.AssignExpr) {
      const a = e as AssignExpr;
      // A plain store into a primitive cannot overload assignment. A value
      // produced without reading step cannot acquire a reference to it here.
      return primitive(shape(a.left)) && ((a.operator === '=' && !mentions(a.right, step)) || valueOnly(a.right, step));
    }
    return false;
  };
  const escapes = (name: string) => nodes.some(n => {
    if (n.kind === NodeKind.VariableDecl) {
      const v = n as VariableDecl;
      if (v.initializer && mentions(v.initializer, name) && !primitiveType(v.type)) return true;
    }
    return isExpression(n.kind) && mentions(n, name) > 0 && !valueOnly(n as Expression, name);
  });
  const used = new Set([
    ...types.keys(),
    ...nodes.filter(n => n.kind === NodeKind.Identifier).map(n => (n as Identifier).name),
  ]);
  let flow: FunctionFlow | undefined;
  for (const node of nodes) {
    if (node.kind === NodeKind.CompoundStmt) {
      const block = node as CompoundStmt;
      const out: Statement[] = [];
      for (let i = 0; i < block.statements.length; i++) {
        const init = block.statements[i], next = block.statements[i + 1];
        const counter = zeroTarget(init);
        const loop = next?.kind === NodeKind.DoWhileStmt ? next as DoWhileStmt : null;
        if (!counter || !word(counter) || !loop || loop.body.kind !== NodeKind.CompoundStmt) { out.push(init); continue; }
        const test = unwrap(loop.condition);
        const body = loop.body as CompoundStmt, last = body.statements.at(-1);
        if (test.kind !== NodeKind.BinaryExpr || (test as BinaryExpr).operator !== '<'
          || nameOf((test as BinaryExpr).left) !== counter || unwrap((test as BinaryExpr).right).kind !== NodeKind.IntegerLiteral
          || !last || last.kind !== NodeKind.ExprStmt) { out.push(init); continue; }
        const inc = unwrap((last as ExprStmt).expression);
        if (inc.kind !== NodeKind.AssignExpr || (inc as AssignExpr).operator !== '+=' || nameOf((inc as AssignExpr).left) !== counter) { out.push(init); continue; }
        const product = unwrap((inc as AssignExpr).right);
        if (product.kind !== NodeKind.BinaryExpr || (product as BinaryExpr).operator !== '*') { out.push(init); continue; }
        const mul = product as BinaryExpr, step = nameOf(mul.left), scale = unwrap(mul.right);
        if (!step || step === counter || !word(step) || escapes(step) || scale.kind !== NodeKind.IntegerLiteral) { out.push(init); continue; }
        const literal = scale as IntegerLiteralExpr;
        if (literal.value < 2n || literal.value > 0x7fffffffn || (literal.suffix && !/^u$/i.test(literal.suffix))
          || mentions(loop, step) !== 1 || findNodesByKind(loop.body, NodeKind.CaseStmt).length || findNodesByKind(loop.body, NodeKind.DefaultStmt).length) { out.push(init); continue; }
        flow ??= buildFunctionFlow(fn.body!.statements, new Set(types.keys()));
        const point = flow.nodeOf(init);
        if (point === undefined || flow.isEscaped(step)) { out.push(init); continue; }
        const reaching = [...flow.reaching(point, step)];
        if (!reaching.length || reaching.some(d => d === ENTRY_DEF ? !parameters.has(step) : !flow!.definition(d, step)?.rhs)) { out.push(init); continue; }
        let fresh = 'nByteStride', ordinal = 2;
        while (used.has(fresh)) fresh = `nByteStride${ordinal++}`;
        used.add(fresh);
        const rhs = Expr.binary(Expr.cast(Type.typedef('uint32_t'), Expr.identifier(step)), '*', cloneNode(literal));
        const declaration = Stmt.declStmt([Decl.variable(fresh, Type.const(Type.typedef('uint32_t')), rhs)]);
        const increment = updateNode(last as ExprStmt, { expression: updateNode(inc as AssignExpr, { right: Expr.identifier(fresh) }) });
        const newBody = updateNode(body, { statements: [...body.statements.slice(0, -1), increment] });
        out.push(declaration, init, updateNode(loop, { body: newBody }));
        const replacement = updateNode(block, { statements: [...out, ...block.statements.slice(i + 2)] });
        return replaceNode(fn.body, block, replacement) as CompoundStmt;
      }
    }
  }
  return null;
}

export const loopStrideHoistPlugin: TransformPlugin = {
  id: 'loop-stride-hoist',
  name: 'Loop Stride Hoist',
  description: 'Compute an invariant 32-bit byte stride before a zero-initialized do loop',
  version: '0.1.1',
  defaultEnabled: true,
  priority: 69.7,
  tags: ['fidelity', 'loops'],
  createTransformer: (options: LoopStrideHoistOptions = {}) => createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      let current = fn;
      const limit = fn.body ? findNodesByKind(fn.body, NodeKind.DoWhileStmt).length : 0;
      // One site per graph: rebuild the proof after each inserted declaration.
      for (let i = 0; i < limit; i++) {
        const body = rewrite(current, options);
        if (!body) break;
        current = updateNode(current, { body });
      }
      return current !== fn ? current : undefined;
    },
  }),
};
