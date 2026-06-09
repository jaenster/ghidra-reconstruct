/**
 * ModuleGraph — central data structure for tracking compilation units
 * and their dependencies.
 *
 * Built during data processing (not after), then resolved to compute
 * minimal include lists per module.
 */

import type {
  Module,
  ModuleSymbol,
  ModuleDep,
  ResolvedModule,
  SymbolKind,
  DepStrength,
} from './module.js';
import type {
  ExtractedDataType,
  ExtractedFunction,
  AnalyzedDataSymbol,
  DetectedClass,
} from '../types.js';
import { collectCrtHeaders } from '../codegen/crt-mapping.js';
import type { BuildInfo, SerializedModule, SerializedDep } from './buildinfo.js';
import { BUILD_INFO_VERSION } from './buildinfo.js';

export class ModuleGraph {
  private modules = new Map<string, Module>();
  /** symbolName → moduleId that exports it */
  private symbolIndex = new Map<string, string>();
  /** Set of "implicit" module IDs that never appear in include lists */
  private implicitModules = new Set<string>();

  /**
   * Create a new module. The id is typically the header path.
   */
  createModule(opts: {
    id: string;
    implPath: string;
    unitName: string;
    namespace?: string;
    namespaceParts?: string[];
    classInfo?: DetectedClass;
    isPlatformOnly?: boolean;
  }): Module {
    if (this.modules.has(opts.id)) {
      return this.modules.get(opts.id)!;
    }
    const mod: Module = {
      id: opts.id,
      implPath: opts.implPath,
      unitName: opts.unitName,
      namespace: opts.namespace,
      namespaceParts: opts.namespaceParts ?? (opts.namespace?.split('::') ?? []),
      exports: [],
      deps: [],
      ownedTypes: [],
      functions: [],
      globals: [],
      classInfo: opts.classInfo,
      isPlatformOnly: opts.isPlatformOnly ?? false,
    };
    this.modules.set(opts.id, mod);
    return mod;
  }

  getModule(id: string): Module | undefined {
    return this.modules.get(id);
  }

  getAllModules(): Module[] {
    return Array.from(this.modules.values());
  }

  getModuleCount(): number {
    return this.modules.size;
  }

  /**
   * Register a symbol as exported by a module.
   */
  exportSymbol(
    moduleId: string,
    name: string,
    kind: SymbolKind,
    visibility: 'export' | 'internal' = 'export',
    ifdef?: string,
  ): void {
    const mod = this.modules.get(moduleId);
    if (!mod) throw new Error(`Module ${moduleId} not found`);

    mod.exports.push({ name, kind, visibility, ifdef });

    // First module to claim a symbol name wins
    if (visibility === 'export' && !this.symbolIndex.has(name)) {
      this.symbolIndex.set(name, moduleId);
    }
  }

  /**
   * Record that a module depends on a symbol.
   */
  addDependency(fromModule: string, symbol: string, strength: DepStrength): void {
    const mod = this.modules.get(fromModule);
    if (!mod) throw new Error(`Module ${fromModule} not found`);
    mod.deps.push({ targetModule: '', symbol, strength });
  }

  /**
   * Look up which module owns a symbol.
   */
  findOwner(symbolName: string): string | undefined {
    return this.symbolIndex.get(symbolName);
  }

  /**
   * Mark a module as implicit (never listed in include output).
   * E.g. d2_platform.h, d2_enums.h
   */
  markImplicit(moduleId: string): void {
    this.implicitModules.add(moduleId);
  }

  /**
   * Register a symbol in the index without creating an export entry.
   * Used for symbols that are globally available (enums, platform types).
   */
  registerGlobalSymbol(symbolName: string, moduleId: string): void {
    if (!this.symbolIndex.has(symbolName)) {
      this.symbolIndex.set(symbolName, moduleId);
    }
  }

