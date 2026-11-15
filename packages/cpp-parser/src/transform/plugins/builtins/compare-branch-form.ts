/**
 * Compare Branch Form Plugin
 *
 * The decompiler prints a comparison as a value (`b = n == 0x13;`, `return n < 7;`,
 * `f(!p)`) both when the original materialised it (SETcc, SBB) and when it branched on it
 * and moved 0 and 1 into a register around the jump. VC8 compiles each source spelling one
 * way only:
 *
 *   source                                   VC8
 *   b = n == 5;          return n == 5;      xor eax, eax; cmp; sete al
 *   if (n == 5) return 1; return 0;          the same: both arms are constants, if-converted
 *   b = 0; if (n == 5) b = 1;                xor eax, eax; cmp; jne L; mov eax, 1; L:
 *   if (n == 5) f(1); else f(0);             cmp; jne L; push 1; jmp M; L: push 0; M: call
 *
 * so only the last two spellings give the branch. extract/compare-sites.ts records
 * per comparison where the decompiler put it (`pos`: `v` a value, `b` a branch condition)
 * and how the compiled code reads its flags (`use`: `j` a conditional jump, `s`/`c` a
 * SETcc or SBB/ADC), with the jump's fall-through shape (`arm`: `t` falls into the target,
 * `d` leaves by JMP). A value-position comparison whose fact rows all say `v`/`j` is
 * written in the branch form:
 *
 *  - `x = C;` and `T x = C;`, x a local whose address is not taken and which C does not
 *    read: `x = 0; if (C) x = 1;` (`false`/`true` for a bool). UNITMODE_ShowElementalHitOverlay
 *    00480d20 (the jump threads into the later `if (!bIsHitMode)`), FPS counter 0044cca0.
 *  - `return C;` in a function returning an integer or bool: `T r = 0; if (C) r = 1;
 *    return r;`.
 *  - a call argument C of a statement `f(..);`, `x = f(..);` or `T x = f(..);` whose other
 *    arguments read no call, assignment or increment: with `arm` `d`, the call is split,
 *    `if (C) f(..1..); else f(..0..);` (statement `f(..);` only, 004e9940); otherwise the
 *    argument is a local set before the statement, `T b = 0; if (C) b = 1; f(.., b, ..);`
 *    (0047f130), T the argument's cast type, else int.
 *
 * Every rewrite keeps the value: C is evaluated once, where it was (the statement's other
 * operands read nothing C could write), and the variable ends 0 or 1 exactly as C.
 *
 * A local the decompiler joined from several arms (`if (a) b = x == 1; else b = x == 2;`)
 * is rewritten in every arm or in none: the original shares one jump between the arms, and a
 * SETcc left in one arm keeps the value materialised.
 *
 * A row whose instruction or flags setter carries a second printed comparison is no
 * evidence: the decompiler split one CMP and its readers into two tests (zlib's `used >
 * ENOUGH` printed as `used < 0x354` and `used == 0x354` beside one JA; a JBE and the SBB of
 * an `a > b` return after one CMP), which one-arm stores cannot rebuild.
 *
 * The comparison is tied to its rows by operator family (`==`/`!=` or ordered) and by every
 * identifier and literal operand's fingerprint (`v:<name>`, `c:<hex>`); a test with no
 * identifier operand is left alone. Only rows printed as a value (`pos` `v`) are
 * considered, and all of them must say `j` (and agree on the arm where it matters). Rows of
 * an older script have no `pos`, so without the new facts the pass does nothing.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, BuiltinType, CallExpr, CompoundStmt, CStyleCastExpr, DeclStmt, ExprStmt,
  Expression, FunctionDecl, Identifier, IntegerLiteralExpr, ParenExpr, ReturnStmt, Statement, TypedefType, TypeNode,
  UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import type { Transformer } from '../../transformer.js';
import { cloneNode } from '../../transformer.js';
import { Decl, Expr, Stmt, Type } from '../../../ast/factory.js';

export interface CompareBranchFormOptions extends PluginOptions {
  /** The function's compare-sites rows (extract/compare-sites.ts), tab separated, one per line. */
  compareSites?: string;
  onSite?: (e: { kind: 'local' | 'return' | 'arg-local' | 'arg-split'; text: string }) => void;
}

interface Row { op: string; fp: [string, string]; pos: string; use: string; arm: string; shared: boolean }

