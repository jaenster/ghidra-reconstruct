/**
 * Which units must be re-emitted after a change.
 *
 * This is the correctness centre of the incremental path. Emitting too many units
 * costs about 1.07 seconds each. Emitting too few leaves a stale `.cpp` on disk
 * that still COMPILES, so nothing anywhere reports it - the tree is quietly wrong
 * until someone runs the oracle. The two errors are not comparable, and every
 * decision here is biased accordingly.
 *
 * <h2>Why this is hash-driven and not rule-driven</h2>
 *
 * The obvious trigger - "re-emit the units whose functions I re-decompiled" - is
 * wrong, and wrong in the silent direction. Retype a struct and a function's
 * decompiled text can come back byte-identical while its EMITTED C++ changes,
 * because casts and member spellings are resolved from program-wide type tables
 * (`buildFuncPtrArgCastTables`, the shape tables) rather than from the body. A
 * body-diff trigger misses exactly that case.
 *
 * So the question asked here is not "what did I re-extract" but "whose INPUTS
 * moved". A unit is dirty when the content hash of one of its own symbols changed,
 * or of any symbol it depends on. `buildinfo.json` already carries both halves -
 * 34k symbol hashes and 84k typed dependency edges, written on every run - and has
 * since before this daemon existed; its own header calls itself the equivalent of
 * a `.tsbuildinfo`.
 *
 * <h2>Type changes propagate two ways</h2>
 *
 * A dependency edge covers "module M names symbol S". It does NOT cover a struct
 * that embeds the struct that changed: `X { Y y; }` has its own unchanged
 * definition and therefore an unchanged hash, while its layout moved underneath
 * it. So changed types are first expanded through a reverse containment map to a
 * fixpoint, and only then mapped to modules.
 *
 * <h2>The fail-safe</h2>
 *
 * Any uncertainty - a changed symbol that is not in the index, a module with no
 * dependency data, a missing buildinfo - returns null, meaning "re-emit
 * everything". That costs about nine minutes. Guessing narrow costs a wrong tree
 * that looks right, which has already cost this project whole debugging sessions
 * elsewhere.
 */

import { readFile } from 'node:fs/promises';
import { hashFunction, hashDataType, hashGlobal } from '@ghidra-mcp/reconstruct/modules/buildinfo';
import type { ExtractedFunction, ExtractedDataType, AnalyzedDataSymbol } from '@ghidra-mcp/reconstruct';

interface SerializedDep {
  symbol: string;
  strength: string;
  targetModule?: string;
}

interface SerializedModule {
  id: string;
  implPath: string;
  unitName: string;
  exports?: Array<{ name?: string }>;
  deps?: SerializedDep[];
  ownedTypeNames?: string[];
  functionNames?: string[];
  globalAddresses?: string[];
}

interface BuildInfoFile {
  modules: SerializedModule[];
  symbolIndex: Record<string, string>;
  symbolHashes: Record<string, string>;
}

export interface DirtySelection {
  /** Unit names to re-emit, or null meaning "everything". */
  units: string[] | null;
  /** Why, in one line, for the daemon's status and its commit message. */
  reason: string;
  /** Symbols whose content hash moved. */
  changedSymbols: string[];
  /** Types reached through containment from a changed type. */
  expandedTypes: string[];
}

export async function loadBuildInfo(path: string): Promise<BuildInfoFile | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as BuildInfoFile;
  } catch {
    return null;
  }
}

/**
 * Every type that must be considered changed once `seeds` have, following
 * containment backwards to a fixpoint.
 *
 * A field's type is matched by NAME after stripping pointer, array and const
 * decoration. A pointer to a changed struct does not change the pointing struct's
 * layout, but it does change what the emitter spells at every member access
 * through it, so pointers are followed too - the cheap direction.
 */
export function expandChangedTypes(
  seeds: Iterable<string>,
  dataTypes: ReadonlyArray<ExtractedDataType>,
): Set<string> {
  const bare = (t: string | undefined): string =>
    (t ?? '')
      .replace(/\b(const|volatile|struct|union|enum|unsigned|signed)\b/g, ' ')
      .replace(/[*&]/g, ' ')
      .replace(/\[[^\]]*\]/g, ' ')
      .trim();

  // type name -> types whose fields name it
  const referencedBy = new Map<string, Set<string>>();
  for (const dt of dataTypes) {
    const fields = (dt as unknown as { fields?: Array<{ dataType?: string; type?: string }> }).fields ?? [];
    for (const f of fields) {
      const target = bare(f.dataType ?? f.type);
      if (!target || target === dt.name) continue;
      let set = referencedBy.get(target);
      if (!set) referencedBy.set(target, (set = new Set()));
      set.add(dt.name);
    }
  }

  const out = new Set<string>();
  const stack = [...seeds];
  while (stack.length > 0) {
    const name = stack.pop()!;
    if (out.has(name)) continue;
    out.add(name);
    for (const parent of referencedBy.get(name) ?? []) {
      if (!out.has(parent)) stack.push(parent);
    }
  }
  return out;
}

