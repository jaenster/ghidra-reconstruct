/**
 * MSVC's inline string functions, put back as the calls they are.
 *
 * With /Oi the compiler expands strlen, strcpy and strcat inline, and the decompiler
 * prints the loops (GetItemName 0048c630-0048c699, BuildSymbolSearchPath, the char-select
 * screen, ...):
 *
 *   p = src;           do { c = *p; p = p + 1; } while (c != 0);      // strlen(src) + 1
 *   q = dst - 1;       do { t = q + 1; q = q + 1; } while (*t != 0);  // q = dst + strlen(dst)
 *   for (n = (uint)(p - src) >> 2; n != 0; n--) { *(u32*)q = *(u32*)s; s += 4; q += 4; }
 *   for (n = (p - src) & 3; n != 0; n--) { *q = *s; s++; q++; }   // rep movsd; rep movsb
 *
 * which is `strcat(dst, src)`. The `dst - 1` is often only an address: the last byte of
 * the frame object before `dst` (`(int)wszAffixWork + 0xc5`, C3-16), or of the field
 * before it.
 *
 * Every address here is evaluated as a byte offset from a base - a frame slot (from the
 * function's stack frame), a pointer variable, a global - so `(int)wszAffixWork + 0xc5`
 * plus one IS `szUtf8Buf` when the frame says szUtf8Buf starts 0xc6 bytes after
 * wszAffixWork, and `p->name` is `p` plus the field's offset. A group is replaced only
 * when every step is proven:
 *
 *  - the scan loops and the copy are the exact shapes above (a strlen scan reading from
 *    its start, an end scan reading one ahead, a dword copy of n >> 2 then n & 3 bytes),
 *  - the copy's length is the scanned tail minus the source and its source is that source,
 *    its destination the end the end scan found,
 *  - the destination is a frame object and the source is not, so they cannot overlap
 *    (strcat requires that; the movs loop with overlap would differ),
 *  - nothing between the steps calls, stores, or changes the values they read,
 *  - every temporary the loops leave behind is dead afterwards (its definitions reach
 *    no use outside the group).
 *
 * Recognised: strcat(dst, src); strcat(dst, "lit") (the end scan followed by a store of
 * the literal's bytes, NUL included); strlen(s) where only the length is used.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  AssignExpr,
  BinaryExpr,
  CStyleCastExpr,
  DoWhileStmt,
  Expression,
  ExprStmt,
  ForStmt,
  Identifier,
  MemberExpr,
  PostfixExpr,
  Statement,
  SubscriptExpr,
  UnaryExpr,
  VariableDecl,
  TypeNode,
} from '../../../ast/nodes.js';
import { Expr, Type } from '../../../ast/factory.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { buildFunctionFlow, ENTRY_DEF, type FunctionFlow } from '../../cfg/dataflow.js';
import { unwrapParens, type TypeShape } from './call-arg-cast.js';

export interface StringIntrinsicDeps {
  /** Declared shape of an expression, or null. */
  shape: (e: Expression) => TypeShape | null;
  isPure: (e: ASTNode) => boolean;
  /** Parameters and locals. */
  locals: ReadonlySet<string>;
  /** Locals whose declared type is an array, with their element size. */
  localArrays: ReadonlyMap<string, { elem: number; isChar?: boolean }>;
  /** The frame: name -> offset, size. */
  stackSlots?: ReadonlyArray<{ name: string; offset: number; size: number }>;
  fieldOffsets?: Record<string, Record<string, number>>;
  /** Aggregate -> field -> declared spelling (to know array fields). */
  structFields?: Record<string, Record<string, string>>;
  aggregateSizes?: Record<string, number>;
}

// ============================================
// BYTE ADDRESSES
// ============================================

const MOD = 1n << 32n;
const norm = (v: bigint) => ((v % MOD) + MOD) % MOD;

/** sum(coef * atom) + c in bytes, mod 2^32. */
interface Addr { terms: Map<string, bigint>; c: bigint }
const constAddr = (c: bigint): Addr => ({ terms: new Map(), c: norm(c) });
const atom = (k: string): Addr => ({ terms: new Map([[k, 1n]]), c: 0n });
function addAddr(a: Addr, b: Addr, sign = 1n): Addr {
  const terms = new Map(a.terms);
  for (const [k, v] of b.terms) {
    const r = norm((terms.get(k) ?? 0n) + sign * v);
    if (r === 0n) terms.delete(k); else terms.set(k, r);
  }
  return { terms, c: norm(a.c + sign * b.c) };
}
const plus = (a: Addr, k: bigint): Addr => ({ terms: a.terms, c: norm(a.c + k) });
const scale = (a: Addr, k: bigint): Addr => {
  const terms = new Map<string, bigint>();
  for (const [t, v] of a.terms) { const r = norm(v * k); if (r !== 0n) terms.set(t, r); }
  return { terms, c: norm(a.c * k) };
};
const sameAddr = (a: Addr, b: Addr) => {
  const d = addAddr(a, b, -1n);
  return d.terms.size === 0 && d.c === 0n;
};
/** a - b when it is a constant. */
const constDiff = (a: Addr, b: Addr): bigint | null => {
  const d = addAddr(a, b, -1n);
  if (d.terms.size !== 0) return null;
  return d.c >= (1n << 31n) ? d.c - MOD : d.c;
};

const literalOf = (e: Expression): bigint | null => {
  const x = unwrapParens(e);
  if (x.kind === NodeKind.IntegerLiteral) return (x as unknown as { value: bigint }).value;
  if (x.kind === NodeKind.CharLiteral) {
    const v = (x as unknown as { value: number | string }).value;
    return typeof v === 'number' ? BigInt(v) : BigInt(String(v).charCodeAt(0));
  }
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '-') {
    const v = literalOf((x as UnaryExpr).operand);
    return v === null ? null : -v;
  }
  return null;
};

/** Byte size of the type a pointer shape points at, when known. */
function pointeeSize(sh: TypeShape | null, deps: StringIntrinsicDeps): number | null {
  if (!sh || sh.stars < 1) return null;
  if (sh.stars > 1) return 4;
  const b = sh.base;
  if (/^(char|signed char|unsigned char|bool)$/.test(b)) return 1;
  if (/^(short|unsigned short|wchar_t)$/.test(b)) return 2;
  if (/^(int|unsigned int|long|unsigned long|float)$/.test(b)) return 4;
  if (/^(long long|unsigned long long|double)$/.test(b)) return 8;
  const agg = deps.aggregateSizes?.[b.replace(/^::/, '')];
  return typeof agg === 'number' ? agg : null;
}


/**
 * The address evaluator for one function. `env` gives the run's current symbolic value
 * of a local (set by the caller as it walks a run); a local not in it is an atom.
 */