function parseRows(s: string | undefined): Row[] {
  if (!s) return [];
  const rows: (Row & { at: Set<string> })[] = [];
  for (const line of s.split('\n')) {
    const f = line.split('\t');
    if (f.length < 22 || f[2] === '-') continue;
    // The op's own instruction and its flags setter: a second row on either is the same compare.
    const at = new Set([f[8], f[11]].filter((a) => a && a !== '-'));
    rows.push({ op: f[1], fp: [f[6], f[7]], pos: f[18], use: f[19], arm: f[20], at, shared: false });
  }
  const count = new Map<string, number>();
  for (const r of rows) for (const a of r.at) count.set(a, (count.get(a) ?? 0) + 1);
  for (const r of rows) r.shared = [...r.at].some((a) => (count.get(a) ?? 0) > 1);
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

/** An operand's fingerprint as the rows print it: `v:<name>`, `c:<hex>` (a non-negative literal), else null. */
function operandPrint(e: Expression): string | null {
  const u = unwrap(e);
  if (u.kind === NodeKind.Identifier) return 'v:' + (u as Identifier).name;
  if (u.kind === NodeKind.IntegerLiteral) return 'c:' + (u as IntegerLiteralExpr).value.toString(16);
  return null;
}

/** The test a value-position expression is: a comparison or `!e`, its family and operand fingerprints. */
function testOf(e: Expression): { eq: boolean; prints: string[] } | null {
  const u = unwrap(e);
  const prints = (xs: Expression[]) => xs.map(operandPrint).filter((x): x is string => x !== null);
  if (u.kind === NodeKind.BinaryExpr && CMP.has((u as BinaryExpr).operator)) {
    const b = u as BinaryExpr;
    return { eq: EQ.has(b.operator), prints: prints([b.left, b.right]) };
  }
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') return { eq: true, prints: [...prints([(u as UnaryExpr).operand]), 'c:0'] };
  return null;
}

/**
 * The arm (`t`, `d`, `r`, `-`) every value-position row of this test agrees is a branch,
 * else null. A row fits when its family matches and it holds every identifier and literal
 * operand of the test; a test with no identifier operand is not tied.
 */
function branchArmOf(rows: Row[], e: Expression): string | null {
  const t = testOf(e);
  if (!t || !t.prints.some((p) => p.startsWith('v:'))) return null;
  const fit = rows.filter((r) => r.pos === 'v' && EQ.has(r.op) === t.eq && t.prints.every((p) => r.fp[0] === p || r.fp[1] === p));
  if (fit.length === 0 || !fit.every((r) => r.use === 'j' && !r.shared)) return null;
  return fit.every((r) => r.arm === fit[0].arm) ? fit[0].arm : '-';
}

function walk(node: unknown, visit: (n: ASTNode) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const c of node) walk(c, visit); return; }
  if ((node as ASTNode).kind !== undefined) visit(node as ASTNode);
  for (const key of Object.keys(node as object)) {
    if (key === 'location' || key === 'leadingTrivia' || key === 'trailingTrivia' || key === 'parent') continue;
    const c = (node as Record<string, unknown>)[key];
    if (c && typeof c === 'object') walk(c, visit);
  }
}

/** Whether `e` reads identifier `x`. */
function reads(e: ASTNode, x: string): boolean {
  let hit = false;
  walk(e, (n) => { if (n.kind === NodeKind.Identifier && (n as Identifier).name === x) hit = true; });
  return hit;
}

/** Whether `e` can write anything: a call, an assignment, an increment or decrement. */
function writes(e: ASTNode): boolean {
  let hit = false;
  walk(e, (n) => {
    if (n.kind === NodeKind.CallExpr || n.kind === NodeKind.AssignExpr || n.kind === NodeKind.PostfixExpr) hit = true;
    if (n.kind === NodeKind.UnaryExpr && ['++', '--'].includes((n as UnaryExpr).operator)) hit = true;
  });
  return hit;
}

const INTEGER = new Set(['bool', 'char', 'short', 'int', 'long', 'long long', '__int64']);
const INTEGER_TYPEDEF = /^(?:BOOL|BOOLEAN|BYTE|WORD|DWORD|UINT|INT|LONG|ULONG|SHORT|USHORT|CHAR|UCHAR|u?int(?:8|16|32)_t|size_t)$/;

/** An integer or bool type a 0/1 select fits; its bool-ness for the literals. */
function scalarKind(t: TypeNode | undefined | null): 'bool' | 'int' | null {
  if (!t) return null;
  if (t.kind === NodeKind.BuiltinType) {
    const n = (t as BuiltinType).name;
    if (n === 'bool') return 'bool';
    return INTEGER.has(n) ? 'int' : null;
  }
  if (t.kind === NodeKind.TypedefType) {
    const n = (t as TypedefType).name;
    return n.kind === NodeKind.Identifier && INTEGER_TYPEDEF.test(n.name) ? 'int' : null;
  }
  return null;
}

const lit = (kind: 'bool' | 'int', v: 0 | 1): Expression => (kind === 'bool' ? Expr.boolLiteral(v === 1) : Expr.intLiteral(v));

class Rewriter {
  private declared = new Set<string>();
  private addressed = new Set<string>();
  private types = new Map<string, TypeNode>();
  private used = new Set<string>();

