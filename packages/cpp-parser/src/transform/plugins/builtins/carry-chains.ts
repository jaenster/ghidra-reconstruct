/**
 * A 64-bit add or subtract the decompiler split into 32-bit halves, put back together
 * where both halves are provably one object.
 *
 * MSVC adds 64-bit values with ADD/ADC on the halves, and the decompiler prints them as
 * two stores joined by a carry (AcceptThreadMain 006c2860, per pipeline stage):
 *
 *   dwQpcDelta = acc.u.LowPart;
 *   acc.u.LowPart = acc.u.LowPart + (end.u.LowPart - start.u.LowPart);
 *   acc.u.HighPart = acc.u.HighPart
 *       + ((end.u.HighPart - start.u.HighPart) - (uint)(end.u.LowPart < start.u.LowPart))
 *       + (uint)CARRY4(dwQpcDelta, end.u.LowPart - start.u.LowPart);
 *
 * which is `acc.QuadPart += end.QuadPart - start.QuadPart`, by the definitions of add
 * with carry (hi' = h1 + h2 + carry(l1 + l2)) and subtract with borrow (hi' = h1 - h2 -
 * (l1 < l2)). This pass recovers that only when every half is a half of ONE 8-byte object
 * the types already name: a member `.u.LowPart`/`.u.HighPart` (or `.LowPart`/`.HighPart`)
 * of a LARGE_INTEGER, or `._0_4_`/`._4_4_` of an 8-byte value. Two separately typed
 * variables are never merged here; that is a retype in Ghidra.
 *
 * The proof runs over one straight-line run of expression statements (no call, no label
 * inside). Locals are resolved to what they were last assigned in the run (a register
 * copy of a half, a pointer to one), and every memory read carries the index of the last
 * store before it that may alias it, so a read of the low half before its store and one
 * after it are different values. The pair (lo, hi) is then matched recursively:
 *
 *   (X.lo, X.hi)                                  X
 *   (l1 + l2, h1 + h2 + CARRY4(l1, l2))           E1 + E2
 *   (l1 - l2, (h1 - h2) - (l1 < l2))              E1 - E2
 *
 * and the low store plus the high store become one 64-bit store at the high store's place.
 * That is value-preserving when nothing between the two stores reads the object or
 * stores to memory, and every half it reads was read before the low store (or is the
 * high half, which the low store does not touch). Temporaries whose only readers were the
 * two stores are removed. `CONCAT44(X.hi, X.lo)` of one object is X's 64-bit value.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  AssignExpr,
  BinaryExpr,
  CallExpr,
  CStyleCastExpr,
  DeclStmt,
  Expression,
  ExprStmt,
  Identifier,
  MemberExpr,
  Statement,
  UnaryExpr,
  VariableDecl,
} from '../../../ast/nodes.js';
import { Expr, Type } from '../../../ast/factory.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { buildFunctionFlow } from '../../cfg/dataflow.js';
import { unwrapParens, type TypeShape } from './call-arg-cast.js';

export interface CarryChainDeps {
  /** The declared shape of an expression (struct name, indirection), or null. */
  shape: (e: Expression) => TypeShape | null;
  isPure: (e: ASTNode) => boolean;
  /** Parameters and locals of the function. */
  locals: ReadonlySet<string>;
  /** Aggregate names that are unions (members overlap). */
  isUnion: (aggregate: string) => boolean;
}

const LARGE_INTEGERS = new Set(['LARGE_INTEGER', '_LARGE_INTEGER', 'ULARGE_INTEGER', '_ULARGE_INTEGER']);
const EIGHT_BYTE_INTS = new Set(['long long', 'unsigned long long', 'longlong', 'ulonglong', 'int64_t', 'uint64_t', '__int64', 'LONGLONG', 'ULONGLONG', 'QWORD', 'undefined8']);

const key = (e: Expression) => emit(e as AnyNode).replace(/\s+/g, ' ');
/**
 * An object's identity: its spelling with the memory-read markers inside its address
 * removed, so `p->a[i]` reached through a register copy and spelled directly agree. That
 * the address reads themselves did not change is checked separately (`addressReadsStable`).
 */
const objKeyOf = (e: Expression) => key(unmark(e));

// ============================================
// SYMBOLIC VALUES
// ============================================

/**
 * A value in the run: an expression over the run's initial state. Memory reads are
 * wrapped as `__mem(<version>, path)`; locals are substituted by what the run assigned.
 */
type Sym = Expression;

const MEM = '__carry_mem';
const memRead = (path: Expression, version: number): Sym =>
  Expr.call(Expr.identifier(MEM), [Expr.intLiteral(version), path]);
function asMemRead(e: Sym): { version: number; path: Expression } | null {
  const x = unwrapParens(e);
  if (x.kind !== NodeKind.CallExpr) return null;
  const c = x as CallExpr;
  if (c.callee.kind !== NodeKind.Identifier || (c.callee as Identifier).name !== MEM) return null;
  return { version: Number((c.arguments[0] as unknown as { value: bigint }).value), path: c.arguments[1] };
}