function makeAddress(deps: StringIntrinsicDeps, env: Map<string, Addr>, outer?: (name: string) => Expression | null) {
  const expanding = new Set<string>();
  const slot = new Map((deps.stackSlots ?? []).map(s => [s.name, s]));
  const fieldOffset = (aggregate: string, field: string): number | null => {
    const o = deps.fieldOffsets?.[aggregate.replace(/^::/, '')]?.[field];
    return typeof o === 'number' ? o : null;
  };
  const isArrayField = (aggregate: string, field: string) => {
    const sp = deps.structFields?.[aggregate.replace(/^::/, '')]?.[field];
    return !!sp && /\[\d*\]\s*$/.test(sp);
  };
  /** Address of an lvalue (the object itself). */
  const lvalue = (e: Expression): Addr | null => {
    const x = unwrapParens(e);
    if (x.kind === NodeKind.Identifier) {
      const n = (x as Identifier).name;
      const s = slot.get(n);
      if (s) return plus(atom('frame'), BigInt(s.offset));
      return deps.locals.has(n) ? null : atom(`&g:${n}`);
    }
    if (x.kind === NodeKind.MemberExpr) {
      const m = x as MemberExpr;
      const owner = m.isArrow ? deps.shape(m.object) : deps.shape(m.object);
      if (!owner || owner.stars !== (m.isArrow ? 1 : 0)) return null;
      const off = fieldOffset(owner.base, (m.member as Identifier).name);
      if (off === null) return null;
      const base = m.isArrow ? value(m.object) : lvalue(m.object);
      return base && plus(base, BigInt(off));
    }
    if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '*') return value((x as UnaryExpr).operand);
    if (x.kind === NodeKind.SubscriptExpr) {
      const s = x as SubscriptExpr;
      const k = literalOf(s.index);
      const base = value(s.array);
      const sz = elementSizeOf(s.array);
      return base && k !== null && sz !== null ? plus(base, k * BigInt(sz)) : null;
    }
    return null;
  };
  /** Element size of an array or pointer expression. */
  const elementSizeOf = (e: Expression): number | null => {
    const x = unwrapParens(e);
    if (x.kind === NodeKind.Identifier) {
      const arr = deps.localArrays.get((x as Identifier).name);
      if (arr) return arr.elem;
    }
    return pointeeSize(deps.shape(x), deps);
  };
  /** Value of a pointer or 4-byte integer expression, as a byte address. */
  const value = (e: Expression): Addr | null => {
    const x = unwrapParens(e);
    const lit = literalOf(x);
    if (lit !== null) return constAddr(lit);
    switch (x.kind) {
      case NodeKind.Identifier: {
        const n = (x as Identifier).name;
        if (deps.localArrays.has(n)) return lvalue(x);
        const v = env.get(n);
        if (v) return v;
        // A value the window did not set: what its single reaching definition says, when
        // nothing that definition reads changed since (see `windowStartValue`).
        if (outer && !expanding.has(n)) {
          const def = outer(n);
          if (def) {
            expanding.add(n);
            try { const r = value(def); if (r) return r; } finally { expanding.delete(n); }
          }
        }
        return atom(`v:${n}`);
      }
      case NodeKind.CStyleCastExpr:
        return value((x as CStyleCastExpr).expression);
      case NodeKind.UnaryExpr: {
        const u = x as UnaryExpr;
        if (u.operator === '&') return lvalue(u.operand);
        if (u.operator === '-') { const v = value(u.operand); return v && scale(v, -1n); }
        return null;
      }
      case NodeKind.MemberExpr: {
        // An array field decays to its address; any other field is a load.
        const m = x as MemberExpr;
        const owner = deps.shape(m.object);
        if (owner && isArrayField(owner.base, (m.member as Identifier).name)) return lvalue(x);
        return null;
      }
      case NodeKind.BinaryExpr: {
        const b = x as BinaryExpr;
        if (b.operator !== '+' && b.operator !== '-') return null;
        const l = value(b.left), r = value(b.right);
        if (!l || !r) return null;
        // Pointer arithmetic scales by the pointee; integer arithmetic does not.
        const ls = deps.shape(b.left), rs = deps.shape(b.right);
        const lp = ls && ls.stars > 0 ? elementSizeOf(b.left) : (unwrapParens(b.left).kind === NodeKind.Identifier && deps.localArrays.has((unwrapParens(b.left) as Identifier).name) ? elementSizeOf(b.left) : 1);
        const rp = rs && rs.stars > 0 ? elementSizeOf(b.right) : 1;
        if (lp === null || rp === null) return null;
        if (lp !== 1 && rp !== 1) return b.operator === '-' ? (lp === rp ? scaleDiv(addAddr(l, r, -1n), lp) : null) : null;
        if (lp !== 1) return addAddr(l, scale(r, BigInt(lp)), b.operator === '+' ? 1n : -1n);
        if (rp !== 1) return b.operator === '+' ? addAddr(r, scale(l, BigInt(rp))) : null;
        return addAddr(l, r, b.operator === '+' ? 1n : -1n);
      }
      default:
        return null;
    }
  };
  /** `value(e)` with `extra` bound for this one evaluation. */
  const valueWith = (extra: ReadonlyMap<string, Addr>, e: Expression): Addr | null => {
    const saved = new Map<string, Addr | undefined>();
    for (const [k, v] of extra) { saved.set(k, env.get(k)); env.set(k, v); }
    try { return value(e); } finally {
      for (const [k, v] of saved) { if (v === undefined) env.delete(k); else env.set(k, v); }
    }
  };
  return { value, lvalue, elementSizeOf, valueWith, env };
}

/** (a) / k when exact (a pointer difference in elements); only constants qualify. */
function scaleDiv(a: Addr, k: number): Addr | null {
  if (a.terms.size !== 0) return null;
  return a.c % BigInt(k) === 0n ? constAddr(a.c / BigInt(k)) : null;
}

// ============================================
// LOOP SHAPES
// ============================================

/** `X = E;` */
function assignOf(st: Statement | undefined): { left: Expression; right: Expression } | null {
  if (!st || st.kind !== NodeKind.ExprStmt) return null;
  const e = unwrapParens((st as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
  return { left: (e as AssignExpr).left, right: (e as AssignExpr).right };
}
const identName = (e: Expression | undefined) => {
  const x = e && unwrapParens(e);
  return x && x.kind === NodeKind.Identifier ? (x as Identifier).name : null;
};
const bodyStatements = (s: Statement): Statement[] => {
  if (s.kind === NodeKind.CompoundStmt) return (s as unknown as { statements: Statement[] }).statements;
  return [s];
};
/**
 * A cast to a one-byte type: `(char)w` of a wider value read at p is the byte at p on
 * this little-endian target (Ghidra types some byte cursors as `ushort *`).
 */
function stripByteCast(e: Expression): Expression {
  const x = unwrapParens(e);
  if (x.kind !== NodeKind.CStyleCastExpr) return x;
  const t = emit((x as CStyleCastExpr).type as unknown as AnyNode).replace(/\s+/g, ' ').trim();
  return /^(char|byte|uchar|uint8_t|int8_t|BYTE|CHAR|undefined1|unsigned char|signed char)$/.test(t)
    ? unwrapParens((x as CStyleCastExpr).expression) : x;
}

/** `x != 0` / `x != '\0'` / `x`: the tested expression. */
function nonZeroTest(e: Expression): Expression | null {
  const x = stripByteCast(e);
  if (x.kind === NodeKind.BinaryExpr && (x as BinaryExpr).operator === '!=' && literalOf((x as BinaryExpr).right) === 0n) return stripByteCast((x as BinaryExpr).left);
  if (x.kind === NodeKind.BinaryExpr || x.kind === NodeKind.UnaryExpr) {
    if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '*') return x;
    if (x.kind === NodeKind.BinaryExpr) return null;
  }
  return x;
}
/** `*P` (any cast on the pointer): P. */
function derefOf(e: Expression): Expression | null {
  const x = stripByteCast(e);
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '*') return (x as UnaryExpr).operand;
  if (x.kind === NodeKind.SubscriptExpr && literalOf((x as SubscriptExpr).index) === 0n) return (x as SubscriptExpr).array;
  return null;
}

