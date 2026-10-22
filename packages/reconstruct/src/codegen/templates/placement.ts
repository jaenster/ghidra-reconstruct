/**
 * Where a registered class's member definitions go.
 *
 * Each module compiled its own copy of every template member it used, and the
 * linker kept one per COMDAT: the CELLIST members sit in D2CMP's address run,
 * the SGAMEDATA ones twice, once in D2Client's run and once in D2Game's. So a
 * member is defined beside the module code it was linked with: in the directory
 * of the nearest function below it in the same module run (project.json
 * `moduleRuns`) that belongs to the run's module, in a unit named for the
 * element the instantiation is over (`D2CMP/SRC/stpl_CELLIST.cpp`). A member
 * with no such function below it - one at the start of its run - goes beside the
 * nearest such function above it: an object's template COMDATs are linked next to
 * that object's own code, so they belong to the unit that follows them (the
 * HASHKEY_STRI members at 0060dc70.. open D2Common's run, ahead of IgnoreList).
 * A run with neither is placed in the module's directory. A member in a run whose
 * module the project does not configure cannot be placed and stops the regen.
 * Class members (an element's own dtor, IgnoreList's methods) are not module
 * code and are passed over; their namespace names no module. An element's orphan
 * copy (`CELLIST::Destructor_Unreferenced`) is placed like a member: it is a
 * COMDAT the module linked, not the element's own code.
 */

import type { ModuleConfig, ModuleRun } from '../../config/schema.js';
import type { ExtractedFunction } from '../../types.js';
import { normalizeUnitName } from '../namespace.js';
import type { TemplateRegistry } from './registry.js';

function addressValue(address: string): number {
  const hex = address.includes(':') ? address.slice(address.lastIndexOf(':') + 1) : address;
  return parseInt(hex, 16);
}

/** The configured module a run's module name denotes (runs-v2 spells `D2sound`, the project `D2Sound`). */
function configuredModule(name: string, modules: Readonly<Record<string, ModuleConfig>>): string | undefined {
  const lower = name.toLowerCase();
  return Object.keys(modules).find(m => m.toLowerCase() === lower);
}

/**
 * The unit of every registered member, keyed by address. `modules` are the
 * project's modules; a function homed under one of them is module code. Every
 * member must lie in one of `runs`.
 */
export function placeTemplateMembers(
  registry: TemplateRegistry,
  functions: readonly ExtractedFunction[],
  modules: Readonly<Record<string, ModuleConfig>>,
  runs: readonly ModuleRun[],
): Map<string, string> {
  const ordered = [...functions].sort((a, b) => addressValue(a.address) - addressValue(b.address));
  const spans = runs
    .map(r => ({ module: r.module, start: addressValue(r.start), end: addressValue(r.end) }))
    .sort((a, b) => a.start - b.start);
  const runOf = (address: number) => spans.find(r => r.start <= address && address < r.end);
  const placement = new Map<string, string>();
  let run: (typeof spans)[number] | undefined;
  let moduleDir: string | undefined;
  // Members met before any module function of their run, waiting for the one above.
  let pending: { address: string; element: string }[] = [];
  const settle = (dir: string) => {
    for (const m of pending) placement.set(m.address, `${dir}::${registry.implPrefix}${m.element}`);
    pending = [];
  };
  const closeRun = () => {
    if (pending.length === 0 || !run) return;
    const module = configuredModule(run.module, modules)!;
    settle(normalizeUnitName(modules[module].namespaces[0]));
  };
  for (const f of ordered) {
    const address = addressValue(f.address);
    const here = runOf(address);
    if (here !== run) {
      closeRun();
      run = here;
      moduleDir = undefined;
    }
    const ns = f.namespace ?? undefined;
    if (ns && (registry.isClassScope(ns) || registry.isOrphan(f.address))) {
      if (!run) {
        throw new Error(`template member ${f.address} ${ns}::${f.name} lies in no module run (project.json moduleRuns)`);
      }
      const element = registry.instantiation(ns)?.element ?? ns;
      if (!configuredModule(run.module, modules)) {
        throw new Error(`template member ${f.address} ${ns}::${f.name} lies in the ${run.module} run, a module project.json does not configure`);
      }
      if (moduleDir) placement.set(f.address, `${moduleDir}::${registry.implPrefix}${element}`);
      else pending.push({ address: f.address, element });
      continue;
    }
    if (!ns || !run) continue;
    // A unit's file is its last segment, inside the directory the rest spell; a
    // one-segment unit is `X/X.cpp`.
    const segments = normalizeUnitName(ns).split('::');
    if (segments[0] !== configuredModule(run.module, modules)) continue;
    moduleDir = segments.length > 1 ? segments.slice(0, -1).join('::') : segments[0];
    settle(moduleDir);
  }
  closeRun();
  return placement;
}