/** `(&X)->f` -> `X.f`, `*(&X)` -> `X`, parentheses dropped: one spelling per place. */
function normalizePath(e: Expression): Expression {
  const x = unwrapParens(e);
  if (x.kind === NodeKind.MemberExpr) {
    const m = x as MemberExpr;
    const obj = normalizePath(m.object);
    const o = unwrapParens(obj);
    if (m.isArrow) {
      if (o.kind === NodeKind.UnaryExpr && (o as UnaryExpr).operator === '&') {
        return { ...m, object: normalizePath((o as UnaryExpr).operand), isArrow: false } as Expression;
      }
      // `(a + i)->f` is `a[i].f`: C defines a[i] as *(a + i).
      if (o.kind === NodeKind.BinaryExpr && (o as BinaryExpr).operator === '+') {
        const sub = { kind: NodeKind.SubscriptExpr, array: (o as BinaryExpr).left, index: (o as BinaryExpr).right } as unknown as Expression;
        return { ...m, object: sub, isArrow: false } as Expression;
      }
    } else if (o.kind === NodeKind.UnaryExpr && (o as UnaryExpr).operator === '*') {
      // `(*p).f` is `p->f`.
      return { ...m, object: (o as UnaryExpr).operand, isArrow: true } as Expression;
    }
    return { ...m, object: o } as Expression;
  }
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '*') {
    const o = unwrapParens(normalizePath((x as UnaryExpr).operand));
    if (o.kind === NodeKind.UnaryExpr && (o as UnaryExpr).operator === '&') return normalizePath((o as UnaryExpr).operand);
    return { ...(x as object), operand: o } as Expression;
  }
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '&') {
    return { ...(x as object), operand: normalizePath((x as UnaryExpr).operand) } as Expression;
  }
  return x;
}

/** The chain of `.member` names from a root, and the root, for an lvalue path. */
function pathSegments(e: Expression): { root: Expression; members: string[]; viaPointer: boolean } {
  const members: string[] = [];
  let x = unwrapParens(e);
  let viaPointer = false;
  for (;;) {
    if (x.kind === NodeKind.MemberExpr) {
      const m = x as MemberExpr;
      members.unshift((m.member as Identifier).name ?? '?');
      if (m.isArrow) { viaPointer = true; }
      x = unwrapParens(m.object);
      if (m.isArrow) break;
      continue;
    }
    if (x.kind === NodeKind.SubscriptExpr || (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '*')) viaPointer = true;
    break;
  }
  return { root: x, members, viaPointer };
}

// ============================================
// THE PASS
// ============================================

interface Half { obj: Expression; part: 'lo' | 'hi'; version: number }

export function lowerCarryChains(body: Statement[], deps: CarryChainDeps): Statement[] {
  let current = body;
  for (let round = 0; round < 64; round++) {
    const next = lowerOneChain(current, deps);
    if (!next) break;
    current = next;
  }
  return current;
}

function containsCarry(x: unknown): boolean {
  if (Array.isArray(x)) return x.some(containsCarry);
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (o.kind === NodeKind.CallExpr) {
    const c = o as unknown as CallExpr;
    if (c.callee.kind === NodeKind.Identifier && /^CARRY4$/.test((c.callee as Identifier).name)) return true;
  }
  for (const [k, v] of Object.entries(o)) {
    if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
    if (v && typeof v === 'object' && containsCarry(v)) return true;
  }
  return false;
}

/**
 * A store whose target is spelled as a high half (`.HighPart`, `._4_4_`) or through a
 * pointer (`*p`, which may hold the address of one): where a subtract with borrow ends.
 */
function storesHighHalf(st: Statement): boolean {
  const a = assignOf(st);
  if (!a) return false;
  const l = unwrapParens(a.left);
  if (l.kind === NodeKind.UnaryExpr && (l as UnaryExpr).operator === '*') return true;
  if (l.kind !== NodeKind.MemberExpr) return false;
  const name = ((l as MemberExpr).member as Identifier).name;
  return name === 'HighPart' || name === '_4_4_';
}

function containsHighHalfStore(x: unknown): boolean {
  if (Array.isArray(x)) return x.some(containsHighHalfStore);
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (o.kind === NodeKind.ExprStmt && storesHighHalf(o as unknown as Statement)) {
    const l = unwrapParens(assignOf(o as unknown as Statement)!.left);
    if (l.kind === NodeKind.MemberExpr) return true;
  }
  for (const [k, v] of Object.entries(o)) {
    if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
    if (v && typeof v === 'object' && containsHighHalfStore(v)) return true;
  }
  return false;
}

/** A call other than the flag pseudo-ops. */
function hasRealCall(x: unknown): boolean {
  if (Array.isArray(x)) return x.some(hasRealCall);
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (o.kind === NodeKind.CallExpr) {
    const c = o as unknown as CallExpr;
    const name = c.callee.kind === NodeKind.Identifier ? (c.callee as Identifier).name : '';
    if (!/^(CARRY4|SBORROW4|CONCAT44)$/.test(name)) return true;
  }
  for (const [k, v] of Object.entries(o)) {
    if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
    if (v && typeof v === 'object' && hasRealCall(v)) return true;
  }
  return false;
}

function lowerOneChain(body: Statement[], deps: CarryChainDeps): Statement[] | null {
  const root = { kind: NodeKind.CompoundStmt, statements: body } as unknown as ASTNode;
  if (!containsCarry(root) && !containsHighHalfStore(root)) return null;
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
  const privateLocals = callOnlyAddressLocals(root, deps.locals);
  for (const list of lists) {
    const r = tryList(list, body, deps, privateLocals);
    if (r) return r;
  }
  return null;
}