interface Scan {
  /** The pointer variable the loop advances. */
  ptr: string;
  /** The other variables the loop sets: an address at ptr + offset, or a byte read. */
  temps: Array<{ name: string; offset: bigint | null }>;
  /** strlen scan (tests the byte at the iteration's start) or end scan (the byte after it). */
  kind: 'strlen' | 'end';
}

/**
 * `do { ...; P = P + 1; } while (<byte at P + d> != 0)`: every statement an assignment, P
 * advanced by exactly one byte per iteration (possibly through a struct-typed pointer,
 * `P = (S*)(t + 1)` with `t = P->name` at offset 0), the test a byte at P + d read either
 * through an address temporary or into a byte temporary. d = 0 is a strlen scan, d = 1 an
 * end scan. On exit P is one past the tested byte; an address temporary at P + k is then
 * P_exit - 1 - d + k... expressed below as `offset` from the exit pointer.
 */
function scanShape(st: Statement, addr: ReturnType<typeof makeAddress>): Scan | null {
  if (st.kind !== NodeKind.DoWhileStmt) return null;
  const body = bodyStatements((st as DoWhileStmt).body);
  if (body.length < 2 || body.length > 4) return null;
  const assigns = body.map(assignOf);
  if (assigns.some(a => !a || !identName(a.left))) return null;
  const names = assigns.map(a => identName(a!.left)!);
  if (new Set(names).size !== names.length) return null;
  // P: the variable whose new value is its start plus one.
  for (const P of names) {
    const pStart = atom(`scan:${P}`);
    const env = new Map<string, Addr>([[P, pStart]]);
    const reads = new Map<string, Addr>();
    let advanced: Addr | null = null;
    let ok = true;
    for (const a of assigns) {
      const v = identName(a!.left)!;
      const d = derefOf(a!.right);
      if (d) {
        const at = addr.valueWith(env, d);
        if (!at) { ok = false; break; }
        reads.set(v, at);
        continue;
      }
      const val = addr.valueWith(env, a!.right);
      if (!val) { ok = false; break; }
      if (v === P) advanced = val; else env.set(v, val);
    }
    if (!ok || !advanced || constDiff(advanced, pStart) !== 1n) continue;
    const test = nonZeroTest((st as DoWhileStmt).condition);
    if (!test) continue;
    let tested: Addr | null = null;
    const tName = identName(test);
    if (tName && reads.has(tName)) tested = reads.get(tName)!;
    const tPtr = derefOf(test);
    if (!tested && tPtr) tested = addr.valueWith(env, tPtr);
    if (!tested) continue;
    const d = constDiff(tested, pStart);
    if (d !== 0n && d !== 1n) continue;
    // Exit pointer = (last iteration's start) + 1; an address temp at start + k is exit - 1 + k.
    const temps: Scan['temps'] = [];
    for (const n of names) {
      if (n === P) continue;
      const e = env.get(n);
      const k = e ? constDiff(e, pStart) : null;
      temps.push({ name: n, offset: e && k !== null ? k - 1n : null });
    }
    return { ptr: P, temps, kind: d === 0n ? 'strlen' : 'end' };
  }
  return null;
}

interface Copy {
  /** The destination and source pointer variables, the count variable. */
  dst: string; src: string; counts: string[];
  /** The byte length both loops copy. */
  length: Expression;
}

/**
 * `for (n = (uint)L >> 2; n != 0; n--) { *(u32*)D = *(u32*)S; S += 4; D += 4; }` then
 * `for (n = L & 3; n != 0; n--) { *D = *S; S += 1; D += 1; }` (the steps in any order,
 * the pointers possibly struct-typed, as `S = (T*)(S->name + 4)`).
 */
function copyShape(a: Statement, b: Statement, addr: ReturnType<typeof makeAddress>): Copy | null {
  const loop = (st: Statement, unit: 4 | 1) => {
    if (st.kind !== NodeKind.ForStmt) return null;
    const f = st as ForStmt;
    const init = f.init && assignOf(f.init as Statement);
    const n = init && identName(init.left);
    if (!init || !n) return null;
    const cond = f.condition && nonZeroTest(f.condition);
    if (!cond || identName(cond) !== n) return null;
    // n-- / n = n - 1
    const inc = f.increment && unwrapParens(f.increment);
    const decOk = !!inc && ((inc.kind === NodeKind.PostfixExpr && (inc as PostfixExpr).operator === '--' && identName((inc as PostfixExpr).operand) === n)
      || (inc.kind === NodeKind.UnaryExpr && (inc as UnaryExpr).operator === '--' && identName((inc as UnaryExpr).operand) === n)
      || (inc.kind === NodeKind.AssignExpr && identName((inc as AssignExpr).left) === n
        && unwrapParens((inc as AssignExpr).right).kind === NodeKind.BinaryExpr
        && literalOf(((unwrapParens((inc as AssignExpr).right)) as BinaryExpr).right) !== null));
    if (!decOk) return null;
    const body = bodyStatements(f.body);
    if (body.length !== 3) return null;
    const mv = assignOf(body[0]);
    if (!mv) return null;
    const dPtr = derefOf(mv.left), sPtr = derefOf(mv.right);
    if (!dPtr || !sPtr) return null;
    // The width of the move: a 4-byte or 1-byte access on both sides.
    const width = (p: Expression) => {
      const x = unwrapParens(p);
      if (x.kind === NodeKind.CStyleCastExpr) {
        const t = emit((x as CStyleCastExpr).type as unknown as AnyNode).replace(/\s+/g, '');
        if (/^(uint32_t|undefined4|uint|int|DWORD|int32_t)\*$/.test(t)) return 4;
        if (/^(uint8_t|undefined1|byte|char|BYTE|int8_t)\*$/.test(t)) return 1;
        return null;
      }
      return 1;
    };
    if (width(dPtr) !== unit || width(sPtr) !== unit) return null;
    // D and S: the variables the derefs go through, at offset 0 from them.
    const D = baseVar(dPtr), S = baseVar(sPtr);
    if (!D || !S || D === S) return null;
    const steps = [assignOf(body[1]), assignOf(body[2])];
    const stepped = new Set<string>();
    for (const s of steps) {
      const v = s && identName(s.left);
      if (!s || !v) return null;
      const e = new Map([[v, atom(`step:${v}`)]]);
      const nv = addr.valueWith(e, s.right);
      if (!nv || constDiff(nv, atom(`step:${v}`)) !== BigInt(unit)) return null;
      stepped.add(v);
    }
    if (!stepped.has(D) || !stepped.has(S)) return null;
    // The deref addresses are exactly D and S.
    const e = new Map([[D, atom('d0')], [S, atom('s0')]]);
    const da = addr.valueWith(e, dPtr), sa = addr.valueWith(e, sPtr);
    if (!da || !sa || constDiff(da, atom('d0')) !== 0n || constDiff(sa, atom('s0')) !== 0n) return null;
    return { n, D, S, init: init.right };
  };
  const l4 = loop(a, 4), l1 = loop(b, 1);
  if (!l4 || !l1 || l4.D !== l1.D || l4.S !== l1.S) return null;
  // n = (uint)L >> 2 and n = L & 3, the same L.
  const shr = unwrapParens(l4.init), and = unwrapParens(l1.init);
  if (shr.kind !== NodeKind.BinaryExpr || (shr as BinaryExpr).operator !== '>>' || literalOf((shr as BinaryExpr).right) !== 2n) return null;
  if (and.kind !== NodeKind.BinaryExpr || (and as BinaryExpr).operator !== '&' || literalOf((and as BinaryExpr).right) !== 3n) return null;
  const L1 = (shr as BinaryExpr).left, L2 = (and as BinaryExpr).left;
  const v1 = addr.value(L1), v2 = addr.value(L2);
  if (!v1 || !v2 || !sameAddr(v1, v2)) return null;
  return { dst: l4.D, src: l4.S, counts: [...new Set([l4.n, l1.n])], length: L2 };
}

