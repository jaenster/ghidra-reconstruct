/**
 * The module-library model: which Blizzard module may see which.
 *
 * Every module of the original game was its own DLL (1.13d and older), and a
 * DLL could only call what it imported. That import graph is acyclic, and it is
 * the rule the per-module build enforces: module A may include module B's public
 * declarations only if A reaches B in it. The data lives in project.json
 * `moduleLibraries` (one entry per module, with the evidence it came from); this
 * file only reads it.
 *
 * Two kinds of edge:
 *  - `imports`: a static import table entry. Transitive - what B may see, a user
 *    of B's public header sees too.
 *  - `loads`: a LoadLibrary + QueryInterface edge (D2gfx -> renderers, Game ->
 *    D2Client/D2Launch/D2Multi). Direct only: the host sees the provider's
 *    interface, not what the provider imports.
 *
 * An `embedded` module (D2Hell) was compiled into every module that used it, so
 * every module may call it; it sees only its own imports.
 */

export interface ModuleLibraryConfig {
  /** Directory the module's files are emitted under; default the module name. */
  root?: string;
  /** Static import edges (1.13d import tables). */
  imports?: string[];
  /** LoadLibrary edges: the host may see the provider, not what it imports. */
  loads?: string[];
  /** Compiled into each user (D2Hell): visible to every module. */
  embedded?: boolean;
  /** Where the edges come from. */
  evidence?: string;
}

/** A reference the original made across the graph, kept with its reason. */
export interface ModuleEdgeException {
  /** Using module. */
  from: string;
  /** Owning module. */
  to: string;
  /** The symbol the exception covers, bare or qualified; omitted = the whole edge. */
  symbol?: string;
  reason: string;
}

export interface ModuleLibrariesConfig {
  /** Off by default: the monolithic tree is emitted exactly as before. */
  enabled?: boolean;
  /** Public header path, `{module}` substituted; default `{module}/{module}.public.h`. */
  publicHeader?: string;
  /** Module-level data header, `{module}` substituted; default `{module}/{module}.globals.h`. */
  globalsHeader?: string;
  /**
   * The order the executable links the module libraries in: the 1.14d code runs
   * (docs/data/runs-v2.tsv). It decides where the linker keeps a COMDAT that
   * several modules emit, so it is part of the build, not cosmetics.
   */
  linkOrder: string[];
  modules: Record<string, ModuleLibraryConfig>;
  exceptions?: ModuleEdgeException[];
}

export const DEFAULT_PUBLIC_HEADER = '{module}/{module}.public.h';
export const DEFAULT_GLOBALS_HEADER = '{module}/{module}.globals.h';

/** The macro a translation unit of `module` is compiled with. */
export function moduleMacro(module: string): string {
  return `D2_MODULE_${module}`;
}

/** The macro every module that may see `module` is compiled with. */
export function seesMacro(module: string): string {
  return `D2_SEES_${module}`;
}

/** Defined by every module-library build; absent, every gate is inert. */
export const MODULE_BUILD_MACRO = 'D2_MODULE_LIBRARIES';

export class ModuleGraph {
  readonly names: string[];
  private readonly roots = new Map<string, string>();
  private readonly reach = new Map<string, Set<string>>();

  constructor(readonly config: ModuleLibrariesConfig) {
    this.names = Object.keys(config.modules);
    for (const name of this.names) this.roots.set(config.modules[name].root ?? name, name);
    const embedded = this.names.filter(n => config.modules[n].embedded);
    for (const name of this.names) {
      const seen = new Set<string>([name]);
      const stack = [...(config.modules[name].imports ?? [])];
      while (stack.length > 0) {
        const next = stack.pop()!;
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(...(config.modules[next]?.imports ?? []));
      }
      for (const loaded of config.modules[name].loads ?? []) seen.add(loaded);
      for (const e of embedded) seen.add(e);
      this.reach.set(name, seen);
    }
  }

  has(module: string): boolean {
    return this.reach.has(module);
  }

  /** Every module `module` may see, itself included. */
  reachable(module: string): ReadonlySet<string> {
    return this.reach.get(module) ?? new Set();
  }

  mayUse(user: string, owner: string): boolean {
    return this.reach.get(user)?.has(owner) ?? false;
  }

