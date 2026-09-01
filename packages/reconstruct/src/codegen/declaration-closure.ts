/**
 * Declaration closure
 *
 * The emitted tree is not wrong, it is INCOMPLETE: bodies name symbols for which
 * no declaration is ever emitted, and GCC answers "X was not declared in this
 * scope". Three gaps produce that, all of them a decision made on one side and
 * not carried to the other:
 *
 *  - a function in an excluded namespace is not emitted, but the call sites in
 *    the namespaces that ARE emitted survive;
 *  - a data symbol is dropped by one of the globals emitter's filters, but the
 *    bodies that read it are unaffected;
 *  - Ghidra's own name for untyped data (`DAT_006db8d0`, `UNK_006dff20`) reaches
 *    a body without ever having been a `globals` record at all.
 *
 * This module closes the gap the only way that is honest: it declares what the
 * bodies reference, taking the declaration from Ghidra's symbol and type data,
 * and it declares NOTHING it cannot source from there. A name it cannot source
 * is reported with its class instead of being invented into existence — several
 * of those names are separate emitter defects (an unresolved call target, a lost
 * goto label, a jump table, a decompiler-local that leaked out of its body), and
 * a declaration would hide them rather than fix them.
 */

import type { AnalyzedDataSymbol, ExtractedFunction } from '../types.js';

export type ClosureOrigin =
  /** A function Ghidra has that no emitted file defines. */
  | 'unemitted-function'
  /** A data symbol Ghidra has that no emitted file declares. */
  | 'undeclared-global'
  /** Ghidra's own name for untyped data — the address is IN the name. */
  | 'ghidra-untyped-data';

export interface ClosureDeclaration {
  /** The spelling the bodies use. */
  name: string;
  /** The line to emit. */
  decl: string;
  /**
   * The DEFINITION, when the bytes behind the declaration are known. A
   * declaration alone leaves the symbol undefined at link; only a symbol whose
   * content extraction actually recovered gets one, and the content comes from
   * Ghidra's own reading of the binary — never from the label's text, which is a
   * truncated and mangled rendering of it.
   */
  def?: string;
  origin: ClosureOrigin;
}

/**
 * Byte content for one data address, as extraction recovered it from Ghidra.
 *
 * `value` is what Ghidra decoded and `length` is how many bytes that was, both
 * WITHOUT the terminator. Carrying the length separately is what makes the
 * content checkable: a value whose encoded length disagrees with Ghidra's is a
 * value that lost bytes in transit, and a definition built from it would be the
 * wrong size.
 */
export interface ClosureStringContent {
  value: string;
  length: number;
  /** Ghidra's data type for it — `string`, `TerminatedCString`, `unicode`, … */
  encoding: string;
}

/**
 * Names that are decompiler or emitter artifacts rather than symbols. Declaring
 * one would make a defect compile, which is strictly worse than the error: the
 * error is the only thing pointing at it.
 *
 * Each entry names the defect it stands for, because that is the actionable
 * part — the closure pass reports these grouped by reason.
 */
const ARTIFACT_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /^func_0x[0-9a-f]+$/i, reason: 'unresolved call target (no function at the address)' },
  { re: /^LAB_[0-9a-f]+(_\d+)?$/i, reason: 'lost goto label' },
  { re: /^(switchD|caseD)_[0-9a-f]+(_\d+)?$/i, reason: 'jump table left in the body' },
  { re: /^switchdataD_[0-9a-f]+$/i, reason: 'jump table left in the body' },
  { re: /^param_\d+$/, reason: 'decompiler parameter leaked into a body that does not declare it' },
  { re: /^[a-z]{1,3}(Var|Stack)_?\d+$/, reason: 'decompiler local leaked out of the scope that declares it' },
  { re: /^(in|unaff|extraout)_/, reason: 'decompiler register pseudo-variable' },
  { re: /^register0x[0-9a-f]+$/i, reason: 'decompiler register pseudo-variable' },
  // `stack0xNNNNNNNN` is a raw frame OFFSET, not a symbol. `stack-frame-address`
  // binds every one the function's Ghidra frame actually owns; what survives to
  // here is an offset the frame does not model — the saved EBP at -4, the SEH
  // prologue's saved ESP, or a slot Ghidra types `undefined1` where the code
  // uses hundreds of bytes. Declaring one would turn a loud missing address into
  // a silent write past a one-byte object, so it stays a report and the fix is
  // the frame in Ghidra.
  { re: /^stack0x[0-9a-f]+$/i, reason: 'raw frame offset the function\'s Ghidra stack frame does not model' },
  { re: /^[a-z]Ram[0-9a-f]{6,}$/, reason: 'unnamed absolute-address access (decompiler varnode, not a symbol)' },
  { re: /^ram0x[0-9a-f]+$/i, reason: 'unnamed absolute-address access (decompiler varnode, not a symbol)' },
];

