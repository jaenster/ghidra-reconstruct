/**
 * Global variable / data symbol extraction from Ghidra
 *
 * This module extracts data symbols (DAT_*, data_*, etc.) from Ghidra,
 * including which functions reference them. This information is used to
 * determine if a symbol should be a true global or a static local.
 */

import { mapWindowed, envConcurrency, listingPageSize } from './pool.js';
import type { GhidraConnection, ExtractedGlobal, AnalyzedDataSymbol, DataSymbolScope, DataValue } from '../types.js';
import { isStructType } from '../codegen/platform-types.js';

/**
 * Strip namespace prefix from a qualified function name.
 * e.g. "D2Client::QUEST_Foo" → "QUEST_Foo"
 */
function stripNamespacePrefix(name: string): string {
  const idx = name.lastIndexOf('::');
  return idx >= 0 ? name.slice(idx + 2) : name;
}

/**
 * Options for global extraction
 */
export interface GlobalExtractionOptions {
  /** Filter by name pattern (supports wildcards) */
  filter?: string;

  /** Filter by namespace */
  namespace?: string;

  /** Maximum number to extract */
  limit?: number;

  /** Offset for pagination */
  offset?: number;
}

/**
 * Response from Ghidra get_global_variables command
 */
interface GhidraGlobalVariableInfo {
  name: string;
  address: string;
  dataType: string;
  size: number;
  namespace?: string;
  isInitialized: boolean;
  xrefCount: number;
  referencingFunctions?: string[];
  value?: string;
}

/**
 * Extract global variables / data symbols from Ghidra
 *
 * This uses the enhanced get_global_variables command which returns:
 * - LABEL type symbols that have data at their address
 * - List of functions that reference each symbol
 * - Data type, size, and value information
 */
export async function extractGlobals(
  connection: GhidraConnection,
  options: GlobalExtractionOptions = {}
): Promise<{
  globals: ExtractedGlobal[];
  total: number;
}> {
  const { filter, namespace, limit = 100, offset = 0 } = options;

  const params: Record<string, unknown> = {
    offset,
    limit,
    _commandTimeout: 300000, // 5 minutes — global extraction can be slow on large binaries
  };

  if (filter) params.filter = filter;

  const result = await connection.sendCommand<{
    globals: GhidraGlobalVariableInfo[];
    total: number;
  }>('list_data_symbols', params);

  // Convert to ExtractedGlobal format, filtering by namespace if needed
  const globals: ExtractedGlobal[] = [];

  for (const g of result.globals) {
    // Skip if namespace filter doesn't match
    if (namespace && g.namespace !== namespace) continue;

    globals.push({
      name: g.name,
      address: g.address,
      dataType: g.dataType,
      size: g.size,
      value: g.value,
      namespace: g.namespace,
      isInitialized: g.isInitialized,
      xrefCount: g.xrefCount,
      referencingFunctions: g.referencingFunctions || [],
    });
  }

  return {
    globals,
    total: result.total,
  };
}

/**
 * Fetch PLATE comments keyed by address.
 *
 * list_data_symbols does not return comments, so data-symbol evidence has to be
 * pulled separately and joined on address.
 */
async function extractPlateComments(
  connection: GhidraConnection
): Promise<Map<string, string>> {
  const byAddress = new Map<string, string>();
  const pageSize = listingPageSize(connection, 500);
  let offset = 0;

  // Until a SHORT page: `list_comments` reports `total` as the size of the page it
  // returned, so `offset < total` stopped after the first 500 PLATE comments, which
  // on Game.exe end at 00417040, a few pages into .text: every data symbol lost its comment.
  for (;;) {
    const result = await connection.sendCommand<{
      comments: Array<{ address: string; comment: string }>;
      total: number;
    }>('list_comments', { type: 'PLATE', limit: pageSize, offset, _commandTimeout: 300000 });

    const comments = result.comments ?? [];
    for (const c of comments) {
      if (c.address && c.comment) byAddress.set(normalizeAddress(c.address), c.comment);
    }
    if (comments.length < pageSize) break;
    offset += pageSize;
  }

  return byAddress;
}

/** Ghidra addresses come back both bare ("0043ff00") and qualified ("menu.dat.ram:0043ff00"). */
function normalizeAddress(address: string): string {
  const bare = address.includes(':') ? address.slice(address.lastIndexOf(':') + 1) : address;
  return bare.replace(/^0x/i, '').toLowerCase();
}

/**
 * Extract all global variables (handles pagination)
 */