/**
 * The daemon's own record of what each symbol hashed to at the last successful
 * generation.
 *
 * Keyed by ADDRESS for functions and globals, not by name. `buildinfo` keys its
 * hashes by name, and 186 function names in this program are carried by more than
 * one function (555 functions in total); a name-keyed comparison therefore reports
 * some of them as changed on every run forever. Namespace-qualifying cuts that to
 * 23 keys, which is better and still not identity - the project's own rule is to
 * reconcile on address and never on names, and here address costs nothing because
 * this cache is ours to shape.
 *
 * The NAME is carried alongside so a symbol that disappears can still be matched
 * against `buildinfo`'s name-keyed module lists, which is how the unit that owned
 * a renamed function is found.
 */
export interface SymbolHashCache {
  /** address -> {hash, name at that address} */
  functions: Record<string, { hash: string; name: string }>;
  /** type path or name -> hash */
  types: Record<string, string>;
  /**
   * `address\0name` -> {hash, name}. Address alone is not identity here: 83
   * addresses in this program carry more than one global (aliases and overlapping
   * symbols), so an address-keyed map loses all but the last and then reports the
   * others as changed on every single run.
   */
  globals: Record<string, { hash: string; name: string; aggregate?: string }>;
}

/**
 * The struct type whose instances this global's initial value adds to, or
 * undefined. The generator reads the initial values of every initialised instance
 * of a struct type (`createParamReachOracle`) to decide what a call through
 * `p->field` reaches, and such a body names the TYPE, not the global. A changed
 * value therefore reaches every unit that names the type.
 */
export function initialisedAggregate(g: AnalyzedDataSymbol): string | undefined {
  const d = g.initializedData;
  if (!d) return undefined;
  const element = /^(.*?)\s*\[[^\]]*\]\s*$/.exec(g.dataType ?? '');
  const base = (element ? element[1] : g.dataType ?? '').replace(/\b(const|volatile|struct|union)\b/g, '').trim();
  if (!base || /[*\[]/.test(base)) return undefined;
  if (element ? d.kind !== 'array' : d.kind !== 'struct') return undefined;
  return base;
}

/** Identity for a global: address plus name, since neither alone is unique. */
export function globalKey(address: string, name: string | undefined): string {
  return `${address}\u0000${name ?? ''}`;
}

/**
 * A type's hash, with the type before it in the list. The emitter lays a header's types
 * out in list order, so a type that moved changes its header while its own record, and
 * so `hashDataType`, stays the same: a reorder alone re-emitted nothing. Keying on the
 * predecessor makes the moved type, its old successor and its new successor dirty.
 */
export function typeHashes(dataTypes: ReadonlyArray<ExtractedDataType>): string[] {
  return dataTypes.map((dt, i) => {
    const prev = i > 0 ? dataTypes[i - 1] : undefined;
    return `${hashDataType(dt)}@${prev ? `${prev.category ?? ''}::${prev.name}` : ''}`;
  });
}

export function emptyHashCache(): SymbolHashCache {
  return { functions: {}, types: {}, globals: {} };
}

/** Snapshot the current model's hashes, to compare the NEXT change against. */
export function computeHashCache(inputs: {
  functions: ReadonlyArray<ExtractedFunction>;
  dataTypes: ReadonlyArray<ExtractedDataType>;
  globals: ReadonlyArray<AnalyzedDataSymbol>;
}): SymbolHashCache {
  const cache = emptyHashCache();
  for (const f of inputs.functions) {
    cache.functions[f.address] = { hash: hashFunction(f), name: f.name };
  }
  const hashes = typeHashes(inputs.dataTypes);
  inputs.dataTypes.forEach((dt, i) => {
    cache.types[dt.category ? `${dt.category}::${dt.name}` : dt.name] = hashes[i];
  });
  for (const g of inputs.globals) {
    const name = g.suggestedName || g.name;
    if (!g.address) continue;
    const aggregate = initialisedAggregate(g);
    cache.globals[globalKey(g.address, name)] = aggregate ? { hash: hashGlobal(g), name, aggregate } : { hash: hashGlobal(g), name };
  }
  return cache;
}

