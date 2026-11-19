/**
 * Countdown Index For Plugin
 *
 * A counted loop whose index the body never reads compiles under VC8 to a register counted
 * down to zero, and the decompiler prints that counter (OBJOP_A2Q2_OpenHoradricScrollChest,
 * 00599c10):
 *
 *     nDropCount = sNewSeed % 5 + 5;
 *     if (nDropCount <= 0) {
 *       return 0;
 *     }
 *     do {
 *       SpawnDrop(..);
 *       nDropCount--;
 *     } while (nDropCount);
 *
 * Compiled as printed, VC8 keeps the count in its own variable and tests it each round; the
 * original counts an index up to it and lets the optimizer reverse it:
 *
 *     for (int i = 0; i < nDropCount; i++) {
 *       SpawnDrop(..);
 *     }
 *
 * A constant count prints as `n = K; do { ..; n--; } while (n);` and becomes
 * `for (n = 0; n < K; n++)` (SFILE_DeleteOldLogFiles 00407570).
 *
 * Rewritten on a proof, for `do { S1..Sk-1; n--; } while (n)` (the test also `n != 0`,
 * `n > 0` or `0 < n`; the step also `--n`, `n -= 1`, `n = n - 1`):
 *  - n is a local or parameter of a 32-bit integer type, declared once, its address never
 *    taken; S1..Sk-1 do not name n, so the body neither reads nor writes it;
 *  - the body holds no `continue` of this loop (it would skip the step), no label and no
 *    case label of an enclosing switch;
 *  - no read of n sees a value the step makes, other than the step itself and the test:
 *    n is dead when the loop ends;
 *  - n >= 1 (unsigned: n != 0) on entry, shown by the statement right before the loop:
 *    `n = K;` / `T n = K;` with K a positive literal, or `if (n <= 0) X` (`n < 1`; unsigned
 *    `n == 0`, `!n`) with X ending in return, goto, break or continue and no else.
 * When the loop ends a void function (only bare `return;` after it) and X is a bare `return;`, the guard is the for loop's
 * own entry test (VC8 jumps to the shared epilogue) and goes with it: for n <= 0 the for
 * loop runs no round and the function returns, as the guard did (AI_UberTristram_Check-
 * DeathAndDropLoot 005e0070 matches only that way). A guard that
 * returns a value, or a loop with code after it, keeps the guard (OBJOP_A2Q2_OpenHoradric-
 * ScrollChest 00599c10 matches only with it). A loop opening the then-branch of `if (n > 0)`
 * is left alone: the for form does not compile to it (Skills_CltDoFunc_EMon_WallMissileRow
 * 004f11d0).
 * With n = c >= 1 on entry the do-while runs its body c times and leaves n dead; the for
 * loop runs it c times as well, on an index nothing else reads. A constant count reuses n as
 * the index: its initial value K becomes the bound, and the `n = K;` statement goes.
 *
 * A counter that a measured vc8form (ptrwalk, postdec, dec) names keeps its countdown: that
 * form was compiled against the original and rewrites this very loop.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AnyNode, AssignExpr, BinaryExpr, CompoundStmt, DeclStmt, DoWhileStmt, ExprStmt, Expression,
  FunctionDecl, Identifier, IfStmt, IntegerLiteralExpr, MemberExpr, ParameterDecl, Statement, TypeNode,
  UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { Decl, Expr, Stmt } from '../../../ast/factory.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, updateNode, cloneNode, replaceNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { buildFunctionFlow } from '../../cfg/index.js';

const SIGNED = new Set(['int', 'signed int', 'int32_t', 'long', 'signed long', 'LONG', 'INT', 'long int']);
const UNSIGNED = new Set(['unsigned int', 'uint', 'uint32_t', 'unsigned', 'DWORD', 'UINT', 'ULONG', 'unsigned long', 'size_t', 'unsigned long int']);
const MAX_SIGNED = 0x7fffffffn;
const MAX_UNSIGNED = 0xffffffffn;

function unwrap(e: Expression): Expression {
  let x = e;
  while (x.kind === NodeKind.ParenExpr) x = (x as unknown as { expression: Expression }).expression;
  return x;
}
const isId = (e: Expression | null | undefined, v: string): boolean => !!e && unwrap(e).kind === NodeKind.Identifier && (unwrap(e) as Identifier).name === v;
function lit(e: Expression | null | undefined): bigint | undefined {
  if (!e) return undefined;
  const x = unwrap(e);
  if (x.kind !== NodeKind.IntegerLiteral) return undefined;
  return BigInt((x as unknown as { value: string | number | bigint }).value);
}

/** Every identifier named v that is a variable reference (not a member name or label), declarations included. */
function mentions(root: ASTNode | null | undefined, v: string): number {
  if (!root) return 0;
  let n = 0;
  const walk = (x: ASTNode): void => {
    if (x.kind === NodeKind.Identifier) { if ((x as Identifier).name === v) n++; return; }
    if (x.kind === NodeKind.MemberExpr) { walk((x as MemberExpr).object as ASTNode); return; }
    if (x.kind === NodeKind.LabelStmt) { walk((x as unknown as { statement: ASTNode }).statement); return; }
    if (x.kind === NodeKind.GotoStmt) return;
    for (const [k, val] of Object.entries(x)) {
      if (k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'location') continue;
      if (Array.isArray(val)) { for (const y of val) if (y && typeof y === 'object' && 'kind' in y) walk(y as ASTNode); }
      else if (val && typeof val === 'object' && 'kind' in val) walk(val as ASTNode);
    }
  };
  walk(root);
  return n;
}

