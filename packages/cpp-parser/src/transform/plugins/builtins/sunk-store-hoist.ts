/**
 * Sunk Store Hoist Plugin
 *
 * The decompiler treats a load through a pointer as never reading the stack. A store into
 * an element of an address-taken local array or struct is then free to move past such a
 * load, and its heuristics sink it to just before the next CALL - after the inlined
 * strlen/strcpy loop that was meant to see it:
 *
 *     szMonsterCode[3] = 0; szMonsterCode[2] = 0;          szMonsterCode[3] = 0; szMonsterCode[2] = 0;
 *     strcat(szFilePath, szMonsterCode);            =>     szMonsterCode[1] = cCode1;
 *     ...                                                  szMonsterCode[0] = cCode0;
 *     szMonsterCode[1] = cCode1;                           strcat(szFilePath, szMonsterCode);
 *     szMonsterCode[0] = cCode0;                           ...
 *     CheckIfFileExists(..., szFilePath, ...);             CheckIfFileExists(..., szFilePath, ...);
 *
 * (PALSHIFT_LoadMonsterPalShift 00477170: the byte stores are at 004771d9/00477207, the
 * copy's LEA EAX,[EBP-0xc] at 00477288. As printed, every monster's palshift path was
 * built from two NUL bytes.) Ghidra cannot be told otherwise; the order is put back here.
 *
 * A store `x.path = v;` moves up to just before the first statement S of its block that
 * reads x through its address, when all of these hold:
 *
 *   - x is a local (not static) and the path is constant: `x[2]`, `x.f`, `x.f[1]`,
 *     `x._1_1_`, `*(T*)((char*)&x + c)`;
 *   - S is a load through a pointer derived from x (`p = x; ... *p`, `p[i]`, `p->f`) or a
 *     library call reading it (strlen, strcmp, strcat's source, memcpy's source, ...);
 *   - from S to the store: no label, goto, or break/continue leaving the span; no call
 *     but those library calls, none writing through x; no store through a pointer derived
 *     from x; no direct access to bytes the store overlaps; nothing writes a name v reads,
 *     and when v loads memory, nothing writes memory at all;
 *   - nothing in the whole function but this store ever writes those bytes: no
 *     initializer, no other overlapping store, no callee handed x where it may write, no
 *     store through a derived pointer. The read as printed sees bytes never written.
 *
 * The last condition is what makes the move safe without the instructions: a read of
 * stack bytes nothing wrote is no program's intent, so placing the one value those bytes
 * ever hold in front of it can only restore the original's order. It changes nothing a
 * correct original observes: the moved value is the same (its operands are unchanged over
 * the span), and nothing between reads or writes the element directly.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, CompoundStmt, FunctionDecl, Statement } from '../../../ast/nodes.js';
import { getChildren } from '../../../ast/visitor.js';
import { cloneNode, createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

/** What the analysis needs to know about the function and its types. */
export interface SunkStoreEnv {
  /** The function body. */
  body: ASTNode;
  /** Every compound statement of the body. */
  blocks: CompoundStmt[];
  /** Locals and parameters by name. */
  scope: Map<string, { name: string; kind: 'local' | 'param'; decl: any; type: any; isStatic: boolean }>;
  /** A name that is not a local or parameter: 'global' (memory) or null (a constant). */
  resolve(name: string): { kind: 'local' | 'param' | 'global' } | null;
  /** An integer constant expression's value. */
  value(e: any): number | null;
  /** sizeof(T), when known. */
  width(t: any): number | null;
  isArray(t: any): boolean;
  isPointer(t: any): boolean;
  element(t: any): any;
}

function walk(root: any, visit: (n: any, parent: any) => void | 'skip'): void {
  const stack: Array<[any, any]> = [[root, null]];
  while (stack.length) {
    const [n, p] = stack.pop()!;
    if (!n || typeof n !== 'object') continue;
    if (visit(n, p) === 'skip') continue;
    const kids = getChildren(n);
    for (let i = kids.length - 1; i >= 0; i--) if (kids[i]) stack.push([kids[i], n]);
  }
}

function unparen(e: any): any {
  while (e && e.kind === NodeKind.ParenExpr) e = e.expression;
  return e;
}

const CAST_KINDS = new Set<string>([
  NodeKind.CStyleCastExpr, NodeKind.StaticCastExpr, NodeKind.ReinterpretCastExpr, NodeKind.ConstCastExpr,
]);

function isCast(e: any): boolean {
  return !!e && CAST_KINDS.has(e.kind);
}

function strip(e: any): any {
  while (e && (e.kind === NodeKind.ParenExpr || CAST_KINDS.has(e.kind))) e = e.expression;
  return e;
}

