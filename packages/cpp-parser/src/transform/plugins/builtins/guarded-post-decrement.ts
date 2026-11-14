/**
 * A guarded counter walk whose original tests the old count after decrementing.
 *
 * while (first && rest && count) { body; count--; }
 *
 * becomes an outer first guard and a do-loop with `rest && remaining--` at its
 * head. The separate unsigned count preserves all32bits and cannot speculatively
 * overflow on an early return, break, or the zero-count exit. It is initialized
 * inside the first guard, matching the original's deferred parameter load.
 *
 * This is opt-in through vc8form: source spelling is selected only after a
 * native measurement. It is not a default loop canonicalization.
 */
import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CallExpr, CompoundStmt, Expression, ExprStmt,
  FunctionDecl, Identifier, IntegerLiteralExpr, ParameterDecl, PostfixExpr,
  Statement, TypeNode, UnaryExpr, VariableDecl, WhileStmt,
} from '../../../ast/nodes.js';
import { Decl, Expr, Stmt, Type } from '../../../ast/factory.js';
import { findNodesByKind, traverseAST } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { isKeywordString } from '../../../lexer/keywords.js';
import { cloneNode, updateNode } from '../../transformer.js';
import { buildFunctionFlow, ENTRY_DEF } from '../../cfg/index.js';

const WORDS = new Set(['int', 'signed', 'signed int', 'unsigned', 'unsigned int', 'int32_t', 'uint32_t']);
const SCALARS = new Set([...WORDS, 'bool', 'char', 'signed char', 'unsigned char', 'short', 'short int', 'signed short',
  'signed short int', 'unsigned short', 'unsigned short int', 'int8_t', 'uint8_t', 'int16_t', 'uint16_t', 'uchar', 'ushort']);
const unparen = (e: Expression): Expression => {
  while (e.kind === NodeKind.ParenExpr) e = (e as { expression: Expression }).expression;
  return e;
};
const id = (e: Expression): string | null => {
  const n = unparen(e); return n.kind === NodeKind.Identifier ? (n as Identifier).name : null;
};
const literal = (e: Expression, value: bigint): boolean => {
  const n = unparen(e); return n.kind === NodeKind.IntegerLiteral && (n as IntegerLiteralExpr).value === value && !(n as IntegerLiteralExpr).suffix;
};
function truth(e: Expression): string | null {
  const n = unparen(e);
  if (n.kind === NodeKind.Identifier) return (n as Identifier).name;
  if (n.kind !== NodeKind.BinaryExpr || (n as BinaryExpr).operator !== '!=') return null;
  const b = n as BinaryExpr;
  return literal(b.right, 0n) ? id(b.left) : literal(b.left, 0n) ? id(b.right) : null;
}
function conjunctions(e: Expression): Expression[] {
  const n = unparen(e);
  return n.kind === NodeKind.BinaryExpr && (n as BinaryExpr).operator === '&&'
    ? [...conjunctions((n as BinaryExpr).left), ...conjunctions((n as BinaryExpr).right)] : [n];
}
function mentions(root: ASTNode, name: string): number {
  let n = 0;
  for (const x of traverseAST(root)) if (x.kind === NodeKind.Identifier && (x as Identifier).name === name) n++;
  return n;
}
function minusOne(e: Expression): boolean {
  const n = unparen(e);
  return literal(n, -1n) || (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '-' && literal((n as UnaryExpr).operand, 1n));
}
function decrement(s: Statement, name: string): boolean {
  if (s.kind !== NodeKind.ExprStmt) return false;
  const n = unparen((s as ExprStmt).expression);
  if ((n.kind === NodeKind.PostfixExpr || n.kind === NodeKind.UnaryExpr)
    && (n as PostfixExpr | UnaryExpr).operator === '--' && id((n as PostfixExpr | UnaryExpr).operand) === name) return true;
  if (n.kind !== NodeKind.AssignExpr || id((n as AssignExpr).left) !== name) return false;
  const a = n as AssignExpr;
  if (a.operator === '-=') return literal(a.right, 1n);
  if (a.operator === '+=') return minusOne(a.right);
  const r = unparen(a.right);
  return a.operator === '=' && r.kind === NodeKind.BinaryExpr && id((r as BinaryExpr).left) === name
    && (((r as BinaryExpr).operator === '-' && literal((r as BinaryExpr).right, 1n))
      || ((r as BinaryExpr).operator === '+' && minusOne((r as BinaryExpr).right)));
}

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

