/**
 * project.json `modules`: the one description of the tree's modules.
 *
 * Every Blizzard module of 1.14d's Game.exe was its own DLL up to 1.13d, and its
 * import table is the evidence for what it may use. Each entry gives the Ghidra
 * namespaces the module owns, the directory its files live in, its kind, the
 * modules it depends on (each edge with its evidence), the references the
 * original made against that graph (each with its reason), its place in the link
 * order, and whether the build treats a wrong-direction include as an error.
 *
 * The generator reads it for three things: where a file goes (`dir`), which
 * module a namespace's code and data belong to (`namespaces`), and the include
 * rule between modules (`dependencies`, `exceptions`). The build reads the same
 * data from the generated `Source/modules.cmake`.
 */

import type { ModuleConfig, ModuleDependency, ModuleKind } from '../config/schema.js';
import { namespaceDirectory, type ModuleLibrariesConfig, type ModuleLibraryConfig } from './module-libraries.js';

export const MODULE_KINDS: readonly ModuleKind[] = ['exe', 'dll-module', 'headers-only', '3rdparty', 'ours'];

/** The generated tree's root: files no module owns (globals/) live under it. */
export const SOURCE_ROOT = 'Source';

/** Where the build reads the module table from (generated, under the source root). */
export const MODULES_CMAKE_PATH = `${SOURCE_ROOT}/modules.cmake`;

/** The modules section is the full model (every entry has a `dir`): the module build is on. */
export function isModuleModel(modules: Record<string, ModuleConfig> | undefined): boolean {
  if (!modules) return false;
  const entries = Object.values(modules);
  return entries.length > 0 && entries.every(m => typeof m?.dir === 'string');
}

/** Modules the Windows build compiles. */
export function windowsModules(modules: Record<string, ModuleConfig>): string[] {
  return Object.keys(modules).filter(n => (modules[n].target ?? 'windows') === 'windows');
}

/**
 * Modules whose code is generated: they own Ghidra namespaces. A headers-only
 * module's root files (`d2_platform.h`) move with the layout but stay the shared
 * root to the module-boundary pass, which every module may include.
 */
export function generatedModules(modules: Record<string, ModuleConfig>): string[] {
  return windowsModules(modules).filter(n => (modules[n].namespaces ?? []).length > 0);
}

export function dependencyList(m: ModuleConfig): ModuleDependency[] {
  return (m.dependencies ?? []).map(d => typeof d === 'string' ? { module: d, via: 'import' as const, evidence: '' } : d);
}

/** Modules in link order (by `linkOrder`, then name). */
export function linkOrdered(modules: Record<string, ModuleConfig>, names: string[]): string[] {
  return [...names].sort((a, b) =>
    (modules[a].linkOrder ?? Number.MAX_SAFE_INTEGER) - (modules[b].linkOrder ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b));
}

/**
 * The include graph of the generated modules, as the module-boundary pass reads it.
 * Hand-written and vendored modules hold no generated code; they are the build's.
 */
export function libraryConfigFromModules(modules: Record<string, ModuleConfig>): ModuleLibrariesConfig {
  const names = generatedModules(modules);
  const known = new Set(names);
  const out: Record<string, ModuleLibraryConfig> = {};
  for (const name of names) {
    const m = modules[name];
    const deps = dependencyList(m).filter(d => known.has(d.module));
    out[name] = {
      namespaces: [...(m.namespaces ?? [])],
      imports: deps.filter(d => d.via === 'import').map(d => d.module),
      loads: deps.filter(d => d.via === 'load').map(d => d.module),
      embedded: m.embedded === true || m.kind === 'headers-only' ? true : undefined,
      evidence: deps.map(d => `${d.module}: ${d.evidence}`).join('; ') || undefined,
    };
  }
  const exceptions = names.flatMap(from => (modules[from].exceptions ?? [])
    .filter(e => known.has(e.to))
    .map(e => ({ from, to: e.to, symbol: e.symbol, reason: e.reason })));
  return { enabled: true, linkOrder: linkOrdered(modules, names), modules: out, exceptions };
}

