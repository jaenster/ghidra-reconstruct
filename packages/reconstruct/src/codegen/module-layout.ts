/**
 * The module layout, applied to the finished tree: every generated file moves to
 * its module's `dir` (project.json `modules`), every include of it follows, and
 * the build's copy of the module table is written beside the sources.
 *
 * It runs last on purpose. Everything before it - the units, the globals
 * partition, the module-boundary pass, the caches the daemon keys by unit - works
 * on the namespace paths (`D2Common/ITEMS/Items.cpp`), so only the paths the tree
 * is written to change.
 */

import type { ModuleConfig, ModuleRun } from '../config/schema.js';
import type { ReconstructedProject, SourceFile, SourceMap } from '../types.js';
import { ModuleGraph } from '../modules/module-libraries.js';
import {
  ModuleLayout, MODULES_CMAKE_PATH, PUBLIC_HEADER_SUFFIX, dependencyList, linkOrdered, reachability, windowsModules,
} from '../modules/module-model.js';
import { orderUnits, runCounts, unitAddresses, type PlacedUnit } from '../modules/unit-order.js';

const BANNER = `# Generated from project.json "modules" by ghidra-mcp ${String.fromCharCode(0x2014)} DO NOT EDIT; change the module table there`;

export function applyModuleLayout(
  project: ReconstructedProject,
  modules: Record<string, ModuleConfig>,
  graph: ModuleGraph | undefined,
  runs: readonly ModuleRun[] = [],
): ModuleLayout {
  const layout = new ModuleLayout(modules);
  const generated = new Set(project.files.keys());
  // A public header named like one of its module's units, in another case, would
  // overwrite it on a case-insensitive disk: that module keeps the pass's own name.
  const placed = new Set<string>();
  const publicSources = new Map<string, string>();
  for (const path of generated) {
    if (path.endsWith(PUBLIC_HEADER_SUFFIX)) publicSources.set(path, layout.pathOf(path));
    else placed.add(layout.pathOf(path).toLowerCase());
  }
  for (const [source, target] of publicSources) {
    if (!placed.has(target.toLowerCase())) continue;
    const module = layout.moduleOfPath(target);
    if (!module) continue;
    const fallback = source.slice(source.lastIndexOf('/') + 1);
    console.warn(`warning: ${module}'s public header ${target} would collide with a unit of the same name in another case; it is ${fallback}`);
    layout.renamePublicHeader(module, fallback);
  }

  const files = new Map<string, SourceFile>();
  for (const [path, file] of project.files) {
    const moved = layout.pathOf(path);
    files.set(moved, {
      ...file,
      path: moved,
      content: layout.rewriteIncludes(file.content, generated),
      includes: file.includes.map(i => (generated.has(i) ? layout.pathOf(i) : i)),
    });
  }
  const sourceMaps = new Map<string, (typeof project.sourceMaps extends Map<string, infer M> ? M : never)>();
  for (const [path, map] of project.sourceMaps) {
    sourceMaps.set(layout.pathOf(path), { ...map, file: layout.pathOf(map.file) });
  }
  for (const m of project.buildInfo?.modules ?? []) {
    if (m.implPath) m.implPath = layout.pathOf(m.implPath);
  }

  const dataUnits = new Map<string, string>();
  if (graph) {
    for (const path of generated) {
      const m = /^globals\/([^/]+)\.(?:cpp|c)$/.exec(path);
      if (m && graph.has(m[1])) dataUnits.set(m[1], layout.pathOf(path));
    }
  }
  const publicHeaders = new Map<string, string>();
  for (const name of Object.keys(modules)) {
    const p = layout.publicHeaderPath(name);
    if (p && files.has(p)) publicHeaders.set(name, p);
  }
  const units = moduleUnitOrders(modules, layout, files, sourceMaps.values(), runs);
  files.set(MODULES_CMAKE_PATH, {
    path: MODULES_CMAKE_PATH,
    content: modulesCMake(modules, dataUnits, publicHeaders, units),
    type: 'header',
    functions: [],
    includes: [],
  });
  for (const name of windowsModules(modules)) {
    const m = modules[name];
    if (m.kind !== 'headers-only' || !m.description) continue;
    const readme = `${m.dir}/README.md`;
    if (files.has(readme)) continue;
    files.set(readme, {
      path: readme,
      content: `# ${name}\n\n${m.description}\n`,
      type: 'header',
      functions: [],
      includes: [],
    });
  }

  project.files.clear();
  for (const [k, v] of files) project.files.set(k, v);
  project.sourceMaps.clear();
  for (const [k, v] of sourceMaps) project.sourceMaps.set(k, v);
  return layout;
}