export function artifactReason(name: string): string | null {
  for (const { re, reason } of ARTIFACT_PATTERNS) {
    if (re.test(name)) return reason;
  }
  return null;
}

/**
 * Ghidra's own naming for data it has not typed. The prefix IS the width it
 * decided on and the suffix IS the address, so the name carries everything a
 * declaration needs — which is why these can be declared even though no
 * `globals` record was ever produced for them.
 *
 * `undefined`-family widths map through the same table the rest of the pipeline
 * uses (`undefined1` -> `uint8_t`), so a declaration here reads exactly like one
 * for a symbol Ghidra did type.
 */
const UNTYPED_DATA_PREFIXES: Array<{ re: RegExp; type: string }> = [
  { re: /^_?BYTE_[0-9a-f]{6,}$/i, type: 'uint8_t' },
  { re: /^_?WORD_[0-9a-f]{6,}$/i, type: 'uint16_t' },
  { re: /^_?DWORD_[0-9a-f]{6,}$/i, type: 'uint32_t' },
  { re: /^_?QWORD_[0-9a-f]{6,}$/i, type: 'uint64_t' },
  // DAT_/UNK_ is Ghidra's "one undefined byte here"; bodies index off its
  // address (`(&UNK_006dff20)[i]`), which only works from a scalar.
  { re: /^_?DAT_[0-9a-f]{6,}$/i, type: 'uint8_t' },
  { re: /^_?UNK_[0-9a-f]{6,}$/i, type: 'uint8_t' },
];

function untypedDataType(name: string): string | null {
  for (const { re, type } of UNTYPED_DATA_PREFIXES) {
    if (re.test(name)) return type;
  }
  return null;
}

/**
 * Ghidra's auto-name for string data: `s_<text>_<address>`.
 *
 * The `<text>` half is a TRUNCATED and MANGLED rendering of the bytes — 34
 * characters at most, with everything that is not identifier-legal replaced by
 * `_`. `s_Error_1__Diablo_II_is_unable_to_p_0072daa8` is 69 bytes of string with
 * a mangled colon and two spaces collapsed. Nothing may ever be reconstructed
 * from it. The ADDRESS half is exact, and that is what the content is keyed on.
 */
const STRING_LABEL_RE = /^s_.*_([0-9a-f]{6,})$/i;

/** Ghidra's byte-string data types. A `char[]` definition is honest for these. */
const BYTE_STRING_ENCODINGS = new Set(['string', 'terminatedcstring', 'string-utf8', 'char']);

/** Compare addresses as numbers, not as text: `0070f130` and `70f130` are one address. */
export function normalizeDataAddress(address: string): string {
  const bare = address.includes(':') ? address.slice(address.lastIndexOf(':') + 1) : address;
  return bare.replace(/^0x/i, '').toLowerCase().replace(/^0+(?=.)/, '');
}

/**
 * The address a Ghidra string label carries, or null if it carries none.
 * Greedy on the text half, so the LAST hex run is the address — a label whose
 * own text is hexadecimal (`s_deadbeef_006ebefc`) still resolves correctly.
 */
export function stringLabelAddress(name: string): string | null {
  const m = STRING_LABEL_RE.exec(name);
  return m ? normalizeDataAddress(m[1]) : null;
}

/**
 * One byte as it appears inside a C++ string literal.
 *
 * Octal, never hex: a hex escape is greedy and `"\x0a" + "1"` written as
 * `"\x0a1"` is one character 0xA1. A three-digit octal escape has a fixed width,
 * so a digit after it can never be swallowed. `?` is escaped so no run of them
 * can form a trigraph.
 */
function escapeByte(byte: number): string {
  switch (byte) {
    case 0x22: return '\\"';
    case 0x5c: return '\\\\';
    case 0x3f: return '\\?';
  }
  if (byte >= 0x20 && byte <= 0x7e) return String.fromCharCode(byte);
  return '\\' + byte.toString(8).padStart(3, '0');
}

/** The exact bytes as a C++ string literal. */
export function cxxStringLiteral(bytes: Uint8Array): string {
  let out = '"';
  for (const byte of bytes) out += escapeByte(byte);
  return out + '"';
}

/**
 * A definition for a byte string, or the reason there cannot be one.
 *
 * `char x[] = "…"` and not `const char*`: the bodies both index it and pass it
 * where a `char*` is wanted, and the array form makes the object's size the
 * string's own size rather than a pointer's. It has to agree with the `extern
 * char x[];` the declaration side emits, which is the whole point of building
 * both here.
 */
