/**
 * The order of a module's units in its library: the order the 1.14d link had them.
 *
 * A linker lays out an object's code together, objects in the order they reach it,
 * so the original's address order is its link order. A unit is placed by the
 * 1.14d address of its first function in its module's runs (project.json
 * `moduleRuns`): a function the unit holds from far outside them - a namespace
 * that gathered a stray from another module - does not drag the unit forward. A
 * unit with none there is placed by its first function at all; a unit with no
 * function goes last, in path order.
 *
 * Many units are split: their functions form several runs with other units'
 * functions between (an inlined helper the original kept in another object, a
 * namespace that is two source files). The first run decides; the count is
 * reported beside the order, since a split unit is the limit on how far the
 * link order alone can bring the layout.
 *
 * The order reaches the build as `D2_MODULE_<m>_UNITS` (codegen/module-layout.ts):
 * the CMake module libraries list their sources in it, so GNU ld, which links an
 * archive's members whole in member order, follows it, and the msvc8 oracle
 * (asm_matching/msvc8/scripts/modules.py) links the VC8 objects and pairs the
 * kept copy of each COMDAT in the same order.
 */

import type { ModuleRun } from '../config/schema.js';
import type { SourceMap } from '../types.js';

/** project.json `modules.<m>.unitOrder`: how the module's library orders its units. */
export const UNIT_ORDER_RULES = ['original-address', 'path'] as const;
export type UnitOrderRule = (typeof UNIT_ORDER_RULES)[number];

export interface PlacedUnit {
  path: string;
  /** The 1.14d address that places the unit; undefined: it holds no function. */
  first?: number;
  /** `first` lies outside the module's runs: the unit has no function inside them. */
  outside: boolean;
  /** Stretches of its functions in 1.14d address order with no other unit's between. */
  runs: number;
}

/**
 * Each unit's function addresses, from the source maps. A function whose body is
 * defined elsewhere (an inline host in its header) is the header's, not the unit's.
 */
export function unitAddresses(maps: Iterable<SourceMap>): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const map of maps) {
    const list = out.get(map.file) ?? [];
    for (const f of map.functions ?? []) {
      if (f.definedIn) continue;
      const a = parseInt(f.address, 16);
      if (Number.isFinite(a)) list.push(a);
    }
    list.sort((x, y) => x - y);
    out.set(map.file, list);
  }
  return out;
}

/** Per unit, how many runs its functions form in the address order of every unit's. */
export function runCounts(addresses: ReadonlyMap<string, readonly number[]>): Map<string, number> {
  const all: Array<[number, string]> = [];
  for (const [unit, list] of addresses) for (const a of list) all.push([a, unit]);
  all.sort((x, y) => x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
  const counts = new Map<string, number>();
  let previous: string | undefined;
  for (const [, unit] of all) {
    if (unit !== previous) counts.set(unit, (counts.get(unit) ?? 0) + 1);
    previous = unit;
  }
  return counts;
}

/** Plain code-unit order: the same on every host, unlike a locale's collation. */
const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A module's units in the original's order. `runs` are the module's own address
 * runs (project.json `moduleRuns` for it); `counts` is runCounts over every unit.
 */
export function orderUnits(
  units: Iterable<string>,
  addresses: ReadonlyMap<string, readonly number[]>,
  runs: readonly ModuleRun[],
  counts: ReadonlyMap<string, number> = runCounts(addresses),
): PlacedUnit[] {
  const bands = runs.map(r => [parseInt(r.start, 16), parseInt(r.end, 16)] as const);
  const inside = (a: number): boolean => bands.some(([s, e]) => a >= s && a < e);
  const placed: PlacedUnit[] = [];
  for (const path of new Set(units)) {
    const list = addresses.get(path) ?? [];
    const own = list.find(inside);
    placed.push({
      path,
      first: own ?? list[0],
      outside: own === undefined && list.length > 0,
      runs: counts.get(path) ?? 0,
    });
  }
  return placed.sort((a, b) => {
    if (a.first === undefined || b.first === undefined) {
      if (a.first !== b.first) return a.first === undefined ? 1 : -1;
      return byPath(a.path, b.path);
    }
    return a.first - b.first || byPath(a.path, b.path);
  });
}