interface Var { type: TypeNode; signed: boolean }

/** Locals and parameters declared once, of a 32-bit integer type, by name. */
function counters(fn: FunctionDecl): { vars: Map<string, Var>; locals: Set<string> } {
  const seen = new Map<string, number>();
  const types = new Map<string, TypeNode>();
  const locals = new Set<string>();
  const bad = new Set<string>();
  for (const p of fn.parameters as ParameterDecl[]) if (p.name) { locals.add(p.name.name); seen.set(p.name.name, (seen.get(p.name.name) ?? 0) + 1); types.set(p.name.name, p.type); }
  for (const x of traverseAST(fn.body!)) {
    if (x.kind !== NodeKind.VariableDecl) continue;
    const d = x as VariableDecl;
    locals.add(d.name.name);
    seen.set(d.name.name, (seen.get(d.name.name) ?? 0) + 1);
    types.set(d.name.name, d.type);
    if (d.specifiers.length > 0 || d.bitWidth) bad.add(d.name.name);
  }
  const vars = new Map<string, Var>();
  for (const [name, t] of types) {
    if (seen.get(name) !== 1 || bad.has(name)) continue;
    const s = emit(t as unknown as AnyNode).replace(/\s+/g, ' ').trim();
    if (SIGNED.has(s)) vars.set(name, { type: t, signed: true });
    else if (UNSIGNED.has(s)) vars.set(name, { type: t, signed: false });
  }
  return { vars, locals };
}

/** `n--`, `--n`, `n -= 1`, `n = n - 1`, `n = n + -1` as a statement: the counter, else null. */
function stepOf(s: Statement): string | null {
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = unwrap((s as ExprStmt).expression);
  if ((e.kind === NodeKind.PostfixExpr || e.kind === NodeKind.UnaryExpr) && (e as UnaryExpr).operator === '--') {
    const o = unwrap((e as UnaryExpr).operand);
    return o.kind === NodeKind.Identifier ? (o as Identifier).name : null;
  }
  if (e.kind !== NodeKind.AssignExpr) return null;
  const a = e as AssignExpr;
  const l = unwrap(a.left);
  if (l.kind !== NodeKind.Identifier) return null;
  const v = (l as Identifier).name;
  if (a.operator === '-=' && lit(a.right) === 1n) return v;
  if (a.operator !== '=') return null;
  const r = unwrap(a.right);
  if (r.kind !== NodeKind.BinaryExpr) return null;
  const b = r as BinaryExpr;
  if (b.operator === '-' && isId(b.left, v) && lit(b.right) === 1n) return v;
  if (b.operator === '+' && isId(b.left, v)) {
    const k = unwrap(b.right);
    if (k.kind === NodeKind.UnaryExpr && (k as UnaryExpr).operator === '-' && lit((k as UnaryExpr).operand) === 1n) return v;
  }
  return null;
}

/** The do-while test is "n != 0" for a counter that only steps down by one from n >= 1. */
function testOf(e: Expression, v: string): boolean {
  const x = unwrap(e);
  if (isId(x, v)) return true;
  if (x.kind !== NodeKind.BinaryExpr) return false;
  const b = x as BinaryExpr;
  if (b.operator === '!=') return (isId(b.left, v) && lit(b.right) === 0n) || (lit(b.left) === 0n && isId(b.right, v));
  if (b.operator === '>') return isId(b.left, v) && lit(b.right) === 0n;
  if (b.operator === '<') return lit(b.left) === 0n && isId(b.right, v);
  return false;
}

