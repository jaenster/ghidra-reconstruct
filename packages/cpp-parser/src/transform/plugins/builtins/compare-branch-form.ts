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
 *    (0047f130), T the argument's cast type, else int. Where the original tested it before
 *    other calls ran (`ic` > 0), the local is set right after the statement of the block that
 *    last set C's operands (DRAW_WORLD_Unit 004dc7b0 tests IsMonsterGhostly's result before
 *    the next call); with no such statement the argument is left.
 *  - `L = C;`, L a field, a global or a store through a pointer: the original kept the 0 or 1
 *    in a register and stored it after the jump, `T t = 0; if (C) t = 1; L = t;`, T the cast
 *    of C, or bool for an uncast comparison (the decompiler casts any other store). A field
 *    of a local that `memset(&s, 0, ..)` just cleared, with no call between, takes the 1
 *    itself: `if (C) s.f = 1;` (NET_D2GS_CLIENT_Send_0x5D 00478740).
 *
 * The stored value before the jump follows the jump: an equality's JZ is taken when its
 * operands are equal, so where that is when the test holds (`a == b` read by JZ, `a != b`
 * by JNZ) the jump carries a preset 1 past an arm that stores 0, `x = 1; if (a != b) x = 0;`
 * (MAINMENU_DetectDoubleClick 00431a60, PLRTRADE_ValidateAndInitiateTrade 00567620). Every
 * row must say so, with a one-arm fall-through; otherwise the preset is 0.
 *
 * Where the local already holds 0 on every path into the store (walking back over
 * statements that do not write it, and out of an if arm into the statements before the if,
 * reaches a zero store with no label between), the zero store is not repeated: the original
 * jumps over the one store (AI_BAAL_ChooseCombatAction 005e9750).
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
 * An equality the original computed with SUB or DEC (`om`) is a case of a switch's
 * subtraction chain that the decompiler joined into a value (SUNITNPC_ResurrectMerc 00579c00:
 * `sub eax, 0x96; je; sub eax, 0x30; jmp; ...; je`): no source comparison, so no evidence.
 *
 * The comparison is tied to its rows by operator family (`==`/`!=` or ordered) and by every
 * identifier, field and literal operand's fingerprint (`v:<name>`, `f:<field>` for a member
 * read, from the newer rows' `f0`/`f1`, `c:<hex>`); a test with no identifier or field
 * operand is left alone. Only rows printed as a value (`pos` `v`) are considered, and all of
 * them must say `j` (and agree on the arm where it matters). Rows of an older script have no
 * `pos`, so without the new facts the pass does nothing.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, BoolLiteralExpr, BuiltinType, CallExpr, CharLiteralExpr, CompoundStmt, CStyleCastExpr, DeclStmt,
  ExprStmt, Expression, FunctionDecl, Identifier, IfStmt, IntegerLiteralExpr, MemberExpr, ParenExpr, ReturnStmt, Statement,
  TypedefType, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import type { Transformer } from '../../transformer.js';
import { cloneNode } from '../../transformer.js';
import { Decl, Expr, Stmt, Type } from '../../../ast/factory.js';

export interface CompareBranchFormOptions extends PluginOptions {
  /** The function's compare-sites rows (extract/compare-sites.ts), tab separated, one per line. */
  compareSites?: string;
  onSite?: (e: { kind: 'local' | 'store' | 'return' | 'arg-local' | 'arg-hoist' | 'arg-split'; text: string }) => void;
}

interface Row {
  op: string; fp: [string, string]; pos: string; use: string; arm: string; shared: boolean;
  /** The operand fingerprints and, from a newer script, `f:<field>` for an operand read from a field. */
  prints: Set<string>;
  /** The instruction at the op (`om`), empty from an older script. */
  om: string;
  /** CALLs between the op and the call taking its value (`ic`), null when not recorded. */
  ic: number | null;
  /** The conditional jump that reads the flags (`um`), `-` when none was tied. */
  um: string;
}