function refName(e: any): string | null {
  if (!e) return null;
  if (e.kind === NodeKind.Identifier && typeof e.name === 'string') return e.name;
  if (e.kind === NodeKind.QualifiedId && e.isGlobal && (!e.qualifier || e.qualifier.length === 0)) {
    return typeof e.name?.name === 'string' ? e.name.name : null;
  }
  return null;
}

function calleeName(callee: any): string | null {
  const c = unparen(callee);
  if (!c) return null;
  if (c.kind === NodeKind.Identifier) return c.name;
  if (c.kind === NodeKind.QualifiedId) return typeof c.name?.name === 'string' ? c.name.name : null;
  if (c.kind === NodeKind.MemberExpr) return typeof c.member?.name === 'string' ? c.member.name : null;
  return null;
}

/** One step of a direct access path: a constant subscript, a field, or an unknown index. */
type Step = { k: 'i'; v: number } | { k: 'f'; v: string } | { k: 'o'; off: number; size: number | null } | { k: '?' };

/** Ghidra's partial-variable member: `x._1_1_` is one byte at offset 1. */
const PARTIAL_MEMBER = /^_(\d+)_(\d+)_$/;

/** Library calls the tree's idiom passes produce from inline loops, by the argument positions they READ. */
const READ_ONLY_ARGS: Record<string, (argc: number) => { read: number[]; write: number[] }> = {
  strlen: () => ({ read: [0], write: [] }),
  strcmp: () => ({ read: [0, 1], write: [] }),
  strncmp: () => ({ read: [0, 1], write: [] }),
  _stricmp: () => ({ read: [0, 1], write: [] }),
  _strcmpi: () => ({ read: [0, 1], write: [] }),
  _strnicmp: () => ({ read: [0, 1], write: [] }),
  memcmp: () => ({ read: [0, 1], write: [] }),
  strcpy: () => ({ read: [1], write: [0] }),
  strncpy: () => ({ read: [1], write: [0] }),
  strcat: () => ({ read: [0, 1], write: [0] }),
  strncat: () => ({ read: [0, 1], write: [0] }),
  memcpy: () => ({ read: [1], write: [0] }),
  memmove: () => ({ read: [1], write: [0] }),
  memset: () => ({ read: [], write: [0] }),
};

export interface SunkStore {
  block: any;
  /** Index of the store statement in `block.statements`. */
  store: number;
  /** Index of the first statement that takes the object's address: where the store belongs. */
  hoistTo: number;
  object: string;
  /** The next statement after the run of stores contains a call - where Ghidra sinks to. */
  beforeCall: boolean;
}

function constIndex(env: SunkStoreEnv, e: any): number | null {
  return env.value(e);
}

/**
 * `x`, `x[c]`, `x.f`, `x.f[c].g`: the root local and the path. Null for anything through a
 * pointer (`->`, `*`), which is not a direct stack access.
 */
function accessPath(env: SunkStoreEnv, e: any): { root: string; path: Step[] } | null {
  const slice = offsetSlice(env, unparen(e));
  if (slice) return { root: slice.root, path: [{ k: 'o', off: slice.off, size: slice.size }] };
  const steps: Step[] = [];
  let x = unparen(e);
  for (;;) {
    if (x?.kind === NodeKind.SubscriptExpr) {
      const v = constIndex(env, x.index);
      steps.push(v === null ? { k: '?' } : { k: 'i', v });
      x = unparen(x.array);
    } else if (x?.kind === NodeKind.MemberExpr && !x.isArrow) {
      const m = x.member?.name;
      const pm = typeof m === 'string' ? PARTIAL_MEMBER.exec(m) : null;
      if (pm) steps.push({ k: 'o', off: Number(pm[1]), size: Number(pm[2]) });
      else steps.push(typeof m === 'string' ? { k: 'f', v: m } : { k: '?' });
      x = unparen(x.object);
    } else break;
  }
  const root = refName(x);
  return root ? { root, path: steps.reverse() } : null;
}

/**
 * `*(T*)&x` or `*(T*)((char*)&x + c)`: the slice of x at byte offset c, sizeof(T) wide - the
 * way an unnamed part of a stack object prints. A direct stack access, not a pointer load.
 */
function offsetSlice(env: SunkStoreEnv, e: any): { root: string; off: number; size: number | null } | null {
  if (e?.kind !== NodeKind.UnaryExpr || e.operator !== '*') return null;
  let x = unparen(e.operand);
  let size: number | null = null;
  if (isCast(x)) {
    const t = env.element(x.type);
    size = t ? env.width(t) : null;
  }
  x = strip(x);
  let off = 0;
  if (x?.kind === NodeKind.BinaryExpr && x.operator === '+') {
    const l = strip(x.left), r = x.right;
    const v = env.value(r);
    if (v === null) return null;
    // `(char*)&x + c` steps in bytes; anything wider than a byte scales, which we do not model.
    if (isCast(unparen(x.left))) {
      const w = env.width(env.element(unparen(x.left).type));
      if (w !== 1) return null;
    } else return null;
    off = v;
    x = l;
  }
  if (x?.kind !== NodeKind.UnaryExpr || x.operator !== '&') return null;
  const root = refName(strip(x.operand));
  return root ? { root, off, size } : null;
}