/** The variable a dereferenced pointer expression goes through (`(T*)p`, `p->name`). */
function baseVar(e: Expression): string | null {
  let x = unwrapParens(e);
  for (;;) {
    if (x.kind === NodeKind.CStyleCastExpr) { x = unwrapParens((x as CStyleCastExpr).expression); continue; }
    if (x.kind === NodeKind.MemberExpr && (x as MemberExpr).isArrow) { x = unwrapParens((x as MemberExpr).object); continue; }
    break;
  }
  return identName(x);
}

// ============================================
// THE REWRITE
// ============================================

export function lowerStringIntrinsics(body: Statement[], deps: StringIntrinsicDeps): Statement[] {
  let current = body;
  for (let round = 0; round < 128; round++) {
    const next = lowerOne(current, deps);
    if (!next) break;
    current = next;
  }
  return current;
}

function lowerOne(body: Statement[], deps: StringIntrinsicDeps): Statement[] | null {
  const root = { kind: NodeKind.CompoundStmt, statements: body } as unknown as ASTNode;
  const lists: Statement[][] = [];
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (!x || typeof x !== 'object') return;
    const n = x as ASTNode;
    if (n.kind === NodeKind.CompoundStmt) lists.push((n as unknown as { statements: Statement[] }).statements);
    for (const [k, v] of Object.entries(n)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
      if (v && typeof v === 'object') walk(v);
    }
  };
  walk(root);
  const flow = buildFunctionFlow(body, deps.locals);
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const r = tryAt(list, i, body, deps, flow) ?? tryStrcmp(list, i, body, deps);
      if (r) return r;
    }
  }
  return null;
}

// ============================================
// repe cmpsb: strcmp(A, "lit") == 0
// ============================================

/**
 * `n = N; Z = true; p = A; q = "lit";
 *  do { if (n == 0) break; n = n + -1; Z = *p == *q; p = p + 1; q = q + 1; } while (Z);`
 * is `repe cmpsb` over N bytes. With q the literal and N its length plus the NUL, Z is
 * exactly `strcmp(A, "lit") == 0`: both stop at the first byte that differs, A's
 * terminator differs from a literal character, and equal through the literal's NUL is
 * equal strings. The setup statements may sit anywhere before the loop among unrelated
 * assignments; p, q and n must be dead after it. (The original source, compiled with
 * /Oi, spelled this strcmp; MSVC's memcmp intrinsic is the same instruction but its
 * length would not be the literal's plus one.)
 */
/** STRING_INTRINSICS_TRACE=1 logs why a strcmp loop was left alone. */
const TRACE = typeof process !== 'undefined' && process.env?.STRING_INTRINSICS_TRACE === '1';
const fail = (why: number): null => {
  if (TRACE) console.error(`[string-intrinsics] strcmp rejected at check ${why}`);
  return null;
};

