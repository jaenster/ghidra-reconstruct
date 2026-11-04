/**
 * Bool Select Form Plugin
 *
 * VC8 materialises a comparison as a value in one of two ways, and which one it picks follows
 * the source spelling, not the value:
 *
 *   source                                   VC8
 *   bool f() { return x >= 0x1c; }           cmp; sbb eax, eax; add eax, 1
 *   bool f() { return x >= 0x1c ? true : false; }   cmp; setae al
 *   bool f() { return !b; }                  neg eax; sbb eax, eax; add eax, 1
 *   bool f() { return b ? false : true; }    test eax, eax; sete al
 *   n = c ? 0xa : 0x6;                       setne al; lea eax, [eax*4 + 6]
 *   n = 6 + (c ? 4 : 0);                     neg eax; sbb eax, eax; and eax, 4; add eax, 6
 *
 * The decompiler prints both forms of each pair the same way, so the text cannot tell them
 * apart; the instructions can. extract/compare-sites.ts records, per comparison, the
 * instruction that reads its flags (`um`): a SETcc for the setcc form, nothing (`-`) for the
 * neg/sbb form, which computes the flag with NEG or SUB and never tests it.
 *
 *  - `return C;` in a function returning `bool`, C a comparison or `!x`, whose comparison the
 *    original read with a SETcc: `return C ? true : false;` (DEBUG_IsValidDebugDirectorySize
 *    00404850, Q35_ActiveFilter 0058ccf0, Q11_IsTaintedSunComplete 0059ac20).
 *  - `c ? A : B`, A and B integer literals whose difference VC8 would scale with LEA (1, 2,
 *    3, 4, 5, 8, 9), whose comparison the original computed with no flag reader:
 *    `B + (c ? A - B : 0)` (zlib deflateBound 00427330, `6 + (s->strstart ? 4 : 0)`). Both
 *    values must be positive: a comparator's `c ? 1 : -1` (BigBuffer_Compare_Ui 00422570) is
 *    written as the select and compiles to the same neg/sbb.
 *
 *  - a call argument `!x` (or `(T)!x`, `x == 0`), x a local or parameter whose address is
 *    never taken, whose comparison the original computed with no flag reader: VC8 passes
 *    `!x` straight to a call with `xor; test; sete`, and materialises it in a BOOL local
 *    with `neg; sbb; add 1`. Hoisted to `BOOL bNotX = !x;` before the statement
 *    (CMD_AutomapToggleParty 00468a90, CMD_ToggleAlwaysRun 00469060, ROSTER_TogglePlayerFlag
 *    00479d30). x is read at the same value: nothing between the new declaration and the
 *    call can write a local whose address is not taken except the statement itself, which
 *    is required not to assign x.
 *
 * The rewrites keep the value and the type: `C ? true : false` is C, and for 32-bit int
 * literals `B + (c ? A - B : 0)` is A or B; the difference is formed in the literals' own
 * type and the rewrite is skipped when it would not fit in int.
 *
 * The comparison is tied to its fact row by operand fingerprint (`v:<name>` for an
 * identifier, `e` otherwise): every row whose operator family and fingerprint fit must agree
 * on the reader's class, or the site is left alone. Without facts the pass does nothing.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, BinaryExpr, BoolLiteralExpr, BuiltinType, ConditionalExpr, CStyleCastExpr, Expression,
  FunctionDecl, Identifier, IntegerLiteralExpr, ParenExpr, ReturnStmt, UnaryExpr,
} from '../../../ast/nodes.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import type { Transformer } from '../../transformer.js';
import { Decl, Expr, Stmt, Type } from '../../../ast/factory.js';
import type { CallExpr, CompoundStmt, ExprStmt, Statement, AssignExpr } from '../../../ast/nodes.js';

export interface BoolSelectFormOptions extends PluginOptions {
  /** The function's compare-sites row (extract/compare-sites.ts), tab separated, one per line. */
  compareSites?: string;
  /**
   * The decompile the body was generated from. Its neg/sbb selects, `(-(uint)(c) & K) + B`,
   * are the ones the original computed without a flag reader; the generator folds each to
   * `c ? K+B : B`. (In the pipeline this is sbb-branchless's own input: the pass keeps the
   * unfolded form instead.)
   */
  decompile?: string;
  onSite?: (e: { kind: 'bool-return' | 'sbb-select' | 'not-arg-local'; text: string }) => void;
}

interface Row { op: string; fp: [string, string]; k: string; um: string; sm: string; b: string }