/**
 * Each module with `unitOrder: "original-address"`: its units (the implementation
 * files in its directory) in the 1.14d link's order, read off the source maps.
 */
export function moduleUnitOrders(
  modules: Record<string, ModuleConfig>,
  layout: ModuleLayout,
  files: ReadonlyMap<string, SourceFile>,
  maps: Iterable<SourceMap>,
  runs: readonly ModuleRun[],
): Map<string, PlacedUnit[]> {
  const out = new Map<string, PlacedUnit[]>();
  const ordered = windowsModules(modules).filter(n => modules[n].unitOrder === 'original-address');
  if (ordered.length === 0) return out;
  const addresses = unitAddresses(maps);
  const counts = runCounts(addresses);
  const unitsOf = new Map<string, string[]>();
  for (const [path, file] of files) {
    if (file.type !== 'implementation') continue;
    const module = layout.moduleOfPath(path);
    if (module === undefined) continue;
    unitsOf.set(module, [...(unitsOf.get(module) ?? []), path]);
  }
  for (const name of ordered) {
    // moduleRuns spells a module as attribution-v2 does (D2sound): matched case-blind.
    const own = runs.filter(r => r.module.toLowerCase() === name.toLowerCase());
    out.set(name, orderUnits(unitsOf.get(name) ?? [], addresses, own, counts));
  }
  return out;
}

/**
 * The include pass's preference: for a file of another module, a module's public
 * header before any internal header that provides the same name.
 */
export function publicHeaderRank(layout: ModuleLayout, files: ReadonlyMap<string, unknown>, modules: Record<string, ModuleConfig>): (from: string, candidate: string) => number {
  const publicPaths = new Set<string>();
  for (const name of Object.keys(modules)) {
    const p = layout.publicHeaderPath(name);
    if (p && files.has(p)) publicPaths.add(p);
  }
  return (from, candidate) =>
    publicPaths.has(candidate) && layout.moduleOfPath(candidate) !== layout.moduleOfPath(from) ? 0 : 1;
}

/** Where a unit was placed from, as its comment in D2_MODULE_<m>_UNITS says it. */
function unitNote(u: PlacedUnit): string {
  if (u.first === undefined) return 'no function';
  const at = u.first.toString(16).padStart(8, '0');
  const runs = u.runs === 1 ? '1 run' : `${u.runs} runs`;
  return `${at}${u.outside ? ' (outside the module\'s runs)' : ''}, ${runs}`;
}

/** A CMake list value: names never hold spaces or semicolons. */
const list = (items: Iterable<string>): string => [...items].join(' ');

/**
 * `Source/modules.cmake`: the module table as the build reads it. One variable
 * family per module, `D2_MODULES` in link order; the gate scanner
 * (cmake/module-gates.cmake) reads the same file.
 */