function tryStrcmp(list: Statement[], i: number, body: Statement[], deps: StringIntrinsicDeps): Statement[] | null {
  const loop = list[i];
  if (loop.kind !== NodeKind.DoWhileStmt) return fail(1);
  const Z = identName((loop as DoWhileStmt).condition);
  if (!Z) return fail(2);
  const st = bodyStatements((loop as DoWhileStmt).body);
  if (st.length !== 5) return fail(3);
  // if (n == 0) break;
  const brk = st[0] as unknown as { kind: NodeKind; condition: Expression; thenBranch: Statement; elseBranch: Statement | null };
  if (brk.kind !== NodeKind.IfStmt || brk.elseBranch) return fail(4);
  const then = bodyStatements(brk.thenBranch);
  if (then.length !== 1 || then[0].kind !== NodeKind.BreakStmt) return fail(5);
  const c = unwrapParens(brk.condition);
  if (c.kind !== NodeKind.BinaryExpr || (c as BinaryExpr).operator !== '==' || literalOf((c as BinaryExpr).right) !== 0n) return fail(6);
  const n = identName((c as BinaryExpr).left);
  if (!n) return fail(7);
  // n = n + -1 / n - 1
  const dec = assignOf(st[1]);
  const decR = dec && unwrapParens(dec.right);
  if (!dec || identName(dec.left) !== n || !decR || decR.kind !== NodeKind.BinaryExpr) return fail(8);
  const db = decR as BinaryExpr;
  const k = literalOf(db.right);
  if (identName(db.left) !== n || !((db.operator === '+' && k === -1n) || (db.operator === '-' && k === 1n))) return fail(9);
  // Z = *p == *q
  const cmp = assignOf(st[2]);
  const cmpR = cmp && unwrapParens(cmp.right);
  if (!cmp || identName(cmp.left) !== Z || !cmpR || cmpR.kind !== NodeKind.BinaryExpr || (cmpR as BinaryExpr).operator !== '==') return fail(10);
  const p = identName(derefOf((cmpR as BinaryExpr).left) ?? undefined);
  const q = identName(derefOf((cmpR as BinaryExpr).right) ?? undefined);
  if (!p || !q || p === q || new Set([n, Z, p, q]).size !== 4) return fail(11);
  // p = p + 1; q = q + 1 (either order), byte pointers.
  const steps = new Set<string>();
  for (const s of [st[3], st[4]]) {
    const a = assignOf(s);
    const r = a && unwrapParens(a.right);
    const v = a && identName(a.left);
    if (!a || !v || !r || r.kind !== NodeKind.BinaryExpr || (r as BinaryExpr).operator !== '+' || identName((r as BinaryExpr).left) !== v || literalOf((r as BinaryExpr).right) !== 1n) return fail(12);
    steps.add(v);
  }
  if (!steps.has(p) || !steps.has(q)) return fail(13);
  for (const v of [p, q]) if (pointeeSize(deps.shape(Expr.identifier(v)), deps) !== 1) return fail(14);
  // The setup: n = N; Z = true; q = "lit"; optionally p = A. Walk back over assignments.
  const setup = new Map<string, { index: number; rhs: Expression }>();
  const kept: number[] = [];
  for (let j = i - 1; j >= 0 && i - j <= 8; j--) {
    const a = assignOf(list[j]);
    const v = a && identName(a.left);
    if (!a || !v) break;
    if ([n, Z, q, p].includes(v) && !setup.has(v)) { setup.set(v, { index: j, rhs: a.right }); continue; }
    if ([n, Z, q, p].includes(v)) break;
    kept.push(j);
  }
  const nInit = setup.get(n), zInit = setup.get(Z), qInit = setup.get(q);
  if (!nInit || !zInit || !qInit) return fail(15);
  const zLit = unwrapParens(zInit.rhs);
  const zTrue = (zLit.kind === NodeKind.BoolLiteral && (zLit as unknown as { value: boolean }).value) || literalOf(zLit) === 1n;
  // The literal, possibly under a pointer cast (`(char *)"0"`).
  let lit = unwrapParens(qInit.rhs);
  if (lit.kind === NodeKind.CStyleCastExpr) lit = unwrapParens((lit as CStyleCastExpr).expression);
  if (!zTrue || lit.kind !== NodeKind.StringLiteral) return fail(16);
  const text = (lit as unknown as { value: string; prefix: string }).value;
  if ((lit as unknown as { prefix: string }).prefix || text.includes('\0')) return fail(17);
  const N = literalOf(nInit.rhs);
  if (N === null || N !== BigInt(text.length + 1)) return fail(18);
  // A: p's setup value, or p itself; nothing kept between may change what it names.
  const pInit = setup.get(p);
  const A = pInit ? pInit.rhs : Expr.identifier(p);
  if (!deps.isPure(A) || hasCall(A)) return fail(19);
  const aNames = new Set<string>();
  collectNames(A, aNames);
  // Only what runs between p's setup and the loop can change what A names.
  for (const j of kept) {
    if (pInit && j < pInit.index) continue;
    const v = identName(assignOf(list[j])!.left);
    if (v && aNames.has(v)) return fail(20);
    if (hasCall(list[j]) && pInit) return fail(21);
  }
  // p, q and n are dead after the loop.
  const flow = buildFunctionFlow(body, deps.locals);
  const loopNodes = new Set<number>();
  for (const node of flow.cfg.nodes) {
    if (node.stmt && contains(loop, node.stmt)) loopNodes.add(node.id);
  }
  const removed = new Set<Statement>([list[nInit.index], list[qInit.index], ...(pInit ? [list[pInit.index]] : [])]);
  for (const node of flow.cfg.nodes) if (node.stmt && removed.has(node.stmt as Statement)) loopNodes.add(node.id);
  for (const v of [p, q, n]) {
    if (flow.isEscaped(v)) return fail(22);
    for (const id of loopNodes) {
      if (!flow.definition(id, v)) continue;
      if (flow.usesOf(id, v).some(u => !loopNodes.has(u))) return fail(23);
    }
  }
  // Z's own setup goes too: the new assignment defines it on every path.
  const call = Expr.binary(Expr.call(Expr.identifier('strcmp'), [A, Expr.stringLiteral(text)]), '==', Expr.intLiteral(0n));
  const assign = { kind: NodeKind.ExprStmt, expression: Expr.assign(Expr.identifier(Z), call) } as unknown as Statement;
  const drop = new Set([nInit.index, zInit.index, qInit.index, ...(pInit ? [pInit.index] : [])]);
  const edited: Statement[] = [];
  list.forEach((s2, idx) => {
    if (idx === i) edited.push(assign);
    else if (!drop.has(idx)) edited.push(s2);
  });
  return dropUnreferencedDecls(replaceList(body, list, edited), new Set([n, p, q]));
}

function collectNames(e: unknown, out: Set<string>): void {
  if (Array.isArray(e)) { e.forEach(x => collectNames(x, out)); return; }
  if (!e || typeof e !== 'object') return;
  const o = e as Record<string, unknown>;
  if (o.kind === NodeKind.Identifier) out.add(o.name as string);
  for (const [k, v] of Object.entries(o)) {
    if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
    if (v && typeof v === 'object') collectNames(v, out);
  }
}

/**
 * The value a local holds when `at` starts, as an expression: its single reaching
 * definition `v = E`, provided E is pure, reads only locals that are not escaped, and
 * nothing it reads (nor v) is written on any path from the definition to `at`.
 */
function windowStartValue(flow: FunctionFlow, at: Statement, deps: StringIntrinsicDeps): (name: string) => Expression | null {
  // A loop's own node is its condition, where its body's definitions reach too: anchor at
  // the body's first statement and count only definitions from outside the loop.
  let anchor: Statement = at;
  const inLoop = new Set<number>();
  if (at.kind === NodeKind.DoWhileStmt) {
    const first = bodyStatements((at as DoWhileStmt).body)[0];
    if (first) anchor = first;
    for (const n of flow.cfg.nodes) if (n.stmt && contains(at, n.stmt)) inLoop.add(n.id);
  }
  const node = flow.nodeOf(anchor);
  return (name) => {
    if (node === undefined || !deps.locals.has(name) || flow.isEscaped(name)) return null;
    const defs = new Set([...flow.reaching(node, name)].filter(d => !inLoop.has(d)));
    if (defs.size !== 1) return null;
    const d = [...defs][0];
    if (d === ENTRY_DEF) return null;
    const info = flow.definition(d, name);
    if (!info || !info.killing || !info.rhs || !deps.isPure(info.rhs) || hasCall(info.rhs)) return null;
    const reads = new Set<string>([name]);
    collectNames(info.rhs, reads);
    for (const r of reads) if (!deps.locals.has(r) || flow.isEscaped(r)) {
      // A global or escaped name could change through any call: only arrays (addresses) are stable.
      if (!deps.localArrays.has(r)) return null;
    }
    if (flow.writtenBetween(d, node, reads)) return null;
    return info.rhs;
  };
}

const isPlainStmt = (s: Statement) => s.kind === NodeKind.ExprStmt || s.kind === NodeKind.DoWhileStmt || s.kind === NodeKind.ForStmt;

/** Does the expression call anything? */
function hasCall(x: unknown): boolean {
  if (Array.isArray(x)) return x.some(hasCall);
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (o.kind === NodeKind.CallExpr) return true;
  for (const [k, v] of Object.entries(o)) {
    if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
    if (v && typeof v === 'object' && hasCall(v)) return true;
  }
  return false;
}

type Event =
  | { kind: 'scan'; index: number; scan: Scan; start: Addr }
  | { kind: 'copy'; index: number; copy: Copy; dst: Addr; src: Addr; length: Addr; env: Map<string, Addr> }
  | { kind: 'assign'; index: number; name: string; pure: boolean }
  | { kind: 'store'; index: number; at: Addr; bytes: bigint[] };

