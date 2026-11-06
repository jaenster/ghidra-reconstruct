/**
 * Data the compiler and the linker made, which the source never declared.
 *
 * Much of what Ghidra labels as data is not a variable of the program. VC8 put it
 * there while compiling and linking the source: the string literals it pooled
 * (/GF), the floating-point constants x87 code reads from memory, the /GS cookie,
 * RTTI for classes with virtual functions, the image header the linker calls
 * `__ImageBase`. The source spells none of these as a declaration, so the tree
 * must not either: it spells the construct that makes the compiler produce them
 * again - a literal at the use, a class with a vtable - and declares nothing.
 *
 * Each datum is classified by its bytes, its type, its section and its users,
 * never by its name alone:
 *
 *   string-literal  a terminated byte string in a read-only section, its object no
 *                   larger than the literal padded to 4 (VC8's alignment of pooled
 *                   strings), no other label inside it and not inside another datum.
 *                   Read-only, so nothing writes it; a datum the code writes cannot
 *                   sit there.
 *   float-literal   a `float`/`double` scalar in a read-only section: a constant
 *                   x87 code loads. Its readers print the value (exact-float-constant
 *                   makes it exact), so the source spelled the number.
 *   gs-cookie       the /GS security cookie. The CRT defines it and /GS reads it;
 *                   the bodies spell the lowered prologue with its constant.
 *   rtti            RTTI the compiler emits for a polymorphic class: the
 *                   complete-object-locator pointer before a vftable, and type
 *                   descriptors Ghidra left untyped.
 *   image-base      the image's DOS header: the linker's `__ImageBase`.
 *
 * A datum any compiled text names - a decompiled body, an override's replacement, a
 * hand-written source, another kept datum's initializer - stays data whatever its
 * class: the name is then how the source reached it, and only a value-preserving
 * spelling may replace it. String literals are the exception for initializers: a
 * pointer table holding a string's address is spelled with the literal, which is
 * what `{ "English", ... }` compiles to.
 *
 * The Mac build is a second witness where it pairs: Clang puts anonymous string
 * literals in `__cstring` and named arrays in `__const`/`__data`. A pair that says
 * the string was a named array keeps it.
 */

import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import type { AnalyzedDataSymbol, DataValue, ExtractedString } from '../types.js';
import { cxxStringLiteral } from './declaration-closure.js';
import { scanReferences } from './needle-index.js';
import { foreignReferencedFileLocals } from './file-local-globals.js';
import { sanitizeSymbolName } from './globals-header.js';
import type { ForeignSource } from './file-static-functions.js';

export type CompilerDataClass = 'string-literal' | 'float-literal' | 'gs-cookie' | 'rtti' | 'image-base';

export interface CompilerDataInput {
  /** Every analyzed global. Those classified get `compilerOutput` set. */
  globals: AnalyzedDataSymbol[];
  /** Ghidra's string data (strings.ndjson). */
  strings: ReadonlyArray<ExtractedString>;
  /** The program's read-only initialized data ranges, [start, end). */
  readOnlySections: ReadonlyArray<readonly [number, number]>;
  /** The program's writable initialized data ranges, [start, end). */
  writableSections?: ReadonlyArray<readonly [number, number]>;
  /** Every identifier a compiled text names: decompiles, overrides, hand-written sources. */
  namedIdentifiers: ReadonlySet<string>;
  /** Globals a hand-written source reaches (by name or address). */
  foreign: ReadonlySet<AnalyzedDataSymbol>;
  /** The image base: the linker's `__ImageBase` is the DOS header there. */
  imageBase?: number;
  /** Windows address -> the section of its Mac pair, where one pairs. */
  macSections?: ReadonlyMap<number, string>;
}

export interface CompilerDataRow {
  address: number;
  name: string;
  cls: CompilerDataClass | 'kept';
  /** Why it was classified, or why it was kept. */
  evidence: string;
  mac?: string;
}

