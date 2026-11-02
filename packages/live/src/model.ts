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
  extractDataTypes,
  extractGlobals,
  type AnalyzedDataSymbol,
  type CachedSourceExtraction,
  type ExtractedDataType,
  type ExtractedFunction,
  type ExtractionResult,
  type GhidraConnection,
  type ReconstructionOptions,
} from '@ghidra-mcp/reconstruct';
import { decompileFunction, getFunctionInfo, listFunctionRecord } from '@ghidra-mcp/reconstruct/extract/functions';
import { fetchInitializedData, inferType, extractPrimaryLabels, markPrimaryLabels, analyzeDataSymbol } from '@ghidra-mcp/reconstruct/extract/globals';
import { attachOperandRefs } from '@ghidra-mcp/reconstruct/extract/operand-refs';
import { extractFunctionFacts, FACT_KEYS } from '@ghidra-mcp/reconstruct/extract/function-facts';
import { callEdgeIndex, calleeAddressesOf } from '@ghidra-mcp/reconstruct/analysis/callgraph';

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
  /** Ghidra's name for the transaction that produced the event. */
  txDescription?: string;
  /**
   * Set by a producer that compared the function's call signature (name, convention,
   * parameter and return types and storage, varargs, inline, no-return, purge, call
   * fixup) before and after and found it unchanged: the edit is inside the function,
   * and its callers decompile exactly as before.
   */
  callersUnaffected?: boolean;
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

/** Function refreshes in flight at once; the local worker's decompiler pool is per core. */
const REFRESH_CONCURRENCY = Number(process.env.D2_LIVE_REFRESH_CONCURRENCY ?? '16');

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


/**
 * The name and category to fetch a datatype by, for one change event.
 *
 * Both `key` and `newName` may arrive as a category path, and `newName` is the
 * one that wins on a rename - so splitting only the key still handed the worker
 * a path and it still answered "Data type not found".
 */
export function eventDataTypeTarget(
  event: { key: string; newName?: string },
  fallback: { name: string; category?: string },
): { name: string; category?: string } {
  const renamed = event.newName ? splitDataTypeKey(event.newName) : undefined;
  const fromKey = splitDataTypeKey(event.key);
  return {
    name: renamed?.name ?? fallback.name,
    category: renamed?.category ?? fromKey.category ?? fallback.category,
  };
}

/** The hex tail of a Ghidra address ("Game.exe.ram:005011f0" -> "005011f0"). */
function addressKey(address: string): string {
  const bare = address.includes(':') ? address.slice(address.lastIndexOf(':') + 1) : address;
  return bare.replace(/^0x/i, '').toLowerCase();
}

function dataTypeKey(name: string, category: string | undefined): string {
  return `${name}${DT_SEP}${category ?? ''}`;
}

export function splitDataTypeKey(key: string): { name: string; category?: string } {
  const sep = key.indexOf(DT_SEP);
  if (sep >= 0) return { name: key.slice(0, sep), category: key.slice(sep + DT_SEP.length) };

  // The journal also spells a datatype as a category path ("/D2CMP/Foo"), and
  // the worker will not resolve one of those as a bare name - it wants name and
  // category apart. Passed through whole, a newly created type is reported
  // changed and then "not extractable", so it never enters the model and every
  // body that now uses it emits against a type nothing declares.
  const slash = key.lastIndexOf('/');
  if (slash < 0) return { name: key };
  return { name: key.slice(slash + 1), category: key.slice(0, slash) || '/' };
}

function tokenize(body: string | undefined): Set<string> {
  const tokens = new Set<string>();
  if (!body) return tokens;
  for (const match of body.matchAll(IDENTIFIER)) tokens.add(match[0]);
  return tokens;
}

/** The member names a change to this type would respell in a body. */
/**
 * The type a spelling refers to: `struct X *[3]` -> `X`. Qualifiers, pointer stars
 * and array dimensions are stripped; the name itself is kept whole.
 */