/** Two direct paths can name overlapping bytes. */
function overlaps(a: Step[], b: Step[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const p = a[i], q = b[i];
    if (p.k === '?' || q.k === '?') return true;
    if (p.k === 'o' && q.k === 'o') {
      if (p.size === null || q.size === null) return true;
      return p.off < q.off + q.size && q.off < p.off + p.size;
    }
    if ((p.k === 'i' && q.k === 'i') || (p.k === 'f' && q.k === 'f')) {
      if (p.v !== q.v) return false;
      continue;
    }
    return true; // a slice against a field or an index, a field against an index: assume overlap
  }
  return true;
}

/** How one occurrence of the object's name is used. */
type Use =
  | { kind: 'address'; node: any }
  | { kind: 'direct'; path: Step[]; write: boolean; node: any }
  | { kind: 'whole'; node: any };

/** Every use of `name` inside `root`, classified. */
function usesOf(env: SunkStoreEnv, root: any, name: string, objIsArray: boolean): Use[] {
  const parents = new Map<any, any>();
  const hits: any[] = [];
  walk(root, (n: any, p) => {
    parents.set(n, p);
    if (n.kind === NodeKind.SizeofExpr) return 'skip';
    if (n.kind === NodeKind.Identifier && n.name === name && !(p?.kind === NodeKind.VariableDecl && (p as any).name === n)) hits.push(n);
    return undefined;
  });
  const out: Use[] = [];
  for (const h of hits) {
    // Climb the direct access chain: x[c], x.f, through parens.
    let top = h;
    for (;;) {
      const p = parents.get(top);
      if (p?.kind === NodeKind.ParenExpr) { top = p; continue; }
      if (p?.kind === NodeKind.SubscriptExpr && p.array === top) { top = p; continue; }
      if (p?.kind === NodeKind.MemberExpr && p.object === top && !p.isArrow) { top = p; continue; }
      break;
    }
    const par = parents.get(top);
    if (par?.kind === NodeKind.UnaryExpr && par.operator === '&') {
      // `*(T*)((char*)&x + c)` is how an unnamed slice of the object prints: a direct stack
      // access at a constant offset, not a load through a pointer. Its bytes are unknown here.
      const deref = constantOffsetDeref(env, par, parents);
      if (deref) {
        const dp = parents.get(deref);
        const write = dp?.kind === NodeKind.AssignExpr && dp.left === deref;
        const sl = offsetSlice(env, deref);
        out.push({ kind: 'direct', path: sl ? [{ k: 'o', off: sl.off, size: sl.size }] : [{ k: '?' }], write, node: deref });
        continue;
      }
      out.push({ kind: 'address', node: par });
      continue;
    }
    const ap = accessPath(env, top);
    if (!ap) { out.push({ kind: 'whole', node: top }); continue; }
    if (ap.path.length === 0) {
      // A bare array decays to its address; a bare struct is a copy of all of it.
      out.push(objIsArray ? { kind: 'address', node: top } : { kind: 'whole', node: top });
      continue;
    }
    // A sub-array field (`s.szName`) decays too; we cannot type fields here, so a direct
    // access that is a call argument or a pointer initialiser is treated as an address.
    if (par?.kind === NodeKind.CallExpr && par.callee !== top) { out.push({ kind: 'address', node: top }); continue; }
    const write = (par?.kind === NodeKind.AssignExpr && par.left === top)
      || ((par?.kind === NodeKind.UnaryExpr || par?.kind === NodeKind.PostfixExpr) && (par.operator === '++' || par.operator === '--'));
    out.push({ kind: 'direct', path: ap.path, write, node: top });
  }
  return out;
}

/** The `*` of `*(T*)&x` or `*(T*)((char*)&x + c)` above `addr` (the `&x`), else null. */
function constantOffsetDeref(env: SunkStoreEnv, addr: any, parents: Map<any, any>): any {
  let x = addr;
  let p = parents.get(x);
  const skipCasts = () => {
    while (p && (p.kind === NodeKind.ParenExpr || p.kind === NodeKind.CStyleCastExpr || p.kind === NodeKind.StaticCastExpr
      || p.kind === NodeKind.ReinterpretCastExpr)) { x = p; p = parents.get(x); }
  };
  skipCasts();
  if (p?.kind === NodeKind.BinaryExpr && (p.operator === '+' || p.operator === '-')) {
    const other = p.left === x ? p.right : p.left;
    if (p.operator === '-' && p.left !== x) return null;
    if (env.value(other) === null) return null;
    x = p; p = parents.get(x);
    skipCasts();
  }
  return p?.kind === NodeKind.UnaryExpr && p.operator === '*' ? p : null;
}