/**
 * Locals whose address is only ever passed straight to a call (`QueryPerformanceCounter
 * (&qpcEnd)`) and never stored or computed with. Assuming, as the Win32 contracts these
 * calls have do, that a callee does not keep a stack address it was given, no pointer the
 * function dereferences can point into such a local: it does not alias memory reached
 * through a pointer.
 */
function callOnlyAddressLocals(root: ASTNode, locals: ReadonlySet<string>): Set<string> {
  const ok = new Set(locals);
  const visit = (x: unknown, parentIsCallArg: boolean): void => {
    if (Array.isArray(x)) { x.forEach(i => visit(i, parentIsCallArg)); return; }
    if (!x || typeof x !== 'object') return;
    const o = x as Record<string, unknown>;
    if (o.kind === NodeKind.UnaryExpr && o.operator === '&') {
      const seg = pathSegments(o.operand as Expression);
      if (seg.root.kind === NodeKind.Identifier && !parentIsCallArg) ok.delete((seg.root as Identifier).name);
    }
    if (o.kind === NodeKind.CallExpr) {
      const c = o as unknown as CallExpr;
      visit(c.callee, false);
      for (const a of c.arguments) visit(unwrapParens(a), true);
      return;
    }
    for (const [k, v] of Object.entries(o)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
      if (v && typeof v === 'object') visit(v, false);
    }
  };
  visit(root, false);
  return ok;
}