/** `e` certainly leaves the statement: ends in return, goto, break or continue. */
function exits(s: Statement): boolean {
  if (s.kind === NodeKind.ReturnStmt || s.kind === NodeKind.GotoStmt || s.kind === NodeKind.BreakStmt || s.kind === NodeKind.ContinueStmt) return true;
  if (s.kind === NodeKind.CompoundStmt) {
    const st = (s as CompoundStmt).statements;
    return st.length > 0 && exits(st[st.length - 1]);
  }
  return false;
}

/** `n <= 0` / `n < 1` / `0 >= n` / `1 > n` (signed) or `n == 0` / `!n` / `0 == n` (unsigned). */
function notPositive(e: Expression, v: string, signed: boolean): boolean {
  const x = unwrap(e);
  if (!signed) {
    if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '!' && isId((x as UnaryExpr).operand, v)) return true;
    if (x.kind === NodeKind.BinaryExpr && (x as BinaryExpr).operator === '==') {
      const b = x as BinaryExpr;
      return (isId(b.left, v) && lit(b.right) === 0n) || (lit(b.left) === 0n && isId(b.right, v));
    }
    return false;
  }
  if (x.kind !== NodeKind.BinaryExpr) return false;
  const b = x as BinaryExpr;
  if (b.operator === '<=') return isId(b.left, v) && lit(b.right) === 0n;
  if (b.operator === '<') return isId(b.left, v) && lit(b.right) === 1n;
  if (b.operator === '>=') return lit(b.left) === 0n && isId(b.right, v);
  if (b.operator === '>') return lit(b.left) === 1n && isId(b.right, v);
  return false;
}

/** The body holds a `continue` of the loop itself, a label, or a case label of an enclosing switch. */
function unsafeBody(body: Statement): boolean {
  let bad = false;
  const walk = (x: ASTNode, inLoop: boolean, inSwitch: boolean): void => {
    if (bad) return;
    switch (x.kind) {
      case NodeKind.ContinueStmt: if (!inLoop) bad = true; return;
      case NodeKind.LabelStmt: bad = true; return;
      case NodeKind.CaseStmt: case NodeKind.DefaultStmt: if (!inSwitch) { bad = true; return; } break;
      default: break;
    }
    const loop = inLoop || x.kind === NodeKind.WhileStmt || x.kind === NodeKind.DoWhileStmt || x.kind === NodeKind.ForStmt || x.kind === NodeKind.ForRangeStmt;
    const sw = inSwitch || x.kind === NodeKind.SwitchStmt;
    for (const [k, val] of Object.entries(x)) {
      if (k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'location') continue;
      if (Array.isArray(val)) { for (const y of val) if (y && typeof y === 'object' && 'kind' in y) walk(y as ASTNode, loop, sw); }
      else if (val && typeof val === 'object' && 'kind' in val) walk(val as ASTNode, loop, sw);
    }
  };
  walk(body, false, false);
  return bad;
}

/** Control the statement graph does not model. */
function unmodelled(fn: FunctionDecl): boolean {
  for (const x of traverseAST(fn.body!)) {
    if (x.kind === NodeKind.TryStmt || x.kind === NodeKind.SehTryStmt || x.kind === NodeKind.AsmDecl) return true;
    if (x.kind === NodeKind.Identifier) {
      const n = (x as Identifier).name;
      if (n === 'ExceptionList' || /^_?setjmp|^__asm|^_asm$/.test(n)) return true;
    }
  }
  return false;
}

/** A name no identifier of the function spells. */
function freshIndex(fn: FunctionDecl): string {
  const used = new Set<string>();
  for (const x of traverseAST(fn)) if (x.kind === NodeKind.Identifier) used.add((x as Identifier).name);
  for (const c of ['i', 'j', 'k', 'n', 'iCount', 'iIndex']) if (!used.has(c)) return c;
  for (let i = 2; ; i++) if (!used.has(`i${i}`)) return `i${i}`;
}

