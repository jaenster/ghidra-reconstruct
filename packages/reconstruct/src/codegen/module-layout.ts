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

import type { ModuleConfig } from '../config/schema.js';
import type { ReconstructedProject, SourceFile } from '../types.js';
import { ModuleGraph } from '../modules/module-libraries.js';
import {
  ModuleLayout, MODULES_CMAKE_PATH, dependencyList, linkOrdered, reachability, windowsModules,
} from '../modules/module-model.js';

const BANNER = `# Generated from project.json "modules" by ghidra-mcp ${String.fromCharCode(0x2014)} DO NOT EDIT; change the module table there`;

export function applyModuleLayout(
  project: ReconstructedProject,
  modules: Record<string, ModuleConfig>,
  graph: ModuleGraph | undefined,
): void {
  const layout = new ModuleLayout(modules);
  const generated = new Set(project.files.keys());

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
  files.set(MODULES_CMAKE_PATH, {
    path: MODULES_CMAKE_PATH,
    content: modulesCMake(modules, dataUnits),
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
}

/** A CMake list value: names never hold spaces or semicolons. */
const list = (items: Iterable<string>): string => [...items].join(' ');

/**
 * `Source/modules.cmake`: the module table as the build reads it. One variable
 * family per module, `D2_MODULES` in link order; the gate scanner
 * (cmake/module-gates.cmake) reads the same file.
 */
export function modulesCMake(modules: Record<string, ModuleConfig>, dataUnits: ReadonlyMap<string, string>): string {
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
  L.push('#   D2_MODULE_<m>_SEES         every module whose headers it may include, itself included');
  L.push('#   D2_MODULE_<m>_EXCEPTIONS   modules it references by a documented exception');
  L.push('#   D2_MODULE_<m>_STRICT       ON: a wrong-direction include is a compile error');
  L.push('#   D2_MODULE_<m>_GENERATED    ON: its code is generated from the Ghidra database');
  L.push('#   D2_MODULE_<m>_DATA         the unit holding its globals (Source/globals/<m>.cpp)');
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
    L.push(`set(D2_MODULE_${name}_SEES ${list(linkOrdered(modules, sees))})`);
    L.push(`set(D2_MODULE_${name}_EXCEPTIONS ${list(exceptions)})`);
    L.push(`set(D2_MODULE_${name}_STRICT ${m.strict ? 'ON' : 'OFF'})`);
    L.push(`set(D2_MODULE_${name}_GENERATED ${(m.namespaces ?? []).length > 0 || (m.files ?? []).length > 0 ? 'ON' : 'OFF'})`);
    L.push(`set(D2_MODULE_${name}_DATA "${dataUnits.get(name) ?? ''}")`);
  }
  L.push('');
  return L.join('\n');
}