export function modulesCMake(
  modules: Record<string, ModuleConfig>,
  dataUnits: ReadonlyMap<string, string>,
  publicHeaders: ReadonlyMap<string, string> = new Map(),
  units: ReadonlyMap<string, readonly PlacedUnit[]> = new Map(),
): string {
  const names = linkOrdered(modules, windowsModules(modules));
  const reach = reachability(modules);
  const L: string[] = [];
  L.push(BANNER);
  L.push('# The modules the Windows build compiles. cmake/check-modules.cmake checks this file');
  L.push('# against project.json at configure time.');
  L.push('#   D2_MODULES                 every module, in the executable\'s link order');
  L.push('#   D2_MODULE_<m>_DIR          its directory');
  L.push('#   D2_MODULE_<m>_KIND         exe, dll-module, headers-only, 3rdparty or ours');
  L.push('#   D2_MODULE_<m>_DEPENDS      the modules it depends on directly');
  L.push('#   D2_MODULE_<m>_IMPORTS      of those, the static imports: the libraries it links');
  L.push('#   D2_MODULE_<m>_LOADS        of those, the LoadLibrary edges: it sees their interface only');
  L.push('#   D2_MODULE_<m>_PUBLIC       its public header, the one header another module includes');
  L.push('#   D2_MODULE_<m>_SEES         every module whose headers it may include, itself included');
  L.push('#   D2_MODULE_<m>_EXCEPTIONS   modules it references by a documented exception');
  L.push('#   D2_MODULE_<m>_STRICT       ON: a wrong-direction include is a compile error');
  L.push('#   D2_MODULE_<m>_GENERATED    ON: its code is generated from the Ghidra database');
  L.push('#   D2_MODULE_<m>_DATA         the unit holding its globals (Source/globals/<m>.cpp)');
  L.push('#   D2_MODULE_<m>_UNIT_ORDER   original-address: its library takes its units in D2_MODULE_<m>_UNITS\'s');
  L.push('#                              order; path: in path order');
  L.push('#   D2_MODULE_<m>_UNITS        its units in the 1.14d link\'s order, each placed by the address of its');
  L.push('#                              first function in the module\'s runs, with the count of runs its');
  L.push('#                              functions form (a split unit); a unit with no function last. The data');
  L.push('#                              unit is not among them: the library takes it after them');
  L.push('');
  L.push(`set(D2_MODULES ${list(names)})`);
  for (const name of names) {
    const m = modules[name];
    const deps = dependencyList(m);
    const exceptions = [...new Set((m.exceptions ?? []).map(e => e.to))];
    const sees = [...(reach.get(name) ?? new Set([name]))].filter(n => names.includes(n));
    for (const e of exceptions) if (!sees.includes(e)) sees.push(e);
    L.push('');
    for (const d of deps) L.push(`# ${name} -> ${d.module} (${d.via}): ${d.evidence}`);
    for (const e of m.exceptions ?? []) L.push(`# ${name} -> ${e.to} exception${e.symbol ? ` (${e.symbol})` : ''}: ${e.reason}`);
    L.push(`set(D2_MODULE_${name}_DIR "${m.dir}")`);
    L.push(`set(D2_MODULE_${name}_KIND "${m.kind}")`);
    L.push(`set(D2_MODULE_${name}_DEPENDS ${list(deps.map(d => d.module).filter(d => names.includes(d)))})`);
    L.push(`set(D2_MODULE_${name}_IMPORTS ${list(deps.filter(d => d.via === 'import').map(d => d.module).filter(d => names.includes(d)))})`);
    L.push(`set(D2_MODULE_${name}_LOADS ${list(deps.filter(d => d.via === 'load').map(d => d.module).filter(d => names.includes(d)))})`);
    L.push(`set(D2_MODULE_${name}_PUBLIC "${publicHeaders.get(name) ?? ''}")`);
    L.push(`set(D2_MODULE_${name}_SEES ${list(linkOrdered(modules, sees))})`);
    L.push(`set(D2_MODULE_${name}_EXCEPTIONS ${list(exceptions)})`);
    L.push(`set(D2_MODULE_${name}_STRICT ${m.strict ? 'ON' : 'OFF'})`);
    L.push(`set(D2_MODULE_${name}_GENERATED ${(m.namespaces ?? []).length > 0 || (m.files ?? []).length > 0 ? 'ON' : 'OFF'})`);
    L.push(`set(D2_MODULE_${name}_DATA "${dataUnits.get(name) ?? ''}")`);
    const placed = units.get(name);
    L.push(`set(D2_MODULE_${name}_UNIT_ORDER "${placed ? 'original-address' : 'path'}")`);
    if (!placed || placed.length === 0) {
      L.push(`set(D2_MODULE_${name}_UNITS )`);
      continue;
    }
    L.push(`set(D2_MODULE_${name}_UNITS`);
    for (const u of placed) L.push(`    ${u.path}  # ${unitNote(u)}`);
    L.push(')');
  }
  L.push('');
  return L.join('\n');
}
