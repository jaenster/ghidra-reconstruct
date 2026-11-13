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
 */
import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CallExpr, CompoundStmt, DeclStmt, DoWhileStmt,
  ExprStmt, Expression, FunctionDecl, Identifier, IntegerLiteralExpr,
  ParameterDecl, Statement, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { Decl, Expr, Stmt, Type } from '../../../ast/factory.js';
import { findNodesByKind, traverseAST } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, updateNode, cloneNode } from '../../transformer.js';
import { buildFunctionFlow, ENTRY_DEF, type FunctionFlow } from '../../cfg/index.js';
import type { TransformPlugin } from '../types.js';

const WORDS = new Set(['int', 'signed int', 'unsigned int', 'signed', 'unsigned', 'int32_t', 'uint32_t']);
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
  let count = 0;
  for (const n of traverseAST(root)) if (n.kind === NodeKind.Identifier && (n as Identifier).name === name) count++;
  return count;
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

function rewrite(fn: FunctionDecl): CompoundStmt | null {
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
  const escapes = (name: string) => nodes.some(n => {
    if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&' && nameOf((n as UnaryExpr).operand) === name) return true;
    // A C++ callee could bind a reference even without an explicit &.
    if (n.kind === NodeKind.CallExpr && (n as CallExpr).arguments.some(a => mentions(a, name))) return true;
    if (n.kind === NodeKind.InitListExpr && mentions(n, name)) return true;
    if (n.kind === NodeKind.VariableDecl) {
      const v = n as VariableDecl;
      if (v.initializer && /&/.test(emit(v.type as never)) && mentions(v.initializer, name)) return true;
    }
    return false;
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
  version: '0.1.0',
  defaultEnabled: true,
  priority: 69.7,
  tags: ['fidelity', 'loops'],
  createTransformer: () => createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      let current = fn;
      const limit = fn.body ? findNodesByKind(fn.body, NodeKind.DoWhileStmt).length : 0;
      // One site per graph: rebuild the proof after each inserted declaration.
      for (let i = 0; i < limit; i++) {
        const body = rewrite(current);
        if (!body) break;
        current = updateNode(current, { body });
      }
      return current !== fn ? current : undefined;
    },
  }),
};