/** Names written anywhere in `root`: assignment targets' roots, ++/--, and anything whose address is taken. */
function writtenNames(root: any): Set<string> {
  const out = new Set<string>();
  const rootOf = (e: any): string | null => {
    let x = strip(e);
    for (;;) {
      if (x?.kind === NodeKind.SubscriptExpr) x = strip(x.array);
      else if (x?.kind === NodeKind.MemberExpr && !x.isArrow) x = strip(x.object);
      else break;
    }
    return refName(x);
  };
  walk(root, (n: any) => {
    if (n.kind === NodeKind.AssignExpr) { const r = rootOf(n.left); if (r) out.add(r); }
    if ((n.kind === NodeKind.UnaryExpr || n.kind === NodeKind.PostfixExpr) && (n.operator === '++' || n.operator === '--')) {
      const r = rootOf(n.operand); if (r) out.add(r);
    }
    if (n.kind === NodeKind.UnaryExpr && n.operator === '&') { const r = rootOf(n.operand); if (r) out.add(r); }
    if (n.kind === NodeKind.VariableDecl) { const d = (n as any).name; const s = typeof d === 'string' ? d : d?.name; if (s) out.add(s); }
    return undefined;
  });
  return out;
}

/**
 * The store's value, if it can be computed earlier: literals, scalar locals and parameters,
 * arithmetic and casts over them, and loads (`p->f`, `*p`, a global) when nothing between
 * writes memory. The scalar names it reads, else null.
 */
function valueOperands(env: SunkStoreEnv, e: any): { names: Set<string>; readsMemory: boolean } | null {
  const names = new Set<string>();
  let ok = true, readsMemory = false;
  walk(e, (n: any) => {
    if (!ok) return 'skip';
    switch (n.kind) {
      case NodeKind.IntegerLiteral: case NodeKind.CharLiteral: case NodeKind.BoolLiteral:
      case NodeKind.FloatingLiteral: case NodeKind.NullptrLiteral: case NodeKind.StringLiteral:
      case NodeKind.ParenExpr: case NodeKind.CStyleCastExpr: case NodeKind.StaticCastExpr:
      case NodeKind.ReinterpretCastExpr: case NodeKind.BinaryExpr: case NodeKind.ConditionalExpr:
        return undefined;
      case NodeKind.SizeofExpr:
        return 'skip';
      case NodeKind.SubscriptExpr: case NodeKind.MemberExpr:
        readsMemory = true;
        return undefined;
      case NodeKind.QualifiedId:
        // A namespaced global or a function's address.
        readsMemory = true;
        return 'skip';
      case NodeKind.UnaryExpr:
        if (n.operator === '++' || n.operator === '--') ok = false;
        else if (n.operator === '*') readsMemory = true;
        return undefined;
      case NodeKind.Identifier: {
        const r = env.resolve(n.name);
        if (!r) return undefined; // an enumerator, a macro constant or a function
        if (r.kind === 'global') { readsMemory = true; return undefined; }
        names.add(n.name);
        return undefined;
      }
      default:
        // Types inside casts are not values.
        if (String(n.kind).endsWith('Type')) return 'skip';
        ok = false;
        return undefined;
    }
  });
  return ok ? { names, readsMemory } : null;
}

/** Whether `stmt` may write memory other than a plain local: a store through anything, or a call. */
function writesMemory(stmt: any): boolean {
  let hit = false;
  walk(stmt, (n: any) => {
    if (hit) return 'skip';
    if (n.kind === NodeKind.CallExpr) { hit = true; return 'skip'; }
    const t = n.kind === NodeKind.AssignExpr ? n.left
      : (n.kind === NodeKind.UnaryExpr || n.kind === NodeKind.PostfixExpr) && (n.operator === '++' || n.operator === '--') ? n.operand
      : null;
    if (t && strip(t)?.kind !== NodeKind.Identifier) hit = true;
    return undefined;
  });
  return hit;
}