function parseRows(s: string | undefined): Row[] {
  if (!s) return [];
  const rows: Row[] = [];
  for (const line of s.split('\n')) {
    const f = line.split('\t');
    if (f.length < 12 || f[2] === '-') continue;
    rows.push({ op: f[1], fp: [f[6], f[7]], k: f[5], um: f[10], sm: f[12], b: f[15] });
  }
  return rows;
}

const CMP = new Set(['<', '>', '<=', '>=', '==', '!=']);
const EQ = new Set(['==', '!=']);

function unwrap(e: Expression): Expression {
  for (;;) {
    if (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
    else if (e.kind === NodeKind.CStyleCastExpr) e = (e as CStyleCastExpr).expression;
    else return e;
  }
}

function fingerprint(e: Expression): string {
  const u = unwrap(e);
  if (u.kind === NodeKind.Identifier) return 'v:' + (u as Identifier).name;
  if (u.kind === NodeKind.IntegerLiteral) return 'c';
  return 'e';
}

/** The operand fingerprints and operator family of a condition, or null if it is no test. */
function testOf(cond: Expression): { eq: boolean; fps: string[] } | null {
  const u = unwrap(cond);
  if (u.kind === NodeKind.BinaryExpr && CMP.has((u as BinaryExpr).operator)) {
    const b = u as BinaryExpr;
    return { eq: EQ.has(b.operator), fps: [fingerprint(b.left), fingerprint(b.right)].filter((f) => f !== 'c') };
  }
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') {
    return { eq: true, fps: [fingerprint((u as UnaryExpr).operand)] };
  }
  if (u.kind === NodeKind.Identifier || u.kind === NodeKind.MemberExpr || u.kind === NodeKind.SubscriptExpr) {
    return { eq: true, fps: [fingerprint(u)] };
  }
  return null;
}

type ReaderClass = 'set' | 'none' | 'jcc';
function classOf(r: Row): ReaderClass {
  const um = r.um;
  if (um === '-') return 'none';
  // `xor eax, eax; cmp [m], eax; setne al` is VC8's own code for a plain `return m != 0;`.
  if (um.startsWith('SET') && r.sm === 'CMP' && r.b === 'z') return 'jcc';
  return um.startsWith('SET') ? 'set' : 'jcc';
}

/** The one reader class every fitting row agrees on, else null. */
function readerOf(rows: Row[], cond: Expression): ReaderClass | null {
  const t = testOf(cond);
  if (!t || t.fps.length !== 1) return null;
  const fp = t.fps[0];
  const fit = rows.filter((r) => EQ.has(r.op) === t.eq && (r.fp[0] === fp || r.fp[1] === fp));
  if (fit.length === 0) return null;
  const c = classOf(fit[0]);
  return fit.every((r) => classOf(r) === c) ? c : null;
}

function isBool(t: unknown): boolean {
  const b = t as BuiltinType;
  return !!b && b.kind === NodeKind.BuiltinType && b.name === 'bool' && (b.modifiers ?? []).length === 0;
}

function boolLit(value: boolean, at: ASTNode): BoolLiteralExpr {
  return { kind: NodeKind.BoolLiteral, value, location: at.location, leadingTrivia: [], trailingTrivia: [] } as BoolLiteralExpr;
}

function intLit(value: bigint, at: ASTNode): Expression {
  const abs = value < 0n ? -value : value;
  const lit = {
    kind: NodeKind.IntegerLiteral, value: abs, suffix: '', base: abs > 9n ? 16 : 10,
    raw: abs > 9n ? '0x' + abs.toString(16) : abs.toString(), location: at.location, leadingTrivia: [], trailingTrivia: [],
  } as IntegerLiteralExpr;
  if (value >= 0n) return lit;
  return { kind: NodeKind.UnaryExpr, operator: '-', operand: lit, prefix: true, location: at.location, leadingTrivia: [], trailingTrivia: [] } as unknown as Expression;
}

/** A plain int literal (no suffix), possibly negated: its value. */
function plainInt(e: Expression): bigint | null {
  let u = e;
  while (u.kind === NodeKind.ParenExpr) u = (u as ParenExpr).expression;
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '-') {
    const v = plainInt((u as UnaryExpr).operand);
    return v === null ? null : -v;
  }
  if (u.kind !== NodeKind.IntegerLiteral) return null;
  const l = u as IntegerLiteralExpr;
  if (l.suffix && l.suffix !== '') return null;
  return l.value <= 0x7fffffffn ? l.value : null;
}

const s32 = (v: bigint): bigint => { v &= 0xffffffffn; return v >= 0x80000000n ? v - 0x100000000n : v; };

