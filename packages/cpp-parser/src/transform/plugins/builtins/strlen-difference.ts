/**
 * Strlen Difference Plugin
 *
 * VC8 inlines `strlen(s)` as a scan that leaves the pointer one past the terminator and then
 * subtracts `s + 1`. The decompiler prints the scan, and string-intrinsics folds the loop back
 * into a call, but the subtraction stays a pointer comparison against `s + 1`
 * (CHATDLG_UpdateChannelOkButtonState 0043e660):
 *
 *   printed                                  original
 *   p = s;                                   if (strlen(s) >= 1) {
 *   p = p + strlen(p) + 1;
 *   if (p != s + 1) {
 *
 * Compiled as printed, VC8 keeps the pointer (`lea; lea; cmp; je`); the original's
 * `sub eax, edx; cmp eax, 1; jb` is the length compared. This pass cancels the difference:
 *
 *   p != s + 1               strlen(s) != 0   (or `>= 1`)
 *   p == s + 1               strlen(s) == 0   (or `< 1`)
 *   (int)p - (int)(s + 1)    (int)strlen(s)
 *
 * The `>= 1`/`< 1` spelling is used where the comparison's fact row (extract/compare-sites)
 * says the original compared with `CMP r, 1`, as VC8 compiles `strlen(s) >= 1`; a TEST keeps
 * `!= 0`. Without a row the zero spelling is written.
 *
 * Value-preserving: p = s + strlen(s) + 1 exactly, so p - (s + 1) is strlen(s) and p == s + 1
 * iff it is 0. Only where the two assignments are adjacent statements, the uses are all in
 * the statement right after them (nothing runs in between that could change the string), p
 * is a nonvolatile local read nowhere else and never has its address taken. The string is
 * a typed nonvolatile char pointer/array or a known object's char-array member. The
 * consumer must evaluate only built-in scalar/pointer expressions before the new strlen;
 * integer differences require matching full-word casts, whose type is preserved. The
 * two assignments are then dead and removed (a declaration `T *p = s;` keeps its
 * declaration without the initializer only if p is declared there).
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CallExpr, CompoundStmt, CStyleCastExpr, DeclStmt, Expression, ExprStmt,
  FunctionDecl, Identifier, IntegerLiteralExpr, ParenExpr, Statement, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import type { Transformer } from '../../transformer.js';
import { Expr } from '../../../ast/factory.js';
import { cloneNode } from '../../transformer.js';
import { buildFunctionFlow, type FunctionFlow } from '../../cfg/dataflow.js';
import type { IfStmt, ReturnStmt } from '../../../ast/nodes.js';
import { createStrlenProof, type StrlenProofOptions } from './strlen-difference-proof.js';

export interface StrlenDifferenceOptions extends PluginOptions, StrlenProofOptions {
  /** The function's compare-sites row (extract/compare-sites.ts). */
  compareSites?: string;
  onSite?: (e: { pointer: string; string: string; form: string }) => void;
}

function unwrapParens(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}
const ident = (e: Expression | null | undefined): string | null => {
  if (!e) return null;
  const u = unwrapParens(e);
  return u.kind === NodeKind.Identifier ? (u as Identifier).name : null;
};

function walk(node: unknown, visit: (n: ASTNode, parent: Record<string | number, unknown>, key: string | number) => void): void {
  if (!node || typeof node !== 'object') return;
  const entries: [string | number, unknown][] = Array.isArray(node)
    ? node.map((c, i) => [i, c] as [number, unknown])
    : Object.keys(node as object).filter((k) => k !== 'location' && k !== 'leadingTrivia' && k !== 'trailingTrivia' && k !== 'parent')
        .map((k) => [k, (node as Record<string, unknown>)[k]] as [string, unknown]);
  for (const [k, c] of entries) {
    if (!c || typeof c !== 'object') continue;
    walk(c, visit);
    if (!Array.isArray(c) && (c as ASTNode).kind !== undefined) visit(c as ASTNode, node as Record<string | number, unknown>, k);
  }
}

/** `p = s;` or `T *p = s;`: p, s. */
function initOf(st: Statement): { p: string; s: Expression; decl: VariableDecl | null } | null {
  if (st.kind === NodeKind.ExprStmt) {
    const e = unwrapParens((st as ExprStmt).expression);
    if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
    const p = ident((e as AssignExpr).left), s = (e as AssignExpr).right;
    return p && s ? { p, s, decl: null } : null;
  }
  if (st.kind === NodeKind.DeclStmt) {
    const ds = (st as DeclStmt).declarations;
    if (ds.length !== 1 || ds[0].kind !== NodeKind.VariableDecl) return null;
    const v = ds[0] as VariableDecl;
    const s = v.initializer as Expression | null;
    return s ? { p: v.name.name, s, decl: v } : null;
  }
  return null;
}

