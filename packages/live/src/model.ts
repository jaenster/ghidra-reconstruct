/**
 * The live model: one extraction held in memory, kept current by re-extracting
 * only what a change in Ghidra actually invalidated.
 *
 * A full extraction is a ~16 minute round trip, so the live loop cannot repeat
 * it per edit. What it can do is bound the blast radius, and the bound is not
 * the edited symbol: renaming a function respells its call sites in every
 * CALLER's body, and renaming a struct field respells every body that touches
 * that field. The indices below exist to answer "what else moved" locally,
 * without asking Ghidra a question per function.
 *
 * Every replacement is IN PLACE. The order of `functions`, `dataTypes` and
 * `globals` reaches the emitted tree — it decides file contents and, through
 * them, diffs — so a re-extract that reordered the arrays would show up as a
 * thousand-file churn for a one-symbol edit.
 */

import {
  extractAllFunctions,
  extractDataType,
  extractGlobals,
  type AnalyzedDataSymbol,
  type CachedSourceExtraction,
  type ExtractedDataType,
  type ExtractedFunction,
  type ExtractionResult,
  type GhidraConnection,
  type ReconstructionOptions,
} from '@ghidra-mcp/reconstruct';
import { decompileFunction, getFunctionInfo } from '@ghidra-mcp/reconstruct/extract/functions';
import { fetchInitializedData } from '@ghidra-mcp/reconstruct/extract/globals';

/**
 * The primary binary plus whatever cross-check source was merged into it, and
 * the options the extraction ran under — a re-extract has to reach Ghidra the
 * same way the original did or it produces a differently-shaped record.
 */
export interface LiveModel {
  primary: ExtractionResult;
  secondary: CachedSourceExtraction | null;
  options: ReconstructionOptions;
  /** Highest event sequence applied. Events at or below this are already in. */
  seq: number;
}

export interface ModelIndices {
  /** Keyed by the bare hex tail of the address. */
  fnByAddr: Map<string, ExtractedFunction>;
  /** Keyed by name + NUL + category — the convention the type hydration uses. */
  dtByKey: Map<string, ExtractedDataType>;
  /** Keyed by the normalised address: no namespace prefix, no `0x`, lower case. */
  globalByAddr: Map<string, AnalyzedDataSymbol>;
  /**
   * Callee -> the address keys of everything that calls it. Indexed under BOTH
   * the callee's name and its address key, because `calledFunctions` is
   * documented as holding either.
   */
  callersOf: Map<string, Set<string>>;
  /** Function address key -> the C identifiers appearing in its body. */
  bodyTokens: Map<string, Set<string>>;
}

/** What the daemon's change stream reports. */
export type ChangeEventKind =
  | 'function.changed'
  | 'function.body'
  | 'function.signature'
  | 'symbol.renamed'
  | 'datatype.changed'
  | 'datatype.renamed'
  | 'datatype.replaced'
  | 'datatype.added'
  | 'datatype.removed'
  | 'data.changed'
  | 'ref.added'
  | 'ref.removed'
  | 'code.added'
  | 'code.removed'
  | 'restored';

export interface ChangeEvent {
  seq: number;
  kind: ChangeEventKind | string;
  target: 'function' | 'global' | 'datatype' | 'program';
  /** Address for a function or global; type name (optionally name + NUL + category) for a datatype. */
  key: string;
  oldName?: string;
  newName?: string;
}

export interface AppliedResult {
  /** Address keys of every function whose record was replaced. */
  touchedFunctions: string[];
  /** Normalised addresses of every global whose record was replaced. */
  touchedGlobals: string[];
  /** Type keys of every datatype whose record was replaced or removed. */
  touchedDataTypes: string[];
  /**
   * The model cannot be trusted incrementally any more and the caller must
   * re-extract from scratch.
   */
  needsFullResync: boolean;
  /** The affected set was large enough that everything was re-decompiled instead. */
  escalatedToFullDecompile: boolean;
}

export type LiveLog = (message: string) => void;

/**
 * Above this fraction of the function count, re-decompiling one function at a
 * time loses to the batch path: `batch_decompile` fans a request out over the
 * worker's decompiler pool, so ~4000 individual round trips cost more than a
 * full re-run that also fixes anything the event stream failed to mention.
 */
const FULL_DECOMPILE_FRACTION = 0.3;