export function baseTypeName(spelling: string): string {
  let t = spelling.trim();
  for (;;) {
    const next = t
      .replace(/^(?:const|volatile|struct|union|enum|class)\s+/, '')
      .replace(/\s*(?:\*|\[\d*\]|\bconst\b|\bvolatile\b)\s*$/, '')
      .trim();
    if (next === t) return t;
    t = next;
  }
}

/**
 * Put the type list in the listing's order, in place. Types the listing does not name
 * keep their relative order after the listed ones.
 */
export function reorderDataTypes(
  dataTypes: ExtractedDataType[],
  listing: readonly { name: string; category?: string }[],
): void {
  const rank = new Map<string, number>();
  listing.forEach((t, i) => { const k = dataTypeKey(t.name, t.category); if (!rank.has(k)) rank.set(k, i); });
  const ordered = dataTypes
    .map((dt, i) => ({ dt, i, r: rank.get(dataTypeKey(dt.name, dt.category)) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => (a.r - b.r) || (a.i - b.i))
    .map(x => x.dt);
  dataTypes.splice(0, dataTypes.length, ...ordered);
}

/** `execute_script` on the worker, Java, returning its printed output. */
async function javaScript(client: GhidraConnection, code: string, timeoutSec = 120): Promise<string> {
  const r = await client.sendCommand<{ success?: boolean; output?: string; error?: string }>(
    'execute_script', { language: 'java', code, scriptTimeout: timeoutSec, _commandTimeout: (timeoutSec + 60) * 1000 },
  );
  if (r.success === false || typeof r.output !== 'string') throw new Error(r.error ?? 'no output');
  return r.output;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The label names at each address, as the symbol table holds them now. */
async function labelsAt(client: GhidraConnection, addrs: readonly string[]): Promise<Map<string, string[]>> {
  const out = await javaScript(client, `
String[] addrs = new String[] { ${addrs.map(a => JSON.stringify(a)).join(', ')} };
ghidra.program.model.symbol.SymbolTable st = currentProgram.getSymbolTable();
StringBuilder sb = new StringBuilder();
for (String a : addrs) {
  ghidra.program.model.address.Address ad = currentProgram.getAddressFactory().getAddress(a);
  if (ad == null) continue;
  for (ghidra.program.model.symbol.Symbol s : st.getSymbols(ad)) {
    if (s.getSymbolType() != ghidra.program.model.symbol.SymbolType.LABEL) continue;
    sb.append(a).append('\\t').append(s.getName()).append('\\n');
  }
}
println(sb.toString());
`);
  const map = new Map<string, string[]>(addrs.map(a => [a, []]));
  for (const line of out.split('\n')) {
    const [a, name] = line.replace(/\r$/, '').split('\t');
    if (!a || !name) continue;
    map.get(addressKey(a))?.push(name);
  }
  return map;
}

/** Every label in the order the global listing walks them (the symbol table's). */
async function labelOrder(client: GhidraConnection): Promise<string[]> {
  const out = await javaScript(client, `
StringBuilder sb = new StringBuilder();
for (ghidra.program.model.symbol.Symbol s : currentProgram.getSymbolTable().getAllSymbols(true)) {
  if (s.getSymbolType() != ghidra.program.model.symbol.SymbolType.LABEL) continue;
  sb.append(s.getAddress()).append('\\t').append(s.getName()).append('\\n');
}
println(sb.toString());
`, 300);
  return out.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.includes('\t'))
    .map(l => { const [a, n] = l.split('\t'); return `${addressKey(a)}\t${n}`; });
}

/**
 * Put the primary binary's globals in the listing's order, in place: address + name
 * ranked by the label walk. Unranked ones keep their relative order after the ranked;
 * merged cross-platform records stay at the tail.
 */
export function reorderGlobals(globals: AnalyzedDataSymbol[], order: readonly string[]): void {
  const rank = new Map<string, number>();
  order.forEach((k, i) => { if (!rank.has(k)) rank.set(k, i); });
  const primary = globals.map((g, i) => ({ g, i })).filter(x => !x.g.platform)
    .map(x => ({ ...x, r: rank.get(`${addressKey(x.g.address)}\t${x.g.name}`) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => (a.r - b.r) || (a.i - b.i)).map(x => x.g);
  const rest = globals.filter(g => g.platform);
  globals.splice(0, globals.length, ...primary, ...rest);
}

/** The type names one record refers to: members, typedef target, function definition. */
function referencedTypeNames(dt: ExtractedDataType): string[] {
  const r = dt as ExtractedDataType & {
    fields?: { dataType?: string }[];
    underlyingType?: string;
    returnType?: string;
    parameters?: { dataType?: string }[];
  };
  const out: string[] = [];
  for (const f of r.fields ?? []) if (f.dataType) out.push(baseTypeName(f.dataType));
  if (r.underlyingType) out.push(baseTypeName(r.underlyingType));
  if (r.returnType) out.push(baseTypeName(r.returnType));
  for (const p of r.parameters ?? []) if (p.dataType) out.push(baseTypeName(p.dataType));
  return out;
}

/**
 * Which type records must be read again after types were renamed, by reference rather
 * than by text: a record refers to a name when one of its members, its typedef target,
 * or its function definition's return or parameter types resolve to it.
 *
 * Transitive over the records whose own NAME derives from a renamed one: the pointer
 * and array records Ghidra keeps beside a type (`X *`, `X[3]`) are renamed with it,
 * and everything that refers to them spells the old name too. A typedef or struct that
 * merely refers to a renamed type keeps its own name, so the closure stops there - its
 * own users spell it, not the renamed type.
 *
 * names: every old spelling now stale (renamed types and their derived records), for
 * globals and bodies. derivedNames: slot -> the name a derived record has now.
 */
export function renameReferrers(
  dataTypes: readonly ExtractedDataType[],
  renamed: ReadonlySet<string>,
  renamedTo?: ReadonlyMap<string, string>,
): { typeSlots: number[]; names: Set<string>; derivedNames: Map<number, string> } {
  const names = new Set(renamed);
  const derivedNames = new Map<number, string>();
  const slots = new Set<number>();
  let grew = true;
  while (grew) {
    grew = false;
    for (let i = 0; i < dataTypes.length; i++) {
      const dt = dataTypes[i];
      if (names.has(dt.name)) continue;
      const base = baseTypeName(dt.name);
      if (base !== dt.name && names.has(base)) {
        // A derived record of a renamed type is renamed with it.
        names.add(dt.name);
        const to = renamedTo?.get(base);
        if (to) derivedNames.set(i, to + dt.name.slice(base.length));
        slots.add(i);
        grew = true;
      }
    }
  }
  for (let i = 0; i < dataTypes.length; i++) {
    if (slots.has(i) || names.has(dataTypes[i].name)) continue;
    if (referencedTypeNames(dataTypes[i]).some(n => names.has(n))) slots.add(i);
  }
  return { typeSlots: [...slots].sort((a, b) => a - b), names, derivedNames };
}

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
  if (events.some(e => isModelInvalidatingRestore(e, events))) {
    result.needsFullResync = true;
    model.seq = Math.max(model.seq, highestSeq);
    log('restored: incremental state discarded, full resync required');
    return result;
  }

  // Drop every restore that is explained by its own transaction before the
  // program-wide test below, which would otherwise resync on it for naming no
  // symbol.
  events = events.filter(e => e.kind !== 'restored');
  if (events.length === 0) {
    model.seq = Math.max(model.seq, highestSeq);
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

  // ---------------------------------------------------------------------------
  // Datatypes first: the field-name diff is what says which bodies moved, and it
  // only exists while both the old and the new record are in hand.
  // ---------------------------------------------------------------------------
  const typeTokens = new Set<string>();
  /** A type was renamed or added: its place in the type list moved. */
  let typeOrderMoved = false;
  /** Old names of renamed types: other records still spell them. */
  const renamedFrom = new Set<string>();
  const renamedTo = new Map<string, string>();
  for (const event of events) {
    if (event.target !== 'datatype') continue;

    // The model still holds a renamed type under its old path; the version journal keys
    // the event by the new one. Looked up by the new path only, a rename read as a new
    // type: the old record stayed, and no body that spells the old name was decompiled.
    let slots = resolveDataTypeSlots(model, event.key);
    if (slots.length === 0 && event.oldName && event.oldName !== event.key) {
      slots = resolveDataTypeSlots(model, event.oldName);
    }
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
        const target = eventDataTypeTarget(event, { name: previous.name, category: previous.category });
        fresh = await extractDataType(client, target.name, target.category);
      } catch (e) {
        log(`datatype ${previous.name}: re-extract failed (${(e as Error).message}); keeping previous`);
        continue;
      }

      model.primary.dataTypes[slot] = fresh;
      indices.dtByKey.delete(key);
      indices.dtByKey.set(dataTypeKey(fresh.name, fresh.category), fresh);
      result.touchedDataTypes.push(dataTypeKey(fresh.name, fresh.category));

      typeTokens.add(fresh.name);
      if (fresh.name !== previous.name) {
        renamedFrom.add(previous.name);
        renamedTo.set(previous.name, fresh.name);
        typeOrderMoved = true;
      }
      const newMembers = memberNames(fresh);
      for (const name of oldMembers) if (!newMembers.has(name)) typeTokens.add(name);
      for (const name of newMembers) if (!oldMembers.has(name)) typeTokens.add(name);
    }

    // A type Ghidra has and the model does not: nothing to diff against, and
    // nothing to invalidate beyond the type's own name.
    if (slots.length === 0 && event.kind !== 'datatype.removed') {
      const { name, category } = eventDataTypeTarget(event, splitDataTypeKey(event.key));
      try {
        const fresh = await extractDataType(client, name, category);
        // No address to sort by, so a new type goes at the end: codegen groups
        // types by category and ownership, not by array position.
        model.primary.dataTypes.push(fresh);
        typeOrderMoved = true;
        indices.dtByKey.set(dataTypeKey(fresh.name, fresh.category), fresh);
        result.touchedDataTypes.push(dataTypeKey(fresh.name, fresh.category));
        typeTokens.add(fresh.name);
      } catch (e) {
        log(`datatype ${name}: reported changed but not extractable (${(e as Error).message})`);
      }
    }
  }

  // A rename changes the type's own record only: Ghidra's change set names the renamed
  // type, not the records that refer to it. Their references still carry the old name -
  // a field `D2UnknownStructure0x18 *` stayed in D2UnitDataPlayerStrc after the struct
  // became D2TradeRecordStrc, and the emitter then cast every access to it. Re-read them,
  // as a full extraction would; see renameReferrers for which ones.
  const globalEvents = events.filter(e => e.target === 'global');
  if (renamedFrom.size > 0) {
    const touched = new Set(result.touchedDataTypes);
    const referrers = renameReferrers(model.primary.dataTypes, renamedFrom, renamedTo);
    for (const slot of referrers.typeSlots) {
      const dt = model.primary.dataTypes[slot];
      const key = dataTypeKey(dt.name, dt.category);
      if (touched.has(key)) continue;
      const renamedTo = referrers.derivedNames.get(slot);
      try {
        const fresh = await extractDataType(client, renamedTo ?? dt.name, dt.category);
        model.primary.dataTypes[slot] = fresh;
        indices.dtByKey.delete(key);
        indices.dtByKey.set(dataTypeKey(fresh.name, fresh.category), fresh);
        result.touchedDataTypes.push(dataTypeKey(fresh.name, fresh.category));
        // A referrer keeps its name, and bodies spell it as before: only the stale old
        // names (referrers.names, below) say which bodies moved. A derived record that
        // was renamed with its type is one of those.
      } catch (e) {
        log(`datatype ${dt.name}: re-extract after a rename failed (${(e as Error).message}); keeping previous`);
      }
    }
    for (const g of model.primary.globals) {
      if (g.platform || !g.dataType || !referrers.names.has(baseTypeName(g.dataType))) continue;
      if (globalEvents.some(e => addressKey(e.key) === addressKey(g.address))) continue;
      globalEvents.push({ seq: 0, kind: 'data.changed', target: 'global', key: g.address, at: '' } as ChangeEvent);
    }
    // Functions whose signature, parameters or locals use one of these types print the
    // name in their body, so the old names in typeTokens send them to be decompiled and
    // their records re-read.
    for (const name of referrers.names) typeTokens.add(name);
  }

  // The type list's order is a whole-program input: the emitter lays types out in it.
  // The full extraction takes it from Ghidra's listing, which is name-ordered, so a
  // renamed or added type sits where the listing puts it - not in its old slot, and not
  // at the end. Ask the listing rather than re-implement its comparator.
  if (typeOrderMoved) {
    try {
      const listing = await extractDataTypes(client, { limit: 10000 });
      reorderDataTypes(model.primary.dataTypes, listing);
    } catch (e) {
      log(`type order: listing failed (${(e as Error).message}); renamed or added types keep their slots`);
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
  // Globals, reconciled per address: the labels Ghidra has there now against the
  // records the model has there. A label added in a check-in becomes a record, analysed
  // as the full pass analyses one, at the place the listing gives it; a label gone takes
  // its record with it; the rest are re-read. Either way the functions that reference
  // the address are decompiled again.
  const globalAddrs: string[] = [];
  for (const ev of globalEvents) {
    const byName = model.primary.globals.find(g => g.name === ev.key || g.name === ev.oldName);
    const key = /^(?:[\w.]+:)?(?:0x)?[0-9a-f]+$/i.test(ev.key) ? addressKey(ev.key) : byName ? addressKey(byName.address) : null;
    if (!key) { log(`global ${ev.key}: no address and not in the model; skipping`); continue; }
    if (!globalAddrs.includes(key)) globalAddrs.push(key);
  }
  if (globalAddrs.length > 0) {
    let labels: Map<string, string[]> | null = null;
    try {
      labels = await labelsAt(client, globalAddrs);
    } catch (e) {
      log(`globals: labels at ${globalAddrs.length} address(es) unavailable (${(e as Error).message}); keeping previous records`);
    }
    let added = false;
    for (const addr of labels ? globalAddrs : []) {
      const names = labels!.get(addr) ?? [];
      const inModel = model.primary.globals.filter(g => !g.platform && addressKey(g.address) === addr);
      for (const gone of inModel.filter(g => !names.includes(g.name))) {
        markReferencingFunctions(gone, nameToFn, affected);
        model.primary.globals.splice(model.primary.globals.indexOf(gone), 1);
        result.touchedGlobals.push(addr);
        log(`global ${gone.name}: no longer at ${gone.address}; removed`);
      }
      for (const name of names) {
        try {
          const page = await extractGlobals(client, { regex: `^${escapeRegex(name)}$`, limit: 100 });
          const row = page.globals.find(g => g.name === name && addressKey(g.address) === addr);
          if (!row) continue; // a label the listing does not report (no data there)
          const existing = inModel.find(g => g.name === name);
          let record: AnalyzedDataSymbol;
          if (existing) {
            record = { ...existing, ...defined(row) };
            // `suggestedType` is DERIVED from dataType, and codegen prefers it, so a type
            // that changed in Ghidra has to re-derive it here or the old spelling wins.
            // Retyping a scalar to the array it really is then emitted an array-sized
            // initializer against a scalar declaration - and the clear-loop that walks the
            // array wrote past a four-byte object.
            if (record.dataType && record.dataType !== existing.dataType) {
              record.suggestedType = inferType(record.dataType);
            }
            model.primary.globals[model.primary.globals.indexOf(existing)] = record;
          } else {
            const analyzed = analyzeDataSymbol(row);
            if (!analyzed) continue; // a string, which the full pass leaves out too
            record = analyzed;
            model.primary.globals.push(record);
            added = true;
            log(`global ${name}: new at ${row.address}`);
          }
          await fetchInitializedData(client, [record]);
          result.touchedGlobals.push(addr);
          markReferencingFunctions(record, nameToFn, affected);
        } catch (e) {
          log(`global ${name}: re-extract failed (${(e as Error).message}); keeping previous`);
        }
      }
      const first = model.primary.globals.find(g => !g.platform && addressKey(g.address) === addr);
      if (first) indices.globalByAddr.set(addr, first); else indices.globalByAddr.delete(addr);
    }
    // A new record goes where the full listing puts it: the symbol table's order.
    if (added) {
      try {
        reorderGlobals(model.primary.globals, await labelOrder(client));
      } catch (e) {
        log(`global order: unavailable (${(e as Error).message}); new globals stay at the end`);
      }
    }
  }

  // Which label is primary at an address with several. A re-listed global arrives
  // without the flag (`list_data_symbols` does not know it), and a rename can move the
  // primary to another label; the full extraction's script answers for the whole
  // program in one call, so it is re-run once per batch and the flags re-marked.
  if (result.touchedGlobals.length > 0) {
    try {
      const marked = markPrimaryLabels(model.primary.globals.filter(g => !g.platform), await extractPrimaryLabels(client));
      if (marked.unmatched > 0) log(`primary labels: ${marked.unmatched} multi-label address(es) whose primary is not listed`);
    } catch (e) {
      log(`primary labels: re-extract failed (${(e as Error).message}); keeping previous flags`);
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
    affected.add(key);

    if (event.callersUnaffected) continue;
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

  // In parallel: the worker answers reads concurrently on its decompiler pool, and one
  // round trip at a time left it idle. Each refresh replaces only its own record, and
  // the touched list keeps the order of `affected` so what follows is deterministic.
  const order = [...affected];
  const replaced = new Array<boolean>(order.length).fill(false);
  let next = 0;
  const lanes = Math.max(1, Math.min(REFRESH_CONCURRENCY, order.length));
  await Promise.all(Array.from({ length: lanes }, async () => {
    for (let i = next++; i < order.length; i = next++) {
      replaced[i] = await refreshFunction(model, indices, client, order[i], {
        // The record too, not only the body: a caller's locals carry the decompiler's
        // resolved types, and those move with a callee's signature. A full extraction
        // reads every record fresh, so a carried-over one would disagree with it.
        reextractInfo: true,
        timeout,
        log,
      });
    }
  }));
  order.forEach((addr, i) => { if (replaced[i]) result.touchedFunctions.push(addr); });

  if (result.touchedFunctions.length > 0) {
    recomputeCallEdges(model, indices, result.touchedFunctions);
    reindexCallers(model, indices);
    await refreshOperandRefs(model, client, result.touchedFunctions, log);
    await refreshFunctionFacts(model, indices, client, result.touchedFunctions, log);
  }

  model.seq = Math.max(model.seq, highestSeq);
  return result;
}

/**
 * The instruction operand references of the given functions (extract/operand-refs.ts),
 * which `folded-address-rebase` reads: an edit that changes a reference (an offset
 * reference added, code re-disassembled) must reach the next emit, and a refreshed
 * record would otherwise carry the old facts forward. One script for the batch; the
 * covered functions' old facts are cleared first, so a reference that is gone is gone.
 * Only the primary binary's records: a merged cross-platform record can share an
 * address with a Windows function.
 */
async function refreshOperandRefs(
  model: LiveModel,
  client: GhidraConnection,
  addrs: readonly string[],
  log: LiveLog,
): Promise<void> {
  const primary = model.primary.functions.filter(f => !f.platform);
  const n = await attachOperandRefs(client, primary, [...addrs]);
  log(`operand references: ${n} of ${addrs.length} refreshed function(s) have some`);
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
    // The record itself comes from the listing, as the full extraction reads it;
    // `get_function_info` only says what the function is called now, which a rename
    // moved. Everything derived later — the body, call edges, platform guards, thunk
    // targets — is carried forward from the record being replaced.
    const listed = await listFunctionRecord(client, info.name, info.address).catch(() => null);
    if (!listed) opts.log(`function ${info.name}: not listed under its name; using get_function_info`);
    const fresh = listed ?? info;
    record = existing ? { ...existing, ...defined(fresh) } : fresh;
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
 * Rebuild `calledFunctions` for the given functions, with the batch call graph's own
 * rule (`calleeAddressesOf`): calls the body prints, in first-occurrence order, its own
 * name included, then a thunk's target - resolved to names as `populateCalledFunctions`
 * does. Any other rule leaves a re-extracted function's edges different from a full
 * extraction's, and they reach the source maps and the include lists.
 */
function recomputeCallEdges(model: LiveModel, indices: ModelIndices, addrs: readonly string[]): void {
  const functions = model.primary.functions;
  const index = callEdgeIndex(functions);
  const addressToName = new Map<string, string>();
  for (const fn of functions) addressToName.set(fn.address, fn.name);
  for (const addr of addrs) {
    const fn = indices.fnByAddr.get(addr);
    if (!fn) continue;
    const callees: string[] = [];
    for (const callee of calleeAddressesOf(fn, index)) {
      const name = addressToName.get(callee);
      if (name) callees.push(name);
    }
    fn.calledFunctions = callees;
  }
}

/**
 * Read the per-function facts (compare sites, branch layout, call and access order, halt
 * lines, ...) again for every function whose body was re-decompiled. They are line-keyed
 * to the body, so facts carried over from the previous record describe a text that is
 * gone, and codegen then lays out branches and orders stores by the old lines. Cleared
 * first: a body that no longer prints a construct must not keep its old fact. Read with
 * no cache, as a full extraction with an empty cache would.
 */
async function refreshFunctionFacts(
  model: LiveModel,
  indices: ModelIndices,
  client: GhidraConnection,
  addrs: readonly string[],
  log: LiveLog,
): Promise<void> {
  const functions: ExtractedFunction[] = [];
  for (const addr of addrs) {
    const fn = indices.fnByAddr.get(addr);
    if (!fn) continue;
    for (const key of FACT_KEYS) delete fn[key];
    functions.push(fn);
  }
  if (functions.length === 0) return;
  // As the full extraction decides it: the compare-site forms are VC8's, PE images only.
  const format = model.primary.programInfo?.format ?? '';
  const compareSites = process.env.GHIDRA_COMPARE_SITES !== '0' && /Portable Executable|\bPE\b/i.test(format);
  try {
    const stats = await extractFunctionFacts(client, functions, { compareSites });
    log(`facts: ${stats.extracted} of ${stats.candidates} candidate(s) re-read for ${functions.length} refreshed function(s)`);
  } catch (e) {
    log(`facts: re-read failed (${(e as Error).message}); the refreshed functions carry none`);
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
 * Ghidra's transaction name for the version bookkeeping a check-in writes.
 * The program's content is untouched by it.
 */
const METADATA_ONLY_TX = 'Update Metadata';

/**
 * Does this event say the program moved under us in a way no diff describes?
 *
 * Ghidra fires an object-restored event for an undo, a redo, a rollback - and
 * also for the metadata write that records a new version on check-in, and again
 * for edits that re-sync the program, such as giving a function custom parameter
 * storage. Only a genuine rollback invalidates the model.
 *
 * The discriminator is the TRANSACTION. A rollback replaces state no event
 * describes, so its restore arrives alone. An edit that happens to re-sync the
 * program is one transaction that ALSO emitted targeted events naming exactly
 * what changed - and those events are a complete description, so the model can
 * be brought up to date from them the ordinary way.
 *
 * Getting this wrong is expensive in one direction only: treating an edit as a
 * rollback stops the loop for good, on the very actions an operator performs
 * most.
 */
export function isModelInvalidatingRestore(
  e: ChangeEvent,
  batch: readonly ChangeEvent[],
): boolean {
  if (e.kind !== 'restored') return false;
  if (e.txDescription === METADATA_ONLY_TX) return false;
  const txId = (e as { txId?: number }).txId;
  if (txId !== undefined && batch.some(other =>
    other !== e &&
    (other as { txId?: number }).txId === txId &&
    other.target !== 'program')) {
    return false;
  }
  return true;
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
    // `operandRefs` is absent on a function that has none: spelled out, so a reference
    // removed in Ghidra does not survive in the carried-forward record.
    model.primary.functions[i] = { ...existing, ...defined(update), operandRefs: update.operandRefs };
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