  /**
   * Resolve all deps to concrete include lists.
   *
   * Algorithm:
   * 1. For each module, resolve dep symbols → target modules via symbolIndex
   * 2. Classify: by-value → headerIncludes, everything else → implIncludes
   * 3. Detect cycles in headerIncludes via Tarjan's SCC
   * 4. Break cycles by converting one edge to a forward decl
   * 5. Strip implicit modules from include lists
   * 6. Compute CRT headers from call deps
   */
  resolve(): Map<string, ResolvedModule> {
    const result = new Map<string, ResolvedModule>();

    // Phase 1: resolve dep symbols to target module IDs
    for (const mod of this.modules.values()) {
      for (const dep of mod.deps) {
        const target = this.symbolIndex.get(dep.symbol);
        if (target) {
          dep.targetModule = target;
        }
      }
    }

    // Phase 2: classify deps into header vs impl includes per module
    for (const mod of this.modules.values()) {
      const headerIncludeSet = new Set<string>();
      const implIncludeSet = new Set<string>();
      const calledNames: string[] = [];

      for (const dep of mod.deps) {
        if (!dep.targetModule || dep.targetModule === mod.id) continue;
        if (this.implicitModules.has(dep.targetModule)) continue;

        switch (dep.strength) {
          case 'by-value':
          case 'type-ref':
            headerIncludeSet.add(dep.targetModule);
            break;
          case 'by-pointer':
            // Pointer types only need forward declarations, not full includes
            // They'll get forward-declared in the header automatically
            implIncludeSet.add(dep.targetModule);
            break;
          case 'call':
            implIncludeSet.add(dep.targetModule);
            break;
        }

        if (dep.strength === 'call') {
          calledNames.push(dep.symbol);
        }
      }

      // Things already in header includes don't need to be in impl includes
      for (const h of headerIncludeSet) {
        implIncludeSet.delete(h);
      }

      result.set(mod.id, {
        module: mod,
        headerIncludes: [...headerIncludeSet].sort(),
        implIncludes: [...implIncludeSet].sort(),
        forwardDecls: [],
        crtHeaders: [...collectCrtHeaders(calledNames)],
      });
    }

    // Phase 3: detect cycles in header includes and break them
    const cycles = this.findHeaderCycles(result);
    for (const cycle of cycles) {
      if (cycle.length < 2) continue;
      // Break by converting the last edge to a forward decl
      const from = cycle[cycle.length - 1];
      const to = cycle[0];
      const resolved = result.get(from);
      if (!resolved) continue;

      resolved.headerIncludes = resolved.headerIncludes.filter(h => h !== to);
      if (!resolved.implIncludes.includes(to)) {
        resolved.implIncludes.push(to);
        resolved.implIncludes.sort();
      }

      // Collect forward decl names from the broken edge
      const fromMod = this.modules.get(from)!;
      for (const dep of fromMod.deps) {
        if (dep.targetModule === to && (dep.strength === 'by-value' || dep.strength === 'by-pointer' || dep.strength === 'type-ref')) {
          resolved.forwardDecls.push(dep.symbol);
        }
      }
    }

    return result;
  }

  /**
   * Detect cycles in the header-include graph using Tarjan's SCC algorithm.
   * Returns arrays of module IDs forming strongly connected components of size > 1.
   */
  findHeaderCycles(resolved: Map<string, ResolvedModule>): string[][] {
    let index = 0;
    const nodeIndex = new Map<string, number>();
    const lowlink = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const sccs: string[][] = [];

    const strongconnect = (v: string) => {
      nodeIndex.set(v, index);
      lowlink.set(v, index);
      index++;
      stack.push(v);
      onStack.add(v);

      const res = resolved.get(v);
      if (res) {
        for (const w of res.headerIncludes) {
          if (!nodeIndex.has(w)) {
            strongconnect(w);
            lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
          } else if (onStack.has(w)) {
            lowlink.set(v, Math.min(lowlink.get(v)!, nodeIndex.get(w)!));
          }
        }
      }

      if (lowlink.get(v) === nodeIndex.get(v)) {
        const scc: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
        } while (w !== v);
        if (scc.length > 1) {
          sccs.push(scc);
        }
      }
    };

    for (const id of this.modules.keys()) {
      if (!nodeIndex.has(id)) {
        strongconnect(id);
      }
    }