export interface SelectInputs {
  /**
   * True when the per-unit identifier cache is missing or empty. Reused units cannot
   * replay their contribution without it, so reuse is not available this run.
   */
  identCacheEmpty?: boolean;
  buildInfo: BuildInfoFile | null;
  /** null on the first run after a cold start: everything is re-emitted. */
  previous: SymbolHashCache | null;
  functions: ReadonlyArray<ExtractedFunction>;
  dataTypes: ReadonlyArray<ExtractedDataType>;
  globals: ReadonlyArray<AnalyzedDataSymbol>;
}

/**
 * Compare the current model against the hashes the last generation recorded and
 * return the units to re-emit.
 */
export function selectDirtyUnits(inputs: SelectInputs): DirtySelection {
  const { buildInfo, functions, dataTypes, globals } = inputs;

  if (!buildInfo || !buildInfo.symbolHashes || !buildInfo.modules) {
    return {
      units: null,
      reason: 'no buildinfo from a previous generation; re-emitting everything',
      changedSymbols: [],
      expandedTypes: [],
    };
  }

  if (!inputs.previous) {
    return {
      units: null,
      reason: 'no hash cache from a previous generation; re-emitting everything',
      changedSymbols: [],
      expandedTypes: [],
    };
  }

  // Reuse needs BOTH a hash cache (which units moved) and the per-unit identifier
  // records (what a reused unit contributes to globals.h/globals.cpp). Without the
  // records the generator refuses outright, so decide it here and re-emit instead:
  // a slow full pass is the correct answer, and failing the queue is not.
  if (inputs.identCacheEmpty) {
    return {
      units: null,
      reason: 'no per-unit identifier records to replay; re-emitting everything',
      changedSymbols: [],
      expandedTypes: [],
    };
  }
  const previous = inputs.previous;

  // `changed` holds NAMES, because that is the spelling the dependency graph and
  // the module symbol lists use. Detection is by address; propagation is by name.
  const changed: string[] = [];
  const changedTypeNames: string[] = [];
  // Globals are also found by ADDRESS: the unit that defines a file-local global
  // lists it in `globalAddresses` and names it in no dependency edge of its own.
  const changedGlobalAddrs = new Set<string>();
  // Struct types one of whose initialised instances changed value: see
  // initialisedAggregate. Matched against dependency edges only - a struct that
  // contains the type did not change shape, so containment is not followed.
  const valueTypes = new Set<string>();

  for (const f of functions) {
    const before = previous.functions[f.address];
    if (!before || before.hash !== hashFunction(f)) {
      changed.push(f.name);
      // A rename keeps the address and changes the name, so the OLD name has to
      // go in too: the unit that owned it is filed under that spelling.
      if (before && before.name !== f.name) changed.push(before.name);
    }
  }
  const hashes = typeHashes(dataTypes);
  for (const [i, dt] of dataTypes.entries()) {
    const key = dt.category ? `${dt.category}::${dt.name}` : dt.name;
    if (previous.types[key] !== hashes[i]) {
      changed.push(dt.name);
      changedTypeNames.push(dt.name);
    }
  }
  for (const g of globals) {
    if (!g.address) continue;
    const name = g.suggestedName || g.name;
    const before = previous.globals[globalKey(g.address, name)];
    if (!before || before.hash !== hashGlobal(g)) {
      changedGlobalAddrs.add(g.address.toLowerCase());
      const now = initialisedAggregate(g);
      if (now) valueTypes.add(now);
      if (before?.aggregate) valueTypes.add(before.aggregate);
      if (name) changed.push(name);
      if (before && before.name && before.name !== name) changed.push(before.name);
    }
  }

  // A symbol whose ADDRESS was present before and is gone now has been deleted or
  // excluded. Its old name must be marked so the unit that emitted it re-emits
  // without it.
  const liveFunctionAddrs = new Set(functions.map(f => f.address));
  const liveGlobalKeys = new Set(
    globals.filter(g => g.address).map(g => globalKey(g.address!, g.suggestedName || g.name)),
  );
  const liveTypeKeys = new Set(
    dataTypes.map(dt => (dt.category ? `${dt.category}::${dt.name}` : dt.name)),
  );
  const disappeared: string[] = [];
  for (const [addr, rec] of Object.entries(previous.functions)) {
    if (!liveFunctionAddrs.has(addr)) { disappeared.push(rec.name); changed.push(rec.name); }
  }
  for (const [key, rec] of Object.entries(previous.globals)) {
    if (!liveGlobalKeys.has(key)) {
      disappeared.push(rec.name);
      changed.push(rec.name);
      changedGlobalAddrs.add(key.slice(0, key.indexOf('\u0000')).toLowerCase());
      if (rec.aggregate) valueTypes.add(rec.aggregate);
    }
  }
  for (const key of Object.keys(previous.types)) {
    if (!liveTypeKeys.has(key)) {
      const bare = key.includes('::') ? key.slice(key.lastIndexOf('::') + 2) : key;
      disappeared.push(bare);
      changed.push(bare);
      changedTypeNames.push(bare);
    }
  }

  if (changed.length === 0) {
    return { units: [], reason: 'no symbol hashes moved', changedSymbols: [], expandedTypes: [] };
  }

  // Follow containment so a struct that merely EMBEDS the changed one is treated
  // as changed too - its own definition, and therefore its own hash, did not move.
  const expanded = expandChangedTypes(changedTypeNames, dataTypes);
  const changedSet = new Set<string>([...changed, ...expanded]);

  const dirty = new Set<string>();
  const unknown: string[] = [];

  // A module is dirty when it OWNS a changed symbol: a function, a type, or a
  // global it defines. The last is matched by address. A global's users reach it
  // through their dependency edges below, but the unit that DEFINES a file-local
  // global has no edge to it - it is its own symbol - and globals.h/globals.cpp,
  // which are rewritten every run, never carry a file-local definition. Without
  // this a retyped static kept its old type and initializer in the defining .cpp.
  const byId = new Map(buildInfo.modules.map(m => [m.id, m]));
  for (const m of buildInfo.modules) {
    const owns =
      (m.functionNames ?? []).some(n => changedSet.has(n)) ||
      (m.ownedTypeNames ?? []).some(n => changedSet.has(n)) ||
      (m.globalAddresses ?? []).some(a => changedGlobalAddrs.has(a.toLowerCase()));
    if (owns) dirty.add(m.unitName);
  }

  // ...or DEPENDS on one. This is the edge that carries a retype outward to every
  // unit that spells the type, which is the case a body-diff trigger would miss.
  for (const m of buildInfo.modules) {
    if (dirty.has(m.unitName)) continue;
    const deps = m.deps;
    if (deps === undefined) {
      // No dependency data for this module: it cannot be shown to be clean.
      unknown.push(m.unitName);
      continue;
    }
    if (deps.some(d => changedSet.has(d.symbol) || valueTypes.has(d.symbol))) dirty.add(m.unitName);
  }

  // Which changed symbols would have nowhere to be emitted.
  //
  // Not every symbol belongs to a module, and that is normal rather than a sign of
  // a stale graph: globals that are not file-local live in globals.h/globals.cpp,
  // types that no unit owns live in d2_platform.h and d2_enums.h, and excluded
  // namespaces (compiler, CRT, VisualStudio) are emitted nowhere at all. Every one
  // of those aggregate outputs is regenerated on EVERY run, incremental included,
  // so a change reaching only them is already covered.
  //
  // Treating them as unexplained made the selection fail open on 173 symbols at
  // baseline - a permanent full rebuild that looked like a working fail-safe.
  // What genuinely indicates a stale graph is a changed FUNCTION that no module
  // claims, because a function has to be emitted into some unit.
  const claimedFunctions = new Set<string>();
  for (const m of buildInfo.modules) {
    for (const n of m.functionNames ?? []) claimedFunctions.add(n);
  }
  // A rename produces a name the graph has never seen - that IS the rename, not
  // evidence the graph is stale. The unit is found through the OLD name, which is
  // already in `changed`.
  const renamedTo = new Set<string>();
  for (const f of functions) {
    const before = previous.functions[f.address];
    if (before && before.name !== f.name) renamedTo.add(f.name);
  }
  const liveFunctionNames = new Set(functions.map(f => f.name));
  const gone = new Set(disappeared);
  const orphans = changed.filter(
    n => !gone.has(n) && !renamedTo.has(n) && liveFunctionNames.has(n) && !claimedFunctions.has(n),
  );

  if (unknown.length > 0) {
    return {
      units: null,
      reason:
        `${unknown.length} module(s) carry no dependency data ` +
        `(e.g. ${unknown.slice(0, 3).join(', ')}); re-emitting everything`,
      changedSymbols: changed,
      expandedTypes: [...expanded],
    };
  }
  if (orphans.length > 0) {
    return {
      units: null,
      reason:
        `${orphans.length} changed symbol(s) are in no module and no index ` +
        `(e.g. ${orphans.slice(0, 3).join(', ')}); re-emitting everything`,
      changedSymbols: changed,
      expandedTypes: [...expanded],
    };
  }

  void byId;
  return {
    units: [...dirty].sort(),
    reason:
      `${changed.length} symbol(s) changed` +
      (disappeared.length > 0 ? `, ${disappeared.length} renamed away or removed` : '') +
      (expanded.size > changedTypeNames.length
        ? `, ${expanded.size - changedTypeNames.length} type(s) reached through containment`
        : '') +
      ` -> ${dirty.size} unit(s)`,
    changedSymbols: changed,
    expandedTypes: [...expanded],
  };
}