/** `A:B` for every `(-(uint)(c) & K) + B` / `- B` of the decompile: the select's two values. */
function sbbSelectsOf(text: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const re = /-\((?:uint|int)\)\([^;]*?\) & (0x[0-9a-f]+|\d+)\) ([+-]) (0x[0-9a-f]+|\d+)/g;
  for (const m of text.matchAll(re)) {
    const k = s32(BigInt(m[1])), base = m[2] === '+' ? s32(BigInt(m[3])) : -s32(BigInt(m[3]));
    out.add(`${s32(k + base)}:${base}`);
  }
  return out;
}

const LEA_DIFF = new Set([1n, 2n, 3n, 4n, 5n, 8n, 9n]);

function paren(e: Expression, at: ASTNode): ParenExpr {
  return { kind: NodeKind.ParenExpr, expression: e, location: at.location, leadingTrivia: [], trailingTrivia: [] } as ParenExpr;
}

function walk(node: unknown, visit: (n: ASTNode, parent: Record<string, unknown>, key: string | number) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const c = node[i];
      if (c && typeof c === 'object') { walk(c, visit); if ((c as ASTNode).kind !== undefined) visit(c as ASTNode, node as unknown as Record<string, unknown>, i); }
    }
    return;
  }
  for (const key of Object.keys(node as object)) {
    if (key === 'location' || key === 'leadingTrivia' || key === 'trailingTrivia' || key === 'parent') continue;
    const c = (node as Record<string, unknown>)[key];
    if (c && typeof c === 'object') {
      walk(c, visit);
      if (!Array.isArray(c) && (c as ASTNode).kind !== undefined) visit(c as ASTNode, node as Record<string, unknown>, key);
    }
  }
}

function rewriteFunction(fn: FunctionDecl, rows: Row[], sbbPairs: Set<string>, opts: BoolSelectFormOptions): void {
  if (!fn.body) return;
  const boolFn = isBool(fn.returnType);
  walk(fn.body, (n, parent, key) => {
    if (n.kind === NodeKind.ReturnStmt && boolFn) {
      const r = n as ReturnStmt;
      if (!r.value) return;
      const v = unwrap(r.value);
      const isTest = (v.kind === NodeKind.BinaryExpr && CMP.has((v as BinaryExpr).operator)) ||
        (v.kind === NodeKind.UnaryExpr && (v as UnaryExpr).operator === '!');
      if (!isTest || readerOf(rows, v) !== 'set') return;
      r.value = { kind: NodeKind.ConditionalExpr, condition: r.value, thenExpr: boolLit(true, n), elseExpr: boolLit(false, n),
        location: n.location, leadingTrivia: [], trailingTrivia: [] } as ConditionalExpr;
      opts.onSite?.({ kind: 'bool-return', text: '' });
      return;
    }
    if (n.kind === NodeKind.ConditionalExpr) {
      const c = n as ConditionalExpr;
      const a = plainInt(c.thenExpr), b = plainInt(c.elseExpr);
      // A sign result (`c ? 1 : -1`) is the comparator's own spelling; only positive selects.
      if (a === null || b === null || a <= 0n || b <= 0n) return;
      const d = a - b;
      if (!LEA_DIFF.has(d < 0n ? -d : d)) return;
      if (!sbbPairs.has(`${a}:${b}`)) return;
      const inner: ConditionalExpr = { ...c, thenExpr: intLit(d, n), elseExpr: intLit(0n, n), leadingTrivia: [], trailingTrivia: [] };
      const sum = { kind: NodeKind.BinaryExpr, operator: '+', left: intLit(b, n), right: paren(inner, n),
        location: n.location, leadingTrivia: n.leadingTrivia ?? [], trailingTrivia: n.trailingTrivia ?? [] } as BinaryExpr;
      (parent as Record<string | number, unknown>)[key] = paren(sum as Expression, n);
      opts.onSite?.({ kind: 'sbb-select', text: '' });
    }
  });
}

/** `!x`, `(T)!x`, `x == 0` (either order) with x an identifier: x. */
function negatedIdent(arg: Expression): string | null {
  const u = unwrap(arg);
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') {
    const o = unwrap((u as UnaryExpr).operand);
    return o.kind === NodeKind.Identifier ? (o as Identifier).name : null;
  }
  if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '==') {
    const b = u as BinaryExpr;
    const l = unwrap(b.left), r = unwrap(b.right);
    const zero = (e: Expression) => e.kind === NodeKind.IntegerLiteral && (e as IntegerLiteralExpr).value === 0n;
    if (l.kind === NodeKind.Identifier && zero(r)) return (l as Identifier).name;
    if (r.kind === NodeKind.Identifier && zero(l)) return (r as Identifier).name;
  }
  return null;
}