/** Whether `stmt` reads the object through its address: a read-only library argument, or a load through a derived pointer. */
function readsThrough(env: SunkStoreEnv, stmt: any, name: string, objIsArray: boolean, derived: Set<string>): boolean {
  const viaObj = (e: any): boolean => {
    if (!e) return false;
    let hit = false;
    walk(e, (m: any) => {
      if (hit) return 'skip';
      if (m.kind === NodeKind.Identifier && derived.has(m.name)) hit = true;
      return undefined;
    });
    return hit || usesOf(env, e, name, objIsArray).some(u => u.kind === 'address');
  };
  // Constant-offset slices of the object are direct accesses, not loads through a pointer.
  const direct = new Set<any>(usesOf(env, stmt, name, objIsArray).filter(u => u.kind === 'direct').map(u => u.node));
  const lhsTops = new Set<any>();
  walk(stmt, (n: any) => {
    if (n.kind === NodeKind.AssignExpr && n.operator === '=') lhsTops.add(strip(n.left));
    return undefined;
  });
  let hit = false;
  walk(stmt, (n: any) => {
    if (hit) return 'skip';
    if (n.kind === NodeKind.CallExpr) {
      const c = calleeName(n.callee);
      const spec = c ? READ_ONLY_ARGS[c] : undefined;
      if (spec) for (const r of spec((n.arguments ?? []).length).read) if (viaObj(n.arguments?.[r])) { hit = true; return 'skip'; }
      return undefined;
    }
    if (lhsTops.has(n) || direct.has(n)) return undefined;
    if (n.kind === NodeKind.UnaryExpr && n.operator === '*' && viaObj(n.operand)) hit = true;
    else if (n.kind === NodeKind.SubscriptExpr && derived.has(refName(strip(n.array)) ?? '')) hit = true;
    else if (n.kind === NodeKind.MemberExpr && n.isArrow && viaObj(n.object)) hit = true;
    return undefined;
  });
  return hit;
}

/** Locals assigned from an address of `name` (or of a pointer already derived from it). */
function derivedPointers(env: SunkStoreEnv, name: string, objIsArray: boolean): Set<string> {
  const derived = new Set<string>([name]);
  const body = env.body;
  for (let changed = true; changed;) {
    changed = false;
    walk(body, (n: any) => {
      let target: string | null = null, src: any = null;
      if (n.kind === NodeKind.AssignExpr) { target = refName(strip(n.left)); src = n.right; }
      else if (n.kind === NodeKind.VariableDecl && n.initializer) {
        const d = n.name; target = typeof d === 'string' ? d : d?.name ?? null;
        src = n.initializer?.kind === NodeKind.InitListExpr ? null : n.initializer;
      }
      if (!target || !src || derived.has(target)) return undefined;
      let hit = false;
      walk(src, (m: any) => {
        if (hit) return 'skip';
        // A call's result is not a pointer into its arguments, and a load's value is not one either.
        if (m.kind === NodeKind.CallExpr || m.kind === NodeKind.SubscriptExpr
          || (m.kind === NodeKind.MemberExpr && m.isArrow) || (m.kind === NodeKind.UnaryExpr && m.operator === '*')) return 'skip';
        if (m.kind === NodeKind.Identifier && derived.has(m.name)) {
          if (m.name !== name) { hit = true; return 'skip'; }
          // The object itself only counts by address.
          hit = usesOf(env, src, name, objIsArray).some(u => u.kind === 'address');
        }
        return undefined;
      });
      if (hit) { derived.add(target); changed = true; }
      return undefined;
    });
  }
  derived.delete(name);
  return derived;
}

/** Whether `stmt` contains a call that is not a read-only use of the object, or writes through a derived pointer. */
function blocksHoist(stmt: any, name: string, derived: Set<string>): string | null {
  let why: string | null = null;
  const mentionsObj = (e: any): boolean => {
    let hit = false;
    walk(e, (m: any) => {
      if (hit) return 'skip';
      if (m.kind === NodeKind.SizeofExpr) return 'skip';
      if (m.kind === NodeKind.Identifier && (m.name === name || derived.has(m.name))) hit = true;
      return undefined;
    });
    return hit;
  };
  walk(stmt, (n: any) => {
    if (why) return 'skip';
    if (n.kind === NodeKind.CallExpr) {
      const c = calleeName(n.callee);
      const spec = c ? READ_ONLY_ARGS[c] : undefined;
      if (!spec) { why = `call ${c ?? '(indirect)'}`; return 'skip'; }
      const { write } = spec((n.arguments ?? []).length);
      for (const w of write) if (n.arguments?.[w] && mentionsObj(n.arguments[w])) { why = `${c} writes through it`; return 'skip'; }
      return undefined;
    }
    // A store through a pointer derived from the object may hit the element.
    const lhs = n.kind === NodeKind.AssignExpr ? strip(n.left) : null;
    if (lhs) {
      let x = lhs, viaPointer = false;
      for (;;) {
        if (x?.kind === NodeKind.SubscriptExpr) { x = strip(x.array); continue; }
        if (x?.kind === NodeKind.MemberExpr) { if (x.isArrow) viaPointer = true; x = strip(x.object); continue; }
        if (x?.kind === NodeKind.UnaryExpr && x.operator === '*') { viaPointer = true; x = strip(x.operand); continue; }
        break;
      }
      if (viaPointer || (lhs.kind === NodeKind.SubscriptExpr && derived.has(refName(x) ?? ''))) {
        if (mentionsObj(lhs)) { why = 'store through a pointer to it'; return 'skip'; }
      }
    }
    return undefined;
  });
  return why;
}