function assignOf(st: Statement): { left: Expression; right: Expression } | null {
  if (st.kind !== NodeKind.ExprStmt) return null;
  const e = unwrapParens((st as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
  return { left: (e as AssignExpr).left, right: (e as AssignExpr).right };
}

const isLabelled = (st: Statement) => st.kind === NodeKind.LabelStmt || st.kind === NodeKind.CaseStmt || st.kind === NodeKind.DefaultStmt;

function tryList(list: Statement[], body: Statement[], deps: CarryChainDeps, privateLocals: ReadonlySet<string>): Statement[] | null {
  for (let h = 0; h < list.length; h++) {
    if (!containsCarry(list[h]) && !storesHighHalf(list[h])) continue;
    // The run that ends at h: expression statements, no call, no label after its start.
    let start = h;
    while (start > 0 && list[start - 1].kind === NodeKind.ExprStmt && !hasRealCall(list[start - 1]) && !isLabelled(list[start])) start--;
    const out = tryChainAt(list, start, h, body, deps, privateLocals);
    if (out) return out;
  }
  return null;
}

/** Strip value-preserving 4-byte casts (`(uint)x`, `(int)x`) and parentheses. */
function stripWordCast(e: Expression): Expression {
  let x = unwrapParens(e);
  while (x.kind === NodeKind.CStyleCastExpr) {
    const t = emit((x as CStyleCastExpr).type as unknown as AnyNode).replace(/\s+/g, ' ');
    if (!/^(uint|int|uint32_t|int32_t|unsigned int|DWORD|LONG|ULONG)$/.test(t)) break;
    x = unwrapParens((x as CStyleCastExpr).expression);
  }
  return x;
}

/** Set CARRY_CHAINS_TRACE=1 to log why a carry chain was left alone. */
const TRACE = typeof process !== 'undefined' && process.env?.CARRY_CHAINS_TRACE === '1';
let traceAt = '';
const fail = (why: number): null => {
  if (TRACE) console.error(`[carry-chains] rejected at check ${why}${traceAt ? ` (${traceAt})` : ''}`);
  return null;
};

function tryChainAt(list: Statement[], start: number, h: number, body: Statement[], deps: CarryChainDeps, privateLocals: ReadonlySet<string>): Statement[] | null {
  if (TRACE) traceAt = key((list[h] as ExprStmt).expression ?? Expr.identifier('?')).slice(0, 60);
  // Only the run's first statement may carry a label: nothing enters in the middle.
  if (list.slice(start + 1, h + 1).some(isLabelled)) return fail(1);

  // ---- symbolic execution of the run
  const stores: Array<{ index: number; path: Expression }> = [];
  const localVal = new Map<string, Sym>();
  const symAt: Array<{ left: Expression; right: Sym; isStore: boolean; path?: Expression } | null> = [];
  const mayAlias = (a0: Expression, b0: Expression): boolean => {
    const a = normalizePath(unmark(a0)), b = normalizePath(unmark(b0));
    if (key(a) === key(b)) return true;
    const pa = pathSegments(a), pb = pathSegments(b);
    const ra = key(pa.root), rb = key(pb.root);
    // Two different non-pointer locals never overlap; nor does a local nothing holds the
    // address of with anything reached through a pointer.
    const localRoot = (p: typeof pa) => !p.viaPointer && p.root.kind === NodeKind.Identifier ? (p.root as Identifier).name : null;
    const la = localRoot(pa), lb = localRoot(pb);
    if (la && lb && la !== lb && deps.locals.has(la) && deps.locals.has(lb)) return false;
    if ((la && !lb && privateLocals.has(la) && pb.viaPointer) || (lb && !la && privateLocals.has(lb) && pa.viaPointer)) return false;
    if (ra !== rb || pa.viaPointer !== pb.viaPointer) return true;
    // Same root: they overlap unless they diverge at different members of a struct.
    const n = Math.min(pa.members.length, pb.members.length);
    for (let i = 0; i < n; i++) {
      if (pa.members[i] === pb.members[i]) continue;
      const owner = i === 0 ? pa.root : prefixExpr(pa, i);
      const sh = deps.shape(owner);
      const agg = sh && (sh.stars === 0 || (pa.viaPointer && i === 0 && sh.stars === 1)) ? sh.base : null;
      // A LARGE_INTEGER's `u` is a struct: its LowPart and HighPart are distinct.
      const halves = new Set([pa.members[i], pb.members[i]]);
      if (halves.has('LowPart') && halves.has('HighPart') && (pa.members[i - 1] === 'u' || (agg && LARGE_INTEGERS.has(agg)))) return false;
      return !(agg && !deps.isUnion(agg) && !LARGE_INTEGERS.has(agg));
    }
    return true;
  };
  const versionOf = (path: Expression, at: number): number => {
    let v = -1;
    for (const s of stores) if (s.index < at && mayAlias(s.path, path)) v = s.index;
    return v;
  };
  const resolve = (e: Expression, at: number, depth = 0): Sym | null => {
    if (depth > 12) return fail(2);
    const x = unwrapParens(e);
    if (x.kind === NodeKind.Identifier) {
      const name = (x as Identifier).name;
      const v = localVal.get(name);
      if (v) return v;
      return x;
    }
    if (x.kind === NodeKind.MemberExpr || (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '*') || x.kind === NodeKind.SubscriptExpr) {
      // A memory read: resolve the address part, then version it.
      const path = resolveLvalue(x, at, depth);
      if (!path) return fail(3);
      if (!isMemoryPath(path)) return path;
      const canon = canonicalHalf(path, deps);
      return memRead(canon, versionOf(canon, at));
    }
    if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '&') {
      const p = resolveLvalue((x as UnaryExpr).operand, at, depth);
      return p ? ({ ...(x as object), operand: p } as Expression) : null;
    }
    if (x.kind === NodeKind.CallExpr) {
      const c = x as CallExpr;
      if (c.callee.kind !== NodeKind.Identifier || !/^(CARRY4|CONCAT44)$/.test((c.callee as Identifier).name)) return fail(4);
      const args = c.arguments.map(a => resolve(a, at, depth + 1));
      if (args.some(a => !a)) return fail(5);
      return { ...c, arguments: args as Expression[] } as Expression;
    }
    // Any other expression: resolve its operands.
    let ok = true;
    const copy = rebuildShallow(x, child => {
      const r = resolve(child, at, depth + 1);
      if (!r) ok = false;
      return r ?? child;
    });
    return ok ? copy : null;
  };
  /** An lvalue with its address-forming parts resolved (pointer locals substituted). */
  const resolveLvalue = (e: Expression, at: number, depth: number): Expression | null => {
    const x = unwrapParens(e);
    if (x.kind === NodeKind.Identifier) {
      const name = (x as Identifier).name;
      // A local used as an lvalue root names itself, unless it holds an address (`p`).
      return x;
    }
    if (x.kind === NodeKind.MemberExpr) {
      const m = x as MemberExpr;
      if (m.isArrow) {
        const base = resolve(m.object, at, depth + 1);
        if (!base) return fail(6);
        return normalizePath({ ...m, object: base } as Expression);
      }
      const obj = resolveLvalue(m.object, at, depth + 1);
      return obj ? normalizePath({ ...m, object: obj } as Expression) : null;
    }
    if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '*') {
      const base = resolve((x as UnaryExpr).operand, at, depth + 1);
      if (!base) return fail(7);
      return normalizePath({ ...(x as object), operand: base } as Expression);
    }
    if (x.kind === NodeKind.SubscriptExpr) {
      const s = x as unknown as { array: Expression; index: Expression };
      const arr = resolveLvalue(s.array, at, depth + 1);
      const idx = resolve(s.index, at, depth + 1);
      if (!arr || !idx || asMemRead(idx)) return fail(8);
      return { ...(x as object), array: arr, index: idx } as Expression;
    }
    return fail(9);
  };
  const isMemoryPath = (p: Expression): boolean => {
    const x = unwrapParens(p);
    if (x.kind === NodeKind.Identifier) return false;
    const seg = pathSegments(x);
    // `local.member` is the local's own storage; still memory for aliasing purposes.
    return seg.members.length > 0 || seg.viaPointer || x.kind === NodeKind.UnaryExpr;
  };

  for (let i = start; i <= h; i++) {
    const st = list[i];
    const inner = isLabelled(st) ? (st as unknown as { statement: Statement }).statement : st;
    const a = assignOf(inner);
    if (!a) { symAt.push(null); if (inner.kind !== NodeKind.ExprStmt) return fail(10); continue; }
    const rhs = resolve(a.right, i);
    if (!rhs) return fail(11);
    const l = unwrapParens(a.left);
    if (l.kind === NodeKind.Identifier && deps.locals.has((l as Identifier).name)) {
      localVal.set((l as Identifier).name, rhs);
      symAt.push({ left: l, right: rhs, isStore: false });
    } else {
      const raw = resolveLvalue(l, i, 0);
      if (!raw) return fail(12);
      const path = canonicalHalf(raw, deps);
      stores.push({ index: i, path });
      symAt.push({ left: l, right: rhs, isStore: true, path });
    }
  }

  // ---- the high store
  const H = symAt[h - start];
  if (!H || !H.isStore || !H.path) return fail(13);
  const hHalf = halfOf(H.path, deps);
  if (!hHalf || hHalf.part !== 'hi') return fail(14);
  // The low store of the same object: the last store to its low half before h.
  let loIdx = -1;
  for (let i = h - 1; i >= start; i--) {
    const s = symAt[i - start];
    if (!s?.isStore || !s.path) continue;
    const half = halfOf(s.path, deps);
    if (half && half.part === 'lo' && objKeyOf(half.obj) === objKeyOf(hHalf.obj)) { loIdx = i; break; }
    // Any other store between the two: bail.
    return fail(15);
  }
  if (loIdx < 0) return fail(16);
  const L = symAt[loIdx - start]!;
  const objKey = objKeyOf(hHalf.obj);
  const preLoVersion = (p: Expression) => versionOf(p, loIdx);

  /** A half of one object read at the state before the low store. */
  const halfRead = (e: Sym): Half | null => {
    const x = stripWordCast(e);
    const m = asMemRead(x);
    if (!m) return fail(17);
    const half = halfOf(m.path, deps);
    if (!half) return fail(18);
    // The low half of the target must be the value before the low store; any other half
    // must have the version it had before the low store (the store does not touch it).
    if (m.version !== preLoVersion(m.path)) {
      if (TRACE) console.error(`[carry-chains] half ${key(m.path)} read at version ${m.version}, before the low store ${preLoVersion(m.path)}`);
      return fail(19);
    }
    return { ...half, version: m.version };
  };

  /**
   * The low half's structure decides both the 64-bit expression and the terms its high
   * half must be: X.lo -> [+X.hi]; l1 + l2 -> hi(l1), hi(l2), +CARRY4(l1, l2);
   * l1 - l2 -> hi(l1), -hi(l2), -(l1 < l2).
   */
  type Term = { sign: 1 | -1; match: (e: Expression) => boolean };
  const decompose = (lo: Sym, depth: number): { wide: Expression; terms: Term[] } | null => {
    if (depth > 4) return fail(20);
    const lh = halfRead(lo);
    if (lh) {
      if (lh.part !== 'lo') return fail(21);
      const w = wide(lh.obj, deps);
      if (!w) return fail(22);
      const objK = objKeyOf(lh.obj);
      return { wide: w, terms: [{ sign: 1, match: e => { const hh = halfRead(e); return !!hh && hh.part === 'hi' && objKeyOf(hh.obj) === objK; } }] };
    }
    const lx = stripWordCast(lo);
    if (lx.kind !== NodeKind.BinaryExpr) return fail(23);
    const lb = lx as BinaryExpr;
    if (lb.operator !== '+' && lb.operator !== '-') return fail(24);
    const d1 = decompose(lb.left, depth + 1);
    const d2 = d1 && decompose(lb.right, depth + 1);
    if (!d1 || !d2) return fail(25);
    if (lb.operator === '+') {
      return {
        wide: Expr.paren(Expr.binary(d1.wide, '+', d2.wide)),
        terms: [...d1.terms, ...d2.terms, { sign: 1, match: e => isCarryOf(e, lb.left, lb.right) }],
      };
    }
    return {
      wide: Expr.paren(Expr.binary(d1.wide, '-', d2.wide)),
      terms: [...d1.terms, ...d2.terms.map(t => ({ ...t, sign: (t.sign === 1 ? -1 : 1) as 1 | -1 })),
        { sign: -1, match: e => isBorrowOf(e, lb.left, lb.right) }],
    };
  };
  const pair = (lo: Sym, hi: Sym): Expression | null => {
    const d = decompose(lo, 0);
    const actual = sumTerms(hi);
    if (!d || !actual || actual.length !== d.terms.length) return fail(26);
    // Every expected term matches exactly one actual term of the same sign.
    const used = new Set<number>();
    for (const t of d.terms) {
      const i = actual.findIndex((a, k) => !used.has(k) && a.sign === t.sign && t.match(a.e));
      if (i < 0) return fail(27);
      used.add(i);
    }
    return d.wide;
  };

  const result = pair(L.right, H.right);
  if (!result) return fail(28);

  // Nothing between the two stores may read the target or store anything.
  for (let i = loIdx + 1; i < h; i++) {
    const s = symAt[i - start];
    if (!s) return fail(29);
    if (s.isStore) return fail(30);
    if (readsObject(s.right, objKey, deps)) return fail(31);
  }
  // The 64-bit expression is read at the high store's place: every object it names must
  // have the value it had before the low store. Only the low store intervenes, and it is
  // gone; so the reads stay valid. The address parts must not have changed either: they
  // are resolved expressions over the run's initial state, so a local they name must not
  // be assigned in the run.
  // A memory read inside an address (a pointer field the object is reached through) is
  // read again at the high store's place: no store between may change it.
  for (const m of nestedAddressReads([result, hHalf.obj])) {
    if (m.version !== versionOf(m.path, h)) return fail(34);
  }
  const assignedInRun = new Set<string>([...localVal.keys()]);
  if (namesAny(result, assignedInRun) || namesAny(hHalf.obj, assignedInRun)) return fail(32);

  // The new statement: X = X + E becomes X += E.
  const target = wide(hHalf.obj, deps);
  if (!target) return fail(33);
  let stmtExpr: Expression;
  const top = unwrapParens(result);
  if (top.kind === NodeKind.BinaryExpr && ((top as BinaryExpr).operator === '+' || (top as BinaryExpr).operator === '-')
    && objKeyOf(unwrapParens((top as BinaryExpr).left)) === objKeyOf(target)) {
    stmtExpr = Expr.assign(target, unmark((top as BinaryExpr).right), (top as BinaryExpr).operator === '+' ? '+=' : '-=');
  } else {
    stmtExpr = Expr.assign(target, unmark(result));
  }
  const newStmt = { ...(list[h] as object), expression: stmtExpr } as unknown as Statement;

  // Replace: low store removed, high store becomes the 64-bit store.
  const edited = list.map((s, i) => (i === h ? newStmt : s)).filter((_, i) => i !== loIdx);
  let out = replaceList(body, list, edited);
  // Temporaries whose readers were only the two stores.
  out = removeDeadTemps(out, deps, list.slice(start, h + 1));
  return out;
}