/** Every problem with the section, or [] when it is sound. */
export function validateModules(modules: Record<string, ModuleConfig>): string[] {
  const problems: string[] = [];
  const names = Object.keys(modules);
  const known = new Set(names);
  const nsOwner = new Map<string, string>();
  const dirOwner = new Map<string, string>();
  const fileOwner = new Map<string, string>();
  const orders = new Map<number, string>();
  for (const name of names) {
    const m = modules[name];
    const at = `modules.${name}`;
    if (!m || typeof m !== 'object') { problems.push(`${at} must be an object`); continue; }
    if (!MODULE_KINDS.includes(m.kind as ModuleKind)) problems.push(`${at}.kind must be one of ${MODULE_KINDS.join(', ')}`);
    if (typeof m.dir !== 'string' || m.dir === '' || m.dir.startsWith('/') || m.dir.endsWith('/')) {
      problems.push(`${at}.dir must be a relative directory`);
    } else if (dirOwner.has(m.dir)) {
      problems.push(`${at}.dir ${m.dir} is also ${dirOwner.get(m.dir)}'s`);
    } else dirOwner.set(m.dir, name);
    if (m.target !== undefined && m.target !== 'windows' && m.target !== 'mac') problems.push(`${at}.target must be windows or mac`);
    if (!Array.isArray(m.namespaces)) problems.push(`${at}.namespaces must be an array`);
    for (const ns of m.namespaces ?? []) {
      if (nsOwner.has(ns)) problems.push(`namespace ${ns} maps to both ${nsOwner.get(ns)} and ${name}`);
      else nsOwner.set(ns, name);
    }
    for (const f of m.files ?? []) {
      if (fileOwner.has(f)) problems.push(`file ${f} belongs to both ${fileOwner.get(f)} and ${name}`);
      else fileOwner.set(f, name);
    }
    if ((m.kind === 'exe' || m.kind === 'dll-module') && (m.namespaces ?? []).length === 0) {
      problems.push(`${at}: a ${m.kind} owns at least one namespace`);
    }
    if (m.strict !== undefined && typeof m.strict !== 'boolean') problems.push(`${at}.strict must be a boolean`);
    for (const key of ['publicHeader', 'rootUnit'] as const) {
      const v = m[key];
      if (v !== undefined && (typeof v !== 'string' || v === '' || v.includes('/'))) problems.push(`${at}.${key} must be a file name`);
    }
    if (m.publicHeader !== undefined && !m.publicHeader.endsWith('.h')) problems.push(`${at}.publicHeader must name a .h file`);
    if ((m.target ?? 'windows') === 'windows') {
      if (!Number.isInteger(m.linkOrder)) problems.push(`${at}.linkOrder must be an integer`);
      else if (orders.has(m.linkOrder!)) problems.push(`${at}.linkOrder ${m.linkOrder} is also ${orders.get(m.linkOrder!)}'s`);
      else orders.set(m.linkOrder!, name);
    }
    if (m.dependencies !== undefined && !Array.isArray(m.dependencies)) { problems.push(`${at}.dependencies must be an array`); continue; }
    const seen = new Set<string>();
    for (const [i, d] of (m.dependencies ?? []).entries()) {
      if (typeof d !== 'object' || d === null) { problems.push(`${at}.dependencies[${i}] must be {module, via, evidence}`); continue; }
      if (!known.has(d.module)) problems.push(`${at}.dependencies[${i}] names unknown module "${d.module}"`);
      if (d.module === name) problems.push(`${at}.dependencies[${i}] names itself`);
      if (seen.has(d.module)) problems.push(`${at}.dependencies names ${d.module} twice`);
      seen.add(d.module);
      if (d.via !== 'import' && d.via !== 'load') problems.push(`${at}.dependencies[${i}].via must be import or load`);
      if (typeof d.evidence !== 'string' || d.evidence.trim() === '') problems.push(`${at}.dependencies[${i}] (${d.module}) needs its evidence`);
      if (known.has(d.module) && (modules[d.module].target ?? 'windows') !== (m.target ?? 'windows') && (m.target ?? 'windows') === 'windows') {
        problems.push(`${at}.dependencies[${i}]: a Windows module cannot depend on the Mac-only ${d.module}`);
      }
    }
  }
  // The static import graph is acyclic. A load edge may close a loop (D2gfx loads the
  // renderers, which import D2gfx): it is a one-step view of an interface, not a link.
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (n: string, path: string[]): void => {
    const s = state.get(n);
    if (s === 2) return;
    if (s === 1) { problems.push(`modules: import cycle ${[...path, n].join(' -> ')}`); return; }
    state.set(n, 1);
    for (const d of dependencyList(modules[n] ?? { namespaces: [] })) if (d.via === 'import' && known.has(d.module)) visit(d.module, [...path, n]);
    state.set(n, 2);
  };
  for (const n of names) visit(n, []);
  // An exception is a real edge: another module, one the graph does not already allow.
  const reach = reachability(modules);
  for (const name of names) {
    for (const [i, e] of (modules[name]?.exceptions ?? []).entries()) {
      const at = `modules.${name}.exceptions[${i}]`;
      if (!e || typeof e !== 'object') { problems.push(`${at} must be {to, symbol?, reason}`); continue; }
      if (!known.has(e.to)) problems.push(`${at} names unknown module "${e.to}"`);
      else if (e.to === name) problems.push(`${at} names its own module`);
      else if (reach.get(name)?.has(e.to)) problems.push(`${at}: ${name} may already use ${e.to}, so it is no exception`);
      if (typeof e.reason !== 'string' || e.reason.trim() === '') problems.push(`${at} needs a reason`);
      if (e.symbol !== undefined && (typeof e.symbol !== 'string' || e.symbol === '')) problems.push(`${at}.symbol must be a name`);
    }
  }
  return problems;
}