export interface CompilerDataResult {
  /** Label (every spelling) -> the literal expression a reference becomes. */
  literalsByName: Map<string, string>;
  /** Address -> the literal expression a reference becomes. */
  literalsByAddress: Map<number, string>;
  /** Label -> the bare string literal (no cast), for the body pass. */
  literalTextByName: Map<string, string>;
  /** Label -> the symbol the linker defines in its place (`__ImageBase`). */
  renames: Map<string, string>;
  rows: CompilerDataRow[];
  counts: Record<CompilerDataClass, number>;
}

function addressOf(g: { address?: string }): number {
  const a = g.address ?? '';
  return Number.parseInt(a.slice(a.lastIndexOf(':') + 1).replace(/^0x/i, ''), 16);
}

function inRanges(a: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  return ranges.some(([lo, hi]) => a >= lo && a < hi);
}

const nameOf = (g: AnalyzedDataSymbol): string => g.suggestedName || g.name;

/** A pointer-sized cast of the literal: the type an array of char decays to. */
export function stringLiteralExpression(bytes: Uint8Array): string {
  return `(char*)${cxxStringLiteral(bytes)}`;
}

/** The bytes of a Ghidra string record, or null when the record does not hold them exactly. */
function stringBytes(value: string, length: number, encoding: string): Uint8Array | null {
  const enc = encoding.trim().toLowerCase();
  if (!['string', 'terminatedcstring', 'string-utf8', 'char'].includes(enc) && !/^char\[\d+\]$/.test(enc)) return null;
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length !== length) return null;
  // A literal holds no NUL before its end; one inside means two strings, or a table.
  if (bytes.includes(0)) return null;
  return bytes;
}

/** A char-array global's text, from its initializer, when that is exactly one terminated string. */
function globalStringBytes(g: AnalyzedDataSymbol): { bytes: Uint8Array; declared: number } | null {
  const type = (g.dataType ?? '').trim();
  const m = /^char\[(\d+)\]$/.exec(type);
  const declared = m ? Number(m[1]) : (type === 'string' || type === 'TerminatedCString' ? Number(g.size) : NaN);
  if (!Number.isSafeInteger(declared) || declared <= 0) return null;
  const dv = g.initializedData;
  let raw: number[] | null = null;
  if (dv?.kind === 'array' && dv.elements) {
    raw = [];
    for (const e of dv.elements) {
      if (e.kind !== 'scalar' || typeof e.value !== 'string') return null;
      const ch = e.value;
      if ([...ch].length !== 1) return null;
      const code = ch.codePointAt(0)!;
      if (code > 0xff) return null;
      raw.push(code);
    }
  } else if (typeof g.value === 'string') {
    const b = Buffer.from(g.value, 'utf8');
    if ([...b].some(x => x >= 0x80)) return null;
    raw = [...b, 0];
  }
  if (!raw || raw.length === 0) return null;
  const nul = raw.indexOf(0);
  if (nul < 0) return null;
  // Everything after the terminator is padding, and padding is zero.
  if (raw.slice(nul).some(x => x !== 0)) return null;
  return { bytes: Uint8Array.from(raw.slice(0, nul)), declared };
}

/** The object a literal of `length` bytes occupies in VC8's pooled .rdata: padded to 4. */
function pooledExtent(length: number): number {
  return (length + 1 + 3) & ~3;
}

/**
 * Interior check: no other label starts inside [lo, hi), and no other datum's extent
 * covers lo. A label inside a string is a pointer into it (a suffix the code reaches);
 * a string inside a datum is a slot of that datum.
 */