/** `+`/`-` terms of a sum, with signs, casts on terms kept. */
function sumTerms(e: Expression): Array<{ e: Expression; sign: 1 | -1 }> | null {
  const out: Array<{ e: Expression; sign: 1 | -1 }> = [];
  const go = (x: Expression, sign: 1 | -1): void => {
    const u = stripWordCast(x);
    if (u.kind === NodeKind.BinaryExpr && ((u as BinaryExpr).operator === '+' || (u as BinaryExpr).operator === '-')) {
      go((u as BinaryExpr).left, sign);
      go((u as BinaryExpr).right, (u as BinaryExpr).operator === '-' ? (sign === 1 ? -1 : 1) : sign);
      return;
    }
    out.push({ e: x, sign });
  };
  go(e, 1);
  return out;
}

function isCarryOf(e: Expression, l1: Expression, l2: Expression): boolean {
  const x = stripWordCast(e);
  if (x.kind !== NodeKind.CallExpr) return false;
  const c = x as CallExpr;
  if (c.callee.kind !== NodeKind.Identifier || (c.callee as Identifier).name !== 'CARRY4') return false;
  const [a, b] = c.arguments.map(stripWordCast);
  const k1 = key(stripWordCast(l1)), k2 = key(stripWordCast(l2));
  return (key(a) === k1 && key(b) === k2) || (key(a) === k2 && key(b) === k1);
}