export async function extractAllGlobals(
  connection: GhidraConnection,
  options: Omit<GlobalExtractionOptions, 'limit' | 'offset'> = {},
  onProgress?: (fetched: number, total: number) => void
): Promise<ExtractedGlobal[]> {
  const allGlobals: ExtractedGlobal[] = [];
  const pageSize = listingPageSize(connection, 500);
  let offset = 0;
  let total = 0;

  // The first page reports the total; every later page depends only on its own
  // offset, so they are fetched `GHIDRA_GLOBALS_PAGE_CONCURRENCY` deep and spliced
  // back in offset order - the order the one-at-a-time walk produced.
  const first = await extractGlobals(connection, { ...options, limit: pageSize, offset: 0 });
  allGlobals.push(...first.globals);
  total = first.total;
  offset = pageSize;
  onProgress?.(Math.min(offset, total), total);
  const offsets: number[] = [];
  for (let o = pageSize; o < total; o += pageSize) offsets.push(o);
  const pages = await mapWindowed(
    offsets,
    envConcurrency('GHIDRA_GLOBALS_PAGE_CONCURRENCY', 4),
    async o => {
      const page = await extractGlobals(connection, { ...options, limit: pageSize, offset: o });
      offset = Math.min(offset + pageSize, total);
      onProgress?.(offset, total);
      return page.globals;
    },
  );
  for (const page of pages) allGlobals.push(...page);

  // Join evidence comments on address. A failure here must not lose the globals
  // themselves — the comments are documentation, the declarations are the output.
  try {
    const comments = await extractPlateComments(connection);
    if (comments.size > 0) {
      for (const g of allGlobals) {
        const comment = comments.get(normalizeAddress(g.address));
        if (comment) g.comment = comment;
      }
    }
  } catch {
    // leave globals uncommented
  }

  // Import address table slots. Same rule: a failure leaves the field unset, which is
  // what an older snapshot looks like too.
  try {
    const slots = await extractImportSlots(connection);
    for (const g of allGlobals) {
      const slot = slots.get(normalizeAddress(g.address));
      if (slot) g.importSlot = slot;
    }
  } catch (err) {
    console.warn(`  Import slots unavailable: ${(err as Error).message}`);
  }

  // Which label is primary where an address carries several. A failure leaves the
  // flags unset; codegen then takes the decompiler's spelling as the witness.
  try {
    const primaries = await extractPrimaryLabels(connection);
    const n = markPrimaryLabels(allGlobals, primaries);
    if (n.unmatched > 0) {
      console.warn(`  Primary labels: ${n.unmatched} multi-label addresses whose primary is not among the listed globals`);
    }
  } catch (err) {
    console.warn(`  Primary labels unavailable: ${(err as Error).message}`);
  }

  return allGlobals;
}

/**
 * The primary label of every non-code address that carries two or more labels.
 * `list_data_symbols` returns each label as its own row and says nothing of which
 * one the listing shows and the decompiler prints; that is the symbol table's
 * `getPrimarySymbol`. Rows: address, name, the parent namespace's full path (empty
 * for global). Java, no imports (the body runs inside GhidraScript.run()).
 */
export const PRIMARY_LABEL_SCRIPT = `
ghidra.program.model.symbol.SymbolTable st = currentProgram.getSymbolTable();
ghidra.program.model.listing.FunctionManager fm = currentProgram.getFunctionManager();
ghidra.program.model.symbol.SymbolIterator it = st.getAllSymbols(false);
java.util.HashSet<ghidra.program.model.address.Address> seen = new java.util.HashSet<>();
StringBuilder sb = new StringBuilder();
while (it.hasNext()) {
  ghidra.program.model.symbol.Symbol s = it.next();
  if (s.getSymbolType() != ghidra.program.model.symbol.SymbolType.LABEL) continue;
  ghidra.program.model.address.Address a = s.getAddress();
  if (!a.isMemoryAddress() || !seen.add(a) || fm.getFunctionAt(a) != null) continue;
  if (st.getSymbols(a).length < 2) continue;
  ghidra.program.model.symbol.Symbol p = st.getPrimarySymbol(a);
  if (p == null) continue;
  ghidra.program.model.symbol.Namespace ns = p.getParentNamespace();
  sb.append(a).append('\t').append(p.getName()).append('\t')
    .append(ns == null || ns.isGlobal() ? "" : ns.getName(true)).append('\n');
}
println(sb.toString());
`;