function hoistNegatedArgs(fn: FunctionDecl, rows: Row[], opts: BoolSelectFormOptions): void {
  if (!fn.body) return;
  const declared = new Set<string>(), used = new Set<string>(), addressed = new Set<string>();
  for (const prm of fn.parameters) { const n = (prm as unknown as { name?: Identifier | null }).name; if (n) declared.add(n.name); }
  walk(fn.body, (n) => {
    if (n.kind === NodeKind.VariableDecl) declared.add((n as unknown as { name: Identifier }).name.name);
    if (n.kind === NodeKind.Identifier) used.add((n as Identifier).name);
    if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
      const o = unwrap((n as UnaryExpr).operand);
      if (o.kind === NodeKind.Identifier) addressed.add((o as Identifier).name);
    }
  });
  const assigns = (stmt: Statement, x: string): boolean => {
    let hit = false;
    walk(stmt, (n) => {
      if (n.kind === NodeKind.AssignExpr) { const l = unwrap((n as AssignExpr).left); if (l.kind === NodeKind.Identifier && (l as Identifier).name === x) hit = true; }
      if ((n.kind === NodeKind.UnaryExpr || n.kind === NodeKind.PostfixExpr) && ['++', '--'].includes((n as UnaryExpr).operator)) {
        const o = unwrap((n as UnaryExpr).operand); if (o.kind === NodeKind.Identifier && (o as Identifier).name === x) hit = true;
      }
    });
    return hit;
  };
  const blocks: CompoundStmt[] = [];
  if (fn.body.kind === NodeKind.CompoundStmt) blocks.push(fn.body as CompoundStmt);
  walk(fn.body, (n) => { if (n.kind === NodeKind.CompoundStmt) blocks.push(n as CompoundStmt); });
  for (const blk of blocks) {
    for (let i = 0; i < blk.statements.length; i++) {
      const st = blk.statements[i];
      if (st.kind !== NodeKind.ExprStmt) continue;
      let e = unwrap((st as ExprStmt).expression);
      if (e.kind === NodeKind.AssignExpr) e = unwrap((e as AssignExpr).right);
      if (e.kind !== NodeKind.CallExpr) continue;
      const call = e as CallExpr;
      for (let j = 0; j < call.arguments.length; j++) {
        const x = negatedIdent(call.arguments[j]);
        if (!x || !declared.has(x) || addressed.has(x) || assigns(st, x)) continue;
        if (readerOf(rows, call.arguments[j]) !== 'none') continue;
        let name = 'bNot' + x.replace(/^[a-z]+(?=[A-Z])/, '').replace(/^./, (c) => c.toUpperCase());
        while (used.has(name) || declared.has(name)) name += '_';
        used.add(name); declared.add(name);
        const decl = Stmt.declStmt([Decl.variable(name, Type.typedef('BOOL'), Expr.not(Expr.identifier(x)))]);
        call.arguments[j] = Expr.identifier(name);
        blk.statements.splice(i, 0, decl);
        i++;
        opts.onSite?.({ kind: 'not-arg-local', text: x });
      }
    }
  }
}

export const boolSelectFormPlugin: TransformPlugin = {
  id: 'bool-select-form',
  name: 'Bool Select Form',
  description: 'Writes a materialised comparison in the spelling VC8 compiles to the original setcc or neg/sbb form, read from the compare-site facts',
  version: '0.1.0',
  defaultEnabled: true,
  priority: 989.99,
  tags: ['codegen', 'vc8'],
  createTransformer(options?: PluginOptions): Transformer {
    const opts = (options ?? {}) as BoolSelectFormOptions;
    const rows = parseRows(opts.compareSites);
    const sbbPairs = sbbSelectsOf(opts.decompile);
    return (ast: ASTNode) => {
      if (rows.length === 0 && sbbPairs.size === 0) return ast;
      const fns: FunctionDecl[] = [];
      if (ast.kind === NodeKind.FunctionDecl) fns.push(ast as FunctionDecl);
      walk(ast, (n) => { if (n.kind === NodeKind.FunctionDecl) fns.push(n as FunctionDecl); });
      for (const fn of fns) { rewriteFunction(fn, rows, sbbPairs, opts); hoistNegatedArgs(fn, rows, opts); }
      return ast;
    };
  },
};