function isBorrowOf(e: Expression, l1: Expression, l2: Expression): boolean {
  const x = stripWordCast(e);
  if (x.kind !== NodeKind.BinaryExpr || (x as BinaryExpr).operator !== '<') return false;
  return key(stripWordCast((x as BinaryExpr).left)) === key(stripWordCast(l1))
    && key(stripWordCast((x as BinaryExpr).right)) === key(stripWordCast(l2));
}

/** A half of an 8-byte object: the object and which half. */
function halfOf(path: Expression, deps: CarryChainDeps): { obj: Expression; part: 'lo' | 'hi' } | null {
  const x = unwrapParens(path);
  if (x.kind !== NodeKind.MemberExpr) return null;
  const m = x as MemberExpr;
  const name = (m.member as Identifier).name;
  /** The object a member access is taken of: `X` for `X.f`, `*p` for `p->f`. */
  const ownerOf = (me: MemberExpr): Expression =>
    me.isArrow ? Expr.unary('*', me.object) : unwrapParens(me.object);
  if (name === '_0_4_' || name === '_4_4_') {
    if (m.isArrow) return null;
    const sh = deps.shape(m.object);
    if (!sh || sh.stars !== 0 || !(LARGE_INTEGERS.has(sh.base) || EIGHT_BYTE_INTS.has(sh.base))) return null;
    return { obj: unwrapParens(m.object), part: name === '_0_4_' ? 'lo' : 'hi' };
  }
  if (name !== 'LowPart' && name !== 'HighPart') return null;
  let obj = ownerOf(m);
  // `X.u.LowPart`, or the anonymous-struct spelling `X.LowPart`.
  const inner = unwrapParens(m.object);
  if (!m.isArrow && inner.kind === NodeKind.MemberExpr && ((inner as MemberExpr).member as Identifier).name === 'u') {
    obj = ownerOf(inner as MemberExpr);
  }
  const sh = deps.shape(obj);
  if (!sh || sh.stars !== 0 || !LARGE_INTEGERS.has(sh.base)) return null;
  return { obj: normalizePath(obj), part: name === 'LowPart' ? 'lo' : 'hi' };
}

/** One spelling per half: `X.u.LowPart` / `X.u.HighPart`, or `X._0_4_` / `X._4_4_` of an integer. */
function canonicalHalf(path: Expression, deps: CarryChainDeps): Expression {
  const h = halfOf(path, deps);
  if (!h) return path;
  const sh = deps.shape(h.obj);
  if (sh && LARGE_INTEGERS.has(sh.base)) {
    return normalizePath(Expr.member(Expr.member(h.obj, 'u'), h.part === 'lo' ? 'LowPart' : 'HighPart'));
  }
  return Expr.member(h.obj, h.part === 'lo' ? '_0_4_' : '_4_4_');
}

/** The 64-bit value of an object: `X.QuadPart` for a LARGE_INTEGER, X itself otherwise. */
function wide(obj: Expression, deps: CarryChainDeps): Expression | null {
  const sh = deps.shape(obj);
  if (!sh || sh.stars !== 0) return null;
  if (LARGE_INTEGERS.has(sh.base)) {
    const o = unwrapParens(obj);
    // `(*p).QuadPart` reads as `p->QuadPart`.
    if (o.kind === NodeKind.UnaryExpr && (o as UnaryExpr).operator === '*') return Expr.member((o as UnaryExpr).operand, 'QuadPart', true);
    return Expr.member(obj, 'QuadPart');
  }
  if (EIGHT_BYTE_INTS.has(sh.base)) return obj;
  return null;
}

