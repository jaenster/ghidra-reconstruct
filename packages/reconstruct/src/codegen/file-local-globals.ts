/**
 * Which globals a translation unit may own as `static`: the whole-program half.
 *
 * `computeFileLocalGlobals` and `reconcileStaticScopeWithBodyReferences` decide
 * from the code that USES a symbol. Two more facts decide whether that answer can
 * stand, and neither is visible from a function body:
 *
 *  - FOREIGN SOURCE. Hand-written code built beside the tree (`support/`, the
 *    d2bs-ng imports) names globals by name or by address. A `static` there is a
 *    link error at best; at worst the foreign file declares its own extern, finds
 *    nothing, and nobody notices until the feature it drives stops working.
 *
 *  - LAYOUT. The original linked each object's data as one contiguous run, in
 *    definition order, and code relies on it: a memset that spans a run of
 *    neighbours, a table read past its end into the next symbol, a loop bounded by
 *    the neighbour's address. A run moved into its TU but split - half `static`
 *    there, half defined in a globals unit - puts a boundary inside it that the
 *    original never had. So a run moves whole or not at all: every member must be
 *    able to live in the TU, or none of them is moved.
 *
 * A run is read off the address order of the program's data: consecutive storage
 * symbols that belong to one TU. A symbol belongs to the TU all its users are in;
 * one without a single-TU user set (several TUs, none, an unmapped function)
 * belongs to the TU on both sides of it, and otherwise to no run. That is the same
 * attribution the original's data layout was checked against (design study,
 * 2026-11-03): per-TU data is contiguous and in link order.
 */
import type { AnalyzedDataSymbol } from '../types.js';
import type { ForeignSource } from './file-static-functions.js';
import { scanReferences, mangledSourceNames } from './file-static-functions.js';
import { isEmittableGlobal, isUnreferenceableArtifact, sanitizeSymbolName } from './globals-header.js';
import { noteGlobalScopeReason, globalScopeReason } from './global-scope-trace.js';

const GHIDRA_DATA_LABEL = /^(?:DAT|PTR|s|u|BYTE|WORD|DWORD|PTR_DAT|PTR_FUN)_(?:.*_)?([0-9a-fA-F]{8})$/;

function addressOf(g: { address: string }): number {
  return Number.parseInt(String(g.address).replace(/^.*:/, '').replace(/^0x/i, ''), 16);
}

function demote(g: AnalyzedDataSymbol, reason: string): void {
  noteGlobalScopeReason(g, reason);
  g.scope = 'global';
  g.ownerFile = undefined;
  g.ownerFunction = undefined;
}

/**
 * The file-local symbols foreign source names, by emitted name, by Ghidra's default
 * label for the address, or (for a source with an `addressBase`) by an integer
 * literal inside the symbol's extent.
 */
export function foreignReferencedFileLocals(
  globals: readonly AnalyzedDataSymbol[],
  foreignSources: ReadonlyArray<ForeignSource>,
): Set<AnalyzedDataSymbol> {
  const out = new Set<AnalyzedDataSymbol>();
  if (foreignSources.length === 0) return out;
  const byName = new Map<string, AnalyzedDataSymbol[]>();
  const byAddress = new Map<number, AnalyzedDataSymbol>();
  const extents: Array<{ lo: number; hi: number; g: AnalyzedDataSymbol }> = [];
  const names = new Set(globals.map(g => g.suggestedName || g.name));
  for (const g of globals) {
    if (g.scope !== 'file-local') continue;
    // A label inside another datum is not storage: an address in its extent is
    // one in its parent's, and the extents searched below must not overlap.
    if (!isEmittableGlobal(g) || isUnreferenceableArtifact(g, names)) continue;
    for (const n of new Set([g.suggestedName || g.name, sanitizeSymbolName(g.suggestedName || g.name), g.name])) {
      const list = byName.get(n);
      if (list) list.push(g); else byName.set(n, [g]);
    }
    const a = addressOf(g);
    if (!Number.isFinite(a)) continue;
    byAddress.set(a, g);
    const size = Number(g.size);
    extents.push({ lo: a, hi: a + (Number.isSafeInteger(size) && size > 0 ? size : 1), g });
  }
  if (byName.size === 0) return out;
  extents.sort((x, y) => x.lo - y.lo);
  const containing = (v: number): AnalyzedDataSymbol | undefined => {
    let lo = 0, hi = extents.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const e = extents[mid];
      if (v < e.lo) hi = mid - 1;
      else if (v >= e.hi) lo = mid + 1;
      else return e.g;
    }
    return undefined;
  };
  const onName = (name: string): void => {
    for (const g of byName.get(name) ?? []) out.add(g);
    const label = GHIDRA_DATA_LABEL.exec(name);
    if (label) {
      const g = byAddress.get(Number.parseInt(label[1], 16));
      if (g) out.add(g);
    }
  };
  for (const src of foreignSources) {
    scanReferences(src.text, name => {
      onName(name);
      for (const part of mangledSourceNames(name)) onName(part);
    }, value => {
      if (src.addressBase === undefined) return;
      const g = containing(value + src.addressBase);
      if (g) out.add(g);
    });
  }
  return out;
}

