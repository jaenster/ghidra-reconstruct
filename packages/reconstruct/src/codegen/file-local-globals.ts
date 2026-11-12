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
import { classScopeOf } from './templates/index.js';

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
  considered: (g: AnalyzedDataSymbol) => boolean = g => g.scope === 'file-local',
): Set<AnalyzedDataSymbol> {
  const out = new Set<AnalyzedDataSymbol>();
  if (foreignSources.length === 0) return out;
  const byName = new Map<string, AnalyzedDataSymbol[]>();
  const byAddress = new Map<number, AnalyzedDataSymbol>();
  const extents: Array<{ lo: number; hi: number; g: AnalyzedDataSymbol }> = [];
  const names = new Set(globals.map(g => g.suggestedName || g.name));
  for (const g of globals) {
    if (!considered(g)) continue;
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
  // Extents can overlap (Ghidra gives a label inside a datum the datum's size: the RECT[16]
  // labels gnTextBoxExclusionLeft..Width at 007bf0a8..007bf0b8 are 256 bytes each), so a
  // bisection on both edges can step past the one that holds `v`, and which one it steps
  // past moves with every symbol added to the list. The last start at or below `v`, then
  // back while a start can still reach it: the innermost extent holding `v`.
  let longest = 0;
  for (const e of extents) longest = Math.max(longest, e.hi - e.lo);
  const containing = (v: number): AnalyzedDataSymbol | undefined => {
    let lo = 0, hi = extents.length - 1, last = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (extents[mid].lo <= v) { last = mid; lo = mid + 1; } else hi = mid - 1;
    }
    for (let i = last; i >= 0 && extents[i].lo > v - longest; i--) {
      if (v < extents[i].hi) return extents[i].g;
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
 * Move back to the globals units every member of a run that cannot move into its
 * TU whole: a run with a member that cannot live there - a static-local of another
 * TU's function, or a global no home could be given (`assignDataHomes`). Every
 * other member is in the TU already: a file-local `static`, a function-local
 * static of one of its functions, or a global it defines with external linkage.
 * Returns how many file-locals moved back.
 */
export function keepDataRunsWhole(
  globals: AnalyzedDataSymbol[],
  implOf: ReadonlyMap<string, string>,
): number {
  let demoted = 0;
  for (const run of dataRuns(globals, implOf)) {
    if (!run.members.some(g => g.scope === 'file-local' || g.homeFile !== undefined)) continue;
    const inUnit = (g: AnalyzedDataSymbol): boolean =>
      (g.scope === 'file-local' && g.ownerFile === run.unit)
      || (g.scope === 'static-local' && g.ownerFunction !== undefined && implOf.get(g.ownerFunction) === run.unit)
      || (g.scope === 'global' && g.homeFile === run.unit);
    if (run.members.every(inUnit)) continue;
    // Named after the first member that cannot move, for the scope report.
    const blocker = run.members.find(g => !inUnit(g) && g.scope !== 'static-local')
      ?? run.members.find(g => !inUnit(g));
    const why = !blocker ? 'other'
      : blocker.scope === 'static-local' ? 'static-local-elsewhere'
      : homeVeto.get(blocker) ? `home-veto:${homeVeto.get(blocker)}`
      : !(blocker.referencingFunctions?.length) ? 'member-without-code-users'
      : globalScopeReason(blocker) ?? 'member-kept-external';
    const reason = `run-not-whole:${why}@${blocker ? `${blocker.suggestedName || blocker.name}:${blocker.address}` : ''}`;
    for (const g of run.members) {
      if (g.homeFile !== undefined) {
        homeVeto.set(g, reason);
        g.homeFile = undefined;
        g.homeDeclaredCentrally = undefined;
        continue;
      }
      if (g.scope !== 'file-local') continue;
      demote(g, reason);
      demoted++;
    }
  }
  return demoted;
}

/**
 * Why `assignDataHomes` gave a global no home, for the report. Keyed by identity;
 * one generation run, one table (`assignDataHomes` clears it).
 */
const homeVeto = new WeakMap<AnalyzedDataSymbol, string>();

/** Why `g` has no home ('' when it has one, 'no-run' when it sits in no TU's run). */
export function dataHomeVeto(g: AnalyzedDataSymbol): string {
  if (g.homeFile !== undefined) return '';
  return homeVeto.get(g) ?? 'no-run';
}

/** Counts of the reasons the last `assignDataHomes`/`keepDataRunsWhole` left a global homeless. */
export function dataHomeVetoCounts(globals: readonly AnalyzedDataSymbol[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const g of globals) {
    const why = homeVeto.get(g);
    if (!why) continue;
    const key = why.replace(/@.*$/, '');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export interface DataHomeInputs {
  /** Hand-written source built beside the tree: a global it names stays declared in globals.h. */
  foreignSources: ReadonlyArray<ForeignSource>;
  /** Every function's qualified (and sanitized) name: a global sharing one is declared by nothing. */
  functionQualifiedNames: ReadonlySet<string>;
  /**
   * Root-scope names a namespace block cannot open under: data type names and root
   * globals. globals.h folds such a leading segment away; a home TU, emitted
   * before that table exists, cannot, so a global in such a namespace keeps no home.
   */
  rootTypeNames: ReadonlySet<string>;
}

/**
 * Give every external global the translation unit its data run belongs to.
 *
 * A global several TUs use is still DATA OF ONE TU: the original linked it inside
 * that object's run, in address order, beside the TU's own statics (design study
 * 2026-11-03: 95% of .data and 86% of .bss sit in their TU's largest run). So it
 * is defined there, with external linkage, and declared in that TU's data header
 * (`dataHeaderPathOf`), which only the TUs that name it include. globals.h keeps
 * what has no home: symbols at a run boundary, in no run, or vetoed here.
 *
 * The home is the run's TU, never a vote of the users: a run is one object's data
 * whatever reads it (`dataRuns`). A symbol hand-written source names keeps its
 * home but is declared in globals.h, which that source includes.
 *
 * Vetoes, each of which globals.h or the globals units resolve today in a way one
 * TU cannot: a name two symbols share (one definition per name, chosen centrally),
 * a name a function owns, an `#ifdef`-guarded symbol, a template-instance
 * namespace, a namespace whose leading segment a root name blocks, and a name with
 * an array dimension in it.
 */
export function assignDataHomes(
  globals: AnalyzedDataSymbol[],
  implOf: ReadonlyMap<string, string>,
  inputs: DataHomeInputs,
): { homed: number; centrallyDeclared: number } {
  for (const g of globals) { g.homeFile = undefined; g.homeDeclaredCentrally = undefined; homeVeto.delete(g); }
  // One emitted name, one symbol: the bare sanitized spelling, because that is the
  // token a body names it by and the key user TUs find their include by. A
  // function-local static is no such name: it is declared inside its function and
  // shadows any extern of the same spelling there.
  const nameCount = new Map<string, number>();
  for (const g of globals) {
    if (g.scope === 'static-local') continue;
    const n = sanitizeSymbolName(g.suggestedName || g.name);
    nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
  }
  const rootGlobalNames = new Set<string>();
  for (const g of globals) if (g.scope === 'global' && !g.namespace) rootGlobalNames.add(sanitizeSymbolName(g.suggestedName || g.name));
  const foreign = foreignReferencedFileLocals(globals, inputs.foreignSources, g => g.scope === 'global');
  const veto = (g: AnalyzedDataSymbol): string | undefined => {
    const raw = g.suggestedName || g.name;
    const name = sanitizeSymbolName(raw);
    if (/\[/.test(raw)) return 'name-with-dimension';
    if (g.ifdef) return 'ifdef';
    if ((nameCount.get(name) ?? 0) > 1) return 'shared-name';
    const ns = g.namespace;
    if (ns && /[<>,*/]/.test(ns)) return 'template-namespace';
    const qualified = ns ? `${ns}::${name}` : name;
    if (inputs.functionQualifiedNames.has(qualified) || inputs.functionQualifiedNames.has(name)) return 'function-name';
    if (ns) {
      // A class's static data member is defined as `T Class::member`, never inside
      // a namespace block; the template header places those (templates/placement.ts).
      if (classScopeOf(g) !== undefined) return 'class-member';
      const lead = ns.split('::')[0];
      if (inputs.rootTypeNames.has(lead) || rootGlobalNames.has(lead)) return 'namespace-blocked';
    }
    return undefined;
  };
  let homed = 0, centrallyDeclared = 0;
  for (const run of dataRuns(globals, implOf)) {
    for (const g of run.members) {
      if (g.scope !== 'global') continue;
      const why = veto(g);
      if (why) { homeVeto.set(g, why); continue; }
      g.homeFile = run.unit;
      homed++;
      if (foreign.has(g)) { g.homeDeclaredCentrally = true; centrallyDeclared++; }
    }
  }
  return { homed, centrallyDeclared };
}

/** The data header beside a TU: `D2Common/Items/Items.cpp` -> `D2Common/Items/Items.data.h`. */
export function dataHeaderPathOf(implPath: string): string {
  return implPath.replace(/\.(?:cpp|cc|cxx|c)$/, '') + '.data.h';
}

/**
 * The key a homed global contributes to its home unit's recorded statics: the unit
 * defines it, so a global that moves in or out re-emits the unit.
 */
export function homedGlobalKey(g: { address: string }): string {
  return `H:${fileLocalGlobalKey(g).slice(2)}`;
}

/** The key a file-local global contributes to its unit's recorded statics. */
export function fileLocalGlobalKey(g: { address: string }): string {
  return `G:${String(g.address).replace(/^.*:/, '').replace(/^0x/i, '').toLowerCase().padStart(8, '0')}`;
}