/**
 * Walk the straight-line window from list[i] (no call, no label, at most 16 statements),
 * keeping each local's symbolic byte address, and try the patterns on what it saw.
 */
function tryAt(list: Statement[], i: number, body: Statement[], deps: StringIntrinsicDeps, flow: FunctionFlow): Statement[] | null {
  const env = new Map<string, Addr>();
  const addr = makeAddress(deps, env, windowStartValue(flow, list[i], deps));
  const events: Event[] = [];
  for (let j = i; j < list.length && j < i + 16; j++) {
    const st = list[j];
    if (!isPlainStmt(st) || hasCall(st)) break;
    const sc = scanShape(st, addr);
    if (sc) {
      const start = env.get(sc.ptr) ?? addr.value(Expr.identifier(sc.ptr)) ?? atom(`v:${sc.ptr}`);
      events.push({ kind: 'scan', index: j, scan: sc, start });
      // After the loop the pointer holds a new value: an atom tied to this loop; an address
      // temporary is that value plus its offset, a byte temporary is unknown.
      const exit = atom(`after:${j}:${sc.ptr}`);
      env.set(sc.ptr, exit);
      for (const t of sc.temps) env.set(t.name, t.offset !== null ? plus(exit, t.offset) : atom(`after:${j}:${t.name}`));
      continue;
    }
    if (st.kind === NodeKind.ForStmt && j + 1 < list.length) {
      const cp = copyShape(list[j], list[j + 1], addr);
      if (!cp) break;
      const dst = env.get(cp.dst) ?? addr.value(Expr.identifier(cp.dst)) ?? atom(`v:${cp.dst}`);
      const src = env.get(cp.src) ?? addr.value(Expr.identifier(cp.src)) ?? atom(`v:${cp.src}`);
      const length = addr.value(cp.length);
      if (!length) break;
      events.push({ kind: 'copy', index: j, copy: cp, dst, src, length, env: new Map(env) });
      env.set(cp.dst, addAddr(dst, length));
      env.set(cp.src, addAddr(src, length));
      for (const c of cp.counts) env.set(c, constAddr(0n));
      j++;
      continue;
    }
    if (st.kind !== NodeKind.ExprStmt) break;
    const a = assignOf(st);
    if (!a) break;
    const name = identName(a.left);
    if (name && deps.locals.has(name) && !deps.localArrays.has(name)) {
      const v = addr.value(a.right);
      env.set(name, v ?? atom(`opaque:${j}:${name}`));
      events.push({ kind: 'assign', index: j, name, pure: v !== null && deps.isPure(a.right) });
      continue;
    }
    // A store of a constant through memory (`*(u16*)end = 0x29`, `end[0] = '\n'`).
    const k = literalOf(a.right);
    const target = unwrapParens(a.left);
    const width = storeWidth(target, deps);
    const at = width ? addr.lvalue(target) : null;
    if (k === null || !width || !at) break;
    const bytes: bigint[] = [];
    for (let b = 0; b < width; b++) bytes.push((norm(k) >> BigInt(8 * b)) & 0xffn);
    events.push({ kind: 'store', index: j, at, bytes });
  }
  if (events.length === 0) return null;
  if (TRACE && events.some(e => e.kind === 'scan')) {
    const show = (a: Addr) => [...a.terms].map(([k, v]) => `${v === 1n ? '' : v + '*'}${k}`).join('+') + (a.c ? `+${a.c >= (1n << 31n) ? a.c - MOD : a.c}` : '');
    console.error('[string-intrinsics] window', events.map(e => e.kind === 'scan' ? `scan(${e.scan.kind} ${e.scan.ptr} from ${show(e.start)})`
      : e.kind === 'copy' ? `copy(${show(e.dst)} <- ${show(e.src)} x ${show(e.length)})` : e.kind === 'store' ? `store(${show(e.at)})` : `${e.name}=`).join('; '));
  }
  return matchStrcat(list, events, body, deps);
}

/** Bytes a store writes: the access width from the cast or the pointer's pointee. */
function storeWidth(target: Expression, deps: StringIntrinsicDeps): number | null {
  const x = unwrapParens(target);
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '*') {
    const p = unwrapParens((x as UnaryExpr).operand);
    if (p.kind === NodeKind.CStyleCastExpr) {
      const t = emit((p as CStyleCastExpr).type as unknown as AnyNode).replace(/\s+/g, '');
      if (/^(uint16_t|undefined2|ushort|short|WORD|int16_t)\*$/.test(t)) return 2;
      if (/^(uint32_t|undefined4|uint|int|DWORD|int32_t)\*$/.test(t)) return 4;
      if (/^(uint8_t|undefined1|byte|char|BYTE|int8_t)\*$/.test(t)) return 1;
      return null;
    }
    const n = pointeeSize(deps.shape(p), deps);
    return n === 1 || n === 2 || n === 4 ? n : null;
  }
  if (x.kind === NodeKind.SubscriptExpr) {
    const n = pointeeSize(deps.shape((x as SubscriptExpr).array), deps);
    return n === 1 ? 1 : null;
  }
  return null;
}

/**
 * Can the objects at `a` and `b` not overlap? A frame object and an address that is not
 * frame-based (a parameter, a global, a pointer loaded from memory: the frame is created
 * on entry, so nothing from outside points into it), or two different frame slots.
 */
function distinctObjects(a: Addr, b: Addr, deps: StringIntrinsicDeps): boolean {
  const fa = a.terms.has('frame'), fb = b.terms.has('frame');
  if (fa !== fb) {
    // The non-frame side must not be a pointer computed from the frame (a local holding &buf).
    const other = fa ? b : a;
    return [...other.terms.keys()].every(k => k.startsWith('v:') && !deps.localArrays.has(k.slice(2)) || k.startsWith('&g:'));
  }
  if (!fa) return false;
  const slotOf = (x: Addr) => {
    if (x.terms.size !== 1) return null;
    const off = x.c >= (1n << 31n) ? x.c - MOD : x.c;
    return (deps.stackSlots ?? []).find(s => off >= BigInt(s.offset) && off < BigInt(s.offset + s.size))?.name ?? null;
  };
  const sa = slotOf(a), sb = slotOf(b);
  return !!sa && !!sb && sa !== sb;
}
const isAfter = (a: Addr, key: string) => a.terms.size === 1 && a.terms.get(key) === 1n && a.c === 0n;

/**
 * strcat(D, S): an end scan from D - 1, a strlen scan of S, and a copy of (tail - S)
 * bytes from S to the end. strcat(D, "lit"): an end scan from D - 1 and stores of the
 * literal's bytes, NUL last, at the end.
 */