/** Foreign source names these: they keep external linkage. Returns how many moved back. */
export function keepForeignReferencedGlobalsExternal(
  globals: AnalyzedDataSymbol[],
  foreignSources: ReadonlyArray<ForeignSource>,
): number {
  const hit = foreignReferencedFileLocals(globals, foreignSources);
  for (const g of hit) demote(g, 'foreign-source');
  return hit.size;
}

export interface DataRun {
  unit: string;
  members: AnalyzedDataSymbol[];
}

/**
 * The program's data, cut into per-TU runs in address order. `implOf` maps a
 * function name to its impl file.
 */
export function dataRuns(
  globals: readonly AnalyzedDataSymbol[],
  implOf: ReadonlyMap<string, string>,
): DataRun[] {
  const names = new Set(globals.map(g => g.suggestedName || g.name));
  const storage = globals
    .filter(g => isEmittableGlobal(g) && !isUnreferenceableArtifact(g, names) && Number.isFinite(addressOf(g)))
    .sort((a, b) => addressOf(a) - addressOf(b));
  // The TU every user of a symbol is in, or undefined.
  const homeOf = (g: AnalyzedDataSymbol): string | undefined => {
    if (g.scope === 'file-local') return g.ownerFile;
    if (g.scope === 'static-local' && g.ownerFunction) return implOf.get(g.ownerFunction);
    let home: string | undefined;
    for (const fn of g.referencingFunctions ?? []) {
      const p = implOf.get(fn);
      if (!p) return undefined;
      if (home === undefined) home = p;
      else if (home !== p) return undefined;
    }
    return home;
  };
  const homes = storage.map(homeOf);
  // A symbol without a home of its own belongs to the run it sits inside.
  const runUnit: Array<string | undefined> = homes.slice();
  let prev: string | undefined;
  const prevHome: Array<string | undefined> = [];
  for (let i = 0; i < storage.length; i++) {
    prevHome.push(prev);
    if (homes[i] !== undefined) prev = homes[i];
  }
  let next: string | undefined;
  for (let i = storage.length - 1; i >= 0; i--) {
    if (homes[i] === undefined && prevHome[i] !== undefined && prevHome[i] === next) runUnit[i] = next;
    if (homes[i] !== undefined) next = homes[i];
  }
  const runs: DataRun[] = [];
  let cur: DataRun | undefined;
  for (let i = 0; i < storage.length; i++) {
    const unit = runUnit[i];
    if (unit === undefined) { cur = undefined; continue; }
    if (cur && cur.unit === unit) cur.members.push(storage[i]);
    else { cur = { unit, members: [storage[i]] }; runs.push(cur); }
  }
  return runs;
}

/**
 * Move back to `global` every file-local symbol whose run cannot move into its TU
 * whole: a run with a member that some other TU uses, that nothing in code uses, or
 * that a veto keeps external. Function-local statics are left alone - they are in
 * the TU already, inside their function. Returns how many moved back.
 */
export function keepDataRunsWhole(
  globals: AnalyzedDataSymbol[],
  implOf: ReadonlyMap<string, string>,
): number {
  let demoted = 0;
  for (const run of dataRuns(globals, implOf)) {
    if (!run.members.some(g => g.scope === 'file-local')) continue;
    const whole = run.members.every(g =>
      (g.scope === 'file-local' && g.ownerFile === run.unit)
      || (g.scope === 'static-local' && g.ownerFunction !== undefined && implOf.get(g.ownerFunction) === run.unit));
    if (whole) continue;
    // Named after the first member that cannot move, for the scope report.
    const blocker = run.members.find(g => g.scope !== 'file-local' && g.scope !== 'static-local')
      ?? run.members.find(g => g.scope === 'static-local');
    const why = !blocker ? 'other'
      : blocker.scope === 'static-local' ? 'static-local-elsewhere'
      : !(blocker.referencingFunctions?.length) ? 'member-without-code-users'
      : globalScopeReason(blocker) ?? 'member-kept-external';
    for (const g of run.members) {
      if (g.scope !== 'file-local') continue;
      demote(g, `run-not-whole:${why}@${blocker ? `${blocker.suggestedName || blocker.name}:${blocker.address}` : ''}`);
      demoted++;
    }
  }
  return demoted;
}

/** The key a file-local global contributes to its unit's recorded statics. */
export function fileLocalGlobalKey(g: { address: string }): string {
  return `G:${String(g.address).replace(/^.*:/, '').replace(/^0x/i, '').toLowerCase().padStart(8, '0')}`;
}