/**
 * What each module may include: itself, its imports transitively, its loads one
 * step, every embedded or headers-only module and the project's own support code
 * (the hooks a hand fix calls); a module of ours may include everything.
 */
export function reachability(modules: Record<string, ModuleConfig>): Map<string, Set<string>> {
  const names = Object.keys(modules);
  const shared = names.filter(n => modules[n].embedded === true || modules[n].kind === 'headers-only' || modules[n].kind === 'ours');
  const out = new Map<string, Set<string>>();
  for (const name of names) {
    const seen = new Set<string>([name]);
    if (modules[name].kind === 'ours') {
      for (const n of names) if ((modules[n].target ?? 'windows') === (modules[name].target ?? 'windows')) seen.add(n);
      out.set(name, seen);
      continue;
    }
    const stack = dependencyList(modules[name]).filter(d => d.via === 'import').map(d => d.module);
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (seen.has(next) || !modules[next]) continue;
      seen.add(next);
      stack.push(...dependencyList(modules[next]).filter(d => d.via === 'import').map(d => d.module));
    }
    for (const d of dependencyList(modules[name])) if (d.via === 'load') seen.add(d.module);
    for (const s of shared) seen.add(s);
    out.set(name, seen);
  }
  return out;
}

/** What the module-boundary pass names a public header before the layout places it. */
export const PUBLIC_HEADER_SUFFIX = '.public.h';
/** The files of a unit: what moves with the root unit when the public header takes its name. */
const ROOT_UNIT_SUFFIXES = ['.h', '.cpp', '.c', '.cpp.map', '.c.map', '.data.h', '.inl'];
export const DEFAULT_PUBLIC_HEADER_NAME = '{module}.h';
export const DEFAULT_ROOT_UNIT_NAME = '{module}Root';

export function publicHeaderName(module: string, m: ModuleConfig): string {
  return (m.publicHeader ?? DEFAULT_PUBLIC_HEADER_NAME).split('{module}').join(module);
}

export function rootUnitName(module: string, m: ModuleConfig): string {
  return (m.rootUnit ?? DEFAULT_ROOT_UNIT_NAME).split('{module}').join(module);
}

/**
 * Where each emitted file goes. The generator names files by namespace
 * (`D2Common/ITEMS/Items.cpp`); the module's `dir` is where that tree lives
 * (`Source/D2Common/ITEMS/Items.cpp`). A nested namespace module moves its own
 * subtree: `Fog/3rdparty/crashy/Report.cpp` -> `3rdparty/crashy/Report.cpp`, and
 * the namespace's own unit `Fog/3rdparty/crashy.cpp` -> `3rdparty/crashy/crashy.cpp`.
 * Files no module owns (globals/, the unnamespaced unit) go under the source root
 * (`Source/globals/globals.h`), so the tree's root holds only the top directories.
 */