function buildOverlap(globals: readonly AnalyzedDataSymbol[], strings: ReadonlyArray<ExtractedString>) {
  const starts: number[] = [];
  const extents: Array<[number, number]> = [];
  for (const g of globals) {
    const a = addressOf(g);
    if (!Number.isFinite(a)) continue;
    starts.push(a);
    const size = Number(g.size);
    extents.push([a, a + (Number.isSafeInteger(size) && size > 0 ? size : 1)]);
  }
  for (const s of strings) {
    const a = addressOf(s);
    if (!Number.isFinite(a)) continue;
    starts.push(a);
    extents.push([a, a + (Number.isSafeInteger(s.length) ? s.length + 1 : 1)]);
  }
  starts.sort((x, y) => x - y);
  extents.sort((x, y) => x[0] - y[0]);
  const firstAtOrAfter = (arr: number[], v: number): number => {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const extentStarts = extents.map(e => e[0]);
  return {
    labelInside(lo: number, hi: number): boolean {
      const i = firstAtOrAfter(starts, lo + 1);
      return i < starts.length && starts[i] < hi;
    },
    insideAnother(lo: number): boolean {
      // Extents that start before lo and reach past it.
      const i = firstAtOrAfter(extentStarts, lo);
      for (let k = i - 1; k >= 0 && k >= i - 64; k--) if (extents[k][1] > lo) return true;
      return false;
    },
  };
}

/** Names an initializer of a global references (pointer elements). */
function initializerNames(dv: DataValue | undefined, out: Set<string>): void {
  if (!dv) return;
  if (dv.kind === 'pointer' && dv.value && /^[A-Za-z_]/.test(dv.value)) {
    const v = dv.value.replace(/[+[].*$/, '');
    out.add(v.slice(v.lastIndexOf('::') + 2 > 1 ? v.lastIndexOf('::') + 2 : 0));
  }
  for (const e of dv.elements ?? []) initializerNames(e, out);
  for (const f of dv.fields ?? []) initializerNames(f.value, out);
}

const GS_DEFAULT_COOKIE = 0xbb40e64e;
const GS_COOKIE_NAMES = new Set(['DEFAULT_SECURITY_COOKIE', '__security_cookie', '__security_cookie_complement']);

function isStringLabel(name: string): boolean {
  return /^s_.*_[0-9a-f]{8}$/i.test(name);
}

/** Ghidra's label for a string datum: `s_<text>_<address>`, as the bodies spell it. */
function stringLabelFor(address: number, value: string): string {
  let text = '';
  for (const ch of value) {
    if (text.length >= 33) break;
    text += /[A-Za-z0-9_]/.test(ch) ? ch : '_';
  }
  return `s_${text}_${address.toString(16).padStart(8, '0')}`;
}

export function classifyCompilerData(input: CompilerDataInput): CompilerDataResult {
  const literalsByName = new Map<string, string>();
  const literalsByAddress = new Map<number, string>();
  const literalTextByName = new Map<string, string>();
  const renames = new Map<string, string>();
  const rows: CompilerDataRow[] = [];
  const counts: Record<CompilerDataClass, number> = {
    'string-literal': 0, 'float-literal': 0, 'gs-cookie': 0, rtti: 0, 'image-base': 0,
  };
  const overlap = buildOverlap(input.globals, input.strings);
  const named = (n: string): boolean => input.namedIdentifiers.has(n) || input.namedIdentifiers.has(sanitizeSymbolName(n));

  // What kept data's initializers name. String labels are spelled as literals there,
  // so they are not counted; anything else an initializer names stays data.
  const initializerNamed = new Set<string>();
  for (const g of input.globals) initializerNames(g.initializedData, initializerNamed);

  const mac = (a: number): string | undefined => input.macSections?.get(a);
  const keep = (address: number, name: string, evidence: string): void => {
    rows.push({ address, name, cls: 'kept', evidence, mac: mac(address) });
  };
  const classify = (g: AnalyzedDataSymbol | undefined, address: number, name: string, cls: CompilerDataClass, evidence: string): void => {
    if (g) g.compilerOutput = cls;
    counts[cls]++;
    rows.push({ address, name, cls, evidence, mac: mac(address) });
  };

  /** A string at `address` with `bytes`, in an object of `extent` bytes: literal, or why not. */
  const stringVerdict = (address: number, bytes: Uint8Array, extent: number): string | null => {
    if (!inRanges(address, input.readOnlySections)) return 'not in a read-only section';
    if (extent > pooledExtent(bytes.length)) return `object of ${extent} bytes is larger than the literal padded to 4`;
    if (overlap.labelInside(address, address + bytes.length + 1)) return 'a label inside it (code reaches a suffix)';
    if (overlap.insideAnother(address)) return 'inside another datum';
    const m = mac(address);
    if (m && m !== '__cstring') return `the Mac pair is a named array (${m})`;
    return null;
  };

  // Ghidra-typed string globals.
  const literalGlobalAddresses = new Set<number>();
  const vftableAt = new Set<number>();
  for (const g of input.globals) if (g.name === 'vftable') vftableAt.add(addressOf(g));
  for (const g of input.globals) {
    const address = addressOf(g);
    if (!Number.isFinite(address)) continue;
    const name = nameOf(g);
    const text = globalStringBytes(g);
    if (text) {
      if (!inRanges(address, input.readOnlySections)) continue;
      const why = named(name) || named(g.name) ? 'named by a compiled text'
        : input.foreign.has(g) ? 'named by a hand-written source'
        : stringVerdict(address, text.bytes, text.declared);
      if (why) { keep(address, name, why); continue; }
      const literal = stringLiteralExpression(text.bytes);
      for (const n of new Set([name, g.name, sanitizeSymbolName(name), sanitizeSymbolName(g.name)])) {
        literalsByName.set(n, literal);
        literalTextByName.set(n, cxxStringLiteral(text.bytes));
      }
      literalsByAddress.set(address, literal);
      literalGlobalAddresses.add(address);
      classify(g, address, name, 'string-literal', `read-only string of ${text.bytes.length} byte(s) in ${text.declared}`);
      continue;
    }
    // The cookie and the image header are reached by name, and the name is what changes:
    // the bodies spell the cookie as its constant (the lowered /GS prologue) and the
    // header as the linker's symbol.
    if (!input.foreign.has(g) && GS_COOKIE_NAMES.has(g.name) && Number(g.size) === 4 && inRanges(address, input.writableSections ?? [])
        && Number.parseInt((g.value ?? '').trim(), (g.value ?? '').trim().startsWith('0x') ? 16 : 10) >>> 0 === GS_DEFAULT_COOKIE) {
      classify(g, address, name, 'gs-cookie', 'the /GS cookie the CRT defines, holding the VC8 default 0xbb40e64e');
      continue;
    }
    // Not asked of the hand-written sources: they reach data by RVA, and every small
    // integer in a binder reads as an address in the header's 128 bytes.
    if (input.imageBase !== undefined && address === input.imageBase
        && (/^IMAGE_DOS_HEADER\b/.test(g.dataType ?? '') || /^IMAGE_DOS_HEADER_/.test(g.name))) {
      classify(g, address, name, 'image-base', 'the DOS header at the image base: the linker\'s __ImageBase');
      for (const n of new Set([name, g.name])) renames.set(n, '__ImageBase');
      continue;
    }
    if (input.foreign.has(g) || named(name) || named(g.name) || initializerNamed.has(name)) continue;
    const type = (g.dataType ?? '').trim();
    if ((type === 'float' || type === 'double') && inRanges(address, input.readOnlySections)) {
      const value = Number.parseFloat((g.value ?? '').trim());
      const m = mac(address);
      if (!Number.isFinite(value)) { keep(address, name, `${type} with no finite value`); continue; }
      if (m && (m === '__data' || m === '__bss' || m === '__common')) { keep(address, name, `the Mac pair is a variable (${m})`); continue; }
      classify(g, address, name, 'float-literal', `read-only ${type} ${value}`);
      continue;
    }
    if (g.name === 'vftable_meta_ptr' && vftableAt.has(address + 4)) {
      classify(g, address, name, 'rtti', 'complete-object-locator pointer in the word before a vftable');
      continue;
    }
    if (/^RTTI_/.test(g.name) && inRanges(address, input.writableSections ?? [])
        && /^(undefined\d*|byte|uint8_t)?$/.test((g.dataType ?? '').trim())) {
      classify(g, address, name, 'rtti', 'type descriptor Ghidra\'s RTTI analysis labelled and left untyped');
      continue;
    }
  }

  // Ghidra's untyped string data, which the declaration closure would otherwise define
  // under its label when a reference is resolved to it.
  const claimed = new Set<number>();
  for (const s of input.strings) {
    const address = addressOf(s);
    if (!Number.isFinite(address) || claimed.has(address) || literalGlobalAddresses.has(address)) continue;
    claimed.add(address);
    if (!inRanges(address, input.readOnlySections)) continue;
    const bytes = stringBytes(s.value, s.length, s.encoding ?? '');
    if (!bytes) continue;
    const label = stringLabelFor(address, s.value);
    if (literalsByName.has(label)) continue;
    // A typed global at this address was judged above; its verdict stands.
    if (input.globals.some(g => addressOf(g) === address)) continue;
    const why = named(label) ? 'named by a compiled text' : stringVerdict(address, bytes, bytes.length + 1);
    if (why) { keep(address, label, why); continue; }
    const literal = stringLiteralExpression(bytes);
    literalsByName.set(label, literal);
    literalTextByName.set(label, cxxStringLiteral(bytes));
    literalsByAddress.set(address, literal);
    classify(undefined, address, label, 'string-literal', `read-only string of ${bytes.length} byte(s), untyped`);
  }

  rows.sort((a, b) => a.address - b.address);
  return { literalsByName, literalsByAddress, literalTextByName, renames, rows, counts };
}

/** The report, one row per datum judged. */
export function compilerDataReport(result: CompilerDataResult): string {
  const lines = ['address\tname\tclass\tevidence\tmac_section'];
  for (const r of result.rows) {
    lines.push([r.address.toString(16).padStart(8, '0'), r.name, r.cls, r.evidence, r.mac ?? ''].join('\t'));
  }
  return lines.join('\n') + '\n';
}

/** Windows address -> Mac section, from mac-win-data-pairs.tsv; rows the pairing contradicts are left out. */
export function parseMacDataPairs(tsv: string): Map<number, string> {
  const out = new Map<number, string>();
  const lines = tsv.split('\n');
  const header = (lines[0] ?? '').split('\t');
  const col = (n: string) => header.indexOf(n);
  const win = col('win_addr'), sec = col('mac_section'), verdict = col('verdict');
  if (win < 0 || sec < 0) return out;
  for (const line of lines.slice(1)) {
    const f = line.split('\t');
    if (!f[win] || !f[sec]) continue;
    if (verdict >= 0 && /CONTRADICTED/.test(f[verdict] ?? '')) continue;
    const a = Number.parseInt(f[win], 16);
    if (Number.isFinite(a)) out.set(a, f[sec]);
  }
  return out;
}

/**
 * Classify the model's data and mark what the compiler made (`compilerOutput`), from
 * the program info's sections, every compiled text and the hand-written sources.
 */
export function markCompilerData(
  globals: AnalyzedDataSymbol[],
  strings: ReadonlyArray<ExtractedString>,
  programInfo: { imageBase?: string; dataSections?: Array<[number, number]>; readOnlyDataSections?: Array<[number, number]> } | undefined,
  options: { projectConfig?: { macDataPairs?: string } },
  projectDir: string | undefined,
  texts: Iterable<string>,
  foreignSources: ReadonlyArray<ForeignSource>,
): CompilerDataResult {
  const namedIdentifiers = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const id of scanReferences(t).identifiers) namedIdentifiers.add(id);
  }
  const readOnly = programInfo?.readOnlyDataSections ?? [];
  const writable = (programInfo?.dataSections ?? []).filter(([lo]) => !readOnly.some(([r]) => r === lo));
  let macSections: Map<number, string> | undefined;
  const macPath = options.projectConfig?.macDataPairs;
  if (macPath) {
    const resolved = macPath.startsWith('~/') ? nodePath.join(os.homedir(), macPath.slice(2))
      : nodePath.resolve(projectDir ?? '.', macPath);
    if (nodeFs.existsSync(resolved)) macSections = parseMacDataPairs(nodeFs.readFileSync(resolved, 'utf-8'));
    else console.warn(`warning: macDataPairs ${resolved} does not exist; strings are judged without the Mac witness`);
  }
  const imageBase = programInfo?.imageBase ? Number.parseInt(programInfo.imageBase.replace(/^0x/i, ''), 16) : undefined;
  return classifyCompilerData({
    globals,
    strings,
    readOnlySections: readOnly,
    writableSections: writable,
    namedIdentifiers,
    foreign: foreignReferencedFileLocals(globals, foreignSources, () => true),
    imageBase: Number.isFinite(imageBase) ? imageBase : undefined,
    macSections,
  });
}
