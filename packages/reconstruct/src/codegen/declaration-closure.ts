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
  origin: ClosureOrigin;
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

/** Ghidra's auto-name for string data: `s_<text>_<address>`. */
const STRING_LABEL_RE = /^s_.*_[0-9a-f]{6,}$/i;

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
}

export interface ClosureResult {
  declarations: ClosureDeclaration[];
  /** Referenced, undeclared, and not sourceable — grouped by why. */
  unresolved: Map<string, string[]>;
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
  const note = (reason: string, name: string): void => {
    const list = unresolved.get(reason);
    if (list) list.push(name);
    else unresolved.set(reason, [name]);
  };

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
      declarations.push({ name, decl: `extern ${untyped} ${name};`, origin: 'ghidra-untyped-data' });
      continue;
    }

    if (STRING_LABEL_RE.test(name)) {
      // Ghidra's auto-name for string data. It never became a `globals` record,
      // but the name says what it is: bytes at that address.
      declarations.push({ name, decl: `extern char ${name}[];`, origin: 'ghidra-untyped-data' });
      continue;
    }

    note('no symbol of this name in the Ghidra data the pipeline was given', name);
  }

  return { declarations, unresolved };
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
  lines.push('// and Ghidra\'s own names for data it never typed. Declared here, never defined');
  lines.push('// here — the definition is in the binary, and its absence is a link question,');
  lines.push('// not a compile one.');
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