/**
 * A body is scanned for identifiers with a plain lexical regex — no parse.
 *
 * This is the right tool here precisely because the question is spelling, not
 * semantics: what has to be found is every body whose TEXT names a renamed
 * symbol or field, including inside comments and string literals, and a
 * superset costs one extra re-decompile while a miss leaves a stale body in the
 * tree. Running the real C++ parser over 14k bodies per event batch would also
 * cost more than the re-extraction it is trying to avoid.
 */
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * Separator between a type's name and its category, matching the key
 * `hydrateDataTypeDetails` builds. NUL because a category is a path and a name
 * can hold almost any printable character, so any visible separator is
 * ambiguous.
 */
const DT_SEP = '\u0000';

/** The hex tail of a Ghidra address ("Game.exe.ram:005011f0" -> "005011f0"). */
function addressKey(address: string): string {
  const bare = address.includes(':') ? address.slice(address.lastIndexOf(':') + 1) : address;
  return bare.replace(/^0x/i, '').toLowerCase();
}

function dataTypeKey(name: string, category: string | undefined): string {
  return `${name}${DT_SEP}${category ?? ''}`;
}

function splitDataTypeKey(key: string): { name: string; category?: string } {
  const sep = key.indexOf(DT_SEP);
  if (sep < 0) return { name: key };
  return { name: key.slice(0, sep), category: key.slice(sep + DT_SEP.length) };
}

function tokenize(body: string | undefined): Set<string> {
  const tokens = new Set<string>();
  if (!body) return tokens;
  for (const match of body.matchAll(IDENTIFIER)) tokens.add(match[0]);
  return tokens;
}

/** The member names a change to this type would respell in a body. */
function memberNames(dt: ExtractedDataType | undefined): Set<string> {
  const names = new Set<string>();
  if (!dt) return names;
  const withMembers = dt as ExtractedDataType & {
    fields?: { name?: string }[];
    values?: { name?: string }[];
  };
  for (const f of withMembers.fields ?? []) if (f.name) names.add(f.name);
  for (const v of withMembers.values ?? []) if (v.name) names.add(v.name);
  return names;
}

/**
 * Drop explicitly-undefined keys so a merge cannot erase a field the target
 * record had. `get_function_info` answers with `namespace: undefined` for a
 * global-namespace function, and spreading that over the existing record would
 * silently move the function to the root of the emitted tree.
 */
function defined<T extends object>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

export function buildIndices(m: LiveModel): ModelIndices {
  const fnByAddr = new Map<string, ExtractedFunction>();
  const dtByKey = new Map<string, ExtractedDataType>();
  const globalByAddr = new Map<string, AnalyzedDataSymbol>();
  const callersOf = new Map<string, Set<string>>();
  const bodyTokens = new Map<string, Set<string>>();

  for (const fn of m.primary.functions) {
    const key = addressKey(fn.address);
    fnByAddr.set(key, fn);
    bodyTokens.set(key, tokenize(fn.decompiled));
  }

  for (const dt of m.primary.dataTypes) dtByKey.set(dataTypeKey(dt.name, dt.category), dt);
  for (const g of m.primary.globals) globalByAddr.set(addressKey(g.address), g);

  const indices: ModelIndices = { fnByAddr, dtByKey, globalByAddr, callersOf, bodyTokens };
  reindexCallers(m, indices);
  return indices;
}

/**
 * Fold a batch of change events into the model.
 *
 * Events are applied as one batch rather than one at a time: a rename usually
 * arrives as several events naming the same function, and re-decompiling its
 * callers once per event would multiply the cost of the cheapest edit there is.
 */