interface Site {
  parent: CompoundStmt;
  index: number;
  loop: DoWhileStmt;
  counter: string;
  /** Constant count: the statement `n = K;` / `T n = K;` before the loop and K. */
  constant: { stmt: Statement; k: Expression; decl: boolean } | null;
  /** The guard `if (n <= 0) return;` goes too: the loop ends a void function, so it is the for loop's own entry test. */
  foldGuard: boolean;
}

/** `return;` alone, bare or in a block. */
function bareReturn(s: Statement): boolean {
  if (s.kind === NodeKind.ReturnStmt) return !(s as unknown as { value: Expression | null }).value;
  if (s.kind === NodeKind.CompoundStmt) {
    const st = (s as CompoundStmt).statements;
    return st.length === 1 && bareReturn(st[0]);
  }
  return false;
}

/** The value `T n = K;` / `n = K;` gives n, when s is such a statement. */
function constantInit(s: Statement, v: string): { k: Expression; decl: boolean } | null {
  if (s.kind === NodeKind.DeclStmt) {
    const ds = (s as DeclStmt).declarations;
    if (ds.length !== 1 || ds[0].kind !== NodeKind.VariableDecl) return null;
    const d = ds[0] as VariableDecl;
    if (d.name.name !== v || !d.initializer || d.initializer.kind === NodeKind.InitListExpr) return null;
    return lit(d.initializer as Expression) !== undefined ? { k: d.initializer as Expression, decl: true } : null;
  }
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = unwrap((s as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=' || !isId((e as AssignExpr).left, v)) return null;
  return lit((e as AssignExpr).right) !== undefined ? { k: (e as AssignExpr).right, decl: false } : null;
}

export interface CountdownIndexForOptions extends PluginOptions {
  /** Counters a measured vc8form of this function names. */
  measuredCounters?: string[];
}

function findSite(fn: FunctionDecl, vars: Map<string, Var>, locals: Set<string>, keep: ReadonlySet<string>): Site | null {
  let flow: ReturnType<typeof buildFunctionFlow> | null = null;
  const parents = new Map<ASTNode, ASTNode>();
  for (const x of traverseAST(fn.body!)) {
    for (const [k, val] of Object.entries(x)) {
      if (k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'location') continue;
      if (Array.isArray(val)) { for (const y of val) if (y && typeof y === 'object' && 'kind' in y) parents.set(y as ASTNode, x); }
      else if (val && typeof val === 'object' && 'kind' in val) parents.set(val as ASTNode, x);
    }
  }
  for (const x of traverseAST(fn.body!)) {
    if (x.kind !== NodeKind.DoWhileStmt) continue;
    const loop = x as DoWhileStmt;
    if (loop.body.kind !== NodeKind.CompoundStmt) continue;
    const st = (loop.body as CompoundStmt).statements;
    if (st.length < 2) continue;
    const v = stepOf(st[st.length - 1]);
    if (!v || !vars.has(v) || keep.has(v) || !testOf(loop.condition, v)) continue;
    const info = vars.get(v)!;
    if (st.slice(0, -1).some(s => mentions(s, v) > 0)) continue;
    if (unsafeBody(loop.body)) continue;
    const parent = parents.get(loop);
    if (!parent || parent.kind !== NodeKind.CompoundStmt) continue;
    const ps = (parent as CompoundStmt).statements;
    const index = ps.indexOf(loop as unknown as Statement);
    // Entry: n >= 1 (unsigned: n != 0).
    let constant: Site['constant'] = null;
    let entered = false;
    let foldGuard = false;
    if (index > 0) {
      const prev = ps[index - 1];
      const c = constantInit(prev, v);
      if (c) {
        const k = lit(c.k)!;
        if (k >= 1n && k <= (info.signed ? MAX_SIGNED : MAX_UNSIGNED)) { constant = { stmt: prev, ...c }; entered = true; }
      } else if (prev.kind === NodeKind.IfStmt) {
        const g = prev as IfStmt;
        if (!g.init && !g.elseBranch && notPositive(g.condition, v, info.signed) && exits(g.thenBranch)) {
          entered = true;
          foldGuard = parent === fn.body && ps.slice(index + 1).every(bareReturn) && bareReturn(g.thenBranch);
        }
      }
    }
    if (!entered) continue;
    // Dead after the loop: only the step and the test read the stepped value.
    if (!flow) flow = buildFunctionFlow(fn.body!.statements, locals);
    if (flow.isEscaped(v)) continue;
    const stepNode = flow.nodeOf(st[st.length - 1]);
    const testNode = flow.nodeOf(loop as unknown as Statement);
    if (stepNode === undefined || testNode === undefined) continue;
    if (flow.usesOf(stepNode, v).some(u => u !== stepNode && u !== testNode)) continue;
    return { parent: parent as CompoundStmt, index, loop, counter: v, constant, foldGuard };
  }
  return null;
}

function rewriteFunction(fn: FunctionDecl, keep: ReadonlySet<string>): FunctionDecl | undefined {
  if (!fn.body || unmodelled(fn)) return undefined;
  let cur = fn;
  let changed = false;
  for (let round = 0; round < 32; round++) {
    const { vars, locals } = counters(cur);
    if (vars.size === 0) break;
    const site = findSite(cur, vars, locals, keep);
    if (!site) break;
    const { parent, index, loop, counter, constant, foldGuard } = site;
    const info = vars.get(counter)!;
    const bodyStmts = (loop.body as CompoundStmt).statements.slice(0, -1);
    const body = updateNode(loop.body as CompoundStmt, { statements: bodyStmts } as Partial<CompoundStmt>);
    let replacement: Statement;
    let drop = 0;
    if (constant) {
      // The counter is the index; a declaration nothing else names moves into the header.
      const own = constant.decl && mentions(cur.body, counter) === 1 + mentions(loop, counter);
      const init = own
        ? Stmt.declStmt([Decl.variable(counter, cloneNode(info.type), Expr.intLiteral(0))])
        : Stmt.expr(Expr.assign(Expr.identifier(counter), Expr.intLiteral(0)));
      if (constant.decl && !own) {
        // Keep the declaration, without its now unused initial value.
        replacement = Stmt.for_(init, Expr.lt(Expr.identifier(counter), cloneNode(constant.k)), Expr.postfix(Expr.identifier(counter), '++'), body);
        const d = (constant.stmt as DeclStmt).declarations[0] as VariableDecl;
        const bare = updateNode(constant.stmt as DeclStmt, { declarations: [updateNode(d, { initializer: null } as Partial<VariableDecl>)] } as Partial<DeclStmt>);
        const stmts = parent.statements.slice();
        stmts[index - 1] = bare;
        stmts[index] = { ...replacement, leadingTrivia: loop.leadingTrivia, trailingTrivia: loop.trailingTrivia } as Statement;
        cur = updateNode(cur, { body: replaceNode(cur.body!, parent, updateNode(parent, { statements: stmts } as Partial<CompoundStmt>)) as CompoundStmt } as Partial<FunctionDecl>);
        changed = true;
        continue;
      }
      replacement = Stmt.for_(init, Expr.lt(Expr.identifier(counter), cloneNode(constant.k)), Expr.postfix(Expr.identifier(counter), '++'), body);
      drop = 1;
    } else {
      const ix = freshIndex(cur);
      replacement = Stmt.for_(
        Stmt.declStmt([Decl.variable(ix, cloneNode(info.type), Expr.intLiteral(0))]),
        Expr.lt(Expr.identifier(ix), Expr.identifier(counter)),
        Expr.postfix(Expr.identifier(ix), '++'),
        body,
      );
      if (foldGuard) drop = 1;
    }
    const stmts = parent.statements.slice();
    stmts.splice(index - drop, 1 + drop, { ...replacement, leadingTrivia: (drop ? stmts[index - 1] : loop).leadingTrivia, trailingTrivia: loop.trailingTrivia } as Statement);
    cur = updateNode(cur, { body: replaceNode(cur.body!, parent, updateNode(parent, { statements: stmts } as Partial<CompoundStmt>)) as CompoundStmt } as Partial<FunctionDecl>);
    changed = true;
  }
  return changed ? cur : undefined;
}

function createCountdownIndexForTransformer(options: CountdownIndexForOptions = {}): Transformer {
  const keep = new Set(options.measuredCounters ?? []);
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, keep);
    },
  });
}

export const countdownIndexForPlugin: TransformPlugin = {
  id: 'countdown-index-for',
  name: 'Countdown Index For',
  description: 'A do-while counting an unread counter down from n >= 1 is the for loop counting an index up to n',
  version: '1.0.0',
  defaultEnabled: true,
  // After loop-step-merge (62.72): its merges can leave the counter the only loop variable.
  priority: 62.74,
  tags: ['matching'],
  createTransformer: createCountdownIndexForTransformer,
};

export { createCountdownIndexForTransformer };