function parseRows(s: string | undefined): Row[] {
  if (!s) return [];
  const rows: (Row & { at: Set<string> })[] = [];
  for (const line of s.split('\n')) {
    const f = line.split('\t');
    if (f.length < 22 || f[2] === '-') continue;
    // The op's own instruction and its flags setter: a second row on either is the same compare.
    const at = new Set([f[8], f[11]].filter((a) => a && a !== '-'));
    const more = f.length >= 27;
    const prints = new Set([f[6], f[7]]);
    if (more) for (const x of [f[24], f[25]]) if (x && x !== '-') prints.add('f:' + x);
    rows.push({
      op: f[1], fp: [f[6], f[7]], pos: f[18], use: f[19], arm: f[20], at, shared: false, prints,
      om: more ? f[22] : '', ic: more && /^\d+$/.test(f[26]) ? Number(f[26]) : null, um: f[10],
    });
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

/**
 * An operand's fingerprint as the rows print it: `v:<name>`, `c:<hex>` (a non-negative
 * literal), `f:<field>` for a member read (`p->a.b` gives `b`), else null.
 */
function operandPrint(e: Expression): string | null {
  const u = unwrap(e);
  if (u.kind === NodeKind.Identifier) return 'v:' + (u as Identifier).name;
  if (u.kind === NodeKind.IntegerLiteral) return 'c:' + (u as IntegerLiteralExpr).value.toString(16);
  if (u.kind === NodeKind.MemberExpr && (u as MemberExpr).member.kind === NodeKind.Identifier) return 'f:' + ((u as MemberExpr).member as Identifier).name;
  return null;
}

/**
 * The test a value-position expression is: a comparison or `!e`, its family, operand
 * fingerprints, and whether it holds when its operands are equal (`==`, `!e`).
 */
function testOf(e: Expression): { eq: boolean; equal: boolean; prints: string[] } | null {
  const u = unwrap(e);
  const prints = (xs: Expression[]) => xs.map(operandPrint).filter((x): x is string => x !== null);
  if (u.kind === NodeKind.BinaryExpr && CMP.has((u as BinaryExpr).operator)) {
    const b = u as BinaryExpr;
    return { eq: EQ.has(b.operator), equal: b.operator === '==', prints: prints([b.left, b.right]) };
  }
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') return { eq: true, equal: true, prints: [...prints([(u as UnaryExpr).operand]), 'c:0'] };
  return null;
}

/** A switch's case test: VC8 subtracts the case values off one register and jumps on zero. */
const SWITCH_STEP = new Set(['SUB', 'DEC', 'ADD', 'INC']);

/**
 * The arm (`t`, `d`, `r`, `-`) every value-position row of this test agrees is a branch,
 * and the most CALLs any of them saw between the op and the call taking the value; else
 * null. A row fits when its family matches and it holds every identifier, field and
 * literal operand of the test; a test with no identifier or field operand is not tied. An
 * equality the original computed with a subtraction is a case of a switch, which the
 * decompiler joined into a value: no source comparison, so no evidence.
 */
function branchArmOf(rows: Row[], e: Expression): { arm: string; ic: number; preset: 0 | 1 } | null {
  const t = testOf(e);
  if (!t || !t.prints.some((p) => p.startsWith('v:') || p.startsWith('f:'))) return null;
  const fit = rows.filter((r) => r.pos === 'v' && EQ.has(r.op) === t.eq && t.prints.every((p) => r.prints.has(p)));
  if (fit.length === 0 || !fit.every((r) => r.use === 'j' && !r.shared && !(EQ.has(r.op) && SWITCH_STEP.has(r.om)))) return null;
  const ic = Math.max(...fit.map((r) => r.ic ?? 0));
  // Which value the jump carries past the arm. An equality's JZ is taken when the operands are
  // equal: when that is when the test holds, the arm stores the other value and the jump keeps
  // a preset 1 (`x = 1; if (!(a == b)) x = 0;`, MAINMENU_DetectDoubleClick 00431a60).
  const holds = (r: Row): boolean | null => {
    if (r.arm !== 't' || !EQ.has(r.op)) return null;
    const onEqual = r.um === 'JZ' || r.um === 'JE' ? true : r.um === 'JNZ' || r.um === 'JNE' ? false : null;
    return onEqual === null ? null : onEqual === t.equal;
  };
  const preset = fit.every((r) => holds(r) === true) ? 1 : 0;
  return { arm: fit.every((r) => r.arm === fit[0].arm) ? fit[0].arm : '-', ic, preset };
}

/** `!c`, written as the opposite comparison where there is one. */
function negate(c: Expression): Expression {
  const u = unwrap(c);
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') return (u as UnaryExpr).operand;
  if (u.kind === NodeKind.BinaryExpr && EQ.has((u as BinaryExpr).operator)) {
    const b = u as BinaryExpr;
    return Expr.binary(b.left, b.operator === '==' ? '!=' : '==', b.right);
  }
  return Expr.unary('!', Expr.paren(u));
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

  /** The value stored before the jump: 0, or 1 where the jump is taken when the test holds. */
  private preset(cond: Expression): 0 | 1 {
    return branchArmOf(this.rows, cond)?.preset ?? 0;
  }

  /** `if (C) x = 1;` after a 0, `if (!C) x = 0;` after a 1: the arm the jump skips. */
  private oneArm(x: string, kind: 'bool' | 'int', cond: Expression): Statement {
    return this.preset(cond) === 1
      ? Stmt.if_(negate(cond), Stmt.expr(Expr.assign(Expr.identifier(x), lit(kind, 0))))
      : Stmt.if_(unwrap(cond), Stmt.expr(Expr.assign(Expr.identifier(x), lit(kind, 1))));
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

  /** Each block's enclosing statement, its block and index there: the walk back for a held zero. */
  private parents = new Map<CompoundStmt, { owner: Statement; block: CompoundStmt; index: number }>();

  private collectParents(blk: CompoundStmt): void {
    blk.statements.forEach((s, index) => {
      const visit = (n: unknown): void => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { for (const c of n) visit(c); return; }
        const node = n as ASTNode;
        if (node.kind === NodeKind.CompoundStmt) {
          this.parents.set(node as CompoundStmt, { owner: s, block: blk, index });
          this.collectParents(node as CompoundStmt);
          return;
        }
        for (const key of Object.keys(node)) {
          if (key === 'location' || key === 'leadingTrivia' || key === 'trailingTrivia' || key === 'parent') continue;
          visit((node as unknown as Record<string, unknown>)[key]);
        }
      };
      for (const key of Object.keys(s)) {
        if (key === 'location' || key === 'leadingTrivia' || key === 'trailingTrivia' || key === 'parent') continue;
        visit((s as unknown as Record<string, unknown>)[key]);
      }
    });
  }

  /**
   * Whether `x` holds zero on every path into statement `i` of `blk`: walking back over
   * statements that do not write it (and are no labels, where other paths join) reaches a
   * store of a zero literal, crossing out of an if arm into the statements before the if.
   * The original then has no zero store of its own before the jump (AI_BAAL 005e9750).
   */
  private zeroHeld(blk: CompoundStmt, i: number, x: string): boolean {
    const zero = (e: Expression | null | undefined): boolean => {
      if (!e) return false;
      const u = unwrap(e);
      return (u.kind === NodeKind.IntegerLiteral && (u as IntegerLiteralExpr).value === 0n)
        || (u.kind === NodeKind.BoolLiteral && !(u as BoolLiteralExpr).value)
        || (u.kind === NodeKind.CharLiteral && (u as CharLiteralExpr).value === 0);
    };
    const storesZero = (s: Statement): boolean => {
      if (s.kind === NodeKind.ExprStmt) {
        const e = unwrap((s as ExprStmt).expression);
        if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return false;
        const l = unwrap((e as AssignExpr).left);
        return l.kind === NodeKind.Identifier && (l as Identifier).name === x && zero((e as AssignExpr).right);
      }
      if (s.kind === NodeKind.DeclStmt) {
        return (s as DeclStmt).declarations.some((d) => d.kind === NodeKind.VariableDecl && (d as VariableDecl).name.name === x
          && zero((d as VariableDecl).initializer as Expression | null));
      }
      return false;
    };
    const touches = (n: ASTNode): boolean => {
      let hit = false;
      walk(n, (m) => {
        if (m.kind === NodeKind.AssignExpr) { const l = unwrap((m as AssignExpr).left); if (l.kind === NodeKind.Identifier && (l as Identifier).name === x) hit = true; }
        if ((m.kind === NodeKind.UnaryExpr && ['++', '--'].includes((m as UnaryExpr).operator)) || m.kind === NodeKind.PostfixExpr) {
          if (reads(m, x)) hit = true;
        }
        if (m.kind === NodeKind.VariableDecl && (m as VariableDecl).name.name === x) hit = true;
        if (m.kind === NodeKind.LabelStmt || m.kind === NodeKind.CaseStmt || m.kind === NodeKind.DefaultStmt) hit = true;
      });
      return hit;
    };
    let b = blk, k = i;
    for (let depth = 0; depth < 8; depth++) {
      for (let j = k - 1; j >= 0; j--) {
        let s = b.statements[j];
        if (s.kind === NodeKind.LabelStmt || s.kind === NodeKind.CaseStmt || s.kind === NodeKind.DefaultStmt) {
          // Paths join at the label, after which its own statement runs.
          while (s.kind === NodeKind.LabelStmt || s.kind === NodeKind.CaseStmt || s.kind === NodeKind.DefaultStmt) s = (s as unknown as { statement: Statement }).statement;
          return storesZero(s);
        }
        if (storesZero(s)) return true;
        if (touches(s)) return false;
      }
      const up = this.parents.get(b);
      if (!up || up.owner.kind !== NodeKind.IfStmt) return false;
      const ifs = up.owner as IfStmt;
      if (ifs.thenBranch !== b && ifs.elseBranch !== b) return false;
      if (touches(ifs.condition)) return false;
      b = up.block; k = up.index;
    }
    return false;
  }

  /**
   * Whether the field `l` (`r.a.b`, `r` a local) was just cleared: walking back over
   * statements that neither call nor name `r` reaches `memset(&r, 0, ...)`.
   */
  private memberZeroHeld(blk: CompoundStmt, i: number, l: Expression): boolean {
    let root = unwrap(l);
    if (root.kind !== NodeKind.MemberExpr) return false;
    while (root.kind === NodeKind.MemberExpr && !(root as MemberExpr).isArrow) root = unwrap((root as MemberExpr).object);
    if (root.kind !== NodeKind.Identifier || !this.declared.has((root as Identifier).name)) return false;
    const r = (root as Identifier).name;
    for (let j = i - 1; j >= 0; j--) {
      const s = blk.statements[j];
      if (s.kind === NodeKind.ExprStmt) {
        const c = unwrap((s as ExprStmt).expression);
        if (c.kind === NodeKind.CallExpr) {
          const call = c as CallExpr;
          const callee = unwrap(call.callee);
          const a0 = call.arguments[0] ? unwrap(call.arguments[0]) : null;
          const a1 = call.arguments[1] ? unwrap(call.arguments[1]) : null;
          if (callee.kind === NodeKind.Identifier && (callee as Identifier).name === 'memset' && a0 && a1
            && a0.kind === NodeKind.UnaryExpr && (a0 as UnaryExpr).operator === '&'
            && unwrap((a0 as UnaryExpr).operand).kind === NodeKind.Identifier && (unwrap((a0 as UnaryExpr).operand) as Identifier).name === r
            && a1.kind === NodeKind.IntegerLiteral && (a1 as IntegerLiteralExpr).value === 0n) return true;
        }
      }
      if (s.kind === NodeKind.LabelStmt || s.kind === NodeKind.CaseStmt || s.kind === NodeKind.DefaultStmt) return false;
      let touched = false;
      walk(s, (m) => { if (m.kind === NodeKind.CallExpr || (m.kind === NodeKind.Identifier && (m as Identifier).name === r)) touched = true; });
      if (touched) return false;
    }
    return false;
  }

  run(): void {
    this.collectJoined();
    if (this.fn.body) this.collectParents(this.fn.body);
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
        const r = this.statement(st, holder ? null : { blk, i });
        if (!r) continue;
        const out = r.out;
        if (holder) holder.statement = out[0];
        blk.statements.splice(i, 1, ...(holder ? [blk.statements[i], ...out.slice(1)] : out));
        if (r.hoist) {
          // The test goes after the statement that set its operand, where the original read it.
          blk.statements.splice(r.hoist.after + 1, 0, ...r.hoist.stmts);
          i += r.hoist.stmts.length;
        }
        i += out.length - 1;
      }
    }
    for (const { holder, key } of arms) {
      const r = this.statement(holder[key] as Statement, null);
      if (r) holder[key] = Stmt.block(r.out);
    }
  }

  private statement(st: Statement, at: { blk: CompoundStmt; i: number } | null): { out: Statement[]; hoist?: { after: number; stmts: Statement[] } } | null {
    const wrap = (out: Statement[] | null) => (out ? { out } : null);
    if (st.kind === NodeKind.ExprStmt) {
      const e = unwrap((st as ExprStmt).expression);
      if (e.kind === NodeKind.AssignExpr && (e as AssignExpr).operator === '=') {
        const a = e as AssignExpr;
        const l = unwrap(a.left);
        if (l.kind === NodeKind.Identifier && this.declared.has((l as Identifier).name)) {
          const x = (l as Identifier).name;
          const kind = scalarKind(this.types.get(x));
          if (kind && !this.addressed.has(x) && testOf(a.right) && this.joined.has(x)) {
            this.opts.onSite?.({ kind: 'local', text: x });
            const pre = this.preset(a.right);
            const arm = this.oneArm(x, kind, a.right);
            if (pre === 0 && at && this.zeroHeld(at.blk, at.i, x)) return { out: [arm] };
            return { out: [Stmt.expr(Expr.assign(Expr.identifier(x), lit(kind, pre))), arm] };
          }
        } else if (testOf(a.right) && !writes(a.left) && !writes(a.right)) {
          // A field, a global or a store through a pointer: the original kept the 0 or 1 in a
          // register and stored it after the jump, so the value goes through a local.
          if (branchArmOf(this.rows, a.right) === null) return null;
          const cast = a.right.kind === NodeKind.CStyleCastExpr ? (a.right as CStyleCastExpr).type : undefined;
          // An uncast comparison stored as it is is a bool store: the decompiler casts any other.
          const kind = cast ? scalarKind(cast) : 'bool';
          if (!kind) return null;
          const pre = this.preset(a.right);
          if (pre === 0 && at && this.memberZeroHeld(at.blk, at.i, a.left)) {
            // A field of a local the code just cleared: the arm stores the 1 itself (Send_0x5D 00478740).
            this.opts.onSite?.({ kind: 'store', text: 'cleared' });
            return { out: [Stmt.if_(unwrap(a.right), Stmt.expr(Expr.assign(a.left, lit(kind, 1))))] };
          }
          const name = this.fresh(kind === 'bool' ? 'bTest' : 'nTest');
          this.opts.onSite?.({ kind: 'store', text: name });
          return {
            out: [
              Stmt.declStmt([Decl.variable(name, cast ? cloneNode(cast) : Type.bool(), lit(kind, pre))]),
              this.oneArm(name, kind, a.right),
              Stmt.expr(Expr.assign(a.left, Expr.identifier(name))),
            ],
          };
        }
        if (unwrap(a.right).kind === NodeKind.CallExpr && (l.kind === NodeKind.Identifier) && !writes(a.left)) {
          return this.callArgs(st, unwrap(a.right) as CallExpr, false, at);
        }
        return null;
      }
      if (e.kind === NodeKind.CallExpr) return this.callArgs(st, e as CallExpr, true, at);
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
        v.initializer = lit(kind, this.preset(init));
        return { out: [st, this.oneArm(x, kind, init)] };
      }
      if (unwrap(init).kind === NodeKind.CallExpr) return this.callArgs(st, unwrap(init) as CallExpr, false, at);
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
      return wrap([
        Stmt.declStmt([Decl.variable(name, cloneNode(this.fn.returnType), lit(kind, this.preset(cond)))]),
        this.oneArm(name, kind, cond),
        r,
      ]);
    }
    return null;
  }

  /**
   * Where a call argument's test goes when the original read it before other calls ran
   * (`ic` > 0): after the statement of this block that last set one of its operands, when
   * every operand is a local whose address is not taken and nothing between writes one.
   * -1 when there is no such statement.
   */
  private hoistPoint(at: { blk: CompoundStmt; i: number }, cond: Expression): number {
    const names: string[] = [];
    let ok = true;
    // The operands' names; a cast's type is not evaluated.
    const visit = (n: unknown): void => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(visit); return; }
      const node = n as ASTNode;
      if (String(node.kind).endsWith('Type')) return;
      if (node.kind === NodeKind.Identifier) {
        const x = (node as Identifier).name;
        if (!this.declared.has(x) || this.addressed.has(x)) ok = false;
        names.push(x);
      }
      if (node.kind === NodeKind.MemberExpr || node.kind === NodeKind.CallExpr || (node.kind === NodeKind.UnaryExpr && (node as UnaryExpr).operator === '*')) ok = false;
      for (const key of Object.keys(node)) {
        if (key === 'location' || key === 'leadingTrivia' || key === 'trailingTrivia' || key === 'parent') continue;
        visit((node as unknown as Record<string, unknown>)[key]);
      }
    };
    visit(cond);
    if (!ok || names.length === 0) return -1;
    const sets = (s: Statement): boolean => {
      let hit = false;
      walk(s, (m) => {
        if (m.kind === NodeKind.AssignExpr) { const l = unwrap((m as AssignExpr).left); if (l.kind === NodeKind.Identifier && names.includes((l as Identifier).name)) hit = true; }
        if (m.kind === NodeKind.VariableDecl && names.includes((m as VariableDecl).name.name)) hit = true;
        if (((m.kind === NodeKind.UnaryExpr && ['++', '--'].includes((m as UnaryExpr).operator)) || m.kind === NodeKind.PostfixExpr) && names.some((x) => reads(m, x))) hit = true;
      });
      return hit;
    };
    for (let j = at.i - 1; j >= 0; j--) {
      const s = at.blk.statements[j];
      if (s.kind === NodeKind.LabelStmt || s.kind === NodeKind.CaseStmt || s.kind === NodeKind.DefaultStmt) return -1;
      if (sets(s)) {
        // Only a plain store of the operand: a branch or loop that sets it has no single point.
        const plain = s.kind === NodeKind.DeclStmt || (s.kind === NodeKind.ExprStmt && unwrap((s as ExprStmt).expression).kind === NodeKind.AssignExpr);
        return plain && j < at.i - 1 ? j : -1;
      }
      if (s.kind !== NodeKind.ExprStmt && s.kind !== NodeKind.DeclStmt) return -1;
    }
    return -1;
  }

  /** A call's value-position test arguments, written as a local set before the statement or as a split call. */
  private callArgs(st: Statement, call: CallExpr, bare: boolean, at: { blk: CompoundStmt; i: number } | null): { out: Statement[]; hoist?: { after: number; stmts: Statement[] } } | null {
    if (writes(call.callee)) return null;
    for (let j = 0; j < call.arguments.length; j++) {
      const arg = call.arguments[j];
      if (!testOf(arg) || writes(arg)) continue;
      if (call.arguments.some((o, k) => k !== j && writes(o))) continue;
      const tie = branchArmOf(this.rows, arg);
      if (tie === null) continue;
      if (tie.arm === 'd') {
        if (!bare || call.arguments.length === 0 || tie.ic > 0) continue;
        const one = cloneNode(call), zero = cloneNode(call);
        one.arguments[j] = Expr.intLiteral(1);
        zero.arguments[j] = Expr.intLiteral(0);
        this.opts.onSite?.({ kind: 'arg-split', text: '' });
        return { out: [Stmt.if_(unwrap(arg), Stmt.expr(one), Stmt.expr(zero))] };
      }
      const cast = arg.kind === NodeKind.CStyleCastExpr ? (arg as CStyleCastExpr).type : undefined;
      const kind = scalarKind(cast) ?? (cast ? null : 'int');
      if (!kind) continue;
      const after = tie.ic > 0 && at ? this.hoistPoint(at, arg) : -1;
      if (tie.ic > 0 && after < 0) continue;
      const type = cast ? cloneNode(cast) : Type.int();
      const name = this.fresh(kind === 'bool' ? 'bTest' : 'nTest');
      this.opts.onSite?.({ kind: after >= 0 ? 'arg-hoist' : 'arg-local', text: name });
      call.arguments[j] = Expr.identifier(name);
      const set = [Stmt.declStmt([Decl.variable(name, type, lit(kind, tie.preset))]), this.oneArm(name, kind, arg)];
      return after >= 0 ? { out: [st], hoist: { after, stmts: set } } : { out: [...set, st] };
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
