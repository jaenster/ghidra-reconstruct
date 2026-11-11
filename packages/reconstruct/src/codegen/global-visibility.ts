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
 *   interior          nothing names it, and it starts inside a live object's extent:
 *                     a label on a slot of that object (a split `T_1__0_`), whose
 *                     bytes the object already holds. Not emitted.
 *   container         nothing names it, but a live label lies inside its extent (a
 *                     table whose code-referenced label is at its centre): kept, it
 *                     is the storage that label's neighbours read.
 *   unreferenced      nothing names it and no live global overlaps it, but it holds
 *                     bytes of the original image (.data/.rdata): defined, declared
 *                     nowhere. At v1969, 42 such items byte-matched the original;
 *                     37 have no Ghidra xref at all, the rest only from code the tree
 *                     does not emit. Dead in the original too, but its data.
 *   dead              the same with no bytes (.bss). Not emitted.
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

export type GlobalVisibility = 'referenced' | 'initializer-only' | 'interior' | 'container' | 'unreferenced' | 'dead';

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

  // Through initializers, from every global that will be emitted, to a fixpoint.
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

  // Objects, by a sweep in address order: a global that starts inside the current
  // object is a label on one of its slots, not an object, and its own size says
  // nothing (Ghidra gives `gFaultHandlerList.head.pNext` the list's 12 bytes from
  // 8 bytes in, which would reach over the next object).
  const all = [...input.others, ...input.candidates]
    .map(g => ({ g, x: extentOf(g) }))
    .filter((e): e is { g: AnalyzedDataSymbol; x: [number, number] } => e.x !== undefined)
    .sort((a, b) => a.x[0] - b.x[0] || b.x[1] - a.x[1]);
  const objectOf = new Map<AnalyzedDataSymbol, AnalyzedDataSymbol>();
  let object: { g: AnalyzedDataSymbol; x: [number, number] } | undefined;
  for (const item of all) {
    if (object && item.x[0] < object.x[1]) { objectOf.set(item.g, object.g); continue; }
    object = item;
  }
  const labelsIn = new Map<AnalyzedDataSymbol, AnalyzedDataSymbol[]>();
  for (const [label, obj] of objectOf) (labelsIn.get(obj) ?? labelsIn.set(obj, []).get(obj)!).push(label);

  // Kept: what is named, what is not a candidate, and - once nothing names it - an
  // object holding bytes of the original image or a live label. Everything a kept
  // initializer names is kept with it, so the loop runs until nothing is added.
  const kept = new Set<AnalyzedDataSymbol>([...input.others, ...live]);
  const reachedFrom = (roots: Iterable<AnalyzedDataSymbol>): void => {
    const work = [...roots];
    while (work.length > 0) {
      const o = work.pop()!;
      for (const t of targetsOf(o)) {
        const e = entries.get(t)!;
        e.referrers.add(o);
        if (e.verdict === 'dead' || e.verdict === 'interior') { e.verdict = 'initializer-only'; e.neighbour = undefined; }
        if (!kept.has(t)) { kept.add(t); work.push(t); }
      }
    }
  };
  reachedFrom(kept);
  for (;;) {
    const added: AnalyzedDataSymbol[] = [];
    for (const g of input.candidates) {
      const e = entries.get(g)!;
      if (e.verdict !== 'dead') continue;
      const obj = objectOf.get(g);
      // A slot of a kept object: the object holds its bytes.
      if (obj && kept.has(obj)) { e.verdict = 'interior'; e.neighbour = obj; continue; }
      if (obj) continue;
      const liveLabel = (labelsIn.get(g) ?? []).find(l => kept.has(l));
      if (liveLabel) { e.verdict = 'container'; e.neighbour = liveLabel; added.push(g); continue; }
      // Bytes of the original image nothing names: kept, declared nowhere.
      if (g.isInitialized) { e.verdict = 'unreferenced'; added.push(g); }
    }
    if (added.length === 0) break;
    for (const g of added) kept.add(g);
    reachedFrom(added);
  }

  const counts: Record<GlobalVisibility, number> = { referenced: 0, 'initializer-only': 0, interior: 0, container: 0, unreferenced: 0, dead: 0 };
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