  /** Whether an exception in project.json covers this reference. */
  excepted(user: string, owner: string, symbol: string): ModuleEdgeException | undefined {
    for (const e of this.config.exceptions ?? []) {
      if (e.from !== user || e.to !== owner) continue;
      if (e.symbol === undefined || e.symbol === symbol || symbol.endsWith(`::${e.symbol}`)) return e;
    }
    return undefined;
  }

  /** The module an emitted path belongs to, by its first directory. */
  moduleOfPath(path: string): string | undefined {
    const slash = path.indexOf('/');
    if (slash < 0) return undefined;
    return this.roots.get(path.slice(0, slash));
  }

  /**
   * The library a file is compiled into: its module, or for a globals unit
   * (`globals/<Module>.cpp`, the definitions of that module's data) that module.
   * Undefined is the shared root library.
   */
  libraryOfPath(path: string): string | undefined {
    const own = this.moduleOfPath(path);
    if (own) return own;
    const m = /^globals\/([^/]+)\.(?:cpp|c)$/.exec(path);
    return m && this.has(m[1]) ? m[1] : undefined;
  }

  /** The module a Ghidra namespace belongs to, by its first segment. */
  moduleOfNamespace(namespace: string | undefined): string | undefined {
    if (!namespace) return undefined;
    const first = namespace.split('::')[0];
    return this.has(first) ? first : undefined;
  }

  publicHeaderOf(module: string): string {
    return (this.config.publicHeader ?? DEFAULT_PUBLIC_HEADER).split('{module}').join(this.config.modules[module]?.root ?? module);
  }

  globalsHeaderOf(module: string): string {
    return (this.config.globalsHeader ?? DEFAULT_GLOBALS_HEADER).split('{module}').join(this.config.modules[module]?.root ?? module);
  }

  /** The static import edges, in the order the config lists them. */
  importsOf(module: string): string[] {
    return [...(this.config.modules[module]?.imports ?? [])];
  }

  /** Modules in link order; any the order leaves out follow, sorted. */
  linkOrder(): string[] {
    const listed = this.config.linkOrder.filter(m => this.has(m));
    const rest = this.names.filter(m => !listed.includes(m)).sort();
    return [...listed, ...rest];
  }
}

/** Every problem with the section, or [] when it is sound. */
export function validateModuleLibraries(config: ModuleLibrariesConfig): string[] {
  const problems: string[] = [];
  if (!config || typeof config !== 'object') return ['moduleLibraries must be an object'];
  if (!config.modules || typeof config.modules !== 'object' || Array.isArray(config.modules)) {
    return ['moduleLibraries.modules must be an object'];
  }
  if (!Array.isArray(config.linkOrder)) problems.push('moduleLibraries.linkOrder must be an array');
  const names = new Set(Object.keys(config.modules));
  for (const [name, m] of Object.entries(config.modules)) {
    for (const key of ['imports', 'loads'] as const) {
      const list = m[key];
      if (list === undefined) continue;
      if (!Array.isArray(list)) { problems.push(`moduleLibraries.modules.${name}.${key} must be an array`); continue; }
      for (const dep of list) {
        if (!names.has(dep)) problems.push(`moduleLibraries.modules.${name}.${key} names unknown module "${dep}"`);
        if (dep === name) problems.push(`moduleLibraries.modules.${name}.${key} names itself`);
      }
    }
  }
  for (const m of config.linkOrder ?? []) {
    if (!names.has(m)) problems.push(`moduleLibraries.linkOrder names unknown module "${m}"`);
  }
  // The static import graph is acyclic: that is the property the build enforces.
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (n: string, path: string[]): void => {
    const s = state.get(n);
    if (s === 2) return;
    if (s === 1) { problems.push(`moduleLibraries: import cycle ${[...path, n].join(' -> ')}`); return; }
    state.set(n, 1);
    for (const d of config.modules[n]?.imports ?? []) if (names.has(d)) visit(d, [...path, n]);
    state.set(n, 2);
  };
  for (const n of names) visit(n, []);
  for (const [i, e] of (config.exceptions ?? []).entries()) {
    if (!names.has(e.from) || !names.has(e.to)) problems.push(`moduleLibraries.exceptions[${i}] names an unknown module`);
    if (typeof e.reason !== 'string' || e.reason.trim() === '') problems.push(`moduleLibraries.exceptions[${i}] needs a reason`);
  }
  return problems;
}
