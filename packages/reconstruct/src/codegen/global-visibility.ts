/**
 * Who can see a central global: the visibility each one needs, from what names it.
 *
 * globals.h declared every global the scoping left external, whether anything
 * named it or not. At v1969, 163 of its 271 root-scope externs and 166 of its 722
 * namespaced ones were named by no function: some only by their own definition,
 * some only inside another global's initializer. A declaration nothing reads is
 * an include edge every module pays for, and a module boundary cannot be drawn
 * through a header that declares everything.
 *
 * Each global globals.h would declare gets one verdict, from every text the tree
 * and the hand-written sources compile:
 *
 *   referenced        a unit file, a header or a hand-written source names it, or a
 *                     function the tree emits reaches it by address (Ghidra's xref):
 *                     declared, by the users' modules where the build has modules.
 *   initializer-only  only the initializer of another live global names it: it needs
 *                     no declaration outside that initializer's translation unit.
 *   interior          nothing names it, and it starts inside a live global's extent:
 *                     a label on a slot of that object (a split `T_1__0_`), whose
 *                     bytes the object already holds. Not emitted.
 *   container         nothing names it, but a live label lies inside its extent (a
 *                     table whose code-referenced label is at its centre): kept, it
 *                     is the storage that label's neighbours read.
 *   dead              nothing names it and no live global overlaps it. Not emitted.
 *
 * Liveness runs from the roots through initializers to a fixpoint, so a table only
 * a dead table names is dead too.
 *
 * Extents are Ghidra's (address, size). A label inside a datum can carry the
 * datum's size rather than its own, which only makes overlaps wider: the
 * conservative direction, since an overlap keeps.
 */

import type { AnalyzedDataSymbol, SourceFile } from '../types.js';
import { scanReferences } from './needle-index.js';
import { identifierRuns } from './module-boundary.js';
import { sanitizeSymbolName } from './globals-header.js';

export type GlobalVisibility = 'referenced' | 'initializer-only' | 'interior' | 'container' | 'dead';

export interface GlobalVisibilityInput {
  /** The globals globals.h would declare: the ones a verdict is given to. */
  candidates: readonly AnalyzedDataSymbol[];
  /** Every other central global: live by construction, and a source of initializer references. */
  others: readonly AnalyzedDataSymbol[];
  /** The emitted files so far (units, headers, d2_platform.h); globals.h and its units are not yet among them. */
  files: ReadonlyMap<string, SourceFile>;
  /** The globals a hand-written source names (by name, Ghidra label or address). */
  foreign: ReadonlySet<AnalyzedDataSymbol>;
  /** Qualified names of the functions the tree emits. */
  emittedFunctions: ReadonlySet<string>;
  /** The identifiers a global's own initializer, as the globals unit will render it, names. */
  initializerNames: (g: AnalyzedDataSymbol) => ReadonlySet<string>;
  /** The module a file belongs to, where the build has modules. */
  moduleOfFile?: (path: string) => string | undefined;
}

export interface GlobalVisibilityEntry {
  verdict: GlobalVisibility;
  /** Modules whose files name it (referenced). */
  userModules: Set<string>;
  /** The live globals whose initializers name it. */
  referrers: Set<AnalyzedDataSymbol>;
  /** For `interior`, the object it sits in; for `container`, a live label inside it. */
  neighbour?: AnalyzedDataSymbol;
  /** For `referenced`: only Ghidra's xref from an emitted function, no text. */
  byAddressOnly?: boolean;
}

export interface GlobalVisibilityResult {
  entries: Map<AnalyzedDataSymbol, GlobalVisibilityEntry>;
  counts: Record<GlobalVisibility, number>;
}

export const emittedGlobalName = (g: { name: string; suggestedName?: string }): string =>
  sanitizeSymbolName(g.suggestedName || g.name);

function addressOf(g: AnalyzedDataSymbol): number {
  const a = g.address ?? '';
  return Number.parseInt(a.slice(a.lastIndexOf(':') + 1).replace(/^0x/i, ''), 16);
}

function extentOf(g: AnalyzedDataSymbol): [number, number] | undefined {
  const lo = addressOf(g);
  if (!Number.isFinite(lo)) return undefined;
  const size = Number(g.size);
  return [lo, lo + (Number.isSafeInteger(size) && size > 0 ? size : 1)];
}