export async function applyEvents(
  model: LiveModel,
  indices: ModelIndices,
  events: readonly ChangeEvent[],
  client: GhidraConnection,
  log: LiveLog = () => {},
): Promise<AppliedResult> {
  const result: AppliedResult = {
    touchedFunctions: [],
    touchedGlobals: [],
    touchedDataTypes: [],
    needsFullResync: false,
    escalatedToFullDecompile: false,
  };
  if (events.length === 0) return result;

  const highestSeq = Math.max(...events.map(e => e.seq));

  // A restore rolls the program back to a state this model has no diff against:
  // symbols it never saw removed are back, and the event stream describes none
  // of it. Nothing incremental is safe, so nothing incremental is attempted.
  if (events.some(e => e.kind === 'restored')) {
    result.needsFullResync = true;
    model.seq = Math.max(model.seq, highestSeq);
    log('restored: incremental state discarded, full resync required');
    return result;
  }

  // A program-wide event names no symbol, so it can only be honoured by asking
  // Ghidra again for everything.
  if (events.some(e => e.target === 'program')) {
    result.needsFullResync = true;
    model.seq = Math.max(model.seq, highestSeq);
    log('program-level change: full resync required');
    return result;
  }

  const timeout = model.options.decompileTimeout ?? 30;
  const nameToFn = new Map<string, ExtractedFunction>();
  for (const fn of model.primary.functions) nameToFn.set(fn.name, fn);

  /** Functions that need a fresh body, by address key. */
  const affected = new Set<string>();
  /** Functions whose Ghidra-side record changed, not just their body text. */
  const reextract = new Set<string>();

  // ---------------------------------------------------------------------------
  // Datatypes first: the field-name diff is what says which bodies moved, and it
  // only exists while both the old and the new record are in hand.
  // ---------------------------------------------------------------------------
  const typeTokens = new Set<string>();
  for (const event of events) {
    if (event.target !== 'datatype') continue;

    const slots = resolveDataTypeSlots(model, event.key);
    // Slots descend so a removal never shifts a slot still to be handled.
    for (const slot of slots.reverse()) {
      const previous = model.primary.dataTypes[slot];
      const key = dataTypeKey(previous.name, previous.category);
      const oldMembers = memberNames(previous);

      // Every name a body could have spelled this type by, before AND after: a
      // rename invalidates the users of the old spelling too.
      typeTokens.add(previous.name);
      if (event.oldName) typeTokens.add(event.oldName);
      if (event.newName) typeTokens.add(event.newName);

      if (event.kind === 'datatype.removed') {
        model.primary.dataTypes.splice(slot, 1);
        indices.dtByKey.delete(key);
        for (const name of oldMembers) typeTokens.add(name);
        result.touchedDataTypes.push(key);
        continue;
      }

      let fresh: ExtractedDataType;
      try {
        fresh = await extractDataType(client, event.newName ?? previous.name, previous.category);
      } catch (e) {
        log(`datatype ${previous.name}: re-extract failed (${(e as Error).message}); keeping previous`);
        continue;
      }

      model.primary.dataTypes[slot] = fresh;
      indices.dtByKey.delete(key);
      indices.dtByKey.set(dataTypeKey(fresh.name, fresh.category), fresh);
      result.touchedDataTypes.push(dataTypeKey(fresh.name, fresh.category));

      typeTokens.add(fresh.name);
      const newMembers = memberNames(fresh);
      for (const name of oldMembers) if (!newMembers.has(name)) typeTokens.add(name);
      for (const name of newMembers) if (!oldMembers.has(name)) typeTokens.add(name);
    }

    // A type Ghidra has and the model does not: nothing to diff against, and
    // nothing to invalidate beyond the type's own name.
    if (slots.length === 0 && event.kind !== 'datatype.removed') {
      const { name, category } = splitDataTypeKey(event.key);
      try {
        const fresh = await extractDataType(client, event.newName ?? name, category);
        // No address to sort by, so a new type goes at the end: codegen groups
        // types by category and ownership, not by array position.
        model.primary.dataTypes.push(fresh);
        indices.dtByKey.set(dataTypeKey(fresh.name, fresh.category), fresh);
        result.touchedDataTypes.push(dataTypeKey(fresh.name, fresh.category));
        typeTokens.add(fresh.name);
      } catch (e) {
        log(`datatype ${name}: reported changed but not extractable (${(e as Error).message})`);
      }
    }
  }

  if (typeTokens.size > 0) {
    for (const [addr, tokens] of indices.bodyTokens) {
      for (const token of typeTokens) {
        if (tokens.has(token)) {
          affected.add(addr);
          break;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Globals. The symbol itself is re-extracted; its readers are re-decompiled,
  // because a rename or retype of a global respells the reader, not the global.
  // ---------------------------------------------------------------------------
  for (const event of events) {
    if (event.target !== 'global') continue;

    const key = addressKey(event.key);
    const existing = indices.globalByAddr.get(key)
      ?? model.primary.globals.find(g => g.name === event.key || g.name === event.oldName);
    if (!existing) {
      log(`global ${event.key}: not in the model; skipping`);
      continue;
    }

    markReferencingFunctions(existing, nameToFn, affected);

    const slot = model.primary.globals.indexOf(existing);
    try {
      // `list_data_symbols` is the only route to a single global and it filters
      // by name, so the page it answers with is matched back by address.
      const page = await extractGlobals(client, {
        filter: event.newName ?? existing.name,
        limit: 25,
      });
      const match = page.globals.find(g => addressKey(g.address) === addressKey(existing.address));
      if (!match) {
        log(`global ${existing.name}: no longer listed at ${existing.address}`);
        continue;
      }

      // `analyzeDataSymbols` derives scope for the whole binary in one pass and
      // its per-symbol helpers are private, so the analysis fields ride along
      // from the record being replaced rather than being recomputed from a row.
      const merged: AnalyzedDataSymbol = { ...existing, ...defined(match) };
      model.primary.globals[slot] = merged;
      indices.globalByAddr.set(addressKey(merged.address), merged);
      await fetchInitializedData(client, [merged]);
      result.touchedGlobals.push(addressKey(merged.address));
      markReferencingFunctions(merged, nameToFn, affected);
    } catch (e) {
      log(`global ${existing.name}: re-extract failed (${(e as Error).message}); keeping previous`);
    }
  }

  // ---------------------------------------------------------------------------
  // Functions. The callers are not a nicety: a rename or a signature change is
  // invisible in the renamed function's own body and visible in every one of its
  // call sites, which live in the callers.
  // ---------------------------------------------------------------------------
  for (const event of events) {
    if (event.target !== 'function') continue;

    const key = addressKey(event.key);
    reextract.add(key);
    affected.add(key);

    const existing = indices.fnByAddr.get(key);
    for (const alias of [key, existing?.name, event.oldName, event.newName]) {
      if (!alias) continue;
      for (const caller of indices.callersOf.get(alias) ?? []) affected.add(caller);
    }
  }

  const total = model.primary.functions.length || 1;
  if (affected.size > total * FULL_DECOMPILE_FRACTION) {
    log(`${affected.size}/${total} functions affected: taking the batch decompile path`);
    result.escalatedToFullDecompile = true;
    await refreshAllFunctions(model, indices, client, log);
    result.touchedFunctions.push(...indices.fnByAddr.keys());
    model.seq = Math.max(model.seq, highestSeq);
    return result;
  }

  for (const addr of affected) {
    const replaced = await refreshFunction(model, indices, client, addr, {
      reextractInfo: reextract.has(addr),
      timeout,
      log,
    });
    if (replaced) result.touchedFunctions.push(addr);
  }

  if (result.touchedFunctions.length > 0) {
    recomputeCallEdges(model, indices, result.touchedFunctions);
    reindexCallers(model, indices);
  }

  model.seq = Math.max(model.seq, highestSeq);
  return result;
}

/** Every function that reads this global, resolved to an address key. */
function markReferencingFunctions(
  global: AnalyzedDataSymbol,
  nameToFn: Map<string, ExtractedFunction>,
  into: Set<string>,
): void {
  for (const caller of global.referencingFunctions ?? []) {
    // Ghidra lists these namespace-qualified; the model keys functions by the
    // bare name, so both spellings are tried before giving up.
    const fn = nameToFn.get(caller) ?? nameToFn.get(caller.split('::').pop() ?? caller);
    if (fn) into.add(addressKey(fn.address));
  }
}

/** Which slots in `dataTypes` an event key names. A bare name may hit several categories. */
function resolveDataTypeSlots(model: LiveModel, key: string): number[] {
  const { name, category } = splitDataTypeKey(key);
  const slots: number[] = [];
  for (let i = 0; i < model.primary.dataTypes.length; i++) {
    const dt = model.primary.dataTypes[i];
    if (dt.name !== name) continue;
    if (category !== undefined && dt.category !== category) continue;
    slots.push(i);
  }
  return slots;
}

/**
 * Re-fetch one function's record and body, replacing it at the position it
 * already occupies. Returns false when nothing could be fetched, so a transient
 * daemon failure leaves the previous record standing rather than a hole.
 */
async function refreshFunction(
  model: LiveModel,
  indices: ModelIndices,
  client: GhidraConnection,
  addr: string,
  opts: { reextractInfo: boolean; timeout: number; log: LiveLog },
): Promise<boolean> {
  const existing = indices.fnByAddr.get(addr);
  const address = existing?.address ?? addr;

  let record: ExtractedFunction | undefined = existing;
  if (opts.reextractInfo || !existing) {
    const info = await getFunctionInfo(client, address);
    if (!info) {
      opts.log(`function ${address}: no longer present in Ghidra`);
      return false;
    }
    // `get_function_info` answers with the Ghidra-side facts only. Everything
    // derived later — the body, call edges, platform guards, thunk targets — is
    // carried forward from the record being replaced.
    record = existing ? { ...existing, ...defined(info) } : info;
  } else {
    record = { ...existing };
  }
  if (!record) return false;

  if (!record.isThunk && !record.isExternal) {
    try {
      record.decompiled = await decompileFunction(client, record.address, opts.timeout);
    } catch (e) {
      opts.log(`function ${record.name}: decompile failed (${(e as Error).message}); keeping previous body`);
    }
  }

  if (existing) {
    model.primary.functions[model.primary.functions.indexOf(existing)] = record;
  } else {
    insertPrimaryFunction(model, record);
  }
  indices.fnByAddr.set(addressKey(record.address), record);
  indices.bodyTokens.set(addressKey(record.address), tokenize(record.decompiled));
  return true;
}

/**
 * Place a newly-created function among the primary binary's functions, in
 * address order.
 *
 * Merged cross-platform records live in the same array and are not part of that
 * ordering, so the insertion point is found among the primary ones only —
 * appending instead would put a Game.exe function after the Mac tail.
 */
function insertPrimaryFunction(model: LiveModel, fn: ExtractedFunction): void {
  const target = addressValue(fn.address);
  const functions = model.primary.functions;
  for (let i = 0; i < functions.length; i++) {
    if (functions[i].platform) continue;
    if (addressValue(functions[i].address) > target) {
      functions.splice(i, 0, fn);
      return;
    }
  }
  // No primary function sits above it; go before the merged tail, if any.
  const firstMerged = functions.findIndex(f => f.platform);
  functions.splice(firstMerged < 0 ? functions.length : firstMerged, 0, fn);
}

function addressValue(address: string): bigint {
  const hex = addressKey(address);
  return /^[0-9a-f]+$/.test(hex) ? BigInt(`0x${hex}`) : 0n;
}

/**
 * Rebuild `calledFunctions` for the given functions by intersecting each fresh
 * body with the known function names.
 *
 * That is the same evidence `buildCallGraph` reads, at name granularity,
 * without re-scanning the 14k bodies that did not move.
 */
function recomputeCallEdges(model: LiveModel, indices: ModelIndices, addrs: readonly string[]): void {
  const names = new Set<string>();
  for (const fn of model.primary.functions) names.add(fn.name);
  for (const addr of addrs) {
    const fn = indices.fnByAddr.get(addr);
    if (!fn) continue;
    const callees: string[] = [];
    for (const token of indices.bodyTokens.get(addr) ?? []) {
      if (token !== fn.name && names.has(token)) callees.push(token);
    }
    fn.calledFunctions = callees;
  }
}

/** Rebuild `callersOf` as the reverse of every function's `calledFunctions`. */
function reindexCallers(model: LiveModel, indices: ModelIndices): void {
  indices.callersOf.clear();
  const nameToAddr = new Map<string, string>();
  for (const fn of model.primary.functions) nameToAddr.set(fn.name, addressKey(fn.address));

  for (const fn of model.primary.functions) {
    const caller = addressKey(fn.address);
    for (const callee of fn.calledFunctions ?? []) {
      for (const alias of [callee, nameToAddr.get(callee), addressKey(callee)]) {
        if (!alias) continue;
        let set = indices.callersOf.get(alias);
        if (!set) indices.callersOf.set(alias, (set = new Set()));
        set.add(caller);
      }
    }
  }
}

/**
 * The escalation path: one `extractAllFunctions` with bodies, which fans out
 * over the worker's decompiler pool, instead of thousands of single calls.
 *
 * The fresh records are folded onto the existing array BY ADDRESS rather than
 * replacing it, so the merged cross-platform functions and the array order both
 * survive an escalation.
 */
async function refreshAllFunctions(
  model: LiveModel,
  indices: ModelIndices,
  client: GhidraConnection,
  log: LiveLog,
): Promise<void> {
  const fresh = await extractAllFunctions(client, {
    decompile: true,
    decompileTimeout: model.options.decompileTimeout ?? 30,
    excludeLibraryCode: model.options.excludeLibraryCode,
    excludePatterns: model.options.excludePatterns,
    // Deliberately no cache: escalating is the admission that the cached bodies
    // are the ones now known to be stale.
  });

  const byAddr = new Map<string, ExtractedFunction>();
  for (const fn of fresh) byAddr.set(addressKey(fn.address), fn);

  for (let i = 0; i < model.primary.functions.length; i++) {
    const existing = model.primary.functions[i];
    if (existing.platform) continue;
    const key = addressKey(existing.address);
    const update = byAddr.get(key);
    if (!update) continue;
    model.primary.functions[i] = { ...existing, ...defined(update) };
    byAddr.delete(key);
  }

  for (const fn of byAddr.values()) insertPrimaryFunction(model, fn);
  if (byAddr.size > 0) log(`${byAddr.size} function(s) new since the last extraction`);

  indices.fnByAddr.clear();
  indices.bodyTokens.clear();
  for (const fn of model.primary.functions) {
    const key = addressKey(fn.address);
    indices.fnByAddr.set(key, fn);
    indices.bodyTokens.set(key, tokenize(fn.decompiled));
  }

  recomputeCallEdges(model, indices, [...indices.fnByAddr.keys()]);
  reindexCallers(model, indices);
}