/** Remove the memory-read markers: the expression as it reads at its own place. */
function unmark(e: Expression): Expression {
  return rebuildDeep(e, x => {
    const m = asMemRead(x as Expression);
    return m ? unmark(m.path) : undefined;
  });
}

/** Memory reads nested inside the address part of another read (or of an object). */
function nestedAddressReads(es: Expression[]): Array<{ version: number; path: Expression }> {
  const out: Array<{ version: number; path: Expression }> = [];
  const visit = (e: Expression, inAddress: boolean): void => {
    rebuildDeep(e, x => {
      const m = asMemRead(x as Expression);
      if (!m) return undefined;
      if (inAddress) out.push(m);
      visit(m.path, true);
      return x;
    });
  };
  // The objects themselves are addresses: every read inside them counts.
  for (const e of es) visit(e, false);
  return out;
}

function readsObject(e: Expression, objKey: string, deps: CarryChainDeps): boolean {
  let hit = false;
  rebuildDeep(e, x => {
    const m = asMemRead(x as Expression);
    if (m) {
      const half = halfOf(m.path, deps);
      const k = half ? objKeyOf(half.obj) : objKeyOf(m.path);
      if (k === objKey || k.startsWith(objKey + '.') || objKey.startsWith(k)) hit = true;
    }
    return undefined;
  });
  return hit;
}

function namesAny(e: Expression, names: ReadonlySet<string>): boolean {
  let hit = false;
  rebuildDeep(unmark(e), x => {
    if (x.kind === NodeKind.Identifier && names.has((x as Identifier).name)) hit = true;
    return undefined;
  });
  return hit;
}

function prefixExpr(seg: { root: Expression; members: string[] }, n: number): Expression {
  let e = seg.root;
  for (let i = 0; i < n; i++) e = Expr.member(e, seg.members[i]);
  return e;
}

/** Rebuild one level: each direct child expression is mapped by `fn`. */
function rebuildShallow(x: Expression, fn: (child: Expression) => Expression): Expression {
  const out: Record<string, unknown> = { ...(x as object) };
  for (const [k, v] of Object.entries(x)) {
    if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'type') continue;
    if (Array.isArray(v)) out[k] = v.map(i => (i && typeof i === 'object' && 'kind' in i && isExpr(i as ASTNode) ? fn(i as Expression) : i));
    else if (v && typeof v === 'object' && 'kind' in (v as object) && isExpr(v as ASTNode)) out[k] = fn(v as Expression);
  }
  return out as unknown as Expression;
}

const EXPR_KINDS = new Set<string>([
  NodeKind.Identifier, NodeKind.BinaryExpr, NodeKind.UnaryExpr, NodeKind.ParenExpr, NodeKind.CStyleCastExpr,
  NodeKind.MemberExpr, NodeKind.SubscriptExpr, NodeKind.CallExpr, NodeKind.IntegerLiteral, NodeKind.ConditionalExpr,
  NodeKind.BoolLiteral, NodeKind.CharLiteral, NodeKind.QualifiedId,
]);
const isExpr = (n: ASTNode) => EXPR_KINDS.has(n.kind);

function rebuildDeep<T>(root: T, fn: (n: ASTNode) => ASTNode | undefined): T {
  const go = (x: unknown): unknown => {
    if (Array.isArray(x)) {
      let changed = false;
      const out = x.map(i => { const r = go(i); if (r !== i) changed = true; return r; });
      return changed ? out : x;
    }
    if (!x || typeof x !== 'object') return x;
    const o = x as Record<string, unknown>;
    if (typeof o.kind === 'string') {
      const r = fn(o as unknown as ASTNode);
      if (r !== undefined) return r;
    }
    let copy: Record<string, unknown> | null = null;
    for (const [k, v] of Object.entries(o)) {
      if (k === 'location' || !v || typeof v !== 'object') continue;
      const r = go(v);
      if (r !== v) { copy = copy ?? { ...o }; copy[k] = r; }
    }
    return copy ?? x;
  };
  return go(root) as T;
}

function replaceList(body: Statement[], orig: Statement[], edited: Statement[]): Statement[] {
  if (body === orig) return edited;
  const root = rebuildDeep({ kind: NodeKind.CompoundStmt, statements: body } as unknown as ASTNode, x => {
    if (x.kind === NodeKind.CompoundStmt && (x as unknown as { statements: Statement[] }).statements === orig) {
      return { ...(x as object), statements: edited } as unknown as ASTNode;
    }
    return undefined;
  });
  return (root as unknown as { statements: Statement[] }).statements;
}

/**
 * Remove assignments in `run` to locals whose definition no longer reaches any use, then
 * declarations of those locals that nothing references. Repeated: a temporary feeding
 * only another removed temporary goes too.
 */