export class ModuleLayout {
  private readonly prefixes: Array<[string, string]> = [];
  private readonly files = new Map<string, string>();
  /** Module directory -> its public header and root unit names. */
  private readonly named = new Map<string, { module: string; publicHeader: string; rootUnit: string }>();
  /** Module directories, longest first. */
  private readonly dirs: Array<[string, string]> = [];

  constructor(modules: Record<string, ModuleConfig>) {
    for (const name of Object.keys(modules)) {
      const m = modules[name];
      for (const ns of m.namespaces ?? []) this.prefixes.push([namespaceDirectory(ns), m.dir]);
      for (const f of m.files ?? []) this.files.set(f, `${m.dir}/${f.slice(f.lastIndexOf('/') + 1)}`);
      if (typeof m.dir === 'string') {
        this.dirs.push([m.dir, name]);
        if ((m.namespaces ?? []).length > 0) {
          this.named.set(m.dir, { module: name, publicHeader: publicHeaderName(name, m), rootUnit: rootUnitName(name, m) });
        }
      }
    }
    this.prefixes.sort((a, b) => b[0].length - a[0].length);
    this.dirs.sort((a, b) => b[0].length - a[0].length);
  }

  /**
   * Give a module's public header another file name: the layout falls back to it when
   * `<M>.h` would collide, on a case-insensitive disk, with one of the module's units
   * (D2gfx's `D2GFX.h`).
   */
  renamePublicHeader(module: string, file: string): void {
    for (const n of this.named.values()) if (n.module === module) n.publicHeader = file;
  }

  /** The module a tree path lies in (its longest module directory). */
  moduleOfPath(path: string): string | undefined {
    for (const [dir, module] of this.dirs) if (path.startsWith(`${dir}/`)) return module;
    return undefined;
  }

  /** The tree path of a module's public header. */
  publicHeaderPath(module: string): string | undefined {
    for (const [dir, n] of this.named) if (n.module === module) return `${dir}/${n.publicHeader}`;
    return undefined;
  }

  /**
   * The tree path of a generated file. A module's public header is `<dir>/<M>.h`, so
   * the unit of the namespace named after the module (`<M>.h/.cpp`, functions directly
   * in namespace M) moves aside to `<dir>/<M>Root.*`; both names come from project.json.
   */
  pathOf(path: string): string {
    const placed = this.placed(path);
    const slash = placed.lastIndexOf('/');
    const n = slash > 0 ? this.named.get(placed.slice(0, slash)) : undefined;
    if (!n) return placed;
    const file = placed.slice(slash + 1);
    const dir = placed.slice(0, slash);
    if (file === `${n.module}${PUBLIC_HEADER_SUFFIX}`) return `${dir}/${n.publicHeader}`;
    if (file.startsWith(`${n.module}.`) && ROOT_UNIT_SUFFIXES.includes(file.slice(n.module.length))) {
      return `${dir}/${n.rootUnit}${file.slice(n.module.length)}`;
    }
    return placed;
  }

  private placed(path: string): string {
    const listed = this.files.get(path);
    if (listed) return listed;
    for (const [prefix, dir] of this.prefixes) {
      if (path.startsWith(`${prefix}/`)) return dir + path.slice(prefix.length);
      if (prefix.includes('/') && path.startsWith(`${prefix}.`) && !path.slice(prefix.length + 1).includes('/')) {
        return `${dir}/${prefix.slice(prefix.lastIndexOf('/') + 1)}${path.slice(prefix.length)}`;
      }
    }
    return `${SOURCE_ROOT}/${path}`;
  }

  /**
   * A file's text with every `#include "<generated path>"` directive spelling the
   * path's new place. Includes are rooted at the tree, so a directive names the
   * same string the file table is keyed by; anything else (a system header, a
   * hand-written header) is left alone.
   */
  rewriteIncludes(content: string, generated: ReadonlySet<string>): string {
    if (!content.includes('#include "')) return content;
    const lines = content.split('\n');
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const open = line.indexOf('#include "');
      if (open < 0 || line.slice(0, open).trim() !== '') continue;
      const start = open + '#include "'.length;
      const end = line.indexOf('"', start);
      if (end < 0) continue;
      const target = line.slice(start, end);
      if (!generated.has(target)) continue;
      const moved = this.pathOf(target);
      if (moved === target) continue;
      lines[i] = line.slice(0, start) + moved + line.slice(end);
      changed = true;
    }
    return changed ? lines.join('\n') : content;
  }
}