export interface PrimaryLabel {
  name: string;
  namespace?: string;
}

/** Address -> its primary label, for every address with two or more labels. */
export async function extractPrimaryLabels(connection: GhidraConnection): Promise<Map<string, PrimaryLabel>> {
  const result = await connection.sendCommand<{ success?: boolean; output?: string; error?: string }>(
    'execute_script',
    { language: 'java', code: PRIMARY_LABEL_SCRIPT, scriptTimeout: 300, _commandTimeout: 360000 }
  );
  if (result.success === false || typeof result.output !== 'string') {
    throw new Error(result.error ?? 'no output');
  }
  return parsePrimaryLabels(result.output);
}

/** Parse the script's `address<TAB>name<TAB>namespace` rows. */
export function parsePrimaryLabels(output: string): Map<string, PrimaryLabel> {
  const out = new Map<string, PrimaryLabel>();
  for (const line of output.split('\n')) {
    const cols = line.replace(/\r$/, '').split('\t');
    if (cols.length < 2) continue;
    const addr = cols[0].trim();
    const name = cols[1];
    if (!addr || !name || !/^[0-9a-f:]+$/i.test(addr.replace(/^.*:/, ''))) continue;
    const namespace = cols[2] ? cols[2] : undefined;
    out.set(normalizeAddress(addr), namespace ? { name, namespace } : { name });
  }
  return out;
}

/**
 * Flag every global at a multi-label address: `primary: true` on the one the symbol
 * table names, false on the rest. An address with one global listed is left alone,
 * and so is a group the primary is not part of (it was filtered out of the listing):
 * no flag is better than a wrong one.
 */
export function markPrimaryLabels(
  globals: Array<{ name: string; address: string; namespace?: string | null; primary?: boolean }>,
  primaries: Map<string, PrimaryLabel>,
): { flagged: number; unmatched: number } {
  const byAddress = new Map<string, typeof globals>();
  for (const g of globals) {
    const key = normalizeAddress(g.address);
    if (!primaries.has(key)) continue;
    const list = byAddress.get(key);
    if (list) list.push(g); else byAddress.set(key, [g]);
  }
  let flagged = 0;
  let unmatched = 0;
  for (const [key, gs] of byAddress) {
    if (gs.length < 2) continue;
    const p = primaries.get(key)!;
    const hits = gs.filter(g => g.name === p.name && (g.namespace ?? '') === (p.namespace ?? ''));
    if (hits.length !== 1) { unmatched++; continue; }
    for (const g of gs) g.primary = g === hits[0];
    flagged++;
  }
  return { flagged, unmatched };
}

/**
 * Every pointer whose reference is external: the IAT slots. Java, no imports (the
 * script body runs inside GhidraScript.run()).
 */
const IMPORT_SLOT_SCRIPT = `
ghidra.program.model.symbol.ReferenceIterator it = currentProgram.getReferenceManager().getExternalReferences();
StringBuilder sb = new StringBuilder();
while (it.hasNext()) {
  ghidra.program.model.symbol.Reference r = it.next();
  ghidra.program.model.listing.Data d = currentProgram.getListing().getDataAt(r.getFromAddress());
  if (d == null || !d.isPointer()) continue;
  ghidra.program.model.symbol.ExternalLocation loc = ((ghidra.program.model.symbol.ExternalReference) r).getExternalLocation();
  sb.append(r.getFromAddress()).append('\\t').append(loc.getLibraryName()).append("::").append(loc.getLabel()).append('\\n');
}
println(sb.toString());
`;

/** Address -> `LIBRARY::symbol` for each import slot. */
export async function extractImportSlots(connection: GhidraConnection): Promise<Map<string, string>> {
  const result = await connection.sendCommand<{ success?: boolean; output?: string; error?: string }>(
    'execute_script',
    { language: 'java', code: IMPORT_SLOT_SCRIPT, scriptTimeout: 120, _commandTimeout: 180000 }
  );
  if (result.success === false || typeof result.output !== 'string') {
    throw new Error(result.error ?? 'no output');
  }
  return parseImportSlots(result.output);
}

/** Parse the script's `address<TAB>LIB::symbol` rows. */
export function parseImportSlots(output: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of output.split('\n')) {
    const [addr, slot] = line.split('\t').map(c => c?.trim());
    if (addr && slot && slot.includes('::')) out.set(normalizeAddress(addr), slot);
  }
  return out;
}

/**
 * Check if a Ghidra data type represents a string literal.
 * These are dead declarations — the decompiler inlines string content directly.
 */