    return sccs;
  }

  /**
   * Convenience: find cycles among modules (by-value deps only,
   * before resolution breaks them). Returns module ID arrays.
   */
  findCycles(): string[][] {
    // Resolve dep symbols to target modules first
    for (const mod of this.modules.values()) {
      for (const dep of mod.deps) {
        if (!dep.targetModule) {
          const target = this.symbolIndex.get(dep.symbol);
          if (target) dep.targetModule = target;
        }
      }
    }

    // Build raw header-level adjacency (before cycle breaking)
    const adj = new Map<string, Set<string>>();
    for (const mod of this.modules.values()) {
      const targets = new Set<string>();
      for (const dep of mod.deps) {
        if ((dep.strength === 'by-value' || dep.strength === 'type-ref') && dep.targetModule && dep.targetModule !== mod.id) {
          if (!this.implicitModules.has(dep.targetModule)) {
            targets.add(dep.targetModule);
          }
        }
      }
      adj.set(mod.id, targets);
    }

    // Tarjan's SCC on raw adjacency
    let index = 0;
    const nodeIndex = new Map<string, number>();
    const lowlink = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const sccs: string[][] = [];

    const strongconnect = (v: string) => {
      nodeIndex.set(v, index);
      lowlink.set(v, index);
      index++;
      stack.push(v);
      onStack.add(v);

      for (const w of adj.get(v) ?? []) {
        if (!nodeIndex.has(w)) {
          strongconnect(w);
          lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
        } else if (onStack.has(w)) {
          lowlink.set(v, Math.min(lowlink.get(v)!, nodeIndex.get(w)!));
        }
      }

      if (lowlink.get(v) === nodeIndex.get(v)) {
        const scc: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
        } while (w !== v);
        if (scc.length > 1) {
          sccs.push(scc);
        }
      }
    };

    for (const id of this.modules.keys()) {
      if (!nodeIndex.has(id)) {
        strongconnect(id);
      }
    }

    return sccs;
  }

  /**
   * Serialize the graph and its resolved state to a BuildInfo object.
   * Call after resolve() to capture the computed includes.
   */
  serialize(
    resolvedMap: Map<string, ResolvedModule>,
    symbolHashes: Record<string, string>,
    pipelineVersion: string,
  ): BuildInfo {
    const modules: SerializedModule[] = [];
    for (const mod of this.modules.values()) {
      modules.push({
        id: mod.id,
        implPath: mod.implPath,
        unitName: mod.unitName,
        namespace: mod.namespace,
        isPlatformOnly: mod.isPlatformOnly,
        exports: [...mod.exports],
        deps: mod.deps.map(d => ({
          symbol: d.symbol,
          strength: d.strength,
          targetModule: d.targetModule,
        })),
        ownedTypeNames: mod.ownedTypes.map(t => t.name),
        functionNames: mod.functions.map(f => f.name),
        globalAddresses: mod.globals.map(g => g.address),
      });
    }

    const resolved: BuildInfo['resolved'] = {};
    for (const [id, res] of resolvedMap) {
      resolved[id] = {
        headerIncludes: res.headerIncludes,
        implIncludes: res.implIncludes,
        forwardDecls: res.forwardDecls,
        crtHeaders: res.crtHeaders,
      };
    }

    return {
      version: BUILD_INFO_VERSION,
      pipelineVersion,
      timestamp: Date.now(),
      modules,
      symbolIndex: Object.fromEntries(this.symbolIndex),
      implicitModules: [...this.implicitModules],
      symbolHashes,
      resolved,
    };
  }

  /**
   * Restore a ModuleGraph from a serialized BuildInfo.
   * Note: only restores graph structure and symbol index, not raw data
   * (functions, types, globals). Those must be re-attached from extraction.
   */
  static deserialize(info: BuildInfo): ModuleGraph {
    const graph = new ModuleGraph();

    for (const sm of info.modules) {
      const mod = graph.createModule({
        id: sm.id,
        implPath: sm.implPath,
        unitName: sm.unitName,
        namespace: sm.namespace,
        isPlatformOnly: sm.isPlatformOnly,
      });
      mod.exports = [...sm.exports];
      mod.deps = sm.deps.map(d => ({
        symbol: d.symbol,
        strength: d.strength,
        targetModule: d.targetModule ?? '',
      }));
    }

    // Restore symbol index
    for (const [name, moduleId] of Object.entries(info.symbolIndex)) {
      graph.symbolIndex.set(name, moduleId);
    }

    // Restore implicit modules
    for (const id of info.implicitModules) {
      graph.implicitModules.add(id);
    }

    return graph;
  }
}