/** Every sunk store in a function, one block at a time. */
export function findSunkStores(env: SunkStoreEnv): SunkStore[] {
  const out: SunkStore[] = [];
  const scope = env.scope;
  const objects = new Map<string, boolean>();
  for (const e of scope.values()) {
    if (e.kind !== 'local' || e.isStatic) continue;
    if (env.isPointer(e.type)) continue;
    // Arrays and structs by element or field; any other local by a byte slice of it.
    objects.set(e.name, env.isArray(e.type));
  }
  if (!objects.size) return out;
  const derivedCache = new Map<string, Set<string>>();

  for (const block of env.blocks) {
    const stmts: any[] = block.statements ?? [];
    // Per object: the first statement index holding an address-take.
    const firstAddr = new Map<string, number>();
    stmts.forEach((s, i) => {
      if (s?.kind !== NodeKind.ExprStmt) return;
      const a = unparen(s.expression);
      if (a?.kind !== NodeKind.AssignExpr || a.operator !== '=') return;
      const ap = accessPath(env, a.left);
      if (!ap || !ap.path.length || !objects.has(ap.root)) return;
      if (ap.path.some(p => p.k === '?')) return;
      const name = ap.root, isArr = objects.get(name)!;
      let j: number | undefined = firstAddr.get(name);
      if (j === undefined) {
        j = stmts.findIndex(st => usesOf(env, st, name, isArr).some(u => u.kind === 'address'));
        firstAddr.set(name, j);
      }
      if (j < 0 || j >= i) return;
      const value = valueOperands(env, a.right);
      if (!value || value.names.has(name)) return;
      let derived = derivedCache.get(name);
      if (!derived) derivedCache.set(name, (derived = derivedPointers(env, name, isArr)));
      // The store belongs just before the first statement that reads the object through a
      // pointer; with no such read the order is unobservable and nothing is wrong.
      let h = -1;
      for (let k = j; k < i; k++) if (readsThrough(env, stmts[k], name, isArr, derived)) { h = k; break; }
      if (h < 0) return;
      for (let k = h; k < i; k++) {
        const s2 = stmts[k];
        // A label between lets control enter past the hoisted store; a goto/break/continue
        // leaving the region lets control leave before reaching the original one.
        if (escapes(s2, 0, 0)) return;
        for (const u of usesOf(env, s2, name, isArr)) {
          if (u.kind === 'whole') return;
          if (u.kind === 'direct' && overlaps(u.path, ap.path)) return;
        }
        const w = writtenNames(s2);
        for (const o of value.names) if (w.has(o)) return;
        if (value.readsMemory && writesMemory(s2)) return;
        if (blocksHoist(s2, name, derived)) return;
      }
      j = h;
      // The read must see bytes nothing else ever writes: then the printed order reads
      // garbage, which no source does, and moving the store up cannot change a value the
      // program relied on.
      if (writtenElsewhere(env, name, isArr, derived, ap.path, a)) return;
      // Where Ghidra sinks a store: just before a call.
      let k = i + 1;
      while (k < stmts.length) {
        const t = unparen(stmts[k]?.expression);
        if (stmts[k]?.kind === NodeKind.ExprStmt && t?.kind === NodeKind.AssignExpr && !hasCall(t)) { k++; continue; }
        break;
      }
      const beforeCall = k < stmts.length && hasCall(stmts[k]);
      out.push({ block, store: i, hoistTo: j, object: name, beforeCall });
    });
  }
  return out;
}

/**
 * Whether anything but `store` may write the element: an initializer, another direct store
 * that overlaps it, a whole-object assignment, a callee handed the object's address in a
 * position it may write through, or a store through a pointer derived from it.
 */