  constructor(private fn: FunctionDecl, private rows: Row[], private opts: CompareBranchFormOptions) {
    for (const p of fn.parameters) {
      const n = (p as unknown as { name?: Identifier | null; type?: TypeNode }).name;
      if (n) { this.declared.add(n.name); this.types.set(n.name, (p as unknown as { type: TypeNode }).type); }
    }
    walk(fn.body, (n) => {
      if (n.kind === NodeKind.VariableDecl) {
        const v = n as VariableDecl;
        this.declared.add(v.name.name);
        this.types.set(v.name.name, v.type);
      }
      if (n.kind === NodeKind.Identifier) this.used.add((n as Identifier).name);
      if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
        const o = unwrap((n as UnaryExpr).operand);
        if (o.kind === NodeKind.Identifier) this.addressed.add((o as Identifier).name);
      }
    });
  }

  private fresh(base: string): string {
    let name = base;
    while (this.used.has(name) || this.declared.has(name)) name += '_';
    this.used.add(name); this.declared.add(name);
    return name;
  }

  /** `if (C) x = 1;`: the arm after the zero store. */
  private oneArm(x: string, kind: 'bool' | 'int', cond: Expression): Statement {
    return Stmt.if_(unwrap(cond), Stmt.expr(Expr.assign(Expr.identifier(x), lit(kind, 1))));
  }

  /**
   * Locals every one of whose test stores (`x = C;`, `T x = C;`) is a branch by the rows.
   * The decompiler prints a join of branched tests as one store per arm; rewriting only
   * some arms leaves a SETcc beside the jump the original shares between them.
   */
  private joined = new Set<string>();

  private collectJoined(): void {
    const ok = new Map<string, boolean>();
    const note = (x: string, value: Expression) => {
      if (!testOf(value)) return;
      const good = !reads(value, x) && !writes(value) && branchArmOf(this.rows, value) !== null;
      ok.set(x, (ok.get(x) ?? true) && good);
    };
    walk(this.fn.body, (n) => {
      if (n.kind === NodeKind.AssignExpr && (n as AssignExpr).operator === '=') {
        const l = unwrap((n as AssignExpr).left);
        if (l.kind === NodeKind.Identifier) note((l as Identifier).name, (n as AssignExpr).right);
      }
      if (n.kind === NodeKind.VariableDecl && (n as VariableDecl).initializer) note((n as VariableDecl).name.name, (n as VariableDecl).initializer as Expression);
    });
    for (const [x, good] of ok) if (good) this.joined.add(x);
  }

  run(): void {
    this.collectJoined();
    const blocks: CompoundStmt[] = [];
    const arms: { holder: Record<string, unknown>; key: string }[] = [];
    walk(this.fn.body, (n) => {
      if (n.kind === NodeKind.CompoundStmt) blocks.push(n as CompoundStmt);
      // A lone statement as an if arm or a loop body becomes a block if it is rewritten.
      for (const key of ['thenBranch', 'elseBranch', 'body']) {
        const c = (n as unknown as Record<string, ASTNode | null>)[key];
        if (n.kind !== NodeKind.FunctionDecl && c && typeof c === 'object' && c.kind !== undefined && c.kind !== NodeKind.CompoundStmt) {
          arms.push({ holder: n as unknown as Record<string, unknown>, key });
        }
      }
    });
    for (const blk of blocks) {
      for (let i = 0; i < blk.statements.length; i++) {
        // A case or label labels the first statement; the rest follow it in the block.
        let holder: { statement: Statement } | null = null;
        let st = blk.statements[i];
        while (st.kind === NodeKind.CaseStmt || st.kind === NodeKind.DefaultStmt || st.kind === NodeKind.LabelStmt) {
          holder = st as unknown as { statement: Statement };
          st = holder.statement;
        }
        const out = this.statement(st);
        if (!out) continue;
        if (holder) holder.statement = out[0];
        blk.statements.splice(i, 1, ...(holder ? [blk.statements[i], ...out.slice(1)] : out));
        i += out.length - 1;
      }
    }
    for (const { holder, key } of arms) {
      const out = this.statement(holder[key] as Statement);
      if (out) holder[key] = Stmt.block(out);
    }
  }

  private statement(st: Statement): Statement[] | null {
    if (st.kind === NodeKind.ExprStmt) {
      const e = unwrap((st as ExprStmt).expression);
      if (e.kind === NodeKind.AssignExpr && (e as AssignExpr).operator === '=') {
        const a = e as AssignExpr;
        const l = unwrap(a.left);
        if (l.kind === NodeKind.Identifier) {
          const x = (l as Identifier).name;
          const kind = scalarKind(this.types.get(x));
          if (kind && this.declared.has(x) && !this.addressed.has(x) && testOf(a.right) && this.joined.has(x)) {
            this.opts.onSite?.({ kind: 'local', text: x });
            return [Stmt.expr(Expr.assign(Expr.identifier(x), lit(kind, 0))), this.oneArm(x, kind, a.right)];
          }
        }
        if (unwrap(a.right).kind === NodeKind.CallExpr && (l.kind === NodeKind.Identifier) && !writes(a.left)) {
          return this.callArgs(st, unwrap(a.right) as CallExpr, false);
        }
        return null;
      }
      if (e.kind === NodeKind.CallExpr) return this.callArgs(st, e as CallExpr, true);
      return null;
    }
    if (st.kind === NodeKind.DeclStmt) {
      const d = st as DeclStmt;
      if (d.declarations.length !== 1 || d.declarations[0].kind !== NodeKind.VariableDecl) return null;
      const v = d.declarations[0] as VariableDecl;
      const init = v.initializer as Expression | null;
      if (!init || v.specifiers.length > 0 || v.directInit || v.copyListInit) return null;
      const x = v.name.name;
      const kind = scalarKind(v.type);
      if (kind && !this.addressed.has(x) && testOf(init) && this.joined.has(x)) {
        this.opts.onSite?.({ kind: 'local', text: x });
        v.initializer = lit(kind, 0);
        return [st, this.oneArm(x, kind, init)];
      }
      if (unwrap(init).kind === NodeKind.CallExpr) return this.callArgs(st, unwrap(init) as CallExpr, false);
      return null;
    }
    if (st.kind === NodeKind.ReturnStmt) {
      const r = st as ReturnStmt;
      if (!r.value) return null;
      const kind = scalarKind(this.fn.returnType);
      if (!kind || !testOf(r.value) || writes(r.value) || branchArmOf(this.rows, r.value) === null) return null;
      const name = this.fresh(kind === 'bool' ? 'bResult' : 'nResult');
      this.opts.onSite?.({ kind: 'return', text: name });
      const cond = r.value;
      r.value = Expr.identifier(name);
      return [
        Stmt.declStmt([Decl.variable(name, cloneNode(this.fn.returnType), lit(kind, 0))]),
        this.oneArm(name, kind, cond),
        r,
      ];
    }
    return null;
  }

  /** A call's value-position test arguments, written as a local set before the statement or as a split call. */
  private callArgs(st: Statement, call: CallExpr, bare: boolean): Statement[] | null {
    if (writes(call.callee)) return null;
    for (let j = 0; j < call.arguments.length; j++) {
      const arg = call.arguments[j];
      if (!testOf(arg) || writes(arg)) continue;
      if (call.arguments.some((o, k) => k !== j && writes(o))) continue;
      const arm = branchArmOf(this.rows, arg);
      if (arm === null) continue;
      if (arm === 'd') {
        if (!bare || call.arguments.length === 0) continue;
        const one = cloneNode(call), zero = cloneNode(call);
        one.arguments[j] = Expr.intLiteral(1);
        zero.arguments[j] = Expr.intLiteral(0);
        this.opts.onSite?.({ kind: 'arg-split', text: '' });
        return [Stmt.if_(unwrap(arg), Stmt.expr(one), Stmt.expr(zero))];
      }
      const cast = arg.kind === NodeKind.CStyleCastExpr ? (arg as CStyleCastExpr).type : undefined;
      const kind = scalarKind(cast) ?? (cast ? null : 'int');
      if (!kind) continue;
      const type = cast ? cloneNode(cast) : Type.int();
      const name = this.fresh(kind === 'bool' ? 'bTest' : 'nTest');
      this.opts.onSite?.({ kind: 'arg-local', text: name });
      call.arguments[j] = Expr.identifier(name);
      return [Stmt.declStmt([Decl.variable(name, type, lit(kind, 0))]), this.oneArm(name, kind, arg), st];
    }
    return null;
  }
}

export const compareBranchFormPlugin: TransformPlugin = {
  id: 'compare-branch-form',
  name: 'Compare Branch Form',
  description: 'Writes a value-position comparison the original branched on as a zeroed local set in one arm, from the compare sites',
  version: '0.1.0',
  defaultEnabled: true,
  priority: 989.991,
  tags: ['codegen', 'vc8'],
  createTransformer(options?: PluginOptions): Transformer {
    const opts = (options ?? {}) as CompareBranchFormOptions;
    const rows = parseRows(opts.compareSites);
    return (ast: ASTNode) => {
      if (!rows.some((r) => r.pos === 'v' && r.use === 'j')) return ast;
      const fns: FunctionDecl[] = [];
      walk(ast, (n) => { if (n.kind === NodeKind.FunctionDecl) fns.push(n as FunctionDecl); });
      for (const fn of fns) if (fn.body) new Rewriter(fn, rows, opts).run();
      return ast;
    };
  },
};