function isStringType(dataType: string): boolean {
  const lower = dataType.toLowerCase();
  return lower === 'string' || lower === 'terminatedcstring' || lower === 'string-utf8'
    || lower.startsWith('string-');
}

/**
 * A string datum someone NAMED is a variable, not a literal.
 *
 * The decompiler inlines an auto-labelled string (`s_...`) as its text, which is why
 * string-typed symbols are dropped. A user-named one it prints by NAME:
 * `_strtok(szInput, gszChatWhisperTargetName)` (CHAT_HandleWhisperCommand), where
 * `gszChatWhisperTargetName` @00712ffc is a writable `" "` in .data that Round 9 typed
 * from its byte use. Dropped, the name was undeclared. It is kept as the `char[size]`
 * it occupies, initialised with its text, when the text fits that size with its NUL.
 */
export function namedStringAsCharArray<T extends { name: string; dataType: string; size: number; value?: string | null }>(g: T): T | null {
  if (!isStringType(g.dataType) || /^(s|u|ds|DAT|PTR|LAB)_/.test(g.name)) return null;
  if (typeof g.value !== 'string' || !(g.size > g.value.length)) return null;
  return {
    ...g,
    dataType: `char[${g.size}]`,
    initializedData: { kind: 'string', value: g.value },
  };
}

/**
 * Map Ghidra data types to C/C++ types
 */
const TYPE_MAP: Record<string, string> = {
  // A bare `undefined` data symbol is a ONE-BYTE slot of unknown type - Ghidra
  // reports every one of them with size 1. It gets the same answer `undefined1`
  // gets here and in the three other mapping tables, so the width survives.
  'undefined': 'uint8_t',
  'undefined1': 'uint8_t',
  'undefined2': 'uint16_t',
  'undefined4': 'uint32_t',
  'undefined8': 'uint64_t',
  'undefined3': 'uint8_t[3]',
  'byte': 'uint8_t',
  'word': 'uint16_t',
  'dword': 'uint32_t',
  'qword': 'uint64_t',
  'pointer': 'void*',
  'pointer32': 'void*',
  'pointer64': 'void*',
  'float': 'float',
  'double': 'double',
  'char': 'char',
  'uchar': 'unsigned char',
  'short': 'short',
  'ushort': 'unsigned short',
  'int': 'int',
  'uint': 'unsigned int',
  'long': 'long',
  'ulong': 'unsigned long',
  'longlong': 'long long',
  'ulonglong': 'unsigned long long',
  'string': 'const char*',
  'terminatedcstring': 'const char*',
  'string-utf8': 'const char*',
};

/**
 * Infer a better C type from Ghidra's type
 */
export function inferType(dataType: string): string {
  const lower = dataType.toLowerCase();
  return TYPE_MAP[lower] || dataType;
}

/**
 * Determine scope based on usage patterns
 */
function determineScope(global: ExtractedGlobal): DataSymbolScope {
  const refs = global.referencingFunctions || [];

  // If only one function references it, it's a static local
  if (refs.length === 1) {
    return 'static-local';
  }

  // All other data is global (do NOT infer 'constant' — that requires
  // checking if the data is in a read-only segment, which we don't have here.
  // An initialized value does NOT mean the variable is immutable!)
  return 'global';
}

/**
 * Infer a better name based on usage
 */
function inferName(global: ExtractedGlobal): string | undefined {
  const name = global.name;

  // Keep original Ghidra names — don't rename DAT_/data_ prefixes
  return undefined;
}

/**
 * Analyze data symbols to determine scope and suggest improvements
 *
 * This is the main entry point for data symbol analysis. It:
 * 1. Extracts all data symbols from Ghidra
 * 2. Determines scope (global, static-local, constant)
 * 3. Suggests better names and types
 */
export async function analyzeDataSymbols(
  connection: GhidraConnection,
  options: Omit<GlobalExtractionOptions, 'limit' | 'offset'> = {},
  onProgress?: (fetched: number, total: number) => void
): Promise<AnalyzedDataSymbol[]> {
  const globals = await extractAllGlobals(connection, options, onProgress);

  return globals
    .map(g => namedStringAsCharArray(g) ?? g)
    .filter(g => !isStringType(g.dataType))
    .map(global => ({
      ...global,
      scope: determineScope(global),
      suggestedName: inferName(global),
      suggestedType: inferType(global.dataType),
      ownerFunction: (global.referencingFunctions?.length === 1)
        ? stripNamespacePrefix(global.referencingFunctions[0])
        : undefined,
    }));
}