function removeDeadTemps(body: Statement[], deps: CarryChainDeps, run: Statement[]): Statement[] {
  const runSet = new Set(run);
  let current = body;
  for (let round = 0; round < 16; round++) {
    const flow = buildFunctionFlow(current, deps.locals);
    const dead = new Set<Statement>();
    for (const n of flow.cfg.nodes) {
      const st = n.stmt;
      if (!st || !runSet.has(st)) continue;
      const a = assignOf(st);
      if (!a) continue;
      const l = unwrapParens(a.left);
      if (l.kind !== NodeKind.Identifier) continue;
      const v = (l as Identifier).name;
      if (!deps.locals.has(v) || flow.isEscaped(v) || !deps.isPure(a.right)) continue;
      if (flow.usesOf(n.id, v).length === 0) dead.add(st);
    }
    if (dead.size === 0) break;
    const root = rebuildDeep({ kind: NodeKind.CompoundStmt, statements: current } as unknown as ASTNode, function visit(x: ASTNode): ASTNode | undefined {
      if (x.kind !== NodeKind.CompoundStmt) return undefined;
      const st = (x as unknown as { statements: Statement[] }).statements;
      if (!st.some(s => dead.has(s))) return undefined;
      return { ...(x as object), statements: st.filter(s => !dead.has(s)).map(s => rebuildDeep(s, visit)) } as unknown as ASTNode;
    });
    current = (root as unknown as { statements: Statement[] }).statements;
  }
  // Declarations of locals nothing references any more.
  const refs = new Map<string, number>();
  rebuildDeep(current, x => {
    if (x.kind === NodeKind.Identifier) refs.set((x as Identifier).name, (refs.get((x as Identifier).name) ?? 0) + 1);
    if (x.kind === NodeKind.VariableDecl) {
      const init = (x as VariableDecl).initializer;
      if (init) rebuildDeep(init, y => { if (y.kind === NodeKind.Identifier) refs.set((y as Identifier).name, (refs.get((y as Identifier).name) ?? 0) + 1); return undefined; });
      return x;
    }
    return undefined;
  });
  return current.filter(s => {
    if (s.kind !== NodeKind.DeclStmt) return true;
    const ds = (s as DeclStmt).declarations as VariableDecl[];
    return !(ds.length === 1 && ds[0].kind === NodeKind.VariableDecl && !ds[0].initializer && (refs.get(ds[0].name.name) ?? 0) === 0
      && runDeclared(run, ds[0].name.name));
  });
}

/** Was `name` assigned in the run (so its declaration may be ours to remove)? */
function runDeclared(run: Statement[], name: string): boolean {
  return run.some(s => {
    const a = assignOf(s);
    const l = a && unwrapParens(a.left);
    return !!l && l.kind === NodeKind.Identifier && (l as Identifier).name === name;
  });
}

// ============================================
// CONCAT44 OF ONE OBJECT
// ============================================

/** `CONCAT44(X.hi, X.lo)` of one 8-byte object X: X's 64-bit value, as `(uint64_t)`. */
export function lowerWholeConcat(e: Expression, deps: CarryChainDeps): Expression | null {
  const x = unwrapParens(e);
  if (x.kind !== NodeKind.CallExpr) return null;
  const c = x as CallExpr;
  if (c.callee.kind !== NodeKind.Identifier || (c.callee as Identifier).name !== 'CONCAT44' || c.arguments.length !== 2) return null;
  const hi = halfOf(normalizePath(stripWordCast(c.arguments[0])), deps);
  const lo = halfOf(normalizePath(stripWordCast(c.arguments[1])), deps);
  if (!hi || !lo || hi.part !== 'hi' || lo.part !== 'lo' || key(hi.obj) !== key(lo.obj) || !deps.isPure(hi.obj)) return null;
  const w = wide(hi.obj, deps);
  return w && Expr.cast(Type.typedef('uint64_t'), w);
}

/**
 * `!X.lo && !X.hi` (or `X.lo == 0 && X.hi == 0`) of one 8-byte object is `X == 0`, and
 * `X.lo != 0 || X.hi != 0` is `X != 0`: both halves zero is the whole value zero. The
 * object must be pure (it is read once instead of twice).
 */
export function lowerWholeZeroTest(e: Expression, deps: CarryChainDeps): Expression | null {
  const x = unwrapParens(e);
  if (x.kind !== NodeKind.BinaryExpr) return null;
  const b = x as BinaryExpr;
  if (b.operator !== '&&' && b.operator !== '||') return null;
  const wantZero = b.operator === '&&';
  /** The half a zero test (`!h`, `h == 0`) or non-zero test (`h`, `h != 0`) is of. */
  const tested = (t: Expression): { obj: Expression; part: 'lo' | 'hi' } | null => {
    const u = unwrapParens(t);
    let operand: Expression | null = null;
    if (wantZero) {
      if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') operand = (u as UnaryExpr).operand;
      else if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '==' && isZeroLiteral((u as BinaryExpr).right)) operand = (u as BinaryExpr).left;
    } else if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '!=' && isZeroLiteral((u as BinaryExpr).right)) {
      operand = (u as BinaryExpr).left;
    }
    if (!operand) return null;
    return halfOf(normalizePath(stripWordCast(operand)), deps);
  };
  const l = tested(b.left), r = tested(b.right);
  if (!l || !r || l.part === r.part || key(l.obj) !== key(r.obj) || !deps.isPure(l.obj)) return null;
  const w = wide(l.obj, deps);
  if (!w) return null;
  return Expr.paren(Expr.binary(w, wantZero ? '==' : '!=', Expr.intLiteral(0n)));
}

function isZeroLiteral(e: Expression): boolean {
  const x = unwrapParens(e);
  return x.kind === NodeKind.IntegerLiteral && (x as unknown as { value: bigint }).value === 0n;
}
