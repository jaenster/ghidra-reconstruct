/**
 * Seed Roll Limited Plugin
 *
 * The game draws a number below a limit with one more inline function around the seed step:
 *
 *     if (nMax <= 0) return 0;
 *     if ((nMax - 1) & nMax) return D2_SeedRoll(pSeed) % (uint32_t)nMax;
 *     return D2_SeedRoll(pSeed) & (nMax - 1);
 *
 * VC8 inlines it and shares what the two arms have in common: the loads of both seed words
 * are hoisted above the power-of-two test, the multiply stays in each arm. The decompiler
 * prints the result as an if/else whose arms each hold a step in one of its many spellings
 * (a 64-bit temporary, a struct temporary, the product hoisted, the high store sunk below
 * the join), and compiled as printed VC8 hoists differently: DAMAGE_RollMinMaxDamageRange
 * 0057d760 keeps the zero high word of the addend in a frame slot (`sub esp, 8`, the
 * original has no frame) and matches once both draws are the call:
 *
 *     if ((int)nRange <= 0) {
 *       nRange = 0;
 *     } else {
 *       uVar1 = pUnit->sSeed.nSeedLow;                  nRange = D2_SeedRollLimited(&pUnit->sSeed, nRange);
 *       uVar2 = (uint64_t)pUnit->sSeed.nSeedHigh;
 *       if (nRange & nRange - 1) {               ->
 *         s = (D2SeedStrc)((uint64_t)uVar1 * 0x6ac690c5 + uVar2);
 *         pUnit->sSeed.nSeedHigh = s.nSeedHigh;
 *         pUnit->sSeed.nSeedLow = s.nSeedLow;
 *         nRange = (uint32_t)(s.nSeedLow % nRange);
 *       } else {
 *         ...the same step...;
 *         nRange = nRange - 1 & s.nSeedLow;
 *       }
 *     }
 *
 * The limit is an `int` in the helper: as `uint32_t` VC8 compiles the same body to other code
 * (0057d760 stays INSN_COUNT_MATCH).
 *
 * The arms are not matched by shape. The guarded block is run symbolically along both arms
 * of its power-of-two test, over bit-exact values (64-bit products, zero and sign extension,
 * truncation, the signedness of `%`), and the rewrite is made only when every one of these
 * holds:
 *   - the guard is a signed `L <= 0` (or `L < 1`, or `L > 0` with the arms swapped) of a
 *     32-bit-or-narrower limit N - `(int)N`, or N of a signed type - and its other arm is
 *     `r = 0;` for a local r of a 32-bit integer type;
 *   - the guarded block holds declarations, assignments to locals (no address taken), stores
 *     to the two words of one seed, `D2_SeedRoll`, `D2_SEED_NEXT`, `D2_SEED_NEXT_VAL`, and
 *     exactly one if/else testing `N & (N - 1)` (or its negation); no other call, store or
 *     control flow. Locals and parameters are read as their values at the block's entry (a
 *     local whose address was taken is a stack object no seed word lies in); any other memory
 *     is read only before the seed is first stored. What the statements before the guard
 *     establish holds there too (factsAt): a limit defined as `k - 1` is tested as
 *     `n & k - 2U`, and a pointer set to `&pUnit->sSeed` names that seed;
 *   - on both paths the seed ends as one step of its entry value (high word, low word), and r
 *     ends as the step's low word `%` N (unsigned) on the true arm and `& (N - 1)` on the false
 *     arm - the helper's two results, bit for bit;
 *   - every other local the block writes is dead after it (reaching definitions over the CFG);
 *   - nothing the seed's address names is written in the block.
 * The call stores the same two words, and r gets the same value converted the same way. The
 * declarations of temporaries nothing names any more go.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AnyNode, AssignExpr, BinaryExpr, CallExpr, CompoundStmt, CStyleCastExpr, DeclStmt, ExprStmt,
  Expression, ForStmt, FunctionDecl, Identifier, IfStmt, IntegerLiteralExpr, MemberExpr, ParameterDecl, ParenExpr,
  Statement, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { Expr } from '../../../ast/factory.js';
import { getChildren, transformAST } from '../../../ast/visitor.js';
import { TriviaKind } from '../../../lexer/trivia.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, cloneNode, updateNode, type Transformer } from '../../transformer.js';
import { buildFunctionFlow } from '../../cfg/index.js';
import { sameExpr } from './rotated-for-loop.js';
import { shapeOfNode, type TypedefResolver } from './call-arg-cast.js';
import { createExprShape, type ExprShape } from './expr-shape.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

const ROLL = 'D2_SeedRoll';
const LIMITED = 'D2_SeedRollLimited';
const NEXT = 'D2_SEED_NEXT';
const NEXT_VAL = 'D2_SEED_NEXT_VAL';
const SEED_TYPE = 'D2SeedStrc';
const MULTIPLIER = 0x6ac690c5n;

export interface SeedRollLimitedOptions extends PluginOptions {
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  fieldTypes?: Record<string, string>;
  functionReturnTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
  onSite?: (e: { seed: string; limit: string; result: string; line: number }) => void;
  /** Rethrow an unexpected error instead of leaving the block (tests). */
  strict?: boolean;
  /** Why a candidate block was left (tests). */
  onReject?: (e: { line: number; why: string }) => void;
}

// ---------------------------------------------------------------------------
// Integer types

type IntKind = { w: 8 | 16 | 32 | 64; s: boolean };

const INT_TYPES: Record<string, IntKind> = {
  'int': { w: 32, s: true }, 'int32_t': { w: 32, s: true }, 'long': { w: 32, s: true }, 'signed': { w: 32, s: true },
  'signed int': { w: 32, s: true }, 'INT': { w: 32, s: true }, 'LONG': { w: 32, s: true }, 'BOOL': { w: 32, s: true },
  'uint32_t': { w: 32, s: false }, 'uint': { w: 32, s: false }, 'unsigned int': { w: 32, s: false },
  'unsigned': { w: 32, s: false }, 'DWORD': { w: 32, s: false }, 'UINT': { w: 32, s: false },
  'ULONG': { w: 32, s: false }, 'unsigned long': { w: 32, s: false },
  'uint64_t': { w: 64, s: false }, 'ulonglong': { w: 64, s: false }, 'unsigned long long': { w: 64, s: false },
  'ULONGLONG': { w: 64, s: false }, 'QWORD': { w: 64, s: false }, 'DWORD64': { w: 64, s: false },
  'int64_t': { w: 64, s: true }, 'longlong': { w: 64, s: true }, 'long long': { w: 64, s: true },
  '__int64': { w: 64, s: true }, 'LONGLONG': { w: 64, s: true },
  'uint8_t': { w: 8, s: false }, 'BYTE': { w: 8, s: false }, 'uchar': { w: 8, s: false }, 'unsigned char': { w: 8, s: false },
  'uint16_t': { w: 16, s: false }, 'WORD': { w: 16, s: false }, 'ushort': { w: 16, s: false }, 'unsigned short': { w: 16, s: false },
  'int8_t': { w: 8, s: true }, 'signed char': { w: 8, s: true }, 'char': { w: 8, s: true },
  'int16_t': { w: 16, s: true }, 'short': { w: 16, s: true },
};