function writtenElsewhere(env: SunkStoreEnv, name: string, objIsArray: boolean,
  derived: Set<string>, path: Step[], store: any): boolean {
  const e = env.scope.get(name);
  if ((e?.decl as any)?.initializer) return true;
  const body = env.body;
  let hit = false;
  const mentionsObj = (x: any): boolean => {
    let m = false;
    walk(x, (n: any) => {
      if (m) return 'skip';
      if (n.kind === NodeKind.SizeofExpr) return 'skip';
      if (n.kind === NodeKind.Identifier && (n.name === name || derived.has(n.name))) m = true;
      return undefined;
    });
    return m;
  };
  walk(body, (n: any) => {
    if (hit) return 'skip';
    if (n.kind === NodeKind.CallExpr) {
      const c = calleeName(n.callee);
      const spec = c ? READ_ONLY_ARGS[c] : undefined;
      const args: any[] = n.arguments ?? [];
      const writable = spec ? spec(args.length).write : args.map((_, i) => i);
      if (writable.some(w => args[w] && mentionsObj(args[w]))) hit = true;
      return undefined;
    }
    if (n === store) return undefined;
    const t = n.kind === NodeKind.AssignExpr ? n.left
      : (n.kind === NodeKind.UnaryExpr || n.kind === NodeKind.PostfixExpr) && (n.operator === '++' || n.operator === '--') ? n.operand
      : null;
    if (!t) return undefined;
    const ap = accessPath(env, t);
    if (ap && ap.root === name) { if (overlaps(ap.path, path)) hit = true; return undefined; }
    // Through a pointer: `*p`, `p[i]`, `p->f` with p derived from the object.
    let x = strip(t), via = false;
    for (;;) {
      if (x?.kind === NodeKind.SubscriptExpr) { via = true; x = strip(x.array); continue; }
      if (x?.kind === NodeKind.MemberExpr) { if (x.isArrow) via = true; x = strip(x.object); continue; }
      if (x?.kind === NodeKind.UnaryExpr && x.operator === '*') { via = true; x = strip(x.operand); continue; }
      break;
    }
    if (via && mentionsObj(t)) hit = true;
    return undefined;
  });
  return hit;
}

/** A label anywhere in `n`, a goto, or a break/continue that leaves `n`. */
function escapes(n: any, loops: number, switches: number): boolean {
  if (!n || typeof n !== 'object') return false;
  switch (n.kind) {
    case NodeKind.LabelStmt: case NodeKind.GotoStmt:
      return true;
    case NodeKind.CaseStmt: case NodeKind.DefaultStmt:
      if (switches === 0) return true;
      break;
    case NodeKind.BreakStmt: return loops + switches === 0;
    case NodeKind.ContinueStmt: return loops === 0;
  }
  const isLoop = n.kind === NodeKind.ForStmt || n.kind === NodeKind.WhileStmt || n.kind === NodeKind.DoWhileStmt;
  const l = isLoop ? loops + 1 : loops, sw = n.kind === NodeKind.SwitchStmt ? switches + 1 : switches;
  let hit = false;
  walk(n, (m: any) => {
    if (hit) return 'skip';
    if (m === n) return undefined;
    if (escapes(m, l, sw)) hit = true;
    return 'skip';
  });
  return hit;
}

function hasCall(n: any): boolean {
  let hit = false;
  walk(n, (m: any) => {
    if (hit) return 'skip';
    if (m.kind === NodeKind.CallExpr) hit = true;
    return undefined;
  });
  return hit;
}


// -------------------------------------------------------------------------------------------
// The transform
// -------------------------------------------------------------------------------------------

const PRIMITIVE_WIDTH: Record<string, number> = {
  char: 1, 'signed char': 1, 'unsigned char': 1, int8_t: 1, uint8_t: 1, byte: 1, BYTE: 1, undefined1: 1, bool: 1,
  short: 2, 'unsigned short': 2, int16_t: 2, uint16_t: 2, ushort: 2, WORD: 2, wchar_t: 2, undefined2: 2,
  int: 4, 'unsigned int': 4, uint: 4, int32_t: 4, uint32_t: 4, DWORD: 4, undefined4: 4, long: 4, 'unsigned long': 4, float: 4,
  double: 8, int64_t: 8, uint64_t: 8, longlong: 8, ulonglong: 8, undefined8: 8,
};

function unqualified(t: any): any {
  while (t && t.kind === NodeKind.QualifiedType) t = t.type;
  return t;
}

function constValue(e: any): number | null {
  e = unparen(e);
  if (!e) return null;
  switch (e.kind) {
    case NodeKind.IntegerLiteral: {
      const v = e.value;
      return typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : null;
    }
    case NodeKind.CharLiteral: return typeof e.value === 'number' ? e.value : null;
    case NodeKind.CStyleCastExpr: case NodeKind.StaticCastExpr: case NodeKind.ReinterpretCastExpr:
      return constValue(e.expression);
    case NodeKind.UnaryExpr: {
      const v = constValue(e.operand);
      if (v === null) return null;
      return e.operator === '-' ? -v : e.operator === '+' ? v : e.operator === '~' ? ~v : null;
    }
    case NodeKind.BinaryExpr: {
      const a = constValue(e.left), b = constValue(e.right);
      if (a === null || b === null) return null;
      switch (e.operator) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '<<': return a * 2 ** b;
        default: return null;
      }
    }
    default: return null;
  }
}