export function stringDefinition(
  name: string,
  content: ClosureStringContent
): { def: string } | { reason: string } {
  if (!BYTE_STRING_ENCODINGS.has(content.encoding.toLowerCase())) {
    return { reason: `string data Ghidra encodes as ${content.encoding}, which no char[] can hold` };
  }
  const bytes = Buffer.from(content.value, 'utf8');
  if (bytes.length !== content.length) {
    // The decoded text does not weigh what Ghidra says the datum weighs, so
    // something was lost between the binary and here. A definition built from it
    // would be the wrong size, which is worse than no definition at all.
    return {
      reason: `string content is ${bytes.length} byte(s) but Ghidra reports ${content.length} — content lost in transit`,
    };
  }
  return { def: `char ${name}[] = ${cxxStringLiteral(bytes)};` };
}

export interface ClosureInputs {
  /** Every function Ghidra gave us, INCLUDING the ones codegen excludes. */
  allFunctions: ReadonlyArray<ExtractedFunction>;
  /** Every data symbol Ghidra gave us, INCLUDING the ones the emitters filter. */
  allGlobals: ReadonlyArray<AnalyzedDataSymbol>;
  /** Identifier -> number of function bodies that reference it, project-wide. */
  referenced: ReadonlyMap<string, number>;
  /** Names a declaration IS emitted for somewhere in the tree. */
  declared: ReadonlySet<string>;
  /** Name of a function that IS emitted (so a call needs qualification, not a declaration). */
  emittedFunctionNames: ReadonlySet<string>;
  /** Render one function's prototype the way the headers do. */
  renderPrototype: (func: ExtractedFunction) => string | null;
  /** Render one data symbol's `extern` the way globals.h does. */
  renderExtern: (symbol: AnalyzedDataSymbol) => string | null;
  /** Sanitize a Ghidra name to the spelling the bodies use. */
  sanitize: (name: string) => string;
  /**
   * Byte content keyed by NORMALIZED ADDRESS (see `normalizeDataAddress`), not
   * by name. Ghidra's label text is lossy; its address is not.
   */
  stringContentByAddress?: ReadonlyMap<string, ClosureStringContent>;
}

export interface ClosureResult {
  declarations: ClosureDeclaration[];
  /** Referenced, undeclared, and not sourceable — grouped by why. */
  unresolved: Map<string, string[]>;
  /**
   * Declared here but NOT defined here, grouped by why. Every one of these is
   * an undefined symbol at link, so the group is the work list — and the reason
   * says whether the fix belongs in Ghidra or in extraction.
   */
  definitionGaps: Map<string, string[]>;
}

/**
 * Decide, for every name some body references, whether a declaration is owed and
 * where it comes from.
 */
export function computeDeclarationClosure(inputs: ClosureInputs): ClosureResult {
  const functionByName = new Map<string, ExtractedFunction>();
  for (const func of inputs.allFunctions) {
    if (!functionByName.has(func.name)) functionByName.set(func.name, func);
  }

  const globalByName = new Map<string, AnalyzedDataSymbol>();
  for (const global of inputs.allGlobals) {
    for (const spelling of [global.suggestedName, global.name]) {
      if (!spelling) continue;
      const key = inputs.sanitize(spelling);
      if (key && !globalByName.has(key)) globalByName.set(key, global);
    }
  }

  const declarations: ClosureDeclaration[] = [];
  const unresolved = new Map<string, string[]>();
  const definitionGaps = new Map<string, string[]>();
  const into = (map: Map<string, string[]>, reason: string, name: string): void => {
    const list = map.get(reason);
    if (list) list.push(name);
    else map.set(reason, [name]);
  };
  const note = (reason: string, name: string): void => into(unresolved, reason, name);
  const undefinable = (reason: string, name: string): void => into(definitionGaps, reason, name);

  for (const name of [...inputs.referenced.keys()].sort()) {
    if (inputs.declared.has(name)) continue;

    const artifact = artifactReason(name);
    if (artifact) { note(artifact, name); continue; }

    // An emitted function referenced by its bare name from another namespace is
    // DECLARED — it just is not visible unqualified. A second declaration at
    // root scope would be a different function, so this is never a closure fix.
    if (inputs.emittedFunctionNames.has(name)) {
      note('emitted function referenced without its namespace qualifier', name);
      continue;
    }

    const global = globalByName.get(name);
    if (global) {
      const decl = inputs.renderExtern(global);
      if (decl) { declarations.push({ name, decl, origin: 'undeclared-global' }); continue; }
      note('data symbol Ghidra has, but with no type a declaration can be built from', name);
      continue;
    }

    const func = functionByName.get(name);
    if (func) {
      const decl = inputs.renderPrototype(func);
      if (decl) { declarations.push({ name, decl, origin: 'unemitted-function' }); continue; }
      note('function Ghidra has, but with no signature a prototype can be built from', name);
      continue;
    }

    const untyped = untypedDataType(name);
    if (untyped) {
      // The name gives a WIDTH, which is enough to declare. It does not give an
      // EXTENT, and the bodies index off these (`(&UNK_006dff20)[i]`), so the
      // object is an array whose length only Ghidra can supply. Defining one
      // byte here would link and then read past it — a defect that compiles.
      declarations.push({ name, decl: `extern ${untyped} ${name};`, origin: 'ghidra-untyped-data' });
      undefinable(
        'untyped data with no sized symbol in Ghidra — needs a typed array at that address before a definition can be honest',
        name,
      );
      continue;
    }

    const stringAddress = stringLabelAddress(name);
    if (stringAddress !== null) {
      // Ghidra's auto-name for string data. It never became a `globals` record,
      // but the name says what it is: bytes at that address.
      const decl = `extern char ${name}[];`;
      const content = inputs.stringContentByAddress?.get(stringAddress);
      if (!content) {
        declarations.push({ name, decl, origin: 'ghidra-untyped-data' });
        undefinable('string label whose byte content the extraction did not carry', name);
        continue;
      }
      const built = stringDefinition(name, content);
      if ('reason' in built) {
        declarations.push({ name, decl, origin: 'ghidra-untyped-data' });
        undefinable(built.reason, name);
        continue;
      }
      declarations.push({ name, decl, def: built.def, origin: 'ghidra-untyped-data' });
      continue;
    }

    note('no symbol of this name in the Ghidra data the pipeline was given', name);
  }

  return { declarations, unresolved, definitionGaps };
}

