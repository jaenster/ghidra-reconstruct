/**
 * The tree a regen replaces, as evidence for the stored bodies it is about to print again.
 *
 * A record is bound when it is captured, but a binding can only say what the capturing
 * index knew: records seeded before the tree carried its globals index have no binding for a
 * global, records captured before the index read the generator's enum form none for an enum
 * constant, records captured before the maps carried storage no parameter storage. Their
 * stored text compiled in the tree being replaced, so what a name meant there is what it
 * meant in the stored body: an unbound site is bound under that tree's index, and a stored
 * parameter list takes that tree's storage where its names are the ones that tree emits.
 *
 * A type has no address. A type that went from the old tree and a type that appeared in the
 * new one are the same type renamed when every place that spelled the one at a fixed address
 * (a function's parameter or return type, a global's type) spells the other now, nothing
 * else pairs with either, and their layouts agree: the same field offsets with the same field
 * types (fields may be renamed), or for an enum the same constant values. Anything less is
 * not a rename and stays what it was: a type gone.
 */
import { TokenKind } from '@ghidra-mcp/cpp-parser';

import { bindSites, type Binding, type SiteScan } from './refs.js';
import { lexTokens, type TypeRef } from './scan.js';
import type { StoredBody } from './store.js';
import type { SymbolIndex } from './symbol-index.js';

export interface PreviousTree {
  index: SymbolIndex;
  /** Where parameter storage is read, when not from `index` (evidence.ts). */
  storage?: SymbolIndex;
  /** Type renames, old qualified name -> new. */
  types: Map<string, string>;
  /** The same by the unqualified name, where it decides alone (spellings in signatures). */
  simple: Map<string, string>;
}

const lastPart = (q: string) => q.split('::').pop()!;
const scopeOf = (q: string) => (q.includes('::') ? q.slice(0, q.lastIndexOf('::')) : '');

/** The identifiers of a type spelling, with their offsets. */
function typeIdents(spelling: string): Array<{ text: string; start: number; end: number }> | undefined {
  const toks = lexTokens(spelling);
  if (!toks) return undefined;
  return toks.filter(t => t.kind === TokenKind.Identifier).map(t => ({ text: t.text, start: t.start, end: t.end }));
}

/** The tokens of a type spelling, for a position-by-position comparison. */
function typeTokens(spelling: string): Array<{ text: string; ident: boolean }> | undefined {
  const toks = lexTokens(spelling);
  if (!toks) return undefined;
  return toks.filter(t => t.kind !== TokenKind.EOF).map(t => ({ text: t.text, ident: t.kind === TokenKind.Identifier }));
}

/** Old and new type renames between two trees (see the header). */
export function typeRenames(before: SymbolIndex, after: SymbolIndex): Map<string, string> {
  const gone = [...before.types].filter(t => !after.types.has(t));
  const added = [...after.types].filter(t => !before.types.has(t));
  if (gone.length === 0 || added.length === 0) return new Map();
  const bySimple = (l: string[]) => {
    const m = new Map<string, string[]>();
    for (const q of l) m.set(lastPart(q), [...(m.get(lastPart(q)) ?? []), q]);
    return m;
  };
  const goneBy = bySimple(gone);
  const addedBy = bySimple(added);
  const votes = new Map<string, Set<string>>();
  const back = new Map<string, Set<string>>();
  const vote = (a: string, b: string) => {
    const ga = goneBy.get(a);
    const ab = addedBy.get(b);
    if (!ga || !ab || ga.length !== 1 || ab.length !== 1) return;
    votes.set(ga[0], (votes.get(ga[0]) ?? new Set()).add(ab[0]));
    back.set(ab[0], (back.get(ab[0]) ?? new Set()).add(ga[0]));
  };
  const compareSpelling = (x: string | undefined, y: string | undefined) => {
    if (x === undefined || y === undefined || x === y) return;
    const tx = typeTokens(x);
    const ty = typeTokens(y);
    if (!tx || !ty || tx.length !== ty.length) return;
    for (let k = 0; k < tx.length; k++) {
      if (tx[k].ident && ty[k].ident) { if (tx[k].text !== ty[k].text) vote(tx[k].text, ty[k].text); } else if (tx[k].text !== ty[k].text) return;
    }
  };
  for (const [a, f] of before.fnByAddr) {
    const g = after.fnByAddr.get(a);
    if (!g) continue;
    compareSpelling(f.retText, g.retText);
    if (f.paramTypes && g.paramTypes && f.paramTypes.length === g.paramTypes.length) f.paramTypes.forEach((t, k) => compareSpelling(t, g.paramTypes![k]));
  }
  for (const [a, x] of before.glByAddr) {
    const y = after.glByAddr.get(a);
    if (x.type && y?.type && x.type.ptr === y.type.ptr && x.type.base !== y.type.base) vote(x.type.base, y.type.base);
  }
  const goneSet = new Set(gone);
  const addedSet = new Set(added);
  const sameType = (x: TypeRef | undefined, y: TypeRef | undefined) => {
    if (!x || !y) return x === y;
    if (x.ptr !== y.ptr) return false;
    if (x.base === y.base) return true;
    const gx = goneBy.get(x.base);
    const ay = addedBy.get(y.base);
    return !!gx && !!ay && gx.some(q => goneSet.has(q)) && ay.some(q => addedSet.has(q));
  };
  const sameLayout = (o: string, n: string): boolean => {
    const so = before.structs.get(o);
    const sn = after.structs.get(n);
    if (so && sn) {
      return so.fields.length > 0 && so.fields.length === sn.fields.length
        && so.fields.every((f, k) => f.offset === sn.fields[k].offset && sameType(f.type, sn.fields[k].type));
    }
    const eo = before.enums.get(o);
    const en = after.enums.get(n);
    if (eo && en && !so && !sn) {
      const vo = [...eo.values()].sort();
      const vn = [...en.values()].sort();
      return vo.length > 0 && vo.length === vn.length && vo.every((v, k) => v === vn[k]);
    }
    return false;
  };
  const out = new Map<string, string>();
  for (const [o, ns] of votes) {
    if (ns.size !== 1) continue;
    const n = [...ns][0];
    if (back.get(n)?.size !== 1) continue;
    if (scopeOf(o) !== scopeOf(n)) continue;
    if (!sameLayout(o, n)) continue;
    out.set(o, n);
  }
  return out;
}