function typeWidth(t: any): number | null {
  const u = unqualified(t);
  if (!u) return null;
  if (u.kind === NodeKind.PointerType) return 4;
  if (u.kind === NodeKind.ArrayType) {
    const n = constValue(u.size), w = typeWidth(u.elementType);
    return n !== null && w !== null ? n * w : null;
  }
  if (u.kind === NodeKind.BuiltinType) {
    const spelled = [...(u.modifiers ?? []), u.name].join(' ');
    return PRIMITIVE_WIDTH[spelled] ?? PRIMITIVE_WIDTH[spelled.replace(/ int$/, '')] ?? PRIMITIVE_WIDTH[u.name] ?? null;
  }
  if (u.kind === NodeKind.TypedefType || u.kind === NodeKind.ElaboratedType) {
    const n = typeof u.name === 'string' ? u.name : u.name?.name;
    return typeof n === 'string' ? PRIMITIVE_WIDTH[n] ?? null : null;
  }
  return null;
}

/** The analysis's view of one function, from the function alone. */
export function functionEnv(fn: FunctionDecl): SunkStoreEnv | null {
  const body = (fn as any).body;
  if (!body) return null;
  const scope: SunkStoreEnv['scope'] = new Map();
  const declName = (d: any): string | null => typeof d?.name === 'string' ? d.name || null : d?.name?.name ?? null;
  for (const p of ((fn as any).parameters ?? []) as any[]) {
    const n = declName(p);
    if (n) scope.set(n, { name: n, kind: 'param', decl: p, type: p.type, isStatic: false });
  }
  const blocks: CompoundStmt[] = [];
  walk(body, (n: any) => {
    if (n.kind === NodeKind.StructDecl || n.kind === NodeKind.ClassDecl || n.kind === NodeKind.UnionDecl) return 'skip';
    if (n.kind === NodeKind.CompoundStmt) blocks.push(n);
    if (n.kind === NodeKind.VariableDecl) {
      const name = declName(n);
      const specs: string[] = n.specifiers ?? [];
      if (name && !scope.has(name)) {
        scope.set(name, { name, kind: 'local', decl: n, type: n.type, isStatic: specs.includes('static') || specs.includes('extern') });
      }
    }
    return undefined;
  });
  return {
    body, blocks, scope,
    // Without a symbol table every other name may be a global: count it as memory.
    resolve: name => scope.get(name) ?? { kind: 'global' },
    value: constValue,
    width: typeWidth,
    isArray: t => unqualified(t)?.kind === NodeKind.ArrayType,
    isPointer: t => unqualified(t)?.kind === NodeKind.PointerType,
    element: t => {
      const u = unqualified(t);
      return u?.kind === NodeKind.ArrayType ? u.elementType : u?.kind === NodeKind.PointerType ? u.pointee : null;
    },
  };
}

export interface SunkStoreHoistOptions extends PluginOptions {
  onHoist?: (e: { object: string; line: number; to: number }) => void;
}

const MAX_MOVES = 64;

/** Every sunk store of `fn` moved up to its read; `fn` itself when there is none. */
export function hoistSunkStores(fn: FunctionDecl, options: SunkStoreHoistOptions = {}): FunctionDecl {
  const first = functionEnv(fn);
  if (!first || !findSunkStores(first).length) return fn;
  // The moves edit a private deep copy in place.
  const cur = cloneNode(fn);
  // One move at a time: each changes the indices the next one is found at.
  for (let n = 0; n < MAX_MOVES; n++) {
    const env = functionEnv(cur);
    if (!env) break;
    const found = findSunkStores(env);
    if (!found.length) break;
    const s = found[0];
    const stmts = s.block.statements as Statement[];
    const moved = stmts[s.store];
    options.onHoist?.({ object: s.object, line: moved.location?.start.line ?? 0, to: stmts[s.hoistTo].location?.start.line ?? 0 });
    (s.block as { statements: Statement[] }).statements =
      [...stmts.slice(0, s.hoistTo), moved, ...stmts.slice(s.hoistTo, s.store), ...stmts.slice(s.store + 1)];
  }
  return cur;
}

export function createSunkStoreHoistTransformer(options: SunkStoreHoistOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      const out = hoistSunkStores(fn, options);
      return out === fn ? undefined : out;
    },
  });
}

export const sunkStoreHoistPlugin: TransformPlugin = {
  id: 'sunk-store-hoist',
  name: 'Sunk Store Hoist',
  description: 'Move a stack element store the decompiler sank past a read through its address back in front of that read',
  version: '1.0.0',
  defaultEnabled: true,
  // After pseudo-op-lower (20) has put the inline string loops back as calls.
  priority: 21,
  tags: ['correctness', 'ghidra'],
  createTransformer: (o?: SunkStoreHoistOptions) => createSunkStoreHoistTransformer(o ?? {}),
};