/**
 * Filter data symbols by scope
 */
export function filterByScope(
  symbols: AnalyzedDataSymbol[],
  scope: DataSymbolScope
): AnalyzedDataSymbol[] {
  return symbols.filter(s => s.scope === scope);
}

/**
 * Get data symbols used by a specific function
 */
export function getSymbolsForFunction(
  symbols: AnalyzedDataSymbol[],
  functionName: string
): AnalyzedDataSymbol[] {
  return symbols.filter(s =>
    s.referencingFunctions?.includes(functionName)
  );
}

/**
 * Get static-local symbols grouped by owner function
 */
export function getStaticLocalsByFunction(
  symbols: AnalyzedDataSymbol[]
): Map<string, AnalyzedDataSymbol[]> {
  const byFunction = new Map<string, AnalyzedDataSymbol[]>();

  for (const symbol of symbols) {
    if (symbol.scope === 'static-local' && symbol.ownerFunction) {
      const existing = byFunction.get(symbol.ownerFunction) || [];
      existing.push(symbol);
      byFunction.set(symbol.ownerFunction, existing);
    }
  }

  return byFunction;
}

/**
 * Fetch initialized data values for globals that have non-trivial data
 * (arrays, structs, tables). Calls read_data_value for each candidate.
 */
export async function fetchInitializedData(
  connection: GhidraConnection,
  globals: AnalyzedDataSymbol[],
  onProgress?: (fetched: number, total: number) => void
): Promise<void> {
  // Only fetch for initialized globals with reasonable size (skip tiny scalars, cap at 64KB).
  //
  // "Tiny" has to mean tiny SCALAR. Ghidra's own `value` covers those, but it returns
  // nothing for a composite, so a struct of four bytes or fewer fell into the gap between
  // the two: no scalar value, no fetched bytes, and the renderer turned it into `= {}`.
  // That is not a missing initializer, it is a WRONG one - real .data bytes replaced by
  // zeroes, silently, in something that still compiles and links.
  //
  // It cost a crash three subsystems away: `g_InventorySizesDefaultConfig` @0x7447b4 is a
  // 2-byte D2InventorySizesStrc holding {16, 1}, the belt grid. Emitted as {0, 0} it made
  // ReinitializeInventoryGrid allocate a ZERO-byte grid, and every belt item restored from
  // a save then wrote past it, corrupting the Fog pool that also holds the inventory's
  // update-list nodes - which is where the access violation finally surfaced.
  //
  // An ARRAY of four bytes or fewer is the same gap: Ghidra gives no scalar value for
  // `fnCmdLineOptionInit *[1]` either. gCmdLineOptionTable @0x6d5be0 holds
  // {&RegisterCmdLineLngOption} and was emitted with no initializer, so
  // LoadDataForGameAndSetupServer called NULL; gaSFileSignatureRsaExponent @0x6cf078
  // (byte[4] = 01 00 01 00, e = 65537) was emitted zero-filled. 106 such arrays at v1234.
  const candidates = globals.filter(g =>
    g.isInitialized && g.size <= 64 * 1024
      && (g.size > 4 || isStructType(g.dataType) || /\[\d+\]\s*$/.test(g.dataType ?? ''))
  );

  if (candidates.length === 0) return;

  // Independent reads, so they are kept `GHIDRA_DATA_CONCURRENCY` deep rather than
  // sent in flights of 20 that each wait for their slowest member. Each result is
  // stored on its own global, so completion order cannot change the output.
  const results = await mapWindowed(
    candidates,
    envConcurrency('GHIDRA_DATA_CONCURRENCY', DATA_CONCURRENCY),
    g => connection.sendCommand<{ value?: DataValue; error?: string }>(
      'read_data_value',
      { address: g.address }
    ).catch(() => null),
    onProgress ? (done, total) => { if (done % 20 === 0 || done === total) onProgress(done, total); } : undefined,
  );

  for (let j = 0; j < results.length; j++) {
    const result = results[j];
    if (result?.value) {
      candidates[j].initializedData = result.value;
    }
  }
}

/**
 * Default depth of the read_data_value window (GHIDRA_DATA_CONCURRENCY). Measured
 * 2026-09-23, 4,603 items: flights of 20 took 76.3s, a window of 32 took 29.4s,
 * byte-identical snapshot.
 */
export const DATA_CONCURRENCY = 32;