/** `p = p + strlen(p) + 1;` */
function isAdvance(st: Statement, p: string): boolean {
  if (st.kind !== NodeKind.ExprStmt) return false;
  const e = unwrapParens((st as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=' || ident((e as AssignExpr).left) !== p) return false;
  const r = unwrapParens((e as AssignExpr).right);
  if (r.kind !== NodeKind.BinaryExpr || (r as BinaryExpr).operator !== '+') return false;
  const one = unwrapParens((r as BinaryExpr).right);
  if (one.kind !== NodeKind.IntegerLiteral || (one as IntegerLiteralExpr).value !== 1n) return false;
  const l = unwrapParens((r as BinaryExpr).left);
  if (l.kind !== NodeKind.BinaryExpr || (l as BinaryExpr).operator !== '+' || ident((l as BinaryExpr).left) !== p) return false;
  const c = unwrapParens((l as BinaryExpr).right);
  if (c.kind !== NodeKind.CallExpr) return false;
  const call = c as CallExpr;
  return ident(call.callee) === 'strlen' && call.arguments.length === 1 && ident(call.arguments[0]) === p;
}

/** `s + 1` */
function isSPlusOne(e: Expression, s: string, proof: ReturnType<typeof createStrlenProof>): boolean {
  const u = unwrapParens(e);
  if (u.kind !== NodeKind.BinaryExpr || (u as BinaryExpr).operator !== '+') return false;
  const one = unwrapParens((u as BinaryExpr).right);
  return proof.baseKey((u as BinaryExpr).left) === s && one.kind === NodeKind.IntegerLiteral && (one as IntegerLiteralExpr).value === 1n;
}

function strlenOf(s: Expression): CallExpr {
  return Expr.call('strlen', [cloneNode(s)]);
}

/** Does the compare-sites row for `p ==/!= ...` say CMP with immediate 1? */
function comparesWithOne(rows: string | undefined, p: string): boolean | null {
  if (!rows) return null;
  const fit = rows.split('\n').map((l) => l.split('\t')).filter((f) => f.length >= 17 && (f[1] === '!=' || f[1] === '==') && (f[6] === 'v:' + p || f[7] === 'v:' + p));
  if (fit.length === 0) return null;
  const one = fit.map((f) => f[12] === 'CMP' && f[15] === 'i' && f[16] === '1');
  return one.every((x) => x === one[0]) ? one[0] : null;
}

/** An identifier that names a value, not the declared name of a variable. */
function isRead(x: ASTNode, parent: Record<string | number, unknown>, key: string | number): boolean {
  return x.kind === NodeKind.Identifier && !(key === 'name' && (parent as unknown as ASTNode).kind === NodeKind.VariableDecl);
}

function countIdent(node: unknown, name: string): number {
  let n = 0;
  walk(node, (x, parent, key) => { if (isRead(x, parent, key) && (x as Identifier).name === name) n++; });
  return n;
}

/** Where the expressions a statement evaluates first live: [container, key] pairs. */
function headOf(st: Statement): [Record<string | number, unknown>, string | number][] | null {
  const o = st as unknown as Record<string | number, unknown>;
  if (st.kind === NodeKind.IfStmt) return (st as IfStmt).init ? null : [[o, 'condition']];
  if (st.kind === NodeKind.ExprStmt) return [[o, 'expression']];
  if (st.kind === NodeKind.ReturnStmt) return (st as ReturnStmt).value ? [[o, 'value']] : null;
  if (st.kind === NodeKind.DeclStmt) {
    const out: [Record<string | number, unknown>, string | number][] = [];
    for (const d of (st as DeclStmt).declarations) {
      if (d.kind !== NodeKind.VariableDecl) return null;
      if ((d as VariableDecl).initializer) out.push([d as unknown as Record<string, unknown>, 'initializer']);
    }
    return out;
  }
  return null;
}

function rewriteBlock(blk: CompoundStmt, opts: StrlenDifferenceOptions, flow: FunctionFlow, proof: ReturnType<typeof createStrlenProof>): void {
  for (let i = 0; i + 2 < blk.statements.length; i++) {
    const init = initOf(blk.statements[i]);
    if (!init || flow.isEscaped(init.p) || !isAdvance(blk.statements[i + 1], init.p)) continue;
    const { p, s } = init;
    const string = proof.baseKey(s);
    if (!string || p === string || !proof.pointer(p)) continue;
    const use = blk.statements[i + 2];
    const head = headOf(use);
    if (!head || !proof.safeConsumer(use, head.map(([obj, key]) => obj[key] as Expression))) continue;
    const nInit = flow.nodeOf(blk.statements[i]), nAdv = flow.nodeOf(blk.statements[i + 1]), nUse = flow.nodeOf(use);
    if (nInit === undefined || nAdv === undefined || nUse === undefined) continue;
    // the scan's start feeds only the scan, and the scan's end only this statement's head
    const fromInit = flow.usesOf(nInit, p), fromAdv = flow.usesOf(nAdv, p);
    if (fromInit.length !== 1 || fromInit[0] !== nAdv || fromAdv.length !== 1 || fromAdv[0] !== nUse) continue;
    if (flow.reaching(nUse, p).size !== 1) continue;
    const sites: { parent: Record<string | number, unknown>; key: string | number; make: () => Expression }[] = [];
    const withOne = comparesWithOne(opts.compareSites, p);
    const visit = (n: ASTNode, parent: Record<string | number, unknown>, key: string | number) => {
      if (n.kind !== NodeKind.BinaryExpr) return;
      const b = n as BinaryExpr;
      const trivia = { leadingTrivia: n.leadingTrivia ?? [], trailingTrivia: n.trailingTrivia ?? [] };
      if ((b.operator === '!=' || b.operator === '==') && ident(b.left) === p && isSPlusOne(b.right, string, proof)) {
        const ne = b.operator === '!=';
        const op = withOne ? (ne ? '>=' : '<') : (ne ? '!=' : '==');
        sites.push({ parent, key, make: () => ({ ...Expr.binary(strlenOf(s), op as never, Expr.intLiteral(withOne ? 1 : 0)), ...trivia }) });
        return;
      }
      const cast = b.operator === '-' ? proof.differenceCast(b.left, b.right) : null;
      if (cast && ident((unwrapParens(b.left) as CStyleCastExpr).expression) === p
        && isSPlusOne((unwrapParens(b.right) as CStyleCastExpr).expression, string, proof)) {
        sites.push({ parent, key, make: () => ({ ...Expr.cast(cloneNode(cast), strlenOf(s)), ...trivia }) as Expression });
      }
    };
    let reads = 0;
    let writesS = false;
    for (const [obj, key] of head) {
      const e = obj[key] as ASTNode;
      walk(e, visit);
      visit(e, obj, key);
      reads += countIdent(e, p) + (e.kind === NodeKind.Identifier && (e as Identifier).name === p ? 1 : 0);
      const w = (n: ASTNode) => {
        if (n.kind === NodeKind.AssignExpr && proof.baseKey((n as AssignExpr).left) === string) writesS = true;
        if ((n.kind === NodeKind.UnaryExpr || n.kind === NodeKind.PostfixExpr) && ['++', '--'].includes((n as UnaryExpr).operator) && proof.baseKey((n as UnaryExpr).operand) === string) writesS = true;
      };
      walk(e, w); w(e);
    }
    // every read of p in the head is a site; nothing in the head moves s
    if (sites.length === 0 || sites.length !== reads || writesS) continue;
    for (const st of sites) st.parent[st.key] = st.make();
    if (init.decl) {
      init.decl.initializer = null;
      blk.statements.splice(i + 1, 1);
    } else {
      blk.statements.splice(i, 2);
    }
    for (const _ of sites) opts.onSite?.({ pointer: p, string, form: withOne ? 'one' : 'zero' });
    return; // the flow is stale now; the caller rebuilds it
  }
}

export const strlenDifferencePlugin: TransformPlugin = {
  id: 'strlen-difference',
  name: 'Strlen Difference',
  description: 'Cancels an inlined strlen\'s pointer difference against s + 1 back into strlen(s)',
  version: '0.1.0',
  defaultEnabled: true,
  priority: 989.985,
  tags: ['codegen', 'vc8'],
  createTransformer(options?: PluginOptions): Transformer {
    const opts = (options ?? {}) as StrlenDifferenceOptions;
    return (ast: ASTNode) => {
      const fns: FunctionDecl[] = [];
      if (ast.kind === NodeKind.FunctionDecl) fns.push(ast as FunctionDecl);
      walk(ast, (n) => { if (n.kind === NodeKind.FunctionDecl) fns.push(n as FunctionDecl); });
      for (const fn of fns) {
        if (!fn.body) continue;
        const proof = createStrlenProof(ast, fn, opts);
        const locals = new Set<string>();
        for (const prm of fn.parameters) { const n = (prm as unknown as { name?: Identifier | null }).name; if (n) locals.add(n.name); }
        walk(fn.body, (n) => { if (n.kind === NodeKind.VariableDecl) locals.add((n as VariableDecl).name.name); });
        const body = (fn.body as CompoundStmt).statements;
        for (let round = 0; round < 64; round++) {
          const flow = buildFunctionFlow(body, locals);
          const blocks: CompoundStmt[] = [fn.body as CompoundStmt];
          walk(fn.body, (n) => { if (n.kind === NodeKind.CompoundStmt) blocks.push(n as CompoundStmt); });
          let fired = 0;
          const count = { n: 0 };
          const o2 = { ...opts, onSite: (e: { pointer: string; string: string; form: string }) => { count.n++; opts.onSite?.(e); } };
          for (const blk of blocks) { rewriteBlock(blk, o2, flow, proof); if (count.n) { fired = count.n; break; } }
          if (!fired) break;
        }
      }
      return ast;
    };
  },
};