function matchStrcat(list: Statement[], evs: Event[], body: Statement[], deps: StringIntrinsicDeps): Statement[] | null {
  for (const end of evs) {
    if (end.kind !== 'scan' || end.scan.kind !== 'end') continue;
    const D = plus(end.start, 1n);
    const endKey = `after:${end.index}:${end.scan.ptr}`;
    // ---- strcat(D, S)
    const cp = evs.find(e => e.kind === 'copy' && e.index > end.index) as Extract<Event, { kind: 'copy' }> | undefined;
    if (cp && isAfter(cp.dst, endKey)) {
      const sc = evs.find(e => e.kind === 'scan' && e.scan.kind === 'strlen' && e.index < cp.index && e !== end
        && sameAddr(e.start, cp.src)
        && sameAddr(cp.length, addAddr(atom(`after:${e.index}:${e.scan.ptr}`), e.start, -1n))) as Extract<Event, { kind: 'scan' }> | undefined;
      // strcat requires the two strings not to overlap: they must be provably distinct objects.
      if (sc && distinctObjects(D, sc.start, deps)) {
        const temps = [sc.scan.ptr, ...sc.scan.temps.map(t => t.name), end.scan.ptr, ...end.scan.temps.map(t => t.name),
          cp.copy.dst, cp.copy.src, ...cp.copy.counts];
        const idiom = [sc.index, end.index, cp.index, cp.index + 1];
        const out = replaceGroup(list, evs, idiom, temps, body, deps, () => {
          const dst = spellAddress(D, deps);
          const src = spellAddress(sc.start, deps) ?? spellByHolder(sc.start, cp.env, new Set(temps.filter((t): t is string => !!t)), deps);
          return dst && src ? callStmt('strcat', [dst, src]) : null;
        }, [sc.start]);
        if (out) return out;
      }
    }
    // ---- strcat(D, "lit")
    const bytes: bigint[] = [];
    const stores: number[] = [];
    for (const e of evs) {
      if (e.index <= end.index) continue;
      if (e.kind === 'assign') { if (e.name === end.scan.ptr) break; continue; }
      if (e.kind !== 'store') break;
      const d0 = constDiff(e.at, atom(endKey));
      if (d0 === null || Number(d0) !== bytes.length) break;
      bytes.push(...e.bytes);
      stores.push(e.index);
      if (bytes.includes(0n)) break;
    }
    const nul = bytes.indexOf(0n);
    const printable = (b: bigint) => (b >= 0x20n && b < 0x7fn) || b === 0x0an || b === 0x09n;
    if (stores.length > 0 && nul === bytes.length - 1 && bytes.slice(0, nul).every(printable)) {
      const text = String.fromCharCode(...bytes.slice(0, nul).map(Number));
      const out = replaceGroup(list, evs, [end.index, ...stores], [end.scan.ptr, ...end.scan.temps.map(t => t.name)], body, deps, () => {
        const dst = spellAddress(D, deps);
        return dst ? callStmt('strcat', [dst, Expr.stringLiteral(text)]) : null;
      }, []);
      if (out) return out;
    }
  }
  return null;
}

function callStmt(fn: string, args: Expression[]): Statement {
  return { kind: NodeKind.ExprStmt, expression: Expr.call(Expr.identifier(fn), args) } as unknown as Statement;
}

/**
 * Replace the idiom's statements (`idiom` plus the assignments to `temps` between its
 * first and last statement) by `make()`, placed where the last of them was. Every other
 * statement between stays where it is; it must be a pure assignment of a local that is
 * not a temporary (it cannot see the string the call writes, which is written at the end
 * exactly as before). The temporaries must be dead after the group, and the variables the
 * call's arguments are spelled from must not change inside it.
 */
function replaceGroup(
  list: Statement[], evs: Event[], idiom: number[], temps: Array<string | null>, body: Statement[],
  deps: StringIntrinsicDeps, make: () => Statement | null, inputs: Addr[],
): Statement[] | null {
  const tempSet = new Set(temps.filter((t): t is string => !!t));
  let first = Math.min(...idiom);
  const last = Math.max(...idiom);
  const remove = new Set(idiom);
  // The temporaries' setup right before the group (`p = src;`, `q = dst - 1;`) is part
  // of it: walk back over assignments to temporaries in the window.
  const byIndex = new Map(evs.map(e => [e.index, e]));
  for (let k = first - 1; ; k--) {
    const e = byIndex.get(k);
    if (!e || e.kind !== 'assign') break;
    if (tempSet.has(e.name)) { remove.add(k); first = k; continue; }
    if (e.pure) continue;
    break;
  }
  for (const e of evs) {
    if (e.index < first || e.index > last || remove.has(e.index)) continue;
    if (e.kind === 'assign' && tempSet.has(e.name)) { remove.add(e.index); continue; }
    if (e.kind === 'assign' && e.pure) continue;
    if (e.kind === 'copy' && remove.has(e.index - 1)) continue;
    return null;
  }
  // A kept assignment may not write a variable the call's arguments are spelled from.
  const inputNames = new Set<string>();
  for (const a of inputs) for (const k of a.terms.keys()) if (k.startsWith('v:')) inputNames.add(k.slice(2));
  for (const e of evs) {
    if (e.index < first || e.index > last || e.kind !== 'assign') continue;
    if (inputNames.has(e.name)) return null;
  }
  const replacement = make();
  if (!replacement) return null;
  // Temporaries are dead afterwards: no definition inside the group reaches a use outside it.
  const removed = new Set<Statement>([...remove].map(k => list[k]));
  const flow = buildFunctionFlow(body, deps.locals);
  const groupNodes = new Set<number>();
  for (const n of flow.cfg.nodes) {
    const st = n.stmt as ASTNode | null;
    if (st && [...removed].some(r => r === st || contains(r, st))) groupNodes.add(n.id);
    if (!st && n.expr && [...removed].some(r => contains(r, n.expr))) groupNodes.add(n.id);
  }
  for (const t of tempSet) {
    if (flow.isEscaped(t)) return null;
    for (const id of groupNodes) {
      if (!flow.definition(id, t)) continue;
      if (flow.usesOf(id, t).some(u => !groupNodes.has(u))) return null;
    }
  }
  const edited: Statement[] = [];
  list.forEach((st, k) => {
    if (k === last) edited.push(replacement);
    else if (!remove.has(k)) edited.push(st);
  });
  return dropUnreferencedDecls(replaceList(body, list, edited), tempSet);
}

/** `T v;` (no initializer) for a name in `names` that nothing references any more. */
function dropUnreferencedDecls(body: Statement[], names: ReadonlySet<string>): Statement[] {
  const refs = new Map<string, number>();
  const count = (x: unknown): void => {
    if (Array.isArray(x)) { x.forEach(count); return; }
    if (!x || typeof x !== 'object') return;
    const o = x as Record<string, unknown>;
    if (o.kind === NodeKind.VariableDecl) { if (o.initializer) count(o.initializer); return; }
    if (o.kind === NodeKind.Identifier) refs.set(o.name as string, (refs.get(o.name as string) ?? 0) + 1);
    for (const [k, v] of Object.entries(o)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
      if (v && typeof v === 'object') count(v);
    }
  };
  count(body);
  const dead = (st: Statement) => {
    if (st.kind !== NodeKind.DeclStmt) return false;
    const ds = (st as unknown as { declarations: VariableDecl[] }).declarations;
    return ds.length === 1 && ds[0].kind === NodeKind.VariableDecl && !ds[0].initializer
      && names.has(ds[0].name.name) && (refs.get(ds[0].name.name) ?? 0) === 0;
  };
  const go = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(go);
    if (!x || typeof x !== 'object') return x;
    const o = x as Record<string, unknown>;
    if (o.kind === NodeKind.CompoundStmt) {
      const st = (o.statements as Statement[]).filter(s => !dead(s)).map(s => go(s) as Statement);
      return { ...o, statements: st };
    }
    return x;
  };
  return body.filter(s => !dead(s)).map(s => go(s) as Statement);
}