function intKindOfBase(base: string, resolve?: TypedefResolver): IntKind | null {
  let b = base;
  for (let i = 0; i < 8; i++) {
    if (INT_TYPES[b]) return INT_TYPES[b];
    const r = resolve?.(b);
    if (!r || r === b) return null;
    b = r.trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Symbolic values: bit-exact keys

/** A 32- or 64-bit integer value: its bits as a canonical key, and the signedness of its type. */
interface Num { t: 'num'; k: string; w: 32 | 64; s: boolean }
/** A D2SeedStrc value: its two words. */
interface Pair { t: 'pair'; lo: Num; hi: Num }
type Val = Num | Pair;

class Reject extends Error {}
const no = (why: string): never => { throw new Reject(why); };

const MASK32 = (1n << 32n) - 1n;
const MASK64 = (1n << 64n) - 1n;

function konst(v: bigint, w: 32 | 64, s: boolean): Num {
  const m = w === 32 ? MASK32 : MASK64;
  return { t: 'num', k: 'c' + (v & m).toString(16), w, s };
}

function constOf(n: Num): bigint | null {
  return n.k.startsWith('c') && /^c[0-9a-f]+$/.test(n.k) ? BigInt('0x' + n.k.slice(1)) : null;
}

/** The low 32 bits of a 64-bit value. */
function trunc(n: Num, s = false): Num {
  if (n.w === 32) return { ...n, s };
  const c = constOf(n);
  if (c !== null) return konst(c, 32, s);
  if (n.k.startsWith('z(') || n.k.startsWith('x(')) return { t: 'num', k: n.k.slice(2, -1), w: 32, s };
  return { t: 'num', k: `t(${n.k})`, w: 32, s };
}

/** The high 32 bits of a 64-bit value. */
function high(n: Num): Num {
  const c = constOf(n);
  if (c !== null) return konst(c >> 32n, 32, false);
  if (n.k.startsWith('z(')) return konst(0n, 32, false);
  return { t: 'num', k: `h(${n.k})`, w: 32, s: false };
}

/** A 32-bit value widened to 64 bits as its type says: zero or sign extension. */
function widen(n: Num, s: boolean): Num {
  if (n.w === 64) return { ...n, s };
  const c = constOf(n);
  if (c !== null) {
    const v = n.s && (c & 0x80000000n) ? c | (MASK64 ^ MASK32) : c;
    return konst(v, 64, s);
  }
  // A truncation of a value whose high word is zero is that value.
  if (n.k.startsWith('h(') && !n.s) return { t: 'num', k: `z(${n.k})`, w: 64, s };
  return { t: 'num', k: `${n.s ? 'x' : 'z'}(${n.k})`, w: 64, s };
}

/** Convert to an integer type. */
function convert(n: Num, kind: IntKind): Num {
  if (kind.w === 64) return widen(n, kind.s);
  if (kind.w === 32) return trunc(n, kind.s);
  // A narrowing store is not modelled.
  return no('narrow conversion');
}

const COMMUTATIVE = new Set(['+', '*', '&', '|', '^']);

/** A value as base + constant: `a(B#cK)` is B + K, anything else is itself + 0. */
function affine(n: Num): { base: string; off: bigint } {
  const m = /^a\((.*)#c([0-9a-f]+)\)$/.exec(n.k);
  return m ? { base: m[1], off: BigInt('0x' + m[2]) } : { base: n.k, off: 0n };
}

/** n + k in w bits: one key per value whatever order the constants came in. */
function offset(n: Num, k: bigint, w: 32 | 64, s: boolean): Num {
  const m = w === 32 ? MASK32 : MASK64;
  const a = affine(n);
  const off = (a.off + k) & m;
  return { t: 'num', k: off === 0n ? a.base : `a(${a.base}#c${off.toString(16)})`, w, s };
}

function binary(op: string, a: Num, b: Num): Num {
  // The usual arithmetic conversions on 32- and 64-bit operands.
  let w: 32 | 64 = a.w === 64 || b.w === 64 ? 64 : 32;
  let s: boolean;
  if (w === 64) {
    if (a.w === 64 && b.w === 64) s = a.s && b.s;
    else s = a.w === 64 ? a.s : b.s;
    a = widen(a, a.w === 64 ? a.s : a.s);
    b = widen(b, b.w === 64 ? b.s : b.s);
    a = { ...a, s }; b = { ...b, s };
  } else {
    s = a.s && b.s;
  }
  const m = w === 32 ? MASK32 : MASK64;
  const ca = constOf(a), cb = constOf(b);
  if (ca !== null && cb !== null) {
    switch (op) {
      case '+': return konst((ca + cb) & m, w, s);
      case '-': return konst((ca - cb) & m, w, s);
      case '*': return konst((ca * cb) & m, w, s);
      case '&': return konst(ca & cb, w, s);
      case '|': return konst(ca | cb, w, s);
      case '^': return konst(ca ^ cb, w, s);
      default: break;
    }
  }
  // A constant added or taken away folds into one offset, modulo 2^w: `(n - 1) - 1` is `n - 2`.
  if (op === '+' && cb !== null) return offset(a, cb, w, s);
  if (op === '+' && ca !== null) return offset(b, ca, w, s);
  if (op === '-' && cb !== null) return offset(a, -cb, w, s);
  if (op === '>>' && cb === 32n && w === 64) {
    if (s) return no('signed 64-bit shift');
    return widen(high(a), false);
  }
  if (COMMUTATIVE.has(op)) {
    const ks = [a.k, b.k].sort();
    return { t: 'num', k: `${op}(${ks[0]},${ks[1]})`, w, s };
  }
  if (op === '-') return { t: 'num', k: `-(${a.k},${b.k})`, w, s };
  if (op === '%' || op === '/') return { t: 'num', k: `${s ? 's' : 'u'}${op}(${a.k},${b.k})`, w, s };
  return no(`operator ${op}`);
}

/** The step from words lo and hi: low * 0x6ac690c5 + high, in 64 bits. */
function stepOf(lo: Num, hi: Num): Num {
  return binary('+', binary('*', widen(trunc(lo), false), konst(MULTIPLIER, 64, false)), widen(trunc(hi), false));
}

// ---------------------------------------------------------------------------
// AST helpers

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function nameOf(e: Expression): string | null {
  const u = unwrap(e);
  return u.kind === NodeKind.Identifier ? (u as Identifier).name : null;
}

function memberName(m: MemberExpr): string | null {
  return m.member.kind === NodeKind.Identifier ? (m.member as Identifier).name : null;
}

function calleeName(c: CallExpr): string | null {
  return nameOf(c.callee);
}

function hasComment(s: ASTNode): boolean {
  return [...(s.leadingTrivia ?? []), ...(s.trailingTrivia ?? [])]
    .some(t => t.kind === TriviaKind.LineComment || t.kind === TriviaKind.BlockComment);
}

/** Every name an expression mentions, member names excluded. */
function namesIn(n: ASTNode, out = new Set<string>()): Set<string> {
  if (n.kind === NodeKind.Identifier) out.add((n as Identifier).name);
  if (n.kind === NodeKind.MemberExpr) {
    namesIn((n as MemberExpr).object, out);
    return out;
  }
  for (const k of getChildren(n)) namesIn(k, out);
  return out;
}

/** The statements a branch holds: a block's list, or the one statement. */
function listOf(s: Statement): Statement[] {
  return s.kind === NodeKind.CompoundStmt ? (s as CompoundStmt).statements : [s];
}

/** Names, members and `*p` with no side effect: something an address can be taken of twice. */
function isPlainLvalue(e: Expression): boolean {
  const u = unwrap(e);
  switch (u.kind) {
    case NodeKind.Identifier:
    case NodeKind.ThisExpr:
      return true;
    case NodeKind.MemberExpr:
      return memberName(u as MemberExpr) !== null && isPlainLvalue((u as MemberExpr).object);
    case NodeKind.UnaryExpr:
      return (u as UnaryExpr).operator === '*' && isPlainLvalue((u as UnaryExpr).operand);
    default:
      return false;
  }
}

/** The address of a seed lvalue: `p` for `*p`, `&E` otherwise. */
function addressOf(e: Expression): Expression {
  const u = unwrap(e);
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '*') return (u as UnaryExpr).operand;
  return Expr.addressOf(u);
}

/** The seed lvalue an address names: `*p` for `p`, E for `&E`. */
function lvalueOfAddress(e: Expression): Expression {
  const u = unwrap(e);
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '&') return (u as UnaryExpr).operand;
  return Expr.unary('*', u);
}

// ---------------------------------------------------------------------------
// The symbolic run of one guarded block

interface Ctx {
  shape: ExprShape;
  resolve?: TypedefResolver;
  locals: ReadonlySet<string>;
  /** Parameters: read as values, never written. */
  params: ReadonlySet<string>;
  addressed: ReadonlySet<string>;
  /** Local or parameter name -> integer kind, or 'seed' for a D2SeedStrc local. */
  kinds: ReadonlyMap<string, IntKind | 'seed'>;
}

interface State {
  env: Map<string, Val>;
  /** The seed's address, once a seed access fixed it: through a pointer fact, what it holds. */
  seed: Expression | null;
  /** The seed's address as the first access spelled it. */
  spelled?: Expression;
  lo: Num | null;
  hi: Num | null;
  /** The seed was stored to on this path. */
  stored: boolean;
  /** The pow-2 test was passed, with this outcome. */
  arm: boolean | null;
  written: Set<string>;
}

const ENTRY_LO: Num = { t: 'num', k: 'm:lo', w: 32, s: false };
const ENTRY_HI: Num = { t: 'num', k: 'm:hi', w: 32, s: false };

function isSeedShape(ctx: Ctx, e: Expression): boolean {
  const s = ctx.shape(e);
  return !!s && s.stars === 0 && s.base === SEED_TYPE;
}

class Runner {
  /** A fact's run (`fact`) reads only integer locals and members of local structs, and sets
   *  `readsMember` when it reads a member. */
  readsMember = false;

  constructor(private ctx: Ctx, private nKey: string, private ptrs: ReadonlyMap<string, Expression> = new Map(),
    private mode: 'block' | 'fact' = 'block') {}

  /** Fix or check the seed a seed lvalue names. */
  private seedAt(st: State, lvalue: Expression): void {
    if (this.mode === 'fact') no('seed in a fact');
    if (!isPlainLvalue(lvalue)) no('seed lvalue with a side effect');
    const spelled = addressOf(lvalue);
    // A pointer local that holds `&E` at the block's entry names E's seed.
    const p = nameOf(spelled);
    const addr = p !== null && this.ptrs.has(p) ? this.ptrs.get(p)! : spelled;
    if (!st.seed) {
      for (const n of namesIn(addr)) if (this.ctx.kinds.get(n) === 'seed') no('seed is a local');
      st.seed = addr;
      st.spelled = spelled;
      return;
    }
    if (!sameExpr(st.seed as ASTNode, addr as ASTNode)) no('two seeds');
  }

  private seedWords(st: State): { lo: Num; hi: Num } {
    return { lo: st.lo ?? ENTRY_LO, hi: st.hi ?? ENTRY_HI };
  }

  private storeSeed(st: State, lo: Num | null, hi: Num | null): void {
    if (lo) st.lo = trunc(lo);
    if (hi) st.hi = trunc(hi);
    st.stored = true;
  }

  /** A local struct of the seed type, read or written as a whole. */
  private isSeedLocal(e: Expression): string | null {
    const n = nameOf(e);
    return n !== null && this.ctx.kinds.get(n) === 'seed' ? n : null;
  }

  /** `S.nSeedLow` / `p->nSeedHigh` of a seed in memory: the field and the seed lvalue. */
  private seedField(e: Expression): { field: 'lo' | 'hi'; lvalue: Expression } | null {
    const u = unwrap(e);
    if (u.kind !== NodeKind.MemberExpr) return null;
    const m = u as MemberExpr;
    const f = memberName(m);
    if (f !== 'nSeedLow' && f !== 'nSeedHigh') return null;
    if (!m.isArrow && this.isSeedLocal(m.object)) return null;
    const lvalue = m.isArrow ? Expr.unary('*', m.object) : m.object;
    if (!isSeedShape(this.ctx, lvalue)) return null;
    return { field: f === 'nSeedLow' ? 'lo' : 'hi', lvalue };
  }

  private kindOf(e: Expression): IntKind | null {
    const s = this.ctx.shape(e);
    if (!s || s.stars !== 0) return null;
    return intKindOfBase(s.base, this.ctx.resolve);
  }

  /** A read of memory other than the seed: allowed only before the seed is stored. */
  private memoryAtom(st: State, e: Expression): Num {
    if (this.mode === 'fact') no('memory in a fact');
    if (st.stored) no('memory read after a seed store');
    const k = this.kindOf(e) ?? no('memory read of unknown type');
    if (k.w === 64) no('64-bit memory read');
    for (const n of namesIn(e)) if (st.written.has(n)) no('memory read through a written name');
    return { t: 'num', k: 'm:' + emit(e as AnyNode).replace(/\s+/g, ''), w: 32, s: k.w < 32 ? true : k.s };
  }

  num(st: State, e: Expression): Num {
    const v = this.val(st, e);
    if (v.t !== 'num') return no('struct value where a number is read');
    return v;
  }

  val(st: State, e0: Expression): Val {
    const e = unwrap(e0);
    switch (e.kind) {
      case NodeKind.IntegerLiteral: {
        const lit = e as IntegerLiteralExpr;
        const suf = lit.suffix.toLowerCase();
        if (suf.includes('l') && suf.replace('u', '') === 'll') return konst(lit.value, 64, !suf.includes('u'));
        if (suf.includes('l')) no('long literal');
        // An unsuffixed literal is an int when it fits, else (hex) an unsigned int.
        if (lit.value > MASK32) no('wide literal');
        const unsigned = suf.includes('u') || (lit.value > 0x7fffffffn && lit.base !== 10);
        if (lit.value > 0x7fffffffn && lit.base === 10 && !suf.includes('u')) no('decimal literal past int');
        return konst(lit.value, 32, !unsigned);
      }
      case NodeKind.Identifier: {
        const n = (e as Identifier).name;
        const known = st.env.get(n);
        if (known) return known;
        const kind = this.ctx.kinds.get(n);
        if (kind === 'seed') return no('seed local read before it is set');
        // A local or parameter the block does not write: its value at the block's entry. One
        // whose address is taken is still a stack object no seed word can be.
        if (this.ctx.locals.has(n) || this.ctx.params.has(n)) {
          if (!kind) return no('local of unknown type');
          if (this.mode === 'fact' && this.ctx.addressed.has(n)) no('addressed local in a fact');
          if (kind.w === 64) return { t: 'num', k: 'v:' + n, w: 64, s: kind.s };
          return { t: 'num', k: 'v:' + n, w: 32, s: kind.w < 32 ? true : kind.s };
        }
        return this.memoryAtom(st, e);
      }
      case NodeKind.MemberExpr: {
        const m = e as MemberExpr;
        const f = memberName(m);
        const local = !m.isArrow ? this.isSeedLocal(m.object) : null;
        if (local && (f === 'nSeedLow' || f === 'nSeedHigh')) {
          const p = st.env.get(local);
          if (!p || p.t !== 'pair') return no('seed local read before it is set');
          return f === 'nSeedLow' ? p.lo : p.hi;
        }
        const sf = this.seedField(e);
        if (sf) {
          this.seedAt(st, sf.lvalue);
          const w = this.seedWords(st);
          return sf.field === 'lo' ? w.lo : w.hi;
        }
        // A member of a local struct the block never writes, or memory.
        const root = nameOf(m.object);
        if (!m.isArrow && root && (this.ctx.locals.has(root) || this.ctx.params.has(root)) && this.ctx.kinds.get(root) !== 'seed') {
          if (st.written.has(root)) no('member of a written local');
          const k = this.kindOf(e) ?? no('member of unknown type');
          this.readsMember = true;
          if (k.w === 64) no('64-bit member');
          return { t: 'num', k: 'v:' + emit(e as AnyNode).replace(/\s+/g, ''), w: 32, s: k.w < 32 ? true : k.s };
        }
        return this.memoryAtom(st, e);
      }
      case NodeKind.CStyleCastExpr: {
        const c = e as CStyleCastExpr;
        const ts = shapeOfNode(c.type, 0, this.ctx.resolve);
        if (!ts || ts.stars !== 0) return no('cast to a pointer');
        if (ts.base === SEED_TYPE) {
          const v = this.num(st, c.expression);
          if (v.w !== 64) no('seed from a 32-bit value');
          return { t: 'pair', lo: trunc(v), hi: high(v) };
        }
        const kind = intKindOfBase(ts.base, this.ctx.resolve) ?? no('cast to an unknown type');
        return convert(this.num(st, c.expression), kind);
      }
      case NodeKind.BinaryExpr: {
        const b = e as BinaryExpr;
        if (!['+', '-', '*', '&', '|', '^', '%', '/', '>>'].includes(b.operator)) no(`operator ${b.operator}`);
        const l = this.num(st, b.left);
        const r = this.num(st, b.right);
        if (b.operator === '>>') {
          // Only the high-word shift of a 64-bit value; the result keeps the left type.
          if (l.w !== 64 || constOf(r) !== 32n) no('shift');
          if (l.s) no('signed 64-bit shift');
          return widen(high(l), false);
        }
        // A 32-bit operand of a 32-bit operator promotes; narrow values are already ints.
        return binary(b.operator, l, r);
      }
      case NodeKind.CallExpr: {
        const c = e as CallExpr;
        const name = calleeName(c);
        if (this.mode === 'fact') no('call in a fact');
        if (name === ROLL && c.arguments.length === 1) {
          this.seedAt(st, lvalueOfAddress(c.arguments[0]));
          const w = this.seedWords(st);
          const step = stepOf(w.lo, w.hi);
          this.storeSeed(st, trunc(step), high(step));
          return trunc(step);
        }
        if (name === NEXT && c.arguments.length === 1) {
          const arg = c.arguments[0];
          const local = this.isSeedLocal(arg);
          let w: { lo: Num; hi: Num };
          if (local) {
            const p = st.env.get(local);
            if (!p || p.t !== 'pair') return no('seed local read before it is set');
            w = { lo: p.lo, hi: p.hi };
          } else {
            if (!isSeedShape(this.ctx, arg)) no('step of a non-seed');
            this.seedAt(st, arg);
            w = this.seedWords(st);
          }
          const step = stepOf(w.lo, w.hi);
          return { t: 'pair', lo: trunc(step), hi: high(step) };
        }
        if (name === NEXT_VAL && c.arguments.length === 1) {
          const sv = this.num(st, c.arguments[0]);
          const v64 = widen(sv, false);
          const step = stepOf(trunc(v64), high(v64));
          return { t: 'pair', lo: trunc(step), hi: high(step) };
        }
        return no('call');
      }
      default:
        return no(`expression ${e.kind} ${emit(e as AnyNode).trim()}`);
    }
  }

  /** Store a value into a local, converted to its type. */
  private setLocal(st: State, name: string, v: Val): void {
    const kind = this.ctx.kinds.get(name);
    if (!this.ctx.locals.has(name) || this.ctx.addressed.has(name)) no('store to a non-local');
    if (kind === 'seed') {
      if (v.t !== 'pair') no('number into a seed local');
      st.env.set(name, v);
    } else {
      if (!kind) no('local of unknown type');
      if (v.t !== 'num') no('struct into a number');
      st.env.set(name, convert(v as Num, kind as IntKind));
    }
    st.written.add(name);
  }

  private assign(st: State, a: AssignExpr): void {
    const lhs = unwrap(a.left);
    let rhs: Val;
    if (a.operator === '=') rhs = this.val(st, a.right);
    else {
      const op = a.operator.slice(0, -1);
      rhs = binary(op, this.num(st, a.left), this.num(st, a.right));
    }
    // A local.
    const name = nameOf(lhs);
    if (name !== null) {
      if (this.isSeedLocal(lhs) && rhs.t === 'num') no('number into a seed local');
      this.setLocal(st, name, rhs);
      return;
    }
    // A word of a seed local.
    if (lhs.kind === NodeKind.MemberExpr && !(lhs as MemberExpr).isArrow && this.isSeedLocal((lhs as MemberExpr).object)) {
      const local = this.isSeedLocal((lhs as MemberExpr).object)!;
      const p = st.env.get(local);
      if (!p || p.t !== 'pair' || rhs.t !== 'num') return no('partial write of an unset seed local');
      const word = trunc(rhs as Num);
      st.env.set(local, memberName(lhs as MemberExpr) === 'nSeedLow' ? { ...p, lo: word } : { ...p, hi: word });
      st.written.add(local);
      return;
    }
    // A word of the seed.
    const sf = this.seedField(lhs);
    if (sf) {
      if (rhs.t !== 'num') no('struct into a seed word');
      this.seedAt(st, sf.lvalue);
      const w = trunc(rhs as Num);
      this.storeSeed(st, sf.field === 'lo' ? w : null, sf.field === 'hi' ? w : null);
      return;
    }
    // The whole seed: `*p = X`, `pUnit->sSeed = X`, or `*(uint64_t*)p = v`.
    if (rhs.t === 'pair' && isSeedShape(this.ctx, lhs) && !this.isSeedLocal(lhs)) {
      this.seedAt(st, lhs);
      this.storeSeed(st, rhs.lo, rhs.hi);
      return;
    }
    if (rhs.t === 'num' && lhs.kind === NodeKind.UnaryExpr && (lhs as UnaryExpr).operator === '*') {
      const ptr = unwrap((lhs as UnaryExpr).operand);
      if (ptr.kind === NodeKind.CStyleCastExpr) {
        const ts = shapeOfNode((ptr as CStyleCastExpr).type, 0, this.ctx.resolve);
        const kind = ts && ts.stars === 1 ? intKindOfBase(ts.base, this.ctx.resolve) : null;
        const target = (ptr as CStyleCastExpr).expression;
        const ps = this.ctx.shape(target);
        if (kind && kind.w === 64 && ps && ps.stars === 1 && ps.base === SEED_TYPE) {
          this.seedAt(st, Expr.unary('*', unwrap(target)));
          const v = widen(rhs as Num, kind.s);
          this.storeSeed(st, trunc(v), high(v));
          return;
        }
      }
    }
    no('store');
  }

  /** Run a statement list; `test` is the pow-2 if, whose arm `take` picks. */
  run(st: State, list: Statement[], take: boolean): void {
    for (const s of list) {
      switch (s.kind) {
        case NodeKind.NullStmt:
          break;
        case NodeKind.DeclStmt:
          for (const d of (s as DeclStmt).declarations) {
            if (d.kind !== NodeKind.VariableDecl) no('declaration');
            const v = d as VariableDecl;
            if (v.specifiers.includes('static') || v.specifiers.includes('extern')) no('static');
            if (!v.initializer) continue;
            if (v.initializer.kind === NodeKind.InitListExpr || v.directInit || v.copyListInit) no('initializer');
            this.setLocal(st, v.name.name, this.val(st, v.initializer as Expression));
          }
          break;
        case NodeKind.ExprStmt: {
          const e = unwrap((s as ExprStmt).expression);
          if (e.kind === NodeKind.AssignExpr) this.assign(st, e as AssignExpr);
          else if (e.kind === NodeKind.CallExpr && calleeName(e as CallExpr) === ROLL) this.val(st, e);
          else no('statement');
          break;
        }
        case NodeKind.CompoundStmt:
          this.run(st, (s as CompoundStmt).statements, take);
          break;
        case NodeKind.IfStmt: {
          const i = s as IfStmt;
          if (st.arm !== null || !i.elseBranch || i.init) no('second if');
          // `X`, `X != 0`, `!X`, `X == 0`: the arm taken when X is not zero.
          let c = unwrap(i.condition);
          let negated = false;
          for (;;) {
            if (c.kind === NodeKind.UnaryExpr && (c as UnaryExpr).operator === '!') {
              negated = !negated; c = unwrap((c as UnaryExpr).operand); continue;
            }
            if (c.kind === NodeKind.BinaryExpr && ['!=', '=='].includes((c as BinaryExpr).operator) &&
                constOf(this.num(st, (c as BinaryExpr).right)) === 0n) {
              if ((c as BinaryExpr).operator === '==') negated = !negated;
              c = unwrap((c as BinaryExpr).left); continue;
            }
            break;
          }
          const k = this.num(st, c).k;
          const n = this.nKey;
          const expect = binary('&', { t: 'num', k: n, w: 32, s: false }, binary('-', { t: 'num', k: n, w: 32, s: false }, konst(1n, 32, false))).k;
          if (k !== expect) no('not the power-of-two test');
          // `arm`: the test's outcome on this path, X != 0.
          st.arm = negated ? !take : take;
          this.run(st, listOf(take ? i.thenBranch : i.elseBranch), take);
          break;
        }
        default:
          no(`statement ${s.kind}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The guard

const INT_CASTS = new Set(['int', 'int32_t', 'INT', 'LONG', 'long']);

interface Guard {
  /** The limit as written, without its `(int)`. */
  limit: Expression;
  result: string;
  /** The branch run when the limit is positive. */
  body: Statement;
}

/** `r = 0;` as the whole branch: r. */
function zeroStore(s: Statement): string | null {
  const l = listOf(s);
  if (l.length !== 1 || l[0].kind !== NodeKind.ExprStmt) return null;
  const e = unwrap((l[0] as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
  const r = unwrap((e as AssignExpr).right);
  if (r.kind !== NodeKind.IntegerLiteral || (r as IntegerLiteralExpr).value !== 0n) return null;
  return nameOf((e as AssignExpr).left);
}

function guardOf(i: IfStmt, ctx: Ctx): Guard | null {
  if (!i.elseBranch || i.init) return null;
  const c = unwrap(i.condition);
  if (c.kind !== NodeKind.BinaryExpr) return null;
  const b = c as BinaryExpr;
  const lit = (e: Expression, v: bigint) => {
    const u = unwrap(e);
    return u.kind === NodeKind.IntegerLiteral && (u as IntegerLiteralExpr).value === v && !(u as IntegerLiteralExpr).suffix.toLowerCase().includes('u');
  };
  let side: Expression;
  let positiveIsThen: boolean;
  if (b.operator === '<=' && lit(b.right, 0n)) { side = b.left; positiveIsThen = false; }
  else if (b.operator === '<' && lit(b.right, 1n)) { side = b.left; positiveIsThen = false; }
  else if (b.operator === '>' && lit(b.right, 0n)) { side = b.left; positiveIsThen = true; }
  else if (b.operator === '>=' && lit(b.right, 1n)) { side = b.left; positiveIsThen = true; }
  else return null;
  let limit = unwrap(side);
  if (limit.kind === NodeKind.CStyleCastExpr) {
    const ts = shapeOfNode((limit as CStyleCastExpr).type, 0, ctx.resolve);
    if (!ts || ts.stars !== 0 || !INT_CASTS.has(ts.base)) return null;
    limit = unwrap((limit as CStyleCastExpr).expression);
    const s = ctx.shape(limit);
    const k = s && s.stars === 0 ? intKindOfBase(s.base, ctx.resolve) : null;
    if (!k || k.w === 64) return null;
  } else {
    const s = ctx.shape(limit);
    const k = s && s.stars === 0 ? intKindOfBase(s.base, ctx.resolve) : null;
    // The compare must be signed as C++ reads it: a signed 32-bit limit, or a narrow one
    // (promoted to int, never negative, so `<= 0` is `== 0` either way).
    if (!k || k.w === 64 || (k.w === 32 && !k.s)) return null;
  }
  const result = zeroStore(positiveIsThen ? i.elseBranch : i.thenBranch);
  if (!result) return null;
  const rk = ctx.kinds.get(result);
  if (!rk || rk === 'seed' || rk.w !== 32 || ctx.addressed.has(result) || !ctx.locals.has(result)) return null;
  return { limit, result, body: positiveIsThen ? i.thenBranch : i.elseBranch };
}

// ---------------------------------------------------------------------------
// What holds at a guard's entry

/**
 * The values locals hold when a guard is reached, from the statements that run before it on
 * every path: the guard is often written against a definition just above it (`n = k - 1;`
 * then the test `n & k - 2U`, or `d = r * 2; n = d + 1;` then `n & d`), and a seed pointer
 * set once (`pSeed = &pUnit->sSeed`) names the same seed as the member it points at.
 *
 * The walk follows the chain of statements from the function's body down to the guard. In
 * each list it runs the statements before the one that leads on, in order: `L = E` gives L
 * E's value when E reads only integer locals and parameters whose address is never taken,
 * constants and members of local structs; anything else gives every local it writes a fresh
 * value nothing else equals. Entering a loop gives the same fresh value to every local the
 * loop writes anywhere (a later iteration reaches the guard too), entering an if to every
 * local its condition writes. A value read from a member of a local struct is dropped at the
 * first call or store that is not to a local, which could write the struct through an
 * address it gave away. A label, case or switch on the way, or a label inside a statement
 * before the guard, starts the walk again after it: control can arrive there without the
 * statements above.
 */
interface Facts {
  env: Map<string, Val>;
  ptrs: Map<string, Expression>;
}

function findPath(root: ASTNode, target: ASTNode, path: ASTNode[] = []): ASTNode[] | null {
  path.push(root);
  if (root === target) return path;
  for (const c of getChildren(root)) {
    if (findPath(c, target, path)) return path;
  }
  path.pop();
  return null;
}

function containsLabel(n: ASTNode): boolean {
  if (n.kind === NodeKind.LabelStmt || n.kind === NodeKind.CaseStmt || n.kind === NodeKind.DefaultStmt) return true;
  return getChildren(n).some(containsLabel);
}

/** Every name a node may write: assignment targets, ++/--, declarations; and whether it calls
 *  or stores anywhere other than a whole local. */
function effectsOf(n: ASTNode, out = { names: new Set<string>(), memory: false }): { names: Set<string>; memory: boolean } {
  const target = (e: Expression) => {
    const name = nameOf(e);
    if (name !== null) out.names.add(name);
    else {
      out.memory = true;
      // A member of a local struct written whole or in part.
      let r = unwrap(e);
      while (r.kind === NodeKind.MemberExpr && !(r as MemberExpr).isArrow) r = unwrap((r as MemberExpr).object);
      const root = nameOf(r);
      if (root !== null) out.names.add(root);
    }
  };
  switch (n.kind) {
    case NodeKind.AssignExpr: target((n as AssignExpr).left); break;
    case NodeKind.UnaryExpr:
      if (['++', '--'].includes((n as UnaryExpr).operator)) target((n as UnaryExpr).operand);
      break;
    case NodeKind.PostfixExpr: target((n as unknown as { operand: Expression }).operand); break;
    case NodeKind.VariableDecl: out.names.add((n as VariableDecl).name.name); break;
    case NodeKind.CallExpr: out.memory = true; break;
    default: break;
  }
  for (const c of getChildren(n)) effectsOf(c, out);
  return out;
}

class FactWalk {
  private env = new Map<string, Val>();
  private ptrs = new Map<string, Expression>();
  /** Locals whose value was read from a member of a local struct. */
  private fromMember = new Set<string>();
  private serial = 0;

  /** ownAddressed: names whose own storage has its address taken (`&x`, `&x.f`; not `&x->f`). */
  constructor(private ctx: Ctx, private ptrLocals: ReadonlySet<string>, private ownAddressed: ReadonlySet<string>) {}

  facts(): Facts {
    return { env: new Map(this.env), ptrs: new Map(this.ptrs) };
  }

  private reset(): void {
    this.env.clear(); this.ptrs.clear(); this.fromMember.clear();
  }

  /** L holds a value no other value equals. */
  private fresh(name: string): void {
    const kind = this.ctx.kinds.get(name);
    if (kind && kind !== 'seed' && !this.ctx.addressed.has(name)) {
      this.env.set(name, { t: 'num', k: `v:${name}@${++this.serial}`, w: kind.w === 64 ? 64 : 32, s: kind.w < 32 ? true : kind.s });
    } else {
      this.env.delete(name);
    }
    this.fromMember.delete(name);
    this.ptrs.delete(name);
    for (const [p, e] of [...this.ptrs]) if (namesIn(e).has(name)) this.ptrs.delete(p);
  }

  private effects(n: ASTNode): void {
    const e = effectsOf(n);
    for (const name of e.names) this.fresh(name);
    if (e.memory) for (const name of [...this.fromMember]) this.fresh(name);
  }

  /** `L = E` or `T L = E`, where L is a local. */
  private define(name: string, rhs: Expression, whole: ASTNode): void {
    const rhsEffects = effectsOf(rhs);
    if (rhsEffects.names.size > 0 || rhsEffects.memory) { this.effects(whole); return; }
    const tracked = (this.ctx.locals.has(name) || this.ctx.params.has(name)) && !this.ctx.addressed.has(name);
    // A seed pointer: `p = &E` with E a plain lvalue of unwritten names.
    const r = unwrap(rhs);
    if ((this.ctx.locals.has(name) || this.ctx.params.has(name)) && !this.ownAddressed.has(name) &&
        this.ptrLocals.has(name) && r.kind === NodeKind.UnaryExpr && (r as UnaryExpr).operator === '&' &&
        isPlainLvalue((r as UnaryExpr).operand) &&
        [...namesIn(r)].every(n => n !== name && (this.ctx.locals.has(n) || this.ctx.params.has(n)) && !this.ownAddressed.has(n))) {
      this.fresh(name);
      this.ptrs.set(name, r);
      return;
    }
    const kind = this.ctx.kinds.get(name);
    if (!tracked || !kind || kind === 'seed') { this.fresh(name); return; }
    try {
      const run = new Runner(this.ctx, '', new Map(), 'fact');
      const st: State = { env: this.env, seed: null, lo: null, hi: null, stored: false, arm: null, written: new Set() };
      const v = convert(run.num(st, rhs), kind);
      this.fresh(name);
      this.env.set(name, v);
      if (run.readsMember) this.fromMember.add(name);
    } catch (e) {
      if (!(e instanceof Reject)) throw e;
      this.fresh(name);
    }
  }

  /** One statement that runs before the guard. */
  step(s: Statement): void {
    if (containsLabel(s)) { this.reset(); return; }
    if (s.kind === NodeKind.ExprStmt) {
      const e = unwrap((s as ExprStmt).expression);
      if (e.kind === NodeKind.AssignExpr && (e as AssignExpr).operator === '=') {
        const name = nameOf((e as AssignExpr).left);
        if (name !== null) { this.define(name, (e as AssignExpr).right, e); return; }
      }
    }
    if (s.kind === NodeKind.DeclStmt) {
      for (const d of (s as DeclStmt).declarations) {
        if (d.kind !== NodeKind.VariableDecl) { this.effects(d); continue; }
        const v = d as VariableDecl;
        if (v.initializer && v.initializer.kind !== NodeKind.InitListExpr && !v.directInit && !v.copyListInit) {
          this.define(v.name.name, v.initializer as Expression, v);
        } else {
          this.effects(v);
        }
      }
      return;
    }
    this.effects(s);
  }

  /** Go from `parent` into its child `child`, on the way to the guard. */
  enter(parent: ASTNode, child: ASTNode): void {
    switch (parent.kind) {
      case NodeKind.CompoundStmt: {
        for (const s of (parent as CompoundStmt).statements) {
          if (s === child) return;
          this.step(s);
        }
        return;
      }
      case NodeKind.IfStmt: {
        const i = parent as IfStmt;
        if (i.init) this.step(i.init);
        if (child !== i.condition) this.effects(i.condition);
        return;
      }
      case NodeKind.ForStmt: {
        const f = parent as ForStmt;
        if (f.init && child !== f.init) this.step(f.init);
        this.effects(f);
        return;
      }
      case NodeKind.WhileStmt:
      case NodeKind.DoWhileStmt:
        this.effects(parent);
        return;
      case NodeKind.FunctionDecl:
        return;
      default:
        // Labels, cases, switches and anything else: start again from here.
        this.reset();
        return;
    }
  }
}

/** The facts at `guard`, a statement of the body `root`. */
function factsAt(root: CompoundStmt, guard: IfStmt, ctx: Ctx, ptrLocals: ReadonlySet<string>, ownAddressed: ReadonlySet<string>): Facts {
  const path = findPath(root, guard);
  const walk = new FactWalk(ctx, ptrLocals, ownAddressed);
  if (!path) return walk.facts();
  for (let i = 0; i + 1 < path.length; i++) walk.enter(path[i], path[i + 1]);
  return walk.facts();
}

// ---------------------------------------------------------------------------
// The pass

interface Found {
  stmt: IfStmt;
  guard: Guard;
  seed: Expression;
  written: Set<string>;
}

/** Every statement under s, s included. */
function statementsUnder(s: ASTNode, out: Statement[] = []): Statement[] {
  const k = s.kind as string;
  if (k.endsWith('Stmt') || k === NodeKind.LabelStmt || k === NodeKind.CaseStmt || k === NodeKind.DefaultStmt) out.push(s as Statement);
  for (const c of getChildren(s)) statementsUnder(c, out);
  return out;
}

function createSeedRollLimitedTransformer(options: SeedRollLimitedOptions = {}): Transformer {
  const typedefTargets = options.typedefTargets ?? {};
  const resolve: TypedefResolver = name => typedefTargets[name];
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      // Work on a copy: the found blocks are replaced where they sit.
      const work = cloneNode(fn.body) as CompoundStmt;
      let anySeed = false;
      const localTypes = new Map<string, TypeNode>();
      const declCount = new Map<string, number>();
      const params = new Set<string>();
      for (const p of fn.parameters as ParameterDecl[]) {
        if (p.name) { localTypes.set(p.name.name, p.type); params.add(p.name.name); }
      }
      const addressed = new Set<string>();
      // The names whose own storage an `&` reaches: the root of `&x`, `&x.f`, `&x[i]`; through
      // `->` or `*` the storage is somewhere else.
      const ownAddressed = new Set<string>();
      const scan = (n: ASTNode): void => {
        if (n.kind === NodeKind.VariableDecl) {
          const v = n as VariableDecl;
          declCount.set(v.name.name, (declCount.get(v.name.name) ?? 0) + 1);
          if (!localTypes.has(v.name.name)) localTypes.set(v.name.name, v.type);
          if (v.type.kind === NodeKind.ArrayType) { addressed.add(v.name.name); ownAddressed.add(v.name.name); }
        }
        if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
          for (const name of namesIn((n as UnaryExpr).operand)) addressed.add(name);
          let r = unwrap((n as UnaryExpr).operand);
          for (;;) {
            if (r.kind === NodeKind.MemberExpr && !(r as MemberExpr).isArrow) r = unwrap((r as MemberExpr).object);
            else if (r.kind === NodeKind.SubscriptExpr) r = unwrap((r as unknown as { array: Expression }).array);
            else break;
          }
          const root = nameOf(r);
          if (root !== null) ownAddressed.add(root);
        }
        if (n.kind === NodeKind.Identifier && ['0x6ac690c5', ROLL, NEXT, NEXT_VAL].includes((n as Identifier).name)) anySeed = true;
        if (n.kind === NodeKind.IntegerLiteral && (n as IntegerLiteralExpr).value === MULTIPLIER) anySeed = true;
        for (const k of getChildren(n)) scan(k);
      };
      scan(work);
      if (!anySeed) return undefined;

      const locals = new Set<string>();
      const kinds = new Map<string, IntKind | 'seed'>();
      const readOnly = new Set<string>();
      const seedPointers = new Set<string>();
      for (const [name, t] of localTypes) {
        // A name declared twice (two scopes) is not tracked.
        if ((declCount.get(name) ?? 0) + (params.has(name) ? 1 : 0) !== 1) continue;
        if (params.has(name)) readOnly.add(name);
        else locals.add(name);
        const s = shapeOfNode(t, 0, resolve);
        if (s && s.stars === 1 && s.base === SEED_TYPE) seedPointers.add(name);
        if (!s || s.stars !== 0) continue;
        if (s.base === SEED_TYPE) kinds.set(name, 'seed');
        else {
          const k = intKindOfBase(s.base, resolve);
          if (k) kinds.set(name, k);
        }
      }
      const shape = createExprShape(localTypes, {
        globalTypes: options.globalTypes ?? {},
        enclosingVarTypes: options.enclosingVarTypes ?? {},
        structFields: options.structFields ?? {},
        fieldTypes: options.fieldTypes ?? {},
        returnTypes: options.functionReturnTypes ?? {},
        resolve,
      });
      const ctx: Ctx = { shape, resolve, locals, params: readOnly, addressed, kinds };

      // The candidates, checked symbolically.
      const found: Found[] = [];
      for (const s of statementsUnder(work)) {
        if (s.kind !== NodeKind.IfStmt) continue;
        const guard = guardOf(s as IfStmt, ctx);
        if (!guard) continue;
        try {
          const facts = factsAt(work, s as IfStmt, ctx, seedPointers, ownAddressed);
          const entry: State = { env: new Map(facts.env), seed: null, lo: null, hi: null, stored: false, arm: null, written: new Set() };
          const nKey = new Runner(ctx, '', facts.ptrs).num(entry, guard.limit).k;
          const ends: State[] = [];
          for (const take of [true, false]) {
            const st: State = { env: new Map(facts.env), seed: null, lo: null, hi: null, stored: false, arm: null, written: new Set() };
            new Runner(ctx, nKey, facts.ptrs).run(st, listOf(guard.body), take);
            if (st.arm === null || !st.seed) no('no test');
            ends.push(st);
          }
          const step = stepOf(ENTRY_LO, ENTRY_HI);
          const n: Num = { t: 'num', k: nKey, w: 32, s: false };
          const want = [
            binary('%', trunc(step), n).k,
            binary('&', trunc(step), binary('-', n, konst(1n, 32, false))).k,
          ];
          ends.forEach((st, i) => {
            if (!st.lo || !st.hi || st.lo.k !== trunc(step).k || st.hi.k !== high(step).k) no('seed not stepped once');
            const r = st.env.get(guard.result);
            if (!r || r.t !== 'num' || r.k !== want[st.arm ? 0 : 1]) no('result');
            if (!sameExpr(st.seed as ASTNode, ends[0].seed as ASTNode)) no('two seeds');
          });
          // The seed's address names nothing the block writes.
          const written = new Set([...ends[0].written, ...ends[1].written]);
          for (const name of [...namesIn(ends[0].seed!), ...namesIn(ends[0].spelled!)]) if (written.has(name)) no('seed address written');
          found.push({ stmt: s as IfStmt, guard, seed: ends[0].spelled!, written });
        } catch (e) {
          // Anything the model does not cover leaves the block as it is.
          if (!(e instanceof Reject) && options.strict) throw e;
          options.onReject?.({ line: s.location?.start.line ?? 0, why: (e as Error).message });
        }
      }
      if (found.length === 0) return undefined;

      // Every temporary is dead after its block.
      const flow = buildFunctionFlow(work.statements, locals);
      const accepted = found.filter(f => {
        const reject = (why: string) => { options.onReject?.({ line: f.stmt.location?.start.line ?? 0, why }); return false; };
        const inside = new Set<number>();
        const stmts = statementsUnder(f.stmt);
        for (const st of stmts) {
          const id = flow.nodeOf(st);
          if (id !== undefined) inside.add(id);
        }
        for (const t of f.written) {
          if (t === f.guard.result) continue;
          if (flow.isEscaped(t)) return reject(`${t} escapes`);
          for (const st of stmts) {
            const id = flow.nodeOf(st);
            if (id === undefined || !flow.definition(id, t)) continue;
            if (flow.usesOf(id, t).some(u => !inside.has(u))) return reject(`${t} live after`);
          }
        }
        return true;
      });
      if (accepted.length === 0) return undefined;

      const replace = new Map<ASTNode, Statement>();
      for (const f of accepted) {
        const call = Expr.call(LIMITED, [cloneNode(f.seed), cloneNode(f.guard.limit)]);
        const stmt = {
          ...Expr.assign(Expr.identifier(f.guard.result), call),
        };
        const es: ExprStmt = {
          kind: NodeKind.ExprStmt,
          expression: stmt as AssignExpr,
          leadingTrivia: f.stmt.leadingTrivia,
          trailingTrivia: f.stmt.trailingTrivia,
          location: f.stmt.location,
        } as ExprStmt;
        replace.set(f.stmt, es);
        options.onSite?.({
          seed: emit(f.seed as AnyNode).trim(), limit: emit(f.guard.limit as AnyNode).trim(), result: f.guard.result,
          line: f.stmt.location?.start.line ?? 0,
        });
      }
      const put = (n: ASTNode): void => {
        for (const [key, v] of Object.entries(n)) {
          if (key === 'leadingTrivia' || key === 'trailingTrivia' || key === 'location') continue;
          if (Array.isArray(v)) {
            v.forEach((x, i) => {
              if (x && typeof x === 'object' && 'kind' in x) {
                const r = replace.get(x as ASTNode);
                if (r) v[i] = r;
                else put(x as ASTNode);
              }
            });
          } else if (v && typeof v === 'object' && 'kind' in v) {
            const r = replace.get(v as ASTNode);
            if (r) (n as unknown as Record<string, unknown>)[key] = r;
            else put(v as ASTNode);
          }
        }
      };
      put(work);
      let body = work;

      // Declarations of temporaries nothing names any more.
      const temps = new Set<string>();
      for (const f of accepted) for (const t of f.written) if (t !== f.guard.result) temps.add(t);
      const used = new Set<string>();
      const collect = (n: ASTNode): void => {
        if (n.kind === NodeKind.VariableDecl) {
          const v = n as VariableDecl;
          if (v.initializer) collect(v.initializer as ASTNode);
          return;
        }
        if (n.kind === NodeKind.Identifier) used.add((n as Identifier).name);
        if (n.kind === NodeKind.MemberExpr) { collect((n as MemberExpr).object); return; }
        for (const k of getChildren(n)) collect(k);
      };
      collect(body);
      const drop = (list: Statement[]): Statement[] => list.filter(s => {
        if (s.kind !== NodeKind.DeclStmt || hasComment(s)) return true;
        const ds = (s as DeclStmt).declarations;
        if (ds.length !== 1 || ds[0].kind !== NodeKind.VariableDecl) return true;
        const v = ds[0] as VariableDecl;
        return !(temps.has(v.name.name) && !v.initializer && !used.has(v.name.name));
      });
      body = transformAST(body, {
        visitCompoundStmt(c: CompoundStmt): ASTNode | undefined {
          const next = drop(c.statements);
          return next.length === c.statements.length ? undefined : updateNode(c, { statements: next } as Partial<CompoundStmt>);
        },
      }) as CompoundStmt;
      if (body.kind === NodeKind.CompoundStmt) {
        const top = drop(body.statements);
        if (top.length !== body.statements.length) body = updateNode(body, { statements: top } as Partial<CompoundStmt>);
      }
      return updateNode(fn, { body } as Partial<FunctionDecl>);
    },
  });
}

export const seedRollLimitedPlugin: TransformPlugin = {
  id: 'seed-roll-limited',
  name: 'Seed Roll Limited',
  description: 'A seed draw below a limit, inlined as an if/else on a power of two, becomes the inline limited roll',
  version: '1.0.0',
  defaultEnabled: true,
  // After seed-roll-step (619.5), whose `x = D2_SeedRoll(&E)` steps this reads as steps.
  priority: 619.6,
  tags: ['game', 'diablo', 'matching'],
  createTransformer: (options: SeedRollLimitedOptions = {}) => createSeedRollLimitedTransformer(options),
};
