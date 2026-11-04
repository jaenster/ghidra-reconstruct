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
import { DETAIL_KINDS } from '@ghidra-mcp/reconstruct/extract/types';
import { disambiguateVtableTypes } from '@ghidra-mcp/reconstruct/modules/vtable-types';
import { disambiguateCategoryDuplicates } from '@ghidra-mcp/reconstruct/modules/category-duplicate-types';
import { dedupeDataTypesByName, isExcludedDataType } from '@ghidra-mcp/reconstruct/modules/data-type-normalize';
import { EXCLUDE_PATTERNS } from './exclude-patterns.js';
import { SHIFTED_POINTER_SCRIPT, applyShiftedPointers, parseShiftedPointers, type ShiftedPointerFact } from '@ghidra-mcp/reconstruct/extract/shifted-pointers';
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
export function addressKey(address: string): string {
  const bare = address.includes(':') ? address.slice(address.lastIndexOf(':') + 1) : address;
  return bare.replace(/^0x/i, '').toLowerCase();
}

export function dataTypeKey(name: string, category: string | undefined): string {
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
 * The name Ghidra holds a type under. The model carries the snapshot's names, and a
 * reconstruct pass renamed some of them (`/WardenClient/vtable` is `WardenClientVtable`,
 * the second `fpDrawGroundTile` is `D2RendererFunctionsStrc_fpDrawGroundTile`). The
 * listing, the journal and `get_data_type` all answer in Ghidra's names, so every
 * lookup against them goes through here.
 */
export function ghidraName(dt: { name: string; sourceName?: string }): string {
  return dt.sourceName ?? dt.name;
}

/** `X * *[4]` -> `[' * *[4]', 'X']`: the spelling after the base name, and the base. */
function splitTypeSuffix(name: string): [suffix: string, base: string] {
  const m = name.match(/^(.*?)((?:\s*\*|\s*\[\d*\])*)$/);
  return m ? [m[2], m[1]] : ['', name];
}

/**
 * Give `sourceName` to the records a reconstruct pass renamed before the passes
 * recorded it (a model seeded from an older snapshot). A record is paired with a
 * listing entry only on evidence: its key is missing from the listing, the entry's key
 * is held by no record, both sit in the same category with the same kind and the same
 * pointer/array spelling, the record's base name ends with the entry's (as both passes
 * name: `<Owner>Vtable`, `<Owner>_<name>`), and the pair is the only candidate either
 * way. Anything else stays unpaired. Returns the number of records paired.
 */
export function adoptGhidraNames(
  dataTypes: ExtractedDataType[],
  listing: readonly { name: string; category?: string; kind?: string }[],
): number {
  const listed = new Set(listing.map(t => dataTypeKey(t.name, t.category)));
  const held = new Set(dataTypes.map(dt => dataTypeKey(ghidraName(dt), dt.category)));
  const orphans = listing.filter(t => !held.has(dataTypeKey(t.name, t.category)));
  const flat = (n: string) => n.replace(/[^A-Za-z0-9_]/g, '_').toLowerCase();
  const sameKind = (a?: string, b?: string) => a === b || a === 'BUILT_IN' || b === 'BUILT_IN';
  const fits = (dt: ExtractedDataType, t: { name: string; category?: string; kind?: string }) => {
    if ((t.category ?? '') !== (dt.category ?? '') || !sameKind(dt.kind, t.kind)) return false;
    const [ds, db] = splitTypeSuffix(dt.name);
    const [ts, tb] = splitTypeSuffix(t.name);
    if (ds.replace(/\s+/g, '') !== ts.replace(/\s+/g, '') || db === tb) return false;
    return flat(db).endsWith(flat(tb));
  };
  const unlisted = dataTypes.filter(dt => !dt.sourceName && !listed.has(dataTypeKey(dt.name, dt.category)));
  let paired = 0;
  for (const dt of unlisted) {
    const candidates = orphans.filter(t => fits(dt, t));
    if (candidates.length !== 1) continue;
    if (unlisted.filter(other => fits(other, candidates[0])).length !== 1) continue;
    dt.sourceName = candidates[0].name;
    paired++;
  }
  return paired;
}

/** The event that asks for the type list to be put back in the listing's order. */
export const TYPE_ORDER_EVENT = 'datatype.order';

/**
 * Where the type list leaves the listing's order: the first position whose record is
 * not the one `reorderDataTypes` would put there, or null when the order is the
 * listing's. Reads copies; the model is not touched.
 */
export function typeOrderDrift(
  dataTypes: readonly ExtractedDataType[],
  listing: readonly { name: string; category?: string; kind?: string }[],
): { index: number; model: string; listing: string } | null {
  const copy = dataTypes.map(dt => ({ ...dt }));
  reorderDataTypes(copy, listing);
  for (let i = 0; i < copy.length; i++) {
    const want = copy[i], have = dataTypes[i];
    if (want.name !== have.name || want.category !== have.category) {
      return { index: i, model: `${have.category}/${have.name}`, listing: `${want.category}/${want.name}` };
    }
  }
  return null;
}

/** Type lists whose records have been matched to their Ghidra names in this process. */
const ghidraNamesAdopted = new WeakSet<ExtractedDataType[]>();

/**
 * Put the type list in the listing's order, in place. Types the listing does not name
 * keep their relative order after the listed ones. A record is ranked by the name
 * Ghidra lists it under, not the one a reconstruct pass gave it: ranked by the latter,
 * every renamed type (the per-class vtables, the category duplicates) was missing from
 * the listing and went to the end of the list.
 */
export function reorderDataTypes(
  dataTypes: ExtractedDataType[],
  listing: readonly { name: string; category?: string; kind?: string }[],
): void {
  adoptGhidraNames(dataTypes, listing);
  const rank = new Map<string, number>();
  listing.forEach((t, i) => { const k = dataTypeKey(t.name, t.category); if (!rank.has(k)) rank.set(k, i); });
  const ordered = dataTypes
    .map((dt, i) => ({ dt, i, r: rank.get(dataTypeKey(ghidraName(dt), dt.category)) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => (a.r - b.r) || (a.i - b.i))
    .map(x => x.dt);
  dataTypes.splice(0, dataTypes.length, ...ordered);
}

/** `A * *[4]` -> the base name `A`, with pointer stars and array extents removed. */
function typeBase(dataType: string): string {
  return dataType.replace(/\[[^\]]*\]/g, '').replace(/[\s*]+$/, '').trim();
}

/**
 * Bring a type read straight from Ghidra into the form the full extraction writes into
 * the snapshot, which is the form the model holds. The extraction runs three passes
 * over the whole type list before it writes the snapshot, and each rewrites records
 * other than the one it is about:
 * - `disambiguateVtableTypes` renames `/X/vtable` to `XVtable` AND repoints the
 *   `vtable *` field of the class that owns it (`ButtonImplementation.pVtable`);
 * - `disambiguateCategoryDuplicates` renames a same-named function definition AND
 *   repoints the field of the struct that owns its category;
 * - the dedup by name merges later same-named enums' values into the first.
 * A type read on its own has none of that: `ButtonImplementation` came back with
 * `pVtable` as `vtable *`, the verifier called the model stale, and the "repair" wrote
 * the raw spelling into the model (v1864, regen 38d807de0).
 *
 * So the passes are run again, by the same code, over the model's list taken back to
 * Ghidra's names (a renamed record and the fields that name it are spelled as Ghidra
 * spells them), with `fresh` in its slot. `mergedEnums` are the later same-named enums
 * the dedup folds into an enum, already read. Copies only; `context` is not written.
 */
export function canonicalDataType(
  fresh: ExtractedDataType,
  context: readonly ExtractedDataType[],
  previous: ExtractedDataType | undefined,
  mergedEnums: readonly ExtractedDataType[] = [],
): ExtractedDataType {
  const toGhidra = new Map<string, string>();
  for (const dt of context) if (dt.sourceName) toGhidra.set(typeBase(dt.name), typeBase(dt.sourceName));
  const revert = (dataType: string | undefined): string | undefined => {
    if (!dataType) return dataType;
    const base = typeBase(dataType);
    const raw = toGhidra.get(base);
    return raw && dataType.startsWith(base) ? `${raw}${dataType.slice(base.length)}` : dataType;
  };
  const asGhidra = (dt: ExtractedDataType): ExtractedDataType => {
    const copy = { ...dt, name: ghidraName(dt) } as ExtractedDataType & { fields?: Array<{ dataType?: string }> };
    delete copy.sourceName;
    if (copy.fields) copy.fields = copy.fields.map(f => ({ ...f, dataType: revert(f.dataType) }));
    return copy;
  };

  const own = structuredClone(fresh);
  delete own.sourceName;
  const list: ExtractedDataType[] = [];
  let placed = false;
  for (const dt of context) {
    if (previous && dt === previous) { list.push(own); placed = true; continue; }
    // The same type under its Ghidra key (a reader that holds no `previous`).
    if (dataTypeKey(ghidraName(dt), dt.category) === dataTypeKey(own.name, own.category)) {
      if (!placed) { list.push(own); placed = true; }
      continue;
    }
    list.push(asGhidra(dt));
  }
  if (!placed) list.push(own);

  disambiguateVtableTypes(list);
  disambiguateCategoryDuplicates(list);
  if (own.kind === 'ENUM' && mergedEnums.length > 0) {
    dedupeDataTypesByName([own, ...mergedEnums.map(e => ({ ...structuredClone(e), name: own.name }))]);
  }
  return own;
}

/** Shifted-pointer facts by `name\u0000category`, as the extraction attaches them. */
export type ShiftedFacts = () => Promise<Map<string, ShiftedPointerFact>>;

/**
 * The extraction attaches `shifted` to pointer typedefs from one whole-program script
 * (extract/shifted-pointers.ts); `get_data_type` does not report it. One read per batch of
 * re-reads. A failed read throws: a typedef read without it would compare as changed and
 * be "repaired" into a plain pointer (v1864, PD2KeyBindSlot and six more, regen 42e768c21).
 */
export function shiftedFactsReader(client: GhidraConnection): ShiftedFacts {
  let read: Promise<Map<string, ShiftedPointerFact>> | undefined;
  return () => (read ??= (async () => {
    const r = await client.sendCommand<{ success?: boolean; output?: string; error?: string }>(
      'execute_script', { language: 'java', code: SHIFTED_POINTER_SCRIPT, scriptTimeout: 300, _commandTimeout: 360000 },
    );
    if (r.success === false || typeof r.output !== 'string') throw new Error(`shifted pointers not read: ${r.error ?? 'no output'}`);
    return parseShiftedPointers(r.output);
  })());
}

/**
 * Re-read one type the way a full extraction reads it. The extraction takes members
 * from `get_data_type` only for the kinds that have them (DETAIL_KINDS); a pointer or
 * an array keeps its listing entry, whose kind `get_data_type` does not report (read
 * from there it came back BUILT_IN). The record then goes through the extraction's
 * whole-list passes (canonicalDataType) against `context`, the model's type list, so it
 * compares with and replaces the model's record in the same form: a record a pass
 * renamed keeps the name the pass gave it while Ghidra's name for it is unchanged, and
 * the fields and enum values the passes rewrote are rewritten the same way. A pointer
 * typedef gets its `shifted` fact from the whole-program script, as in the extraction.
 */
export async function rereadDataType(
  client: GhidraConnection,
  name: string,
  category: string | undefined,
  previous: ExtractedDataType | undefined,
  listing: () => Promise<readonly ExtractedDataType[] | null>,
  context: readonly ExtractedDataType[],
  shifted: ShiftedFacts,
): Promise<ExtractedDataType> {
  let fresh = await extractDataType(client, name, category);
  // Attached before the renames, under Ghidra's names, as the extraction does.
  if (fresh.kind === 'TYPEDEF') applyShiftedPointers(await shifted(), [fresh]);
  if (!DETAIL_KINDS.has(fresh.kind)) {
    const entries = await listing();
    const key = dataTypeKey(fresh.name, fresh.category);
    const entry = entries?.find(t => dataTypeKey(t.name, t.category) === key);
    if (entry) fresh = { ...entry };
  }
  // The dedup keeps the first enum of a name and merges the values of the later ones
  // (in listing order, the exclude filter applied first). The model holds only the
  // first, so the later ones are read here.
  const mergedEnums: ExtractedDataType[] = [];
  if (fresh.kind === 'ENUM') {
    const entries = await listing();
    if (!entries) throw new Error(`no type listing to find the enums merged into ${fresh.name}`);
    const live = entries.filter(t => !isExcludedDataType(t, EXCLUDE_PATTERNS));
    const at = live.findIndex(t => dataTypeKey(t.name, t.category) === dataTypeKey(fresh.name, fresh.category));
    for (const t of live.slice(at + 1)) {
      if (t.name !== fresh.name || t.kind !== 'ENUM') continue;
      mergedEnums.push(await extractDataType(client, t.name, t.category));
    }
  }
  fresh = canonicalDataType(fresh, context, previous, mergedEnums);
  if (previous?.sourceName && !fresh.sourceName && fresh.name === previous.sourceName && fresh.category === previous.category) {
    fresh.sourceName = previous.sourceName;
    fresh.name = previous.name;
  }
  return fresh;
}

/** Names per global listing call: one regex alternation, well under any length limit. */
const GLOBAL_LIST_CHUNK = 200;

type ExtractedGlobalRow = Awaited<ReturnType<typeof extractGlobals>>['globals'][number];

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

/**
 * The label names at each address as the symbol table holds them now, and the plate
 * comment there (the full extraction joins plate comments onto globals by address).
 */
async function labelsAt(client: GhidraConnection, addrs: readonly string[]): Promise<Map<string, { names: string[]; comment?: string }>> {
  const out = await javaScript(client, `
String[] addrs = new String[] { ${addrs.map(a => JSON.stringify(a)).join(', ')} };
ghidra.program.model.symbol.SymbolTable st = currentProgram.getSymbolTable();
StringBuilder sb = new StringBuilder();
for (String a : addrs) {
  ghidra.program.model.address.Address ad = currentProgram.getAddressFactory().getAddress(a);
  if (ad == null) continue;
  for (ghidra.program.model.symbol.Symbol s : st.getSymbols(ad)) {
    if (s.getSymbolType() != ghidra.program.model.symbol.SymbolType.LABEL) continue;
    sb.append("L\\t").append(a).append('\\t').append(s.getName()).append('\\n');
  }
  String c = currentProgram.getListing().getComment(ghidra.program.model.listing.CodeUnit.PLATE_COMMENT, ad);
  if (c != null) sb.append("C\\t").append(a).append('\\t').append(c.replace("\\\\", "\\\\\\\\").replace("\\n", "\\\\n").replace("\\r", "\\\\r").replace("\\t", "\\\\t")).append('\\n');
}
println(sb.toString());
`);
  const map = new Map<string, { names: string[]; comment?: string }>(addrs.map(a => [a, { names: [] }]));
  for (const line of out.split('\n')) {
    const [kind, a, value] = line.replace(/\r$/, '').split('\t');
    if (!kind || !a || value === undefined) continue;
    const entry = map.get(addressKey(a));
    if (!entry) continue;
    if (kind === 'L' && value) entry.names.push(value);
    if (kind === 'C') entry.comment = value.replace(/\\(\\|n|r|t)/g, (_, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : '\\'));
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

/** A function's namespace-qualified name, as Ghidra lists referencing functions. */
function qualifiedName(fn: ExtractedFunction): string {
  return fn.namespace ? `${fn.namespace}::${fn.name}` : fn.name;
}

/** The data addresses a function's instructions reference, from its operand references. */
function refTargets(fn: ExtractedFunction): Set<string> {
  const out = new Set<string>();
  for (const r of fn.operandRefs?.refs ?? []) if (r.to) out.add(addressKey(r.to));
  return out;
}

/** Does a global's initialized data hold a pointer spelled as one of these names? */
function initializedDataNames(g: AnalyzedDataSymbol, names: ReadonlySet<string>): boolean {
  const walk = (v: unknown): boolean => {
    if (typeof v === 'string') return names.has(v);
    if (Array.isArray(v)) return v.some(walk);
    if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).some(walk);
    return false;
  };
  return walk((g as { initializedData?: unknown }).initializedData);
}

/**
 * Does a global's initialized data spell one of these names as an identifier anywhere in
 * a value (`name`, `name+0x4`, `NS::name`)? An over-match costs one re-read, a miss a
 * stale table, so any token naming it counts.
 */
export function initializedDataSpells(g: AnalyzedDataSymbol, names: ReadonlySet<string>): boolean {
  const walk = (v: unknown): boolean => {
    if (typeof v === 'string') {
      for (const token of v.match(/[A-Za-z_$][\w$]*(?:::[A-Za-z_$][\w$]*)*/g) ?? []) {
        if (names.has(token) || names.has(token.includes('::') ? token.slice(token.lastIndexOf('::') + 2) : token)) return true;
      }
      return false;
    }
    if (Array.isArray(v)) return v.some(walk);
    if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).some(walk);
    return false;
  };
  return walk((g as { initializedData?: unknown }).initializedData);
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

interface MemberRecord { name?: string; dataType?: string; offset?: number; size?: number; value?: number | string }

function membersOf(dt: ExtractedDataType | undefined): MemberRecord[] {
  const r = dt as (ExtractedDataType & { fields?: MemberRecord[]; values?: MemberRecord[] }) | undefined;
  return [...(r?.fields ?? []), ...(r?.values ?? [])];
}

/**
 * The member names a body could print differently after `previous` became `fresh`, and
 * whether the layout moved. A body reaches a member through a global or a pointer chain
 * without ever spelling the type's name, so the type name alone finds none of them: a
 * field retyped from `D2AllStatesDataTbl *` to `uint16_t *` (v1858) left every reader's
 * `[i].nStateId` in the model, and the emitted code no longer compiled. Covered: a member
 * added, removed, retyped, moved or resized, an enum value renumbered; a changed size or
 * any moved offset counts every member, since strides and the members after it moved.
 */
export function changedMemberTokens(
  previous: ExtractedDataType,
  fresh: ExtractedDataType,
): { tokens: string[]; layoutChanged: boolean } {
  const key = (m: MemberRecord): string =>
    `${m.dataType ?? ''}\u0000${m.offset ?? ''}\u0000${m.size ?? ''}\u0000${m.value ?? ''}`;
  const before = new Map(membersOf(previous).filter(m => m.name).map(m => [m.name!, m]));
  const after = new Map(membersOf(fresh).filter(m => m.name).map(m => [m.name!, m]));
  const tokens = new Set<string>();
  // The layout is the slots, whatever they are called: a rename in place moves nothing.
  const slots = (dt: ExtractedDataType): string =>
    membersOf(dt).filter(m => m.offset !== undefined).map(m => `${m.offset}:${m.size ?? ''}`).sort().join(',');
  const layoutChanged = previous.size !== fresh.size || slots(previous) !== slots(fresh);
  for (const [name, m] of before) {
    const n = after.get(name);
    if (!n || key(n) !== key(m)) tokens.add(name);
  }
  for (const name of after.keys()) if (!before.has(name)) tokens.add(name);
  if (layoutChanged) for (const name of [...before.keys(), ...after.keys()]) tokens.add(name);
  return { tokens: [...tokens], layoutChanged };
}

/** Types that hold one of `names` by value (not through a pointer), to a fixpoint. */
export function byValueEmbedders(dataTypes: readonly ExtractedDataType[], names: ReadonlySet<string>): number[] {
  const reached = new Set(names);
  const slots = new Set<number>();
  for (let grew = true; grew;) {
    grew = false;
    dataTypes.forEach((dt, i) => {
      if (slots.has(i) || reached.has(dt.name)) return;
      const fields = (dt as ExtractedDataType & { fields?: MemberRecord[] }).fields ?? [];
      if (fields.some(f => f.dataType && !f.dataType.includes('*') && reached.has(baseTypeName(f.dataType)))) {
        slots.add(i);
        reached.add(dt.name);
        grew = true;
      }
    });
  }
  return [...slots].sort((a, b) => a - b);
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

/** What `readGlobalRecords` read for a set of addresses. */
export interface GlobalRead {
  /** The labels Ghidra has at each address now, and the plate comment there. */
  labels: Map<string, { names: string[]; comment?: string }>;
  /**
   * `address\tname` -> the record a reconcile stores for that label, or null when the
   * full pass keeps no record for it (no data there, or a string it leaves out). A label
   * that could not be read is absent: a reconcile keeps its previous record.
   */
  records: Map<string, AnalyzedDataSymbol | null>;
  /** The initialized-data read failed: the records carry none. */
  initializedDataFailed: boolean;
}

/**
 * The read half of a global reconcile, with no model write: the labels at these
 * addresses, each listed row rebuilt as the full pass builds one (analyzeDataSymbol, the
 * plate comment at the address, initialized data), and the flags other whole-program
 * steps set (primary, import slot) carried from the model's record of the same label.
 * Null when the labels themselves could not be read. The reconcile in applyEvents and
 * the model verifier (verifier.ts) both read through here.
 */
export async function readGlobalRecords(
  model: LiveModel,
  client: GhidraConnection,
  globalAddrs: readonly string[],
  log: LiveLog,
): Promise<GlobalRead | null> {
  let labels: Map<string, { names: string[]; comment?: string }>;
  try {
    labels = await labelsAt(client, globalAddrs);
  } catch (e) {
    log(`globals: labels at ${globalAddrs.length} address(es) unavailable (${(e as Error).message}); keeping previous records`);
    return null;
  }
  // Every listed row the addresses need, in a few listing calls rather than one per
  // name: each call walks the whole symbol table, and a names round re-reads hundreds.
  const rows = new Map<string, ExtractedGlobalRow>();
  const unreadable = new Set<string>();
  const wanted = [...new Set(globalAddrs.flatMap(a => labels.get(a)?.names ?? []))];
  for (let i = 0; i < wanted.length; i += GLOBAL_LIST_CHUNK) {
    const chunk = wanted.slice(i, i + GLOBAL_LIST_CHUNK);
    try {
      const page = await extractGlobals(client, { regex: `^(?:${chunk.map(escapeRegex).join('|')})$`, limit: 100000 });
      for (const row of page.globals) rows.set(`${addressKey(row.address)}\t${row.name}`, row);
    } catch (e) {
      log(`globals: listing ${chunk.length} name(s) failed (${(e as Error).message}); keeping their previous records`);
      for (const n of chunk) unreadable.add(n);
    }
  }
  const records = new Map<string, AnalyzedDataSymbol | null>();
  const fresh: AnalyzedDataSymbol[] = [];
  for (const addr of globalAddrs) {
    const here = labels.get(addr) ?? { names: [] };
    for (const name of here.names) {
      if (unreadable.has(name)) continue;
      const key = `${addr}\t${name}`;
      try {
        const row = rows.get(key);
        const analyzed = row ? analyzeDataSymbol(row) : null;
        if (!analyzed) { records.set(key, null); continue; }
        const record: AnalyzedDataSymbol = analyzed;
        if (here.comment) record.comment = here.comment;
        const existing = model.primary.globals.find(g => !g.platform && g.name === name && addressKey(g.address) === addr);
        if (existing) {
          const keep = existing as AnalyzedDataSymbol & { primary?: boolean; importSlot?: unknown };
          const out = record as AnalyzedDataSymbol & { primary?: boolean; importSlot?: unknown };
          if (keep.primary !== undefined) out.primary = keep.primary;
          if (keep.importSlot !== undefined) out.importSlot = keep.importSlot;
        }
        records.set(key, record);
        fresh.push(record);
      } catch (e) {
        log(`global ${name}: re-extract failed (${(e as Error).message}); keeping previous`);
      }
    }
  }
  let initializedDataFailed = false;
  if (fresh.length > 0) {
    try {
      await fetchInitializedData(client, fresh);
    } catch (e) {
      initializedDataFailed = true;
      log(`globals: initialized data for ${fresh.length} record(s) failed (${(e as Error).message})`);
    }
  }
  return { labels, records, initializedDataFailed };
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
  const readersByName = readerNameIndex(model.primary.functions);
  let dataRefs: DataRefIndex | null = null;
  /** The functions whose instructions reference [start, start + extent): built once, on first use. */
  const markReadersOfRange = (addr: string, extent: number) => {
    dataRefs ??= dataRefIndex(model.primary.functions);
    for (const fn of dataRefs.readers(addr, extent)) affected.add(fn);
  };

  /** Functions that need a fresh body, by address key. */
  const affected = new Set<string>();

  // ---------------------------------------------------------------------------
  // Datatypes first: the field-name diff is what says which bodies moved, and it
  // only exists while both the old and the new record are in hand.
  // ---------------------------------------------------------------------------
  const typeTokens = new Set<string>();
  /** The type listing, read at most once per batch; null when it could not be read. */
  let listingRead: Promise<ExtractedDataType[] | null> | undefined;
  const shiftedFacts = shiftedFactsReader(client);
  const typeListing = () => (listingRead ??= extractDataTypes(client, { limit: 10000 }).catch((e: Error) => {
    log(`type listing failed (${e.message})`);
    return null;
  }));
  /** Types whose size or member offsets moved: what embeds them by value moved too. */
  const layoutMoved = new Set<string>();
  // Types whose members changed in any way: a global of one holds an initializer
  // printed member by member, which only a re-read of the global renews.
  const membersMoved = new Set<string>();
  /** A type was renamed or added: its place in the type list moved. */
  let typeOrderMoved = false;
  /** Old names of renamed types: other records still spell them. */
  const renamedFrom = new Set<string>();
  const renamedTo = new Map<string, string>();
  // A model seeded before the passes recorded sourceName learns its Ghidra names once,
  // before any event is resolved against them: unresolved, a change to a renamed type
  // reads as a new one and lands beside the stale record.
  if (events.some(e => e.target === 'datatype') && !ghidraNamesAdopted.has(model.primary.dataTypes)) {
    const listing = await typeListing();
    if (listing) {
      const n = adoptGhidraNames(model.primary.dataTypes, listing);
      if (n > 0) log(`type names: ${n} record(s) matched to the name Ghidra lists them under`);
      ghidraNamesAdopted.add(model.primary.dataTypes);
    }
  }

  for (const event of events) {
    if (event.target !== 'datatype') continue;
    // Names no type: the list's order went stale (the verifier found it), so put it back.
    if (event.kind === TYPE_ORDER_EVENT) { typeOrderMoved = true; continue; }

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
        const target = eventDataTypeTarget(event, { name: ghidraName(previous), category: previous.category });
        fresh = await rereadDataType(client, target.name, target.category, previous, typeListing, model.primary.dataTypes, shiftedFacts);
      } catch (e) {
        log(`datatype ${previous.name}: re-extract failed (${(e as Error).message}); keeping previous`);
        continue;
      }

      model.primary.dataTypes[slot] = fresh;
      indices.dtByKey.delete(key);
      indices.dtByKey.set(dataTypeKey(fresh.name, fresh.category), fresh);
      result.touchedDataTypes.push(dataTypeKey(fresh.name, fresh.category));

      typeTokens.add(fresh.name);
      if (ghidraName(fresh) !== ghidraName(previous) || fresh.category !== previous.category) {
        renamedFrom.add(previous.name);
        renamedTo.set(previous.name, fresh.name);
        typeOrderMoved = true;
      }
      const changed = changedMemberTokens(previous, fresh);
      for (const name of changed.tokens) typeTokens.add(name);
      if (changed.layoutChanged) layoutMoved.add(fresh.name);
      if (changed.tokens.length > 0 || changed.layoutChanged) membersMoved.add(fresh.name);
    }

    // A type Ghidra has and the model does not: nothing to diff against, and
    // nothing to invalidate beyond the type's own name.
    if (slots.length === 0 && event.kind !== 'datatype.removed') {
      const { name, category } = eventDataTypeTarget(event, splitDataTypeKey(event.key));
      try {
        const fresh = await rereadDataType(client, name, category, undefined, typeListing, model.primary.dataTypes, shiftedFacts);
        // Appended for now; the listing puts it in place below.
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

  // A type embedding a moved one by value moved with it, whether or not the change set
  // names it: re-read its record, and its members are printed at new offsets.
  if (layoutMoved.size > 0) {
    const touched = new Set(result.touchedDataTypes);
    for (const slot of byValueEmbedders(model.primary.dataTypes, layoutMoved)) {
      const dt = model.primary.dataTypes[slot];
      const key = dataTypeKey(dt.name, dt.category);
      typeTokens.add(dt.name);
      for (const name of memberNames(dt)) typeTokens.add(name);
      if (touched.has(key)) continue;
      try {
        const fresh = await rereadDataType(client, ghidraName(dt), dt.category, dt, typeListing, model.primary.dataTypes, shiftedFacts);
        model.primary.dataTypes[slot] = fresh;
        indices.dtByKey.delete(key);
        indices.dtByKey.set(dataTypeKey(fresh.name, fresh.category), fresh);
        result.touchedDataTypes.push(dataTypeKey(fresh.name, fresh.category));
        for (const name of memberNames(fresh)) typeTokens.add(name);
      } catch (e) {
        log(`datatype ${dt.name}: re-extract after an embedded layout change failed (${(e as Error).message}); keeping previous`);
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
        const fresh = await rereadDataType(client, renamedTo ?? ghidraName(dt), dt.category, dt, typeListing, model.primary.dataTypes, shiftedFacts);
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

  // A global's initializer is extracted against its type's members (`initializedData`
  // names each field and spells an interior pointer by the member it lands on), so a
  // member change leaves it describing the old layout: v1895 turned D2StormListHead's
  // two link fields into one embedded StormLinkStrc, and the eleven list heads kept
  // `.pPrevLink = &gList.pPrevLink`, a member the struct no longer has. Re-read every
  // global held by value in such a type, or in a type embedding one by value.
  if (membersMoved.size > 0) {
    const holders = new Set(membersMoved);
    for (const slot of byValueEmbedders(model.primary.dataTypes, membersMoved)) holders.add(model.primary.dataTypes[slot].name);
    for (const g of model.primary.globals) {
      if (g.platform || !g.dataType || g.dataType.includes('*') || !holders.has(baseTypeName(g.dataType))) continue;
      if (globalEvents.some(e => addressKey(e.key) === addressKey(g.address))) continue;
      globalEvents.push({ seq: 0, kind: 'data.changed', target: 'global', key: g.address, at: '' } as ChangeEvent);
    }
  }

  // The type list's order is a whole-program input: the emitter lays types out in it.
  // The full extraction takes it from Ghidra's listing, which is name-ordered, so a
  // renamed or added type sits where the listing puts it - not in its old slot, and not
  // at the end. Ask the listing rather than re-implement its comparator.
  if (typeOrderMoved) {
    const listing = await typeListing();
    if (listing) reorderDataTypes(model.primary.dataTypes, listing);
    else log('type order: no listing; renamed or added types keep their slots');
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
  /**
   * Reconcile the globals at these addresses with the symbol table: a label gone takes
   * its record with it, a new one is listed, and every listed one is rebuilt from its
   * row exactly as the full pass builds one (analyzeDataSymbol, the plate comment at
   * the address, initialized data) - nothing derived is carried over, because what it
   * was derived from (the functions that reference it, their names) may have moved.
   * Only the flags other whole-program steps set (primary, import slot) are kept.
   * markUsers: also send the functions that reference them to be decompiled again.
   */
  const goneGlobalNames = new Set<string>();
  const reconcileGlobals = async (globalAddrs: readonly string[], markUsers: boolean): Promise<void> => {
    if (globalAddrs.length === 0) return;
    const read = await readGlobalRecords(model, client, globalAddrs, log);
    if (!read) return;
    let added = false;
    for (const addr of globalAddrs) {
      const names = read.labels.get(addr)?.names ?? [];
      const inModel = model.primary.globals.filter(g => !g.platform && addressKey(g.address) === addr);
      if (markUsers) {
        // Every function whose code references the data, by address, before and after:
        // the decompiler prints a reader from the data's label, type and contents, so any
        // change there moves the reader's text - also for data the model keeps no record
        // of (a string), where there is no referencing-functions list to go by.
        let extent = 1;
        for (const g of inModel) extent = Math.max(extent, g.size ?? 1);
        for (const name of names) extent = Math.max(extent, read.records.get(`${addr}\t${name}`)?.size ?? 1);
        markReadersOfRange(addr, extent);
      }
      for (const gone of inModel.filter(g => !names.includes(g.name))) {
        goneGlobalNames.add(gone.name);
        const ns = (gone as { namespace?: string }).namespace;
        if (ns) goneGlobalNames.add(`${ns}::${gone.name}`);
        if (markUsers) markReferencingFunctions(gone, readersByName, affected);
        model.primary.globals.splice(model.primary.globals.indexOf(gone), 1);
        result.touchedGlobals.push(addr);
        log(`global ${gone.name}: no longer at ${gone.address}; removed`);
      }
      for (const name of names) {
        const key = `${addr}\t${name}`;
        if (!read.records.has(key)) continue;   // unreadable: the previous record stands
        const record = read.records.get(key)!;
        const existing = inModel.find(g => g.name === name);
        if (!record) {
          // Not listed (no data there) or a string the full pass leaves out.
          if (existing) {
            model.primary.globals.splice(model.primary.globals.indexOf(existing), 1);
            result.touchedGlobals.push(addr);
          }
          continue;
        }
        if (existing) {
          model.primary.globals[model.primary.globals.indexOf(existing)] = record;
        } else {
          model.primary.globals.push(record);
          added = true;
          log(`global ${name}: new at ${record.address}`);
        }
        result.touchedGlobals.push(addr);
        if (markUsers) markReferencingFunctions(record, readersByName, affected);
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
  };
  await reconcileGlobals(globalAddrs, true);

  // A global renamed or removed is also spelled in the initialized data of the tables
  // that point at it: the extraction writes a pointer element as its target's label. Those
  // tables are read again, as the full extraction would read them, or a renamed array's
  // table keeps naming the old label (gaUnitSoundTableByClassId at v1870).
  if (goneGlobalNames.size > 0) {
    const reconciled = new Set(globalAddrs);
    const tables = new Set<string>();
    for (const g of model.primary.globals) {
      if (g.platform) continue;
      const addr = addressKey(g.address);
      if (!reconciled.has(addr) && initializedDataSpells(g, goneGlobalNames)) tables.add(addr);
    }
    if (tables.size > 0) {
      log(`renamed or removed globals: ${goneGlobalNames.size}; ${tables.size} table(s) point at an old name`);
      await reconcileGlobals([...tables], false);
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
  // the touched list keeps the order of the input so what follows is deterministic.
  const refreshAll = async (addrs: readonly string[]): Promise<string[]> => {
    const replaced = new Array<boolean>(addrs.length).fill(false);
    let next = 0;
    const lanes = Math.max(1, Math.min(REFRESH_CONCURRENCY, addrs.length));
    await Promise.all(Array.from({ length: lanes }, async () => {
      for (let i = next++; i < addrs.length; i = next++) {
        replaced[i] = await refreshFunction(model, indices, client, addrs[i], {
          // The record too, not only the body: a caller's locals carry the decompiler's
          // resolved types, and those move with a callee's signature. A full extraction
          // reads every record fresh, so a carried-over one would disagree with it.
          reextractInfo: true,
          timeout,
          log,
        });
      }
    }));
    const done = addrs.filter((_, i) => replaced[i]);
    if (done.length > 0) {
      recomputeCallEdges(model, indices, done);
      reindexCallers(model, indices);
      await refreshOperandRefs(model, client, done, log);
      await refreshFunctionFacts(model, indices, client, done, log);
    }
    return done;
  };

  // What each function was before: its name, and the data it referenced.
  const before = new Map<string, { name: string; qualified: string; targets: Set<string> }>();
  const remember = (addr: string) => {
    const fn = indices.fnByAddr.get(addr);
    if (fn && !before.has(addr)) before.set(addr, { name: fn.name, qualified: qualifiedName(fn), targets: refTargets(fn) });
  };
  const order = [...affected];
  for (const addr of order) remember(addr);
  result.touchedFunctions.push(...await refreshAll(order));

  // A renamed function is spelled in more places than its call sites: a body that takes
  // its address or passes it along, the globals that list it among their referencing
  // functions, and the tables whose initialized data point at it. A function whose data
  // references moved changes those globals' lists too. All of them are read again, as
  // the full extraction reads everything.
  const renamed: { name: string; qualified: string }[] = [];
  const globalsToRead = new Set<string>();
  for (const addr of result.touchedFunctions) {
    const was = before.get(addr);
    const fn = indices.fnByAddr.get(addr);
    if (!was || !fn) continue;
    const now = refTargets(fn);
    if (fn.name !== was.name) {
      renamed.push({ name: was.name, qualified: was.qualified });
      for (const t of was.targets) globalsToRead.add(t);
      for (const t of now) globalsToRead.add(t);
    } else {
      for (const t of was.targets) if (!now.has(t)) globalsToRead.add(t);
      for (const t of now) if (!was.targets.has(t)) globalsToRead.add(t);
    }
  }
  if (renamed.length > 0) {
    const oldNames = new Set(renamed.map(r => r.name));
    const touched = new Set(result.touchedFunctions);
    const spelling: string[] = [];
    for (const [addr, tokens] of indices.bodyTokens) {
      if (touched.has(addr)) continue;
      for (const n of oldNames) if (tokens.has(n)) { spelling.push(addr); break; }
    }
    if (spelling.length > 0) {
      for (const addr of spelling) remember(addr);
      log(`renamed functions: ${renamed.length}; ${spelling.length} more bodies spell an old name`);
      result.touchedFunctions.push(...await refreshAll(spelling));
    }
    const named = new Set<string>();
    for (const r of renamed) { named.add(r.name); named.add(r.qualified); }
    for (const g of model.primary.globals) {
      if (g.platform) continue;
      if ((g.referencingFunctions ?? []).some(f => named.has(f)) || initializedDataNames(g, named)) {
        globalsToRead.add(addressKey(g.address));
      }
    }
  }
  const knownGlobals = [...globalsToRead].filter(a => indices.globalByAddr.has(a));
  if (knownGlobals.length > 0) {
    log(`globals whose referencing functions moved: ${knownGlobals.length}`);
    await reconcileGlobals(knownGlobals, false);
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

/**
 * Function address keys under every spelling a `referencingFunctions` entry can have: the
 * namespace-qualified name and the bare one. Several functions can share either (four are
 * called DrawGroundTile), so each name maps to all of them.
 */
export function readerNameIndex(functions: readonly ExtractedFunction[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  const add = (name: string, key: string) => {
    let set = index.get(name);
    if (!set) index.set(name, (set = new Set()));
    set.add(key);
  };
  for (const fn of functions) {
    if (fn.platform) continue;
    const key = addressKey(fn.address);
    add(fn.name, key);
    add(qualifiedName(fn), key);
  }
  return index;
}

/**
 * Every function that reads this global, resolved to address keys. Ghidra lists them
 * namespace-qualified; a qualified name that matches is the answer, and only a name with no
 * qualified match falls back to every function of that bare name. Taking one function per
 * bare name re-decompiled whichever DrawGroundTile came last and left the Direct3D one stale.
 */
function markReferencingFunctions(
  global: AnalyzedDataSymbol,
  byName: Map<string, Set<string>>,
  into: Set<string>,
): void {
  for (const caller of global.referencingFunctions ?? []) {
    const hits = byName.get(caller) ?? byName.get(caller.split('::').pop() ?? caller);
    for (const key of hits ?? []) into.add(key);
  }
}

/** Functions by the data addresses their instructions reference (operand references). */
export interface DataRefIndex {
  /** Address keys of the functions referencing any byte of [addr, addr + extent). */
  readers(addr: string, extent: number): Set<string>;
}

export function dataRefIndex(functions: readonly ExtractedFunction[]): DataRefIndex {
  const entries: Array<{ to: bigint; fn: string }> = [];
  for (const fn of functions) {
    if (fn.platform) continue;
    const key = addressKey(fn.address);
    for (const r of fn.operandRefs?.refs ?? []) {
      if (r.to) entries.push({ to: addressValue(r.to), fn: key });
    }
  }
  entries.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  return {
    readers(addr: string, extent: number): Set<string> {
      const start = addressValue(addr);
      const end = start + BigInt(Math.max(1, extent));
      let lo = 0;
      let hi = entries.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (entries[mid].to < start) lo = mid + 1; else hi = mid;
      }
      const out = new Set<string>();
      for (let i = lo; i < entries.length && entries[i].to < end; i++) out.add(entries[i].fn);
      return out;
    },
  };
}

/** Which slots in `dataTypes` an event key names. A bare name may hit several categories. */
function resolveDataTypeSlots(model: LiveModel, key: string): number[] {
  const { name, category } = splitDataTypeKey(key);
  const slots: number[] = [];
  for (let i = 0; i < model.primary.dataTypes.length; i++) {
    const dt = model.primary.dataTypes[i];
    if (ghidraName(dt) !== name) continue;
    if (category !== undefined && dt.category !== category) continue;
    slots.push(i);
  }
  return slots;
}

/** What `fetchFunctionRecord` read: the record a refresh would put in the model. */
export interface FetchedFunction {
  record: ExtractedFunction;
  /** The decompile failed and `record.decompiled` is the previous body, carried. */
  decompileFailed: boolean;
}

/**
 * Read one function's record and body from Ghidra as a refresh reads them, merged onto
 * the record in hand, without touching the model. Null when nothing could be fetched.
 * The refresh below and the model verifier (verifier.ts) both read through here, so the
 * verifier compares the model with exactly what a refresh would have written.
 */
export async function fetchFunctionRecord(
  client: GhidraConnection,
  existing: ExtractedFunction | undefined,
  addr: string,
  opts: { reextractInfo: boolean; timeout: number; log: LiveLog },
): Promise<FetchedFunction | null> {
  const address = existing?.address ?? addr;

  let record: ExtractedFunction | undefined = existing;
  if (opts.reextractInfo || !existing) {
    const info = await getFunctionInfo(client, address);
    if (!info) {
      opts.log(`function ${address}: no longer present in Ghidra`);
      return null;
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
  if (!record) return null;

  let decompileFailed = false;
  if (!record.isThunk && !record.isExternal) {
    try {
      record.decompiled = await decompileFunction(client, record.address, opts.timeout);
    } catch (e) {
      decompileFailed = true;
      opts.log(`function ${record.name}: decompile failed (${(e as Error).message}); keeping previous body`);
    }
  }
  return { record, decompileFailed };
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
  const fetched = await fetchFunctionRecord(client, existing, addr, opts);
  if (!fetched) return false;
  const { record } = fetched;

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
 * A failed read throws FactsRefreshError: the functions have no facts by then.
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
    if (fn) functions.push(fn);
  }
  // Their old facts are cleared by then, so carrying on would publish these functions
  // without any: the caller stops the batch instead.
  let failure = 'unknown';
  if (!(await readFunctionFacts(model, client, functions, log, m => { failure = m; }))) {
    throw new FactsRefreshError(failure);
  }
}

/**
 * The facts step of a refresh over the given records, in place: every fact cleared, then
 * read again with no cache. False when the read failed and the records carry none. Shared
 * with the model verifier, which runs it over copies.
 */
export async function readFunctionFacts(
  model: LiveModel,
  client: GhidraConnection,
  functions: readonly ExtractedFunction[],
  log: LiveLog,
  onFailure?: (message: string) => void,
): Promise<boolean> {
  for (const fn of functions) for (const key of FACT_KEYS) delete fn[key];
  if (functions.length === 0) return true;
  // As the full extraction decides it: the compare-site forms are VC8's, PE images only.
  const format = model.primary.programInfo?.format ?? '';
  const compareSites = process.env.GHIDRA_COMPARE_SITES !== '0' && /Portable Executable|\bPE\b/i.test(format);
  try {
    const stats = await extractFunctionFacts(client, [...functions], { compareSites });
    log(`facts: ${stats.extracted} of ${stats.candidates} candidate(s) re-read for ${functions.length} refreshed function(s)`);
    return true;
  } catch (e) {
    const message = (e as Error).message;
    log(`facts: re-read failed (${message}); the refreshed functions carry none`);
    onFailure?.(message);
    return false;
  }
}

/** The facts of re-decompiled functions could not be read; the batch must not be published. */
export class FactsRefreshError extends Error {
  constructor(message: string) {
    super(`facts: re-read failed: ${message}`);
    this.name = 'FactsRefreshError';
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