function contains(root: unknown, target: unknown): boolean {
  if (root === target) return true;
  if (Array.isArray(root)) return root.some(r => contains(r, target));
  if (!root || typeof root !== 'object') return false;
  for (const [k, v] of Object.entries(root)) {
    if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
    if (v && typeof v === 'object' && contains(v, target)) return true;
  }
  return false;
}

/**
 * A local (not a temporary) that holds exactly `a` at the call: `(char *)p` when p
 * points at something wider than a byte, `p` itself otherwise.
 */
function spellByHolder(a: Addr, env: ReadonlyMap<string, Addr>, temps: ReadonlySet<string>, deps: StringIntrinsicDeps): Expression | null {
  for (const [name, v] of env) {
    if (temps.has(name) || !sameAddr(v, a)) continue;
    const sh = deps.shape(Expr.identifier(name));
    if (!sh || sh.stars !== 1) continue;
    const plainChar = /^(char)$/.test(sh.base);
    return plainChar ? Expr.identifier(name) : asCharPointer(Expr.identifier(name));
  }
  return null;
}

const asCharPointer = (e: Expression) => Expr.cast(Type.pointer(Type.char()), e);

/** A byte-array field reads as char * through a cast; a char array is one already. */
function fieldSpelling(e: Expression, aggregate: string, field: string, deps: StringIntrinsicDeps): Expression {
  const sp = deps.structFields?.[aggregate.replace(/^::/, '')]?.[field] ?? '';
  return /^(char|CHAR)\s*\[/.test(sp) ? e : asCharPointer(e);
}

/** The char-array field of `aggregate` at byte offset `off`, if any. */
function charArrayFieldAt(aggregate: string, off: bigint, deps: StringIntrinsicDeps): string | null {
  const agg = aggregate.replace(/^::/, '');
  const fields = deps.fieldOffsets?.[agg];
  if (!fields) return null;
  for (const [n, o] of Object.entries(fields)) {
    if (BigInt(o) !== off) continue;
    const sp = deps.structFields?.[agg]?.[n] ?? '';
    if (/^(char|byte|uchar|uint8_t|BYTE|CHAR|undefined1?)\s*\[\d*\]\s*$/.test(sp)) return n;
  }
  return null;
}

/**
 * An expression for a byte address: the frame array that starts there, a char-array
 * field of a frame struct, `p` for a char pointer, `p->field` for a struct pointer.
 */
function spellAddress(a: Addr, deps: StringIntrinsicDeps): Expression | null {
  if (a.terms.size !== 1) return null;
  const [[k, coef]] = [...a.terms];
  if (coef !== 1n) return null;
  const off = a.c >= (1n << 31n) ? a.c - MOD : a.c;
  if (k === 'frame') {
    for (const s of deps.stackSlots ?? []) {
      const rel = off - BigInt(s.offset);
      if (rel < 0n || rel >= BigInt(s.size)) continue;
      const arr = deps.localArrays.get(s.name);
      if (rel === 0n && arr && arr.elem === 1) {
        // strcat takes char *: a byte/uint8_t buffer is spelled through a cast.
        return arr.isChar ? Expr.identifier(s.name) : asCharPointer(Expr.identifier(s.name));
      }
      const sh = deps.shape(Expr.identifier(s.name));
      const f = sh && sh.stars === 0 ? charArrayFieldAt(sh.base, rel, deps) : null;
      if (f) return fieldSpelling(Expr.member(Expr.identifier(s.name), f), sh!.base, f, deps);
    }
    return null;
  }
  if (k.startsWith('v:')) {
    const name = k.slice(2);
    const sh = deps.shape(Expr.identifier(name));
    if (!sh || sh.stars !== 1) return null;
    if (off === 0n && pointeeSize(sh, deps) === 1) return sh.base === 'char' ? Expr.identifier(name) : asCharPointer(Expr.identifier(name));
    const f = charArrayFieldAt(sh.base, off, deps);
    return f ? fieldSpelling(Expr.member(Expr.identifier(name), f, true), sh.base, f, deps) : null;
  }
  return null;
}

function replaceList(body: Statement[], orig: Statement[], edited: Statement[]): Statement[] {
  if (body === orig) return edited;
  const go = (x: unknown): unknown => {
    if (Array.isArray(x)) {
      let changed = false;
      const out = x.map(i => { const r = go(i); if (r !== i) changed = true; return r; });
      return changed ? out : x;
    }
    if (!x || typeof x !== 'object') return x;
    const o = x as Record<string, unknown>;
    if (o.kind === NodeKind.CompoundStmt && o.statements === orig) return { ...o, statements: edited };
    let copy: Record<string, unknown> | null = null;
    for (const [k, v] of Object.entries(o)) {
      if (k === 'location' || !v || typeof v !== 'object') continue;
      const r = go(v);
      if (r !== v) { copy = copy ?? { ...o }; copy[k] = r; }
    }
    return copy ?? x;
  };
  return go(body) as Statement[];
}

/** For the plugin: the locals declared as arrays, with their element size. */
export function localArraysOf(body: ASTNode): Map<string, { elem: number; isChar: boolean }> {
  const out = new Map<string, { elem: number; isChar: boolean }>();
  const elemSize = (t: TypeNode): number | null => {
    const tt = t as unknown as { kind: NodeKind; elementType?: TypeNode };
    if (tt.kind !== NodeKind.ArrayType || !tt.elementType) return null;
    const name = emit(tt.elementType as unknown as AnyNode).replace(/\s+/g, ' ').trim();
    if (/^(char|byte|uchar|uint8_t|int8_t|BYTE|CHAR|undefined1|undefined|bool)$/.test(name)) return 1;
    if (/^(WCHAR|wchar_t|short|ushort|uint16_t|int16_t|wchar16|WORD)$/.test(name)) return 2;
    if (/^(int|uint|uint32_t|int32_t|DWORD|undefined4)$/.test(name)) return 4;
    return null;
  };
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (!x || typeof x !== 'object') return;
    const o = x as Record<string, unknown>;
    if (o.kind === NodeKind.VariableDecl) {
      const v = o as unknown as VariableDecl;
      const e = elemSize(v.type);
      const elemName = emit(((v.type as unknown as { elementType?: TypeNode }).elementType ?? v.type) as unknown as AnyNode).trim();
      if (e) out.set(v.name.name, { elem: e, isChar: /^(char|CHAR)$/.test(elemName) });
    }
    for (const [k, v] of Object.entries(o)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
      if (v && typeof v === 'object') walk(v);
    }
  };
  walk(body);
  return out;
}

