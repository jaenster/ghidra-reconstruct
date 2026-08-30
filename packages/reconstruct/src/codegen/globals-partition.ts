/**
 * Which module's translation unit a central global's DEFINITION belongs in.
 *
 * `globals.cpp` was one translation unit for the whole binary, and that is what
 * stops anything smaller than the whole binary from linking. Its initializers
 * name every module's functions - a dispatch table of D2Game handlers, a
 * renderer vtable of D2Gdi entry points - so pulling in one data symbol pulls
 * the object file, and the object file pulls every module. Measured on the v785
 * snapshot: 1289 of its pointer initializers resolve to a function, spread over
 * thirteen modules, and a D2Common-only link fails on 1001 undefined symbols
 * that have nothing to do with D2Common.
 *
 * The fix is to give each module its own globals translation unit, so a slice
 * links the data it uses and not the data it does not. The attribution is in
 * the extraction itself and needs no external table:
 *
 *   - `referencingFunctions` says which functions read the global, and a
 *     function's module is the first segment of its Ghidra namespace - the same
 *     rule that decides which directory its .cpp is written to;
 *   - `initializedData` carries its pointer targets BY NAME, so the functions a
 *     definition will name are known before a line is rendered.
 *
 * A global is placed only when BOTH agree on one module. Either disagreeing -
 * two modules read it, a referencing function cannot be placed, or the table
 * points at a function from somewhere else - leaves it in the shared
 * `globals.cpp`, which is where an unplaced symbol was already going. So the
 * split can only ever move a definition, never lose one and never duplicate
 * one: `generateGlobalsImpl` still computes its one-definition-per-name winner
 * over the WHOLE set, and each file emits the winners in its own partition.
 *
 * On the v785 snapshot this places 3337 of 6713 central globals and moves 872 of
 * the 1289 cross-module function references out of the shared unit. The 417 that
 * remain are tables no function reads (renderer vtables reached only through
 * another table) and tables two modules share; those are a real cross-module
 * dependency, not a filing error, and they stay visible.
 */

import type { AnalyzedDataSymbol, ExtractedFunction, DataValue } from '../types.js';

export interface GlobalsPartition {
  /** The module whose directory this unit is written beside, e.g. `D2Common`. */
  module: string;
  members: AnalyzedDataSymbol[];
}

export interface GlobalsPartitionResult {
  partitions: GlobalsPartition[];
  /** Everything no single module owns; these keep `globals.cpp`. */
  shared: AnalyzedDataSymbol[];
}

/**
 * Function name → module, keyed by BOTH the qualified and the bare spelling.
 *
 * `referencingFunctions` and a pointer initializer's target are recorded with
 * whichever spelling Ghidra held, so both have to resolve. A bare name two
 * modules both declare is dropped rather than guessed at - the same unanimity
 * rule the field-type tables run on - and a global whose reference cannot be
 * placed stays shared, which is the safe direction.
 */
export function buildFunctionModuleMap(
  functions: readonly ExtractedFunction[],
): Map<string, string> {
  const byName = new Map<string, string>();
  const ambiguousBare = new Set<string>();
  for (const fn of functions) {
    if (!fn.name) continue;
    const ns = fn.namespace ?? '';
    const module = ns ? ns.split('::')[0] : '';
    if (!module) continue;
    byName.set(ns ? `${ns}::${fn.name}` : fn.name, module);
    const held = byName.get(fn.name);
    if (held === undefined) byName.set(fn.name, module);
    else if (held !== module) ambiguousBare.add(fn.name);
  }
  for (const n of ambiguousBare) byName.delete(n);
  return byName;
}

/** Every name a pointer in this datum points at, however deeply nested. */
function collectPointerTargets(value: DataValue | undefined | null, out: string[]): void {
  if (!value || typeof value !== 'object') return;
  if (value.kind === 'pointer' && typeof value.value === 'string' && value.value) {
    out.push(value.value);
  }
  for (const e of value.elements ?? []) collectPointerTargets(e, out);
  for (const f of value.fields ?? []) collectPointerTargets(f.value, out);
}

export function partitionGlobalsByModule(
  globals: readonly AnalyzedDataSymbol[],
  functionModules: ReadonlyMap<string, string>,
): GlobalsPartitionResult {
  const byModule = new Map<string, AnalyzedDataSymbol[]>();
  const shared: AnalyzedDataSymbol[] = [];

  for (const g of globals) {
    const modules = new Set<string>();
    let unplaceable = false;

    const refs = g.referencingFunctions ?? [];
    for (const r of refs) {
      const m = functionModules.get(r);
      if (m === undefined) { unplaceable = true; break; }
      modules.add(m);
    }

    // A global no function reads is reached only through another global's
    // table. Its own pointer targets are then the only evidence there is, and
    // one module's worth of them is enough to place it.
    if (!unplaceable) {
      const targets: string[] = [];
      collectPointerTargets(g.initializedData, targets);
      if (typeof g.value === 'string' && g.value) targets.push(g.value);
      for (const t of targets) {
        const m = functionModules.get(t);
        // A target that is not a function - a label, another datum, a switch
        // case - says nothing about the module and is not a disqualification.
        if (m !== undefined) modules.add(m);
      }
    }

    if (unplaceable || modules.size !== 1) { shared.push(g); continue; }
    const module = [...modules][0];
    const list = byModule.get(module);
    if (list) list.push(g); else byModule.set(module, [g]);
  }

  const partitions = [...byModule]
    .map(([module, members]) => ({ module, members }))
    .sort((a, b) => a.module.localeCompare(b.module));
  return { partitions, shared };
}