export function previousTree(index: SymbolIndex, current: SymbolIndex, storage?: SymbolIndex): PreviousTree {
  const types = typeRenames(index, current);
  const simple = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [o, n] of types) {
    const s = lastPart(o);
    if (simple.has(s)) ambiguous.add(s);
    simple.set(s, lastPart(n));
  }
  for (const s of ambiguous) simple.delete(s);
  return { index, types, simple, ...(storage ? { storage } : {}) };
}

/** A type spelling with every renamed type spelled by its new name. */
export function renameTypeSpelling(spelling: string | undefined, prev: PreviousTree): string | undefined {
  if (spelling === undefined || prev.simple.size === 0) return spelling;
  const ids = typeIdents(spelling);
  if (!ids) return spelling;
  let out = spelling;
  for (const id of [...ids].reverse()) {
    const n = prev.simple.get(id.text);
    if (n) out = `${out.slice(0, id.start)}${n}${out.slice(id.end)}`;
  }
  return out;
}

const renameType = (q: string, prev: PreviousTree) => prev.types.get(q) ?? q;

function sameNames(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  return !!a && !!b && a.length === b.length && a.every((x, k) => x === b[k]);
}

/** A binding as the new tree would write it: renamed types followed, storage filled in. */
export function migrateBinding(b: Binding, prev: PreviousTree): Binding {
  switch (b.k) {
    case 'ty': return { ...b, q: renameType(b.q, prev) };
    case 'en': return { ...b, e: renameType(b.e, prev) };
    case 'gl': return b.t ? { ...b, t: renameTypeSpelling(b.t, prev) } : b;
    case 'fd': return { ...b, s: renameType(b.s, prev), ...(b.t ? { t: renameTypeSpelling(b.t, prev) } : {}) };
    case 'fdc': return { ...b, c: b.c.map(([s, o]) => [renameType(s, prev), o] as [string, number]) };
    case 'fn': {
      const out: Binding = { ...b };
      if (!out.ps && out.p && out.a.length === 1) {
        const was = (prev.storage ?? prev.index).fnByAddr.get(out.a[0]);
        if (was?.storage && sameNames(was.params, out.p)) out.ps = [...was.storage];
      }
      if (out.pt) out.pt = out.pt.map(t => renameTypeSpelling(t, prev)!);
      if (out.rt !== undefined) out.rt = renameTypeSpelling(out.rt, prev);
      return out;
    }
    default: return b;
  }
}

/**
 * A stored body read against the tree it compiled in: its unbound sites bound there, its
 * parameters given that tree's storage, every type it names under its current name.
 */
export function migrateStored(stored: StoredBody, scan: SiteScan, bindings: Array<Binding | undefined>, prev: PreviousTree): { stored: StoredBody; bindings: Array<Binding | undefined> } {
  const out = [...bindings];
  if (out.some((b, i) => !b && scan.sites[i].kind !== 'member')) {
    const there = bindSites(scan, prev.index, stored.scope);
    out.forEach((b, i) => {
      const t = there[i];
      if (b || !t || scan.sites[i].kind === 'member') return;
      if (t.k === 'fn' || t.k === 'gl' || t.k === 'en' || t.k === 'ty') out[i] = t;
    });
  }
  const was = (prev.storage ?? prev.index).fnByAddr.get(stored.address);
  const paramStorage = stored.paramStorage ?? (was?.storage && sameNames(was.params, stored.params) ? [...was.storage] : undefined);
  return {
    stored: {
      ...stored,
      ...(paramStorage ? { paramStorage } : {}),
      ...(stored.paramTypes ? { paramTypes: stored.paramTypes.map(t => renameTypeSpelling(t, prev)!) } : {}),
      ...(stored.ret !== undefined ? { ret: renameTypeSpelling(stored.ret, prev) } : {}),
    },
    bindings: out.map(b => (b ? migrateBinding(b, prev) : b)),
  };
}