export function guardedPostDecrement(fn: FunctionDecl, counter: string, temporary: string): { body: CompoundStmt } | { why: string } {
  if (![counter, temporary].every(n => /^[A-Za-z_]\w*$/.test(n) && !isKeywordString(n))) return { why: 'invalid counter or temporary identifier' };
  if (!fn.body) return { why: 'no function body' };
  const nodes = [...traverseAST(fn.body)];
  if (nodes.some(n => [NodeKind.GotoStmt, NodeKind.LabelStmt, NodeKind.CaseStmt, NodeKind.DefaultStmt,
    NodeKind.LambdaExpr, NodeKind.AsmDecl, NodeKind.NewExpr].includes(n.kind))) return { why: 'control entry, lambda, assembly or allocation' };
  const types = new Map<string, TypeNode>(), parameters = new Set<string>(), duplicates = new Set<string>();
  const add = (name: string, type: TypeNode) => { if (types.has(name)) duplicates.add(name); types.set(name, type); };
  for (const p of fn.parameters as ParameterDecl[]) if (p.name) { add(p.name.name, p.type); parameters.add(p.name.name); }
  const declarations = findNodesByKind(fn.body, NodeKind.VariableDecl) as VariableDecl[];
  for (const d of declarations) { add(d.name.name, d.type); if (d.specifiers.length) duplicates.add(d.name.name); }
  const used = new Set([...types.keys(), ...nodes.filter(n => n.kind === NodeKind.Identifier).map(n => (n as Identifier).name)]);
  if (temporary === counter || used.has(temporary)) return { why: 'temporary is not fresh' };
  const spelled = (name: string) => types.has(name) && !duplicates.has(name) ? emit(types.get(name) as never).trim() : '';
  if (!WORDS.has(spelled(counter))) return { why: 'counter is not one plain nonvolatile32bit scalar' };
  const loops = (findNodesByKind(fn.body, NodeKind.WhileStmt) as WhileStmt[]).filter(w => {
    if (w.body.kind !== NodeKind.CompoundStmt) return false;
    const ps = conjunctions(w.condition), st = (w.body as CompoundStmt).statements;
    return ps.length >= 3 && truth(ps.at(-1)!) === counter && !!st.length && decrement(st.at(-1)!, counter);
  });
  if (loops.length !== 1) return { why: `${loops.length} matching loops` };
  const loop = loops[0], parts = conjunctions(loop.condition), first = truth(parts[0]);
  if (!first || first === counter || !SCALARS.has(spelled(first).replace(/^const\s+/, ''))) return { why: 'first guard is not one nonvolatile scalar' };
  const body = loop.body as CompoundStmt, tail = body.statements.at(-1)!;
  if (findNodesByKind(body, NodeKind.ContinueStmt).length) return { why: 'continue may skip the original decrement' };
  if (mentions(loop, counter) !== mentions(tail, counter) + 1) return { why: 'counter has another read or write in the loop' };
  const declared = declarations.filter(d => d.name.name === counter).length;
  if (mentions(fn.body, counter) !== mentions(loop, counter) + declared) return { why: 'counter is read or written outside the loop' };
  if (nodes.some(n => {
    if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&' && id((n as UnaryExpr).operand) === counter) return true;
    if (n.kind === NodeKind.CallExpr && (n as CallExpr).arguments.some(a => mentions(a, counter))) return true;
    if (n.kind === NodeKind.VariableDecl && (n as VariableDecl).initializer && mentions((n as VariableDecl).initializer!, counter)) return true;
    return false;
  })) return { why: 'counter may escape through an address, reference or initializer' };
  const flow = buildFunctionFlow(fn.body.statements, new Set(types.keys()));
  const point = flow.nodeOf(loop), tailPoint = flow.nodeOf(tail);
  if (point === undefined || tailPoint === undefined || flow.isEscaped(counter)) return { why: 'no unaliased entry proof' };
  // The tail's own definition is an inductive back edge, not an initial value.
  // Every entry value before the first iteration must already be initialized.
  const reaching = [...flow.reaching(point, counter)].filter(d => d !== tailPoint);
  if (!reaching.length || reaching.some(d => d === ENTRY_DEF ? !parameters.has(counter) : !flow.definition(d, counter)?.rhs)) return { why: 'counter is not initialized at loop entry' };
  const rest = parts.slice(1, -1).map(p => cloneNode(p)).reduce((a, b) => Expr.binary(a, '&&', b));
  const post = Expr.postfix(Expr.identifier(temporary), '--');
  const stop = Expr.binary(Expr.unary('!', Expr.paren(rest)), '||', Expr.unary('!', post));
  const inner = Stmt.doWhile(Stmt.compound([Stmt.if_(stop, Stmt.break_()), ...body.statements.slice(0, -1).map(s => cloneNode(s))]), cloneNode(parts[0]));
  const declaration = Stmt.declStmt([Decl.variable(temporary, Type.int(['unsigned']), Expr.cast(Type.int(['unsigned']), Expr.identifier(counter)))]);
  const replacement = Stmt.if_(cloneNode(parts[0]), Stmt.compound([declaration, inner]));
  return { body: replaceNode(fn.body, loop, replacement) as CompoundStmt };
}