/** Every identifier a file names: its code, and the bodies of its macros. */
function fileIdentifiers(content: string): Set<string> {
  const ids = new Set(scanReferences(content).identifiers);
  const defines = content.split('\n').filter(l => /^\s*#\s*define\b/.test(l)).join('\n');
  if (defines) for (const id of identifierRuns(defines)) ids.add(id);
  return ids;
}

export function classifyGlobalVisibility(input: GlobalVisibilityInput): GlobalVisibilityResult {
  const byName = new Map<string, AnalyzedDataSymbol[]>();
  for (const g of input.candidates) {
    const n = emittedGlobalName(g);
    const list = byName.get(n);
    if (list) list.push(g); else byName.set(n, [g]);
  }
  const entries = new Map<AnalyzedDataSymbol, GlobalVisibilityEntry>();
  for (const g of input.candidates) entries.set(g, { verdict: 'dead', userModules: new Set(), referrers: new Set() });

  // Roots: what a compiled text names.
  const named = new Set<AnalyzedDataSymbol>();
  for (const [path, file] of input.files) {
    const module = input.moduleOfFile?.(path);
    for (const id of fileIdentifiers(file.content)) {
      for (const g of byName.get(id) ?? []) {
        named.add(g);
        if (module) entries.get(g)!.userModules.add(module);
      }
    }
  }
  const live = new Set<AnalyzedDataSymbol>();
  for (const g of input.candidates) {
    const e = entries.get(g)!;
    if (named.has(g) || input.foreign.has(g)) { e.verdict = 'referenced'; live.add(g); continue; }
    if ((g.referencingFunctions ?? []).some(f => input.emittedFunctions.has(f))) {
      e.verdict = 'referenced';
      e.byAddressOnly = true;
      live.add(g);
    }
  }

  // Through initializers, from every live global, to a fixpoint.
  const edges = new Map<AnalyzedDataSymbol, AnalyzedDataSymbol[]>();
  const targetsOf = (o: AnalyzedDataSymbol): AnalyzedDataSymbol[] => {
    let t = edges.get(o);
    if (t) return t;
    t = [];
    if (o.initializedData || o.isInitialized) {
      for (const id of input.initializerNames(o)) {
        for (const g of byName.get(id) ?? []) if (g !== o) t.push(g);
      }
    }
    edges.set(o, t);
    return t;
  };
  const work: AnalyzedDataSymbol[] = [...input.others, ...live];
  const reached = new Set<AnalyzedDataSymbol>(work);
  while (work.length > 0) {
    const o = work.pop()!;
    for (const t of targetsOf(o)) {
      const e = entries.get(t)!;
      e.referrers.add(o);
      if (e.verdict === 'dead') e.verdict = 'initializer-only';
      if (!reached.has(t)) { reached.add(t); work.push(t); }
    }
  }

  // What nothing reaches: an interior slot of a live object, or a live label's container.
  const liveExtents: Array<{ lo: number; hi: number; g: AnalyzedDataSymbol }> = [];
  for (const g of [...input.others, ...input.candidates]) {
    if (entries.has(g) && entries.get(g)!.verdict === 'dead') continue;
    const x = extentOf(g);
    if (x) liveExtents.push({ lo: x[0], hi: x[1], g });
  }
  liveExtents.sort((a, b) => a.lo - b.lo);
  let longest = 0;
  for (const e of liveExtents) longest = Math.max(longest, e.hi - e.lo);
  const firstAtOrAfter = (v: number): number => {
    let lo = 0, hi = liveExtents.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (liveExtents[mid].lo < v) lo = mid + 1; else hi = mid; }
    return lo;
  };
  for (const g of input.candidates) {
    const e = entries.get(g)!;
    if (e.verdict !== 'dead') continue;
    const x = extentOf(g);
    if (!x) continue;
    const [lo, hi] = x;
    // A live object starting before it and reaching past its start holds it.
    for (let i = firstAtOrAfter(lo) - 1; i >= 0 && liveExtents[i].lo > lo - longest; i--) {
      const p = liveExtents[i];
      if (p.lo < lo && p.hi > lo) { e.verdict = 'interior'; e.neighbour = p.g; break; }
    }
    if (e.verdict !== 'dead') continue;
    // A live label at or inside its extent: this is that label's storage.
    const i = firstAtOrAfter(lo);
    if (i < liveExtents.length && liveExtents[i].lo < hi) { e.verdict = 'container'; e.neighbour = liveExtents[i].g; }
  }

  const counts: Record<GlobalVisibility, number> = { referenced: 0, 'initializer-only': 0, interior: 0, container: 0, dead: 0 };
  for (const e of entries.values()) counts[e.verdict]++;
  return { entries, counts };
}

/**
 * The module a root-scope global is declared in: the one module that names it, or
 * the one of its users every other user may see. Undefined when no user module
 * qualifies (the users cannot share it without a wrong-direction edge).
 */
export function ownerModuleOfUsers(
  users: ReadonlySet<string>,
  mayUse: (user: string, owner: string) => boolean,
): string | undefined {
  const list = [...users].sort();
  if (list.length <= 1) return list[0];
  const candidates = list.filter(m => list.every(u => u === m || mayUse(u, m)));
  // Several (modules that see each other): the one the others import.
  return candidates.find(c => candidates.every(o => o === c || mayUse(o, c))) ?? candidates[0];
}