/**
 * Render the definitions the closure could source, for the one translation unit
 * that owns them.
 *
 * Exactly the declarations that carry a `def`, so the DEFINITION set is a subset
 * of the DECLARATION set by construction and the two can never name different
 * objects — the failure mode `isEmittableGlobal` exists to prevent on the
 * modelled globals, applied to the closure's.
 */
export function renderClosureDefinitionBlock(
  declarations: ReadonlyArray<ClosureDeclaration>
): string[] {
  const defined = declarations.filter(d => d.def);
  if (defined.length === 0) return [];
  const lines: string[] = [];
  lines.push('// =============================================================================');
  lines.push('// Declaration closure — definitions');
  lines.push('//');
  lines.push('// The storage behind the closure declarations in globals.h whose content Ghidra');
  lines.push('// actually has. The bytes are read from the binary, never rebuilt from the');
  lines.push('// label: a Ghidra string label is a truncated, mangled rendering of its own');
  lines.push('// content and agrees with it only by accident.');
  lines.push('// =============================================================================');
  lines.push('');
  for (const d of defined) lines.push(d.def!);
  lines.push('');
  return lines;
}

/**
 * Render the closure as a block for the one header every translation unit sees.
 */
export function renderClosureBlock(declarations: ReadonlyArray<ClosureDeclaration>): string[] {
  if (declarations.length === 0) return [];
  const lines: string[] = [];
  lines.push('// =============================================================================');
  lines.push('// Declaration closure');
  lines.push('//');
  lines.push('// Symbols the emitted bodies reference that no emitted file declares: callees');
  lines.push('// in namespaces this build excludes, data symbols the globals filters dropped,');
  lines.push('// and Ghidra\'s own names for data it never typed. Where the content behind one');
  lines.push('// is known, globals.cpp defines it; where it is not, the symbol stays undefined');
  lines.push('// and its absence is a link question, not a compile one.');
  lines.push('// =============================================================================');
  lines.push('');
  const byOrigin = new Map<ClosureOrigin, ClosureDeclaration[]>();
  for (const d of declarations) {
    const list = byOrigin.get(d.origin);
    if (list) list.push(d); else byOrigin.set(d.origin, [d]);
  }
  const titles: Record<ClosureOrigin, string> = {
    'unemitted-function': 'Callees with no emitted definition',
    'undeclared-global': 'Data symbols no emitted file declares',
    'ghidra-untyped-data': 'Ghidra names for untyped data (the address is in the name)',
  };
  for (const origin of ['unemitted-function', 'undeclared-global', 'ghidra-untyped-data'] as ClosureOrigin[]) {
    const list = byOrigin.get(origin);
    if (!list || list.length === 0) continue;
    lines.push(`// ${titles[origin]}`);
    for (const d of list) lines.push(d.decl);
    lines.push('');
  }
  return lines;
}
