/**
 * Implementation file generation
 *
 * Generates .cpp files with function implementations
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type {
  ExtractedFunction,
  DetectedClass,
  ReconstructOptions,
  AnalyzedDataSymbol,
  StructField,
} from '../types.js';
import { isPlatformOrBuiltinType, isStructType, castPointerInitializer, normalizeDataValue, isCharacterValueType } from './platform-types.js';
import { crtFunctionNames } from './crt-mapping.js';
import { CPP_KEYWORDS } from './header.js';

// Import cpp-parser for code transformation
import { transformGhidraCode, preprocessGhidraCode, isGhidraGeneratedName, suggestBetterName, takeFuncPtrArgCastTypedefs, type TransformResult, type FuncPtrTarget } from '@ghidra-mcp/cpp-parser';
import { parseTemplateName, collapseConsecutiveDuplicates } from './namespace.js';
import { namespaceResolution, renderNamespace, type ResolvedNamespace } from './namespace-resolution.js';
import { cleanFunctionComment, guardedFuncDefTypedef, emittedFunctionName, returnSigType } from './header.js';
import { declarationHead } from './calling-convention.js';
import { normalizeSignatureType, collapseFuncPtrTypedef, rootQualifyShadowedType, emittedParameterName, getAggregateTypeNames } from './platform-types.js';
import { generateStaticLocalsBlock, emitDataValue, inferArrayDeclaration, isWideTextDatum, normalizeArrayDeclaration, braceArrayInitializer, isFuncDefTypedefName, getKnownFuncDefTypedefs, getKnownEnumConstants, setInitializerNamespace, renderGlobalScalarInitializer, recordDeclaredName } from './globals-header.js';

/** normalizeSignatureType + fn-ptr-typedef double-indirection collapse, for
 *  emitting function parameter and return types ("fpFoo *" → "fpFoo"). */
function sigType(type: string): string {
  return rootQualifyShadowedType(
    collapseFuncPtrTypedef(normalizeSignatureType(type), isFuncDefTypedefName)
  );
}

/**
 * Clean a parameter name: apply the same renaming the body transform does
 */
function cleanParamName(name: string): string {
  if (name === 'this') return 'pThis';
  if (!isGhidraGeneratedName(name)) return name;
  return suggestBetterName(name) ?? name;
}

/**
 * Renumber param_N / param_N_NN names sequentially to fix Ghidra's
 * mixed calling convention duplicate naming
 */
/**
 * The parameter names of the prototype Ghidra's DECOMPILER emitted, in order.
 * They are not always the names the symbol table holds: a prototype whose
 * storage was never committed decompiles with `param_1`, `param_2`, … while the
 * symbol table already carries the real names.
 *
 * Returns undefined when the prototype cannot be located or a parameter's name
 * cannot be read (a function-pointer parameter, varargs, an unnamed slot) —
 * a partial pairing would rename the wrong identifier.
 */
/**
 * The return type of the prototype Ghidra's DECOMPILER emitted.
 *
 * The emitter takes a function's return type from `Function.getReturnType()` —
 * the raw database field — but its BODY from the decompiler, which resolves its
 * own prototype through `HighFunction`. The two disagree whenever the database
 * field was never curated: the field says `undefined`, which normalises to
 * `uint8_t`, while the decompiler produced a `void` body full of bare `return;`
 * statements. The emitted function then cannot compile ("return-statement with
 * no value, in function returning 'uint8_t'").
 *
 * Returns undefined when the prototype cannot be read, so the caller keeps the
 * database's answer rather than guessing.
 */
export function decompiledReturnType(decompiled: string | undefined): string | undefined {
  if (!decompiled) return undefined;
  const open = prototypeOpenParen(decompiled);
  if (open === undefined) return undefined;

  // Everything before the `(` is a PLATE comment, then
  // `<return type> [convention] <qualified name>` — which Ghidra wraps across up
  // to three lines when it is long, so the whole head is normalised rather than
  // just its last line.
  let head = decompiled.slice(0, open);
  head = head.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  head = head.replace(/\s+/g, ' ').trim();
  // Drop the function name (the final identifier, possibly qualified).
  head = head.replace(/[A-Za-z_][\w:]*\s*$/, '').trim();
  // Drop the calling convention, which is not part of the type.
  head = head.replace(/\b__(?:fastcall|cdecl|stdcall|thiscall|clrcall|vectorcall)\b/g, '').trim();
  head = head.replace(/\s+/g, ' ').replace(/\s+\*/g, ' *').trim();
  return head === '' ? undefined : head;
}

/**
 * The (possibly qualified) name the DECOMPILER printed for this function.
 *
 * This is the spelling every call site in every other body is written with,
 * which is not necessarily the spelling the symbol table hands the emitter for
 * the declaration — the two are separate round-trips, so a rename or a namespace
 * move landing between them splits the pair. Reading it back is what lets the
 * reference be respelled as the declaration (see `function-name-reconcile`).
 *
 * Returns undefined when the prototype cannot be located.
 */
export function decompiledFunctionName(decompiled: string | undefined): string | undefined {
  if (!decompiled) return undefined;
  const open = prototypeOpenParen(decompiled);
  if (open === undefined) return undefined;
  let head = decompiled.slice(0, open);
  head = head.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  head = head.replace(/\s+/g, ' ').trim();
  const m = head.match(/([A-Za-z_][\w:]*)\s*$/);
  return m ? m[1] : undefined;
}

/** Index of the `(` that opens the decompiled prototype's parameter list. */
function prototypeOpenParen(decompiled: string): number | undefined {
  const bodyStart = decompiled.search(/\)[\s\n]*\{/);
  if (bodyStart === -1) return undefined;
  let depth = 0;
  for (let i = bodyStart; i >= 0; i--) {
    const c = decompiled[i];
    if (c === ')') depth++;
    else if (c === '(') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return undefined;
}

export function decompiledParameterNames(decompiled: string | undefined): string[] | undefined {
  if (!decompiled) return undefined;
  const open = prototypeOpenParen(decompiled);
  if (open === undefined) return undefined;
  const bodyStart = decompiled.search(/\)[\s\n]*\{/);

  const inner = decompiled.slice(open + 1, bodyStart).trim();
  if (inner === '' || inner === 'void') return [];
  if (inner.includes('(')) return undefined;  // function-pointer parameter

  const names: string[] = [];
  for (const part of inner.split(',')) {
    const m = part.trim().match(/([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?$/);
    if (!m) return undefined;
    names.push(m[1]);
  }
  return names;
}

function renumberParams(params: Array<{ name: string; dataType: string }>): Array<{ name: string; dataType: string }> {
  let counter = 1;
  return params.map(p => {
    let name = cleanParamName(p.name);
    if (/^param_\d+(_\d+)?$/.test(name)) {
      name = `param_${counter}`;
      counter++;
    }
    return { name, dataType: p.dataType };
  });
}
import type { OverrideRegistry } from '../overrides/index.js';
import type { LibraryRegistry } from '../library/index.js';
import type { MethodConversionRegistry, MethodCallMapping } from '../methods/index.js';
import { applyPatches } from '../overrides/patches.js';

// ── Parse error logging ─────────────────────────────────────────────────────

let parseErrorLogPath: string | null = null;
let parseErrorCount = 0;

/**
 * Set the file path for logging parse errors during reconstruction.
 * Errors are appended so the file accumulates across runs — truncate it
 * yourself if you want a clean slate.
 */
export function setParseErrorLogPath(path: string): void {
  parseErrorLogPath = path;
  parseErrorCount = 0;
  try {
    mkdirSync(join(path, '..'), { recursive: true });
  } catch {
    // directory already exists
  }
}

/**
 * Get the number of parse errors logged so far in this run.
 */
export function getParseErrorCount(): number {
  return parseErrorCount;
}

function logParseError(
  message: string,
  funcName: string,
  funcAddress: string,
  code?: string,
  warnings?: string[]
): void {
  parseErrorCount++;

  if (!parseErrorLogPath) return;

  const separator = '━'.repeat(80);
  const timestamp = new Date().toISOString();
  let entry = `\n${separator}\n`;
  entry += `[${timestamp}] PARSE ERROR #${parseErrorCount}\n`;
  entry += `Function : ${funcName}\n`;
  entry += `Address  : ${funcAddress}\n`;
  entry += `Error    : ${message}\n`;

  if (warnings && warnings.length > 0) {
    entry += `Warnings : ${warnings.join('; ')}\n`;
  }

  if (code) {
    // Show the full code so errors can be reproduced, but cap at 5000 chars
    // to avoid multi-MB log files from huge functions
    const truncated = code.length > 5000
      ? code.slice(0, 5000) + `\n... (truncated, ${code.length} chars total)`
      : code;
    entry += `\n--- Code (${code.length} chars) ---\n${truncated}\n--- End Code ---\n`;
  }

  try {
    appendFileSync(parseErrorLogPath, entry);
  } catch {
    // If we can't write the log, give up silently
  }
}

/**
 * Quest function prefix → correct D2QuestSpecificDataUnion member name.
 * Ghidra always picks the first union member (pA1Q1) regardless of which
 * quest the function belongs to. This map lets us rewrite to the correct one.
 */
const QUEST_PREFIX_TO_UNION_MEMBER: Record<string, string> = {
  'Q00_': 'pA1Q0', 'Q01_': 'pA1Q1', 'Q02_': 'pA1Q2', 'Q03_': 'pA1Q3',
  'Q04_': 'pA1Q4', 'Q05_': 'pA1Q5', 'Q06_': 'pA1Q6', 'Q07_': 'pA1Q7',
  'Q08_': 'pA2Q0', 'Q09_': 'pA2Q1', 'Q10_': 'pA2Q2', 'Q11_': 'pA2Q3',
  'Q12_': 'pA2Q4', 'Q13_': 'pA2Q5', 'Q14_': 'pA2Q6', 'Q15_': 'pA2Q7',
  'Q16_': 'pA2Q8', 'Q17_': 'pA3Q0', 'Q18_': 'pA3Q1', 'Q19_': 'pA3Q2',
  'Q20_': 'pA3Q3', 'Q21_': 'pA3Q4', 'Q22_': 'pA3Q5', 'Q23_': 'pA3Q6',
  'Q24_': 'pA3Q7', 'Q25_': 'pA4Q0', 'Q26_': 'pA4Q1', 'Q27_': 'pA4Q2',
  'Q28_': 'pA4Q3', 'Q30_': 'pA4Q4', 'Q31_': 'pA5Q1', 'Q32_': 'pA5Q2',
  'Q33_': 'pA5Q3', 'Q34_': 'pA5Q4', 'Q35_': 'pA5Q5', 'Q36_': 'pA5Q6',
  // Q40_ omitted: Quest40 is cross-quest utility code accessing multiple quest structs
};

/**
 * Declaration-time struct field renames: Ghidra field name → emitted C++ member
 * name. header.ts renames a field whose name is a C++ keyword (`int` → `int_`),
 * so every reference to it has to use the same spelling. The map is built from
 * the same struct model the declarations come from and from the same keyword
 * set, then applied on MemberExpr nodes by the `reserved-field-rename` pass.
 */
const structFieldRenames = new Map<string, string>();

export function setStructFieldRenames(
  structs: Iterable<{ fields?: StructField[] }>,
): void {
  structFieldRenames.clear();
  for (const dt of structs) {
    for (const f of dt.fields ?? []) {
      const raw = (f.name ?? '').replace(/\[\d+\](?:\[\d+\])*$/, '');
      if (!raw || !CPP_KEYWORDS.has(raw)) continue;
      structFieldRenames.set(raw, `${raw}_`);
    }
  }
}

/** The declaration-time field renames, as the plugin option shape. */
export function getStructFieldRenames(): Record<string, string> {
  return Object.fromEntries(structFieldRenames);
}

/**
 * Per-quest struct field layout: offset↔name maps for each D2QuestDataA#Q#Strc,
 * keyed by the quest tag (e.g. "A5Q5"). Populated from the extracted structs so
 * the union-member rewrite can remap a field by its BYTE OFFSET when it switches
 * union members (Ghidra emits the field name of the arbitrary member it picked).
 */
interface QuestStructLayout {
  byOffset: Map<number, string>;
  byName: Map<string, number>;
}
const questStructLayouts = new Map<string, QuestStructLayout>();

export function setQuestStructLayouts(
  structs: Iterable<{ name: string; fields: StructField[] }>,
): void {
  questStructLayouts.clear();
  for (const dt of structs) {
    const m = dt.name.match(/^D2QuestData(A[1-5]Q\d+)Strc$/);
    if (!m) continue;
    const byOffset = new Map<number, string>();
    const byName = new Map<string, number>();
    for (const f of dt.fields ?? []) {
      byOffset.set(f.offset, f.name);
      byName.set(f.name, f.offset);
    }
    questStructLayouts.set(m[1], { byOffset, byName });
  }
}

/** Resolve the byte offset a quest-struct field name refers to: `field_0xNN`
 *  encodes the offset directly; a named field is looked up in its own struct's
 *  layout. Returns undefined when unknown (caller leaves the access untouched). */
function questFieldOffset(srcTag: string, field: string): number | undefined {
  const fm = field.match(/^field_0x([0-9A-Fa-f]+)$/);
  if (fm) return parseInt(fm[1], 16);
  return questStructLayouts.get(srcTag)?.byName.get(field);
}

/**
 * Rewrite wrong quest union member accesses based on function name or source file.
 * e.g. in Q04_xxx: `.pA1Q1->` → `.pA1Q4->`
 *
 * Matches three patterns (in priority order):
 * 1. QNN_ prefix (quest callback naming): Q04_DespawnRogueGuards
 * 2. A#Q# in function name (object/operation naming): OBJOP_A1Q4_ActivateInifussTree
 * 3. A#Q# in source file path: D2Game/Quests/A1Q4.cpp
 */
function rewriteQuestUnionMembers(
  code: string,
  funcName: string,
  sourceFile?: string,
  locals?: ReadonlyArray<{ name: string; dataType: string }>,
): string {
  // 1. Function-quest heuristic: Ghidra picks an arbitrary union member (usually
  //    pA1Q1); rewrite to the member for the quest this function belongs to.
  let member: string | null = null;
  const prefixMatch = funcName.match(/\b(Q\d+)_/);
  if (prefixMatch) member = QUEST_PREFIX_TO_UNION_MEMBER[prefixMatch[1] + '_'] ?? null;
  if (!member) {
    const aqMatch = funcName.match(/\b(A[1-5]Q\d+)\b/); // OBJOP_A1Q4_, QUEST_A3Q5_
    if (aqMatch) member = `p${aqMatch[1]}`;
  }
  if (!member && sourceFile) {
    const fileMatch = sourceFile.match(/\b(A[1-5]Q\d+)\b/); // D2Game/Quests/A1Q4
    if (fileMatch) member = `p${fileMatch[1]}`;
  }
  if (member) {
    const tgtTag = member.slice(1); // "pA5Q5" → "A5Q5"
    const tgtLayout = questStructLayouts.get(tgtTag);
    // 1a. INLINE field access `.pSRC)->FIELD`: Ghidra resolved the union to an
    //     arbitrary member (pSRC) so FIELD is that member's name at the touched
    //     offset. Switching the member to the function's own quest (pTGT) leaves
    //     FIELD pointing at the wrong name → "has no member". Remap FIELD by its
    //     byte offset to pTGT's field at the same offset. (The decompiler picks
    //     the member by offset-fit, so the offset is the stable invariant.)
    //
    //     EXCEPT when the access CONTINUES into a subfield/array/arrow
    //     (`->FIELD.x`, `->FIELD[i]`, `->FIELD->`): the decompiler only emits such
    //     a chain when the member it picked genuinely HAS FIELD as a struct/array
    //     at that offset (e.g. `->sQuestGUID.aPlayerGUID`), so its member choice is
    //     VALID — switching it would deref a scalar ("non-class type 'bool'").
    //     Leave those untouched.
    code = code.replace(
      /\.p(A[1-5]Q\d+)(\s*\)?\s*->\s*)([A-Za-z_]\w*)([.[]|->)?/g,
      (full, srcTag: string, mid: string, field: string, cont: string | undefined) => {
        if (cont === '.' || cont === '[' || cont === '->') return full; // valid structured access — keep member
        // The union members all alias offset 0, so `.pSRC->FIELD` already COMPILES
        // whenever FIELD is a real named member of pSRC — and reads the same bytes
        // any other member would. The decompiler only emits such a real-named access
        // when it deliberately picked pSRC (e.g. a genuine cross-quest read of
        // another quest's state). Leave those untouched; only `field_0xNN` (or a
        // stale name not present on pSRC) signals an arbitrary offset-fit member
        // that must be remapped to the function's own quest to resolve.
        if (questStructLayouts.get(srcTag)?.byName.has(field)) return full;
        let remapped = field;
        if (tgtLayout) {
          const off = questFieldOffset(srcTag, field);
          if (off !== undefined) {
            const tf = tgtLayout.byOffset.get(off);
            if (tf) remapped = tf;
          }
        }
        return `.${member}${mid}${remapped}`;
      },
    );
    // 1b. BARE member uses (no `->`, e.g. passed as a pointer value or assigned to
    //     a typed local): plain member rewrite, no field involved. Skip members
    //     followed by `->` — those are field accesses handled/kept by 1a.
    code = code.replace(/\.p(A[1-5]Q\d+)\b(?!\s*\)?\s*->)/g, `.${member}`);
  }

  // 2. Type-driven correction: a local declared `D2QuestDataA#Q#Strc* x = …pA?Q?`
  //    must read its OWN union member regardless of the enclosing function's quest
  //    — cross-quest functions (e.g. an A1Q5 function with a D2QuestDataA1Q4Strc*
  //    local) otherwise keep the wrong member and fail with an unrelated-pointer
  //    conversion (not downgraded by -fpermissive). The union members are all
  //    offset-0 pointers, so matching the declared type is correct.
  code = code.replace(
    /(D2QuestData(A[1-5]Q\d+)Strc\s*\*\s*\w+\s*=\s*[^;]*?\.p)A[1-5]Q\d+\b/g,
    '$1$2',
  );

  // 3. Bare-assignment type-driven correction: `pX = …pA?Q?;` where pX is a local
  //    declared `D2QuestDataA#Q#Strc*` (declared on its own line, so step 2's
  //    in-statement-type rule misses it). step 1b forced the function's quest
  //    member, breaking the assignment ("cannot convert A1Q5Strc* to A1Q4Strc*").
  //    Rewrite the member to match pX's OWN declared quest. (All members are
  //    offset-0 pointers, so this is the same address read as the correct type.)
  //    The var→quest map is built from the BODY's declarations (Ghidra body-local
  //    decls are not in func.localVariables) plus any passed locals/params.
  const localMember = new Map<string, string>();
  for (const v of locals ?? []) {
    const m = v.dataType.match(/^D2QuestData(A[1-5]Q\d+)Strc\s*\*/);
    if (m) localMember.set(v.name, m[1]);
  }
  for (const m of code.matchAll(/\bD2QuestData(A[1-5]Q\d+)Strc\s*\*\s*(\w+)\b/g)) {
    localMember.set(m[2], m[1]); // body decl wins (it's the actual emitted type)
  }
  if (localMember.size > 0) {
    code = code.replace(
      /(^|[\s{};])(\w+)(\s*=\s*[^;=]*?\.p)A[1-5]Q\d+\b/gm,
      (full, lead: string, varName: string, mid: string) => {
        const tag = localMember.get(varName);
        return tag ? `${lead}${varName}${mid}${tag}` : full;
      },
    );
  }
  return code;
}

/**
 * Check if a name is a valid C++ namespace (not a template instantiation)
 */
function isValidNamespace(name: string): boolean {
  const templateInfo = parseTemplateName(name);
  // Template instantiations are not valid namespace names
  if (templateInfo.isTemplate) return false;
  // Also reject names with angle brackets
  if (name.includes('<') || name.includes('>')) return false;
  // Also reject names with commas (mangled template params)
  if (name.includes(',')) return false;
  // Reject switch table artifacts
  if (name.startsWith('switchD_') || name.includes('::switchD_')) return false;
  return true;
}

/**
 * Function names the platform resolves at ROOT scope, whatever namespace Ghidra
 * files them under.
 *
 * `main` and `wmain` are NOT among them, and cannot be. C++ reserves `::main`:
 * it must return `int`, it may not be declared `extern "C"`, and it may not
 * carry a calling convention — so a forwarder for it is ill-formed whatever the
 * function behind it looks like. Nor is one ever wanted here: the only `main`
 * 1.14d has is `Fog::Engine::Application::Service::main` @ 004065e0, which
 * returns `void` and is stored into a `SERVICE_TABLE_ENTRYA.lpServiceProc` two
 * statements before `StartServiceCtrlDispatcherA`. The service control manager
 * dispatches that by the name STRING in the table, not through the linker, so
 * the process entry point is `WinMain` and this function needs no root-scope
 * symbol at all.
 */
const ENTRY_POINT_NAMES = new Set(['WinMain', 'wWinMain', 'DllMain']);

/**
 * Context for code generation, carrying optional registries
 */
export interface ImplGenContext {
  overrides?: OverrideRegistry | null;
  libraries?: LibraryRegistry | null;
  methodConversions?: MethodConversionRegistry | null;
  /** Optional precomputed method mappings for call-site rewriting */
  methodMappings?: Record<string, MethodCallMapping>;
  /** Analyzed globals for static-local injection into function bodies */
  analyzedGlobals?: AnalyzedDataSymbol[];
  /** File-local globals for the current impl file */
  fileLocalGlobals?: AnalyzedDataSymbol[];
  /** Struct/union/enum names, for the qualified-name cleanup on reference sites. */
  _namespaceCollisionTypeNames?: string[];
  /** The resolved entity behind `_enclosingNamespace`; passes segments around
   *  without anyone re-splitting the rendered text. */
  _enclosingResolvedNamespace?: ResolvedNamespace;
  /** Internal: accumulated preambles from injection-aware plugins */
  _preambles?: Set<string>;
  /**
   * Internal: the namespace block the current impl file's bodies are emitted
   * inside. C++ name lookup for a reference's leading qualifier starts here, so
   * `namespace-shadow-qualify` needs it to tell a shadowed reference from a
   * correct one. Set per file by `generateImplementation`.
   */
  _enclosingNamespace?: string;
  /** Enum type names moved to shared d2_enums.h — skip in per-file headers */
  _sharedEnumTypes?: Set<string>;
  /**
   * Constant names that more than one enum declares with DIFFERENT values, so
   * `d2_enums.h` exports none of them at global scope. Only the qualified
   * `<Enum>_ns::Name` spelling means anything for these.
   */
  _ambiguousEnumConstants?: string[];
  /** Enum name → the member names it declares, un-deduplicated. */
  _enumMembers?: Record<string, string[]>;
  /**
   * Full set of namespace paths that exist in the project (e.g.
   * "D2Common::Unit::Path", "D2Common::Path::DynamicPath"). Used to make
   * redundant-qualifier stripping collision-aware: a prefix is only stripped
   * if the remaining leading segment can't be captured by a sibling namespace
   * reachable from a deeper enclosing scope.
   */
  knownNamespaces?: Set<string>;
  /**
   * Type names that are ALSO an emitted namespace component (`ButtonWrapper`,
   * `Draw`). The type lives at root scope, so every reference to it from inside
   * the shadowing namespace must be spelled `::ButtonWrapper`.
   */
  shadowedTypeNames?: Set<string>;
  /**
   * Map from function address (bigint) to the function defined there, carrying
   * the namespace a reference to it has to name. Built once, from the run's
   * namespace resolution, so a func-ptr literal is spelled the way the
   * definition is.
   */
  functionAddressMap?: Map<bigint, FuncPtrTarget>;
  /** Map from function name to its header path — for adding includes when func-ptr-literal resolves references */
  functionNameToHeader?: Map<string, string>;
  /**
   * Every header that declares a given bare function name, each tagged with the
   * qualified name a reference to it is spelled with. A bare name is not a key:
   * `Initialize` is declared by four different renderers, so a reference has to
   * be resolved from the qualifier written at the reference site.
   */
  functionNameCandidates?: Map<string, { qualified: string; header: string }[]>;
  /**
   * Reference spelling the DECOMPILER printed for a function → the spelling its
   * emitted DECLARATION uses. Non-empty only where the two round-trips
   * disagree, i.e. where a rename or a namespace move landed between them; the
   * body then references a name the tree never declares. Applied on the AST by
   * `function-name-reconcile`.
   */
  functionRefAliases?: Record<string, string>;
  /** Bitfield catalog: "field_0xNN:mask" → bitfield member name */
  bitfieldCatalog?: Map<string, string>;
  /** Current source file name (e.g., "D2Game/Quests/A1Q4") — used for quest union rewriting */
  sourceFileName?: string;
  /** BuildInfo output — populated by generateFilesForFunctions after graph resolution */
  _buildInfo?: import('../modules/buildinfo.js').BuildInfo;
  /** Internal: accumulated identifiers from all function bodies in the current file */
  _fileIdentifiers?: Set<string>;
  /**
   * Internal: function-pointer typedef names `funcptr-arg-cast` spelled into the
   * current file's bodies. They have to be declared in the file — the callee's
   * header need not be included there.
   */
  _castTypedefs?: Set<string>;
  /**
   * Internal: for each body identifier, how many distinct function bodies (across
   * ALL files) reference it. Drives the globals.h "referenced-but-undeclared"
   * safety net — a static-local symbol named in >1 body needs an extern so those
   * other bodies compile. Unlike `_fileIdentifiers`, this is NOT reset per file.
   */
  bodyIdentifierFnCounts?: Map<string, number>;
  /**
   * Tables that let `funcptr-arg-cast` decide, per call site, whether the
   * function whose address is being passed really has a different prototype
   * from the funcdef the parameter is declared with. Built once per run.
   */
  funcPtrArgCasts?: FuncPtrArgCastTables;
}

/**
 * Per-enclosing-scope views of the shared `funcptr-arg-cast` tables. The plugin
 * caches its transformer on the options OBJECT, so a fresh object per function
 * would rebuild it every time; one object per distinct scope keeps that cache
 * useful while still letting the plugin resolve unqualified names the way C++
 * does.
 */
const funcPtrArgCastScopeViews = new WeakMap<object, Map<string, FuncPtrArgCastTables>>();

function funcPtrArgCastsForScope(
  tables: FuncPtrArgCastTables,
  segments: readonly string[] | undefined,
): FuncPtrArgCastTables {
  if (!segments || segments.length === 0) return tables;
  const key = segments.join('::');
  let views = funcPtrArgCastScopeViews.get(tables);
  if (!views) { views = new Map(); funcPtrArgCastScopeViews.set(tables, views); }
  let view = views.get(key);
  if (!view) {
    view = { ...tables, enclosingSegments: [...segments] } as FuncPtrArgCastTables;
    views.set(key, view);
  }
  return view;
}

/** @see ImplGenContext.funcPtrArgCasts */
export interface FuncPtrArgCastTables {
  /** Callable name (bare AND qualified) → param index → funcdef typedef name */
  paramFuncdefs: Record<string, Record<number, string>>;
  /**
   * System-header callee → slot → the callback typedef that slot declares.
   * Cast into only when the supplied function takes no parameters at all.
   */
  zeroArityCallbackSlots?: Record<string, Record<number, string>>;
  /**
   * The same, for a slot the SDK leaves unnamed: the callback type in parts,
   * built rather than named. Same arity-0 gate.
   */
  zeroArityCallbackCasts?: Record<string, Record<number, {
    returnType: string; paramTypes: string[]; convention?: string;
  }>>;
  /** Funcdef typedef name → its normalized signature key */
  funcdefSignatures: Record<string, string>;
  /** Function name (bare AND qualified) → its own normalized signature key */
  functionSignatures: Record<string, string>;
  /** Data-symbol names — a name that denotes data is never cast as a function */
  variableNames: string[];
  /** Names (bare AND qualified) of functions that return `void*` */
  voidPointerFunctions: string[];
  /** Funcdef typedefs a same-named function hides — the cast must say `::T` */
  rootQualifiedTypedefs: string[];
  /** Field names declared `void*` by every struct/union that has them */
  voidPointerFields?: string[];
  /** Callable name (bare AND qualified) → its emitted parameter type spellings, in order */
  functionParamTypes?: Record<string, string[]>;
  /**
   * Imported-SDK callee → its parameter type spellings, read off Ghidra's own
   * argument annotations (see `win32-signatures.ts`). A slot from this table is
   * cast into ONLY when both the parameter and the argument are pointers.
   */
  pointerOnlyParamTypes?: Record<string, string[]>;
  /** Callable name (bare AND qualified) → its emitted return type spelling */
  functionReturnTypes?: Record<string, string>;
  /**
   * Callable name (bare AND qualified) → the calling convention its emitted
   * declaration carries, for the conventions the emitter spells. A cast that
   * selects one member of an overload set has to name the member's whole type,
   * and the convention is part of it.
   */
  functionConventions?: Record<string, string>;
  /**
   * Every spelling that denotes a FUNCTION. Not pruned on signature collision -
   * two functions sharing a bare name disagree about the signature, not about
   * being functions.
   */
  functionNames?: string[];
  /** Bare names more than one function carries - i.e. an overload set */
  overloadedFunctionNames?: string[];
  /** Global variable name (as emitted) → its emitted declaration type spelling */
  globalTypes?: Record<string, string>;
  /** Callables with a `...` tail — arguments past the declared ones have no type */
  varArgFunctions?: string[];
  /** Field name → declared type, where every aggregate declaring it agrees */
  fieldTypes?: Record<string, string>;
  /** Typedef name → the spelling it stands for, so hidden indirection is visible */
  typedefTargets?: Record<string, string>;
  /** Aggregate name → field name → declared type, exact where the walk is known */
  structFields?: Record<string, Record<string, string>>;
  /**
   * The aggregates whose emitted declaration carries a converting constructor,
   * so a C cast to one of them is legal C++ and already means the four-byte
   * reinterpretation. Every other aggregate has to have the cast written out.
   */
  convertingAggregates?: string[];
  /** Aggregate name → every member name its emitted declaration carries */
  aggregateMembers?: Record<string, string[]>;
  /**
   * Funcdef name → the return and parameter spellings the funcdef declares. A
   * call made THROUGH a function-pointer field or variable has no callee name
   * for a name table to match, so this is the only record of what that call
   * returns and what it takes.
   */
  funcdefDecls?: Record<string, FuncdefDecl>;
  /** Aggregate name → field name → the funcdef its declared type names */
  structFieldFuncdefs?: Record<string, Record<string, string>>;
  /** Field name → funcdef, where every aggregate declaring that name agrees */
  fieldFuncdefs?: Record<string, string>;
  /** Enclosing namespace segments for the body being transformed, outermost first */
  enclosingSegments?: string[];
}

/** @see FuncPtrArgCastTables.funcdefDecls */
export interface FuncdefDecl {
  returnType: string;
  paramTypes: string[];
  varArgs: boolean;
}

/**
 * Generate an implementation file
 */
export function generateImplementation(
  name: string,
  functions: ExtractedFunction[],
  classInfo: DetectedClass | undefined,
  headerPath: string,
  options: ReconstructOptions,
  context?: ImplGenContext,
  extraIncludes?: string[],
  crtHeaders?: Set<string>,
  internalFunctions?: Set<string>,
  /** Set of data type names (struct/union/enum) that collide with namespace
   *  components. Kept in the signature for callers; the collision itself is now
   *  resolved on the AST by `qualified-name-cleanup`. */
  dataTypeNames?: Set<string>
): string {
  // Set source file name for quest union rewriting
  if (context) {
    context.sourceFileName = name;
  }
  const lines: string[] = [];

  // Generated file banner
  lines.push('// Auto-generated by ghidra-mcp — DO NOT EDIT');
  lines.push('');

  // Include header
  const headerInclude = headerPath.replace(/\\/g, '/');
  lines.push(`#include "${headerInclude}"`);

  // Cross-file includes — deduped; the globals header and a type-owner header can
  // resolve to the same file, and the own header is already emitted above.
  if (extraIncludes && extraIncludes.length > 0) {
    const seen = new Set([headerInclude]);
    for (const inc of [...extraIncludes].sort()) {
      const normalized = inc.replace(/\\/g, '/');
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      lines.push(`#include "${normalized}"`);
    }
  }
  lines.push('');

  // Collect library headers needed by referenced functions
  const libraryHeaders = new Set<string>();
  if (context?.libraries) {
    for (const func of functions) {
      for (const called of func.calledFunctions ?? []) {
        const libFunc = context.libraries.getByName(called);
        if (libFunc) {
          libraryHeaders.add(libFunc.header);
        }
      }
    }
  }

  // CRT/stdlib includes — use precise headers when provided, otherwise fall back to blanket includes
  if (crtHeaders && crtHeaders.size > 0) {
    for (const header of [...crtHeaders].sort()) {
      lines.push(`#include ${header}`);
    }
  } else if (!crtHeaders) {
    // Legacy fallback: blanket includes when no CRT analysis was performed
    lines.push('#include <cstring>');
    lines.push('#include <cstdlib>');
  }
  // Add any extra library headers (not already covered by CRT headers)
  for (const header of [...libraryHeaders].sort()) {
    if (!crtHeaders?.has(header)) {
      lines.push(`#include ${header}`);
    }
  }
  lines.push('');

  // Get namespace from class or first function
  // CRITICAL: Methods must follow their parent struct's scope, not the function's namespace.
  // If the struct is at global scope (classInfo.namespace is undefined), methods should
  // also be at global scope, even if the functions have a namespace in Ghidra.
  const rawNamespace = classInfo?.namespace || functions[0]?.namespace;

  // Check if all functions are methods (have parentClass)
  const allMethods = functions.length > 0 && functions.every(f => f.parentClass);

  // CRITICAL FIX: For method-only units, don't use namespace wrapping.
  // Methods are always scoped as StructName::Method() at global scope.
  // The classInfo.namespace is often wrong (set from function namespace, not struct location).
  // Wrapper functions will preserve the original namespace for compatibility.
  // The namespace is the one resolved for THIS symbol's address — the same
  // entity the header declaration, globals.h and every call site render from.
  const namespaceOwner = allMethods
    ? undefined
    : (classInfo?.namespace ? { address: undefined, namespace: rawNamespace } : functions[0]);
  const resolvedNamespace = namespaceOwner
    ? namespaceResolution().of(namespaceOwner)
    : undefined;
  let namespace = renderNamespace(resolvedNamespace);

  // Only emit namespace block if it's a valid C++ namespace (not a template instantiation)
  const useNamespace = namespace && options.organization === 'namespace' && isValidNamespace(namespace);


  // Funcdef typedefs the body casts to must be declared at ROOT scope, before
  // the namespace opens: a cast may spell one `::T` to escape a same-named
  // function that would otherwise hide it.
  const rootTypedefInsertIndex = lines.length;

  // Open namespace
  if (useNamespace) {
    lines.push(`namespace ${namespace} {`);
    lines.push('');
  }

  // Bodies are transformed below and their references resolve from inside this
  // block — tell the shadow-qualifier which scope that is.
  if (context) {
    context._enclosingNamespace = useNamespace ? namespace : undefined;
    context._enclosingResolvedNamespace = useNamespace ? resolvedNamespace : undefined;
  }

  // File-local globals are deferred until after function bodies are generated,
  // so we can filter out globals whose names don't appear in any function body.
  const fileLocalInsertIndex = lines.length;
  // Reset accumulated identifiers for this file
  if (context) {
    context._fileIdentifiers = undefined;
    context._castTypedefs = undefined;
  }

  // Generate function implementations, grouping consecutive same-ifdef functions
  let currentIfdef: string | undefined;
  for (const func of functions) {
    // Skip external functions (they're just declarations)
    if (func.isExternal) continue;

    // Skip thunk functions
    if (func.isThunk) continue;

    // Skip library functions — they don't get implementations
    if (func.isLibrary) continue;

    // Group consecutive functions with the same ifdef under one guard
    if (func.ifdef !== currentIfdef) {
      if (currentIfdef) {
        lines.push(`#endif // ${currentIfdef}`);
        lines.push('');
      }
      if (func.ifdef) {
        lines.push(`#ifdef ${func.ifdef}`);
      }
      currentIfdef = func.ifdef;
    }

    const isInternal = internalFunctions?.has(func.name) ?? false;
    let impl: string;
    try {
      impl = generateFunctionImplementation(func, classInfo, options, context, isInternal, useNamespace ? resolvedNamespace : undefined);
    } catch (err) {
      if (err instanceof RangeError && /call stack|stack size/i.test(String(err.message))) {
        parseErrorCount++;
        console.error(`[STACK OVERFLOW] ${func.name} @ ${func.address} — using raw body`);
        // Emit raw decompiled code as fallback
        const rawBody = func.decompiled ?? '    // Decompilation not available';
        const hexAddr = func.address.includes(':') ? func.address.slice(func.address.lastIndexOf(':') + 1) : func.address;
        impl = `// 1.14d: ${hexAddr}\n${rawBody}`;
      } else {
        throw err;
      }
    }
    lines.push(impl);
    lines.push('');
  }
  // Close any trailing ifdef
  if (currentIfdef) {
    lines.push(`#endif // ${currentIfdef}`);
    lines.push('');
  }

  // Now that all function bodies have been generated and _fileIdentifiers accumulated,
  // emit file-local globals filtered by actual usage, spliced at the deferred position.
  if (context?.fileLocalGlobals && context.fileLocalGlobals.length > 0) {
    // These are spliced INSIDE the namespace block opened above, so a pointer
    // initializer naming another namespace's symbol resolves from in there.
    setInitializerNamespace(useNamespace ? resolvedNamespace : undefined);
    const fileLocalLines: string[] = [];
    for (const global of context.fileLocalGlobals) {
      let type = global.suggestedType || global.dataType;
      let name = global.suggestedName || global.name;

      // Sanitize name
      name = name.replace(/[^A-Za-z0-9_]/g, '_');
      if (/^\d/.test(name)) name = '_' + name;
      if (!name || name === '_') name = `_global_${global.address}`;

      // NOTE: do NOT skip on `_fileIdentifiers` membership here. These globals are
      // file-local precisely because computeFileLocalGlobals saw all their
      // referencing functions in THIS file — they're used by construction. The
      // identifier set is built from transform output and misses bare lowercase
      // global-variable refs (e.g. `gbNetworkPacketSyncFlag++`), so the old skip
      // dropped genuinely-used globals → "'x' was not declared". An emitted-but-
      // unused static is at worst a warning, never an error.

      // `auto` is a one-byte `undefined` slot, and it must resolve to the SAME
      // type globals.h gives the same symbol when it is not file-local - `int`
      // here made `&sym` an `int*` against a `uint8_t*` reference.
      if (type === 'auto') type = 'uint8_t';

      // A file-local static IS a declaration — and the only one this symbol
      // gets. The closure pass must not add an `extern` for it: that would be a
      // conflicting declaration in this TU and a phantom symbol in every other.
      recordDeclaredName(name);

      if (global.initializedData) {
        const arrayInfo = inferArrayDeclaration(global);
        // The declared type must travel with the value: without it the walk has
        // no element/field types and every pointer slot is emitted uncast — the
        // same call in globals.cpp has always passed it.
        const initializer = emitDataValue(global.initializedData, 0, type);
        if (arrayInfo && (global.initializedData.kind === 'array' || isWideTextDatum(global, type))) {
          fileLocalLines.push(`static ${arrayInfo.type} ${name}[${arrayInfo.count}] = ${initializer};`);
        } else {
          fileLocalLines.push(`static ${normalizeArrayDeclaration(type, name)} = ${braceArrayInitializer(type, initializer)};`);
        }
      } else if (global.isInitialized) {
        // The one renderer globals.h and globals.cpp use. The local copy of it
        // quoted a single character and nothing else, so Ghidra's rendered text
        // for a `char[N]` went out bare (`= { end }`) and its all-numeric
        // addresses (`00304096`) were read by C++ as OCTAL.
        const arrayInfo = inferArrayDeclaration(global);
        let value = renderGlobalScalarInitializer(global.value, type, arrayInfo?.count);
        if (arrayInfo) {
          fileLocalLines.push(`static ${arrayInfo.type} ${name}[${arrayInfo.count}] = { ${value} };`);
        } else {
          const decl = normalizeArrayDeclaration(type, name);
          const isArray = /\[\d+\]/.test(decl);
          if (isArray) {
            fileLocalLines.push(`static ${decl} = { ${value} };`);
          } else {
            fileLocalLines.push(`static ${decl} = ${value};`);
          }
        }
      } else {
        if (type === 'auto') type = 'uint8_t';
        const arrayInfo = inferArrayDeclaration(global);
        if (arrayInfo) {
          fileLocalLines.push(`static ${arrayInfo.type} ${name}[${arrayInfo.count}];`);
        } else {
          fileLocalLines.push(`static ${normalizeArrayDeclaration(type, name)};`);
        }
      }
    }

    setInitializerNamespace(undefined);

    if (fileLocalLines.length > 0) {
      lines.splice(fileLocalInsertIndex, 0, ...fileLocalLines, '');
    }
  }

  // `funcptr-arg-cast` spells a funcdef typedef into a cast whose callee lives in
  // another module, so no header this file includes declares it ("error: expected
  // ')' before 'fpInsertExpansionCd'"). Declare exactly the typedefs the casts
  // used — NOT every body identifier that happens to share a FUNCTION_DEFINITION
  // name, which turns a local called `length` into a typedef. The RECON_FPTD
  // guard is the same one the headers use, so at most one definition expands.
  if (context?._castTypedefs && context._castTypedefs.size > 0) {
    const typedefs: string[] = [];
    for (const name of context._castTypedefs) {
      const decl = guardedFuncDefTypedef(name);
      if (decl) typedefs.push(decl);
    }
    if (typedefs.length > 0) {
      lines.splice(rootTypedefInsertIndex, 0, ...typedefs, '');
    }
  }

  // Close namespace
  if (useNamespace) {
    lines.push(`} // namespace ${namespace}`);
  }

  // ── Generate wrapper functions for methods with namespace ──────────────────
  // Methods are always at global scope. If the original function had a namespace,
  // generate a wrapper in that namespace to preserve the original calling convention.
  if (classInfo && options.organization === 'namespace') {
    const methodsWithWrappers = functions.filter(f =>
      f.parentClass === classInfo.name &&
      f.namespace &&  // Has a namespace (methods are global, so any namespace means wrapper needed)
      !f.isExternal &&
      !f.isThunk &&
      !f.isLibrary
    );

    if (methodsWithWrappers.length > 0) {
      lines.push('');
      lines.push('// =============================================================================');
      lines.push('// Wrapper functions (preserve original namespace calling conventions)');
      lines.push('// =============================================================================');
      lines.push('');

      // Group by namespace
      const byNamespace = new Map<string, typeof methodsWithWrappers>();
      for (const func of methodsWithWrappers) {
        if (!byNamespace.has(func.namespace!)) {
          byNamespace.set(func.namespace!, []);
        }
        byNamespace.get(func.namespace!)!.push(func);
      }

      // Emit wrappers grouped by namespace
      for (const [wrapperNs, funcs] of byNamespace) {
        if (isValidNamespace(wrapperNs)) {
          lines.push(`namespace ${wrapperNs} {`);
          lines.push('');

          for (const func of funcs) {
            // Generate wrapper function signature
            const params = func.parameters || [];
            const returnType = func.returnType || 'void';
            const paramList = params.map(p => `${p.dataType} ${p.name}`).join(', ');

            lines.push(`// Wrapper for ${classInfo.name}::${func.name} (original location)`);
            lines.push(`${returnType} ${func.name}(${paramList}) {`);

            // Generate method call
            const thisParam = params[0]?.name || 'pThis';
            const argList = params.slice(1).map(p => p.name).join(', ');

            if (returnType !== 'void') {
              if (params.length > 1) {
                lines.push(`    return ${thisParam}->${func.name}(${argList});`);
              } else {
                lines.push(`    return ${thisParam}->${func.name}();`);
              }
            } else {
              if (params.length > 1) {
                lines.push(`    ${thisParam}->${func.name}(${argList});`);
              } else {
                lines.push(`    ${thisParam}->${func.name}();`);
              }
            }
            lines.push(`}`);
            lines.push('');
          }

          lines.push(`} // namespace ${wrapperNs}`);
          lines.push('');
        }
      }
    }
  }

  let output = lines.join('\n');

  // (`Forms::D2WinImage::FuncName` → `Forms::FuncName` when D2WinImage is a
  //  struct is decided on the QualifiedId node by `qualified-name-cleanup`, not
  //  on this file's text — see transformDecompiledCode.)

  // (Redundant enclosing-namespace prefixes are dropped on the reference's own
  //  QualifiedId by `enclosing-namespace-strip` — see transformDecompiledCode.)

  const entryPointLines: string[] = [];
  // ── Process entry point ───────────────────────────────────────────────────
  // The PE entry symbol is `WinMain@16` at ROOT scope. Ghidra hangs the function
  // under the namespace of the file it belongs to, so the emitted definition
  // mangles as `D2Client::Engine::Application::WinMain(...)` and no link can ever
  // find an entry point. Emit a forwarder that has the name the linker wants.
  //
  // The forwarder takes exactly the STACK parameters. Ghidra's recovered
  // prototype for 1.14d has three further parameters whose storage is EBP/ESI/EBX
  // — registers, inherited at entry, never pushed by the OS. They are part of the
  // body's model of itself, not of the call contract, so they cannot appear in
  // the entry signature; they are forwarded as zero and the comment says so.
  if (useNamespace && options.organization === 'namespace') {
    for (const func of functions) {
      if (func.isExternal || func.isThunk || func.isLibrary) continue;
      if (func.parentClass) continue;
      if (!ENTRY_POINT_NAMES.has(func.name)) continue;
      const params = func.parameters ?? [];
      const isStackParam = (p: { storage?: string }) => !p.storage || /^Stack\[/.test(p.storage);
      const stackParams = params.filter(isStackParam);
      // A prototype with no stack parameters at all says nothing about the ABI;
      // do not invent one.
      if (params.length > 0 && stackParams.length === 0) continue;
      const registerParams = params.filter(p => !isStackParam(p));
      const declArgs = stackParams.length > 0
        ? stackParams.map(p => `${p.dataType} ${p.name}`).join(', ')
        : 'void';
      const callArgs = [
        ...stackParams.map(p => p.name),
        ...registerParams.map(() => '0'),
      ].join(', ');
      const ret = func.returnType && func.returnType !== 'void' ? 'return ' : '';
      entryPointLines.push('');
      entryPointLines.push(`// Process entry point — the linker resolves \`${func.name}\` at root scope,`);
      entryPointLines.push(`// not \`${namespace}::${func.name}\`.`);
      if (registerParams.length > 0) {
        entryPointLines.push(`// ${registerParams.map(p => p.name).join(', ')} are register-storage in Ghidra's`);
        entryPointLines.push('// prototype (inherited, not pushed by the caller); they are not entry arguments.');
      }
      entryPointLines.push(`extern "C" ${func.returnType || 'int'} __stdcall ${func.name}(${declArgs}) {`);
      entryPointLines.push(`    ${ret}${namespace}::${func.name}(${callArgs});`);
      entryPointLines.push('}');
    }
  }
  if (entryPointLines.length > 0) {
    // Appended AFTER the qualifier stripper: it removes the enclosing namespace
    // from a qualified name, which would turn the forwarder's
    // `D2Client::Engine::Application::WinMain(...)` into a call to ITSELF.
    output = output + '\n' + entryPointLines.join('\n');
  }

  // Prepend any accumulated preambles (deduplicated inline helpers, etc.)
  if (context?._preambles && context._preambles.size > 0) {
    // Deduplicate by splitting each preamble into individual lines/blocks and merging
    const allPreambleLines = new Set<string>();
    for (const preamble of context._preambles) {
      // Each preamble block is already deduplicated per-function, but across
      // functions the same helpers may appear. Split on double-newline (block separator).
      for (const block of preamble.split('\n\n')) {
        const trimmed = block.trim();
        if (trimmed) allPreambleLines.add(trimmed);
      }
    }

    if (allPreambleLines.size > 0) {
      const preambleSection = [...allPreambleLines].join('\n\n') + '\n\n';
      // Insert after the #include block: find the first blank line after includes
      const includeEndIdx = output.indexOf('\n\n', output.lastIndexOf('#include'));
      if (includeEndIdx !== -1) {
        output = output.slice(0, includeEndIdx + 2) + preambleSection + output.slice(includeEndIdx + 2);
      } else {
        output = preambleSection + output;
      }
    }
  }

  return output;
}

/**
 * Generate a single function implementation
 *
 * Override priority:
 * 1. If an override with action "replace" exists, use sourceFile content as body
 * 2. If an override with action "patch" exists, transform then patch
 * 3. Otherwise, use standard cpp-parser transform
 */
export function generateFunctionImplementation(
  func: ExtractedFunction,
  classInfo: DetectedClass | undefined,
  options: ReconstructOptions,
  context?: ImplGenContext,
  isInternal?: boolean,
  /**
   * The namespace block this body is emitted inside, as the resolved entity.
   * Passed explicitly rather than read back off the rendered text: the body's
   * references are shortened against these segments, and a file that opens no
   * namespace block must not have anything shortened.
   */
  enclosingNamespace?: ResolvedNamespace,
): string {
  const lines: string[] = [];

  // Add function comment if available (strip Ghidra metadata)
  if (func.comment) {
    const cleaned = cleanFunctionComment(func.comment, context?.functionAddressMap);
    if (cleaned) {
      for (const commentLine of cleaned.split('\n')) {
        lines.push(`// ${commentLine}`);
      }
    }
  }

  // Add address comment — with cross-platform reference if available
  {
    const stripAddr = (a: string) => a.includes(':') ? a.slice(a.lastIndexOf(':') + 1) : a;
    if (func.crossPlatformAddress) {
      const xplat = func.crossPlatformAddress;
      if (func.platform) {
        lines.push(`// 1.14d ${func.platform}: ${stripAddr(func.address)}`);
      } else {
        lines.push(`// 1.14d win: ${stripAddr(func.address)} | ${xplat.platform}: ${stripAddr(xplat.address)}`);
      }
    } else if (func.platform) {
      lines.push(`// 1.14d ${func.platform}: ${stripAddr(func.address)}`);
    } else {
      lines.push(`// 1.14d: ${stripAddr(func.address)}`);
    }
  }

  // Determine body — check overrides first
  let body: string;
  let bodyIdentifiers: Set<string> | undefined;
  let overrideApplied = false;
  const override = context?.overrides?.get(func.address);

  const isMethod = classInfo && classInfo.methods.some(m => m.address === func.address);

  // Ghidra spells the hidden __thiscall argument `this`; a free function has no
  // `this`, so the body must name the parameter the signature actually declares.
  // Applied on the `this` EXPRESSION by the `this-param-rewrite` pass — a `this`
  // in a comment or a string stays as written.
  const thisName = func.parameters?.some(p => p.name === 'this')
    ? 'pThis'
    : (!isMethod && func.parameters.length > 0
        ? cleanParamName(func.parameters[0].name)
        : undefined);

  // Identifier renames the SIGNATURE performs and the body must mirror, applied
  // on the AST by the transform's rename map rather than by word-boundary text
  // substitution:
  //  - Ghidra's mixed-calling-convention duplicate `param_N_NN` names are
  //    renumbered sequentially (see renumberParams, which the signature uses).
  //  - A param whose name equals its own base type (`fpLevelDataFn1
  //    fpLevelDataFn1`) is renamed to `n<name>`, else a body reference resolves
  //    to the TYPE and `(int)fpLevelDataFn1` is a cast-of-a-type.
  const bodyRenames: Record<string, string> = {};
  {
    // `preprocessGhidraCode` rewrites Ghidra's `this` to `self` in the raw TEXT,
    // before the body is ever parsed — so `this-param-rewrite` finds no `this`
    // expression to rewrite and the body keeps saying `self` while the emitted
    // signature says `pThis`. Two renamers, one parameter, two answers. Carry
    // the preprocessor's spelling into the rename map so they agree.
    if (func.parameters?.some(p => p.name === 'this')) {
      bodyRenames['self'] = 'pThis';
    }
    let counter = 1;
    for (const p of func.parameters ?? []) {
      const origName = p.name === 'this' ? 'pThis' : p.name;
      if (/^param_\d+(_\d+)?$/.test(origName)) {
        const newName = `param_${counter}`;
        if (origName !== newName) bodyRenames[origName] = newName;
        counter++;
      }
    }
    // Ghidra can hold a NAMED parameter list whose storage was never committed to
    // the decompiler (`storage: <UNASSIGNED>`). The signature then reads
    // `BNCLIENT_SendLogonRequest(char *szUsername, char *szPassword)` while the
    // body it decompiled still says `param_1`/`param_2` — the emitted function
    // uses identifiers it never declares. Pair the two lists positionally and
    // rename the body to the names the signature actually declares.
    const decompiledNames = decompiledParameterNames(func.decompiled);
    const declaredNames = renumberParams(func.parameters ?? []).map(p => p.name);
    //
    // The two lists can also differ in LENGTH: with an unknown calling
    // convention the decompiler recovers only the parameters it could place
    // (`SCOMP_ADPCMEncode` decompiles as 5 `param_N` against a 6-name committed
    // prototype), or invents extras beyond it. Ghidra numbers `param_N` by
    // position in the prototype it printed, so the two lists still agree on
    // their common prefix — pair that prefix and leave the remainder alone.
    if (decompiledNames) {
      decompiledNames.slice(0, declaredNames.length).forEach((fromName, i) => {
        const toName = declaredNames[i];
        if (!/^param_\d+(_\d+)?$/.test(fromName)) return;
        if (!toName || /^param_\d+(_\d+)?$/.test(toName)) return;
        if (fromName in bodyRenames) return;
        bodyRenames[fromName] = toName;
      });
    }

    for (const p of renumberParams(func.parameters ?? [])) {
      const emitted = emittedParameterName(p.name, sigType(p.dataType));
      if (emitted !== p.name) bodyRenames[p.name] = emitted;
    }
    // Locals carry the same hazard as parameters and by the same rule: Ghidra
    // names a `sockaddr_in` local `sockaddr` and a `fpTimerFunction *` local
    // `fpTimerFunction`, and the declaration then hides the type the rest of the
    // scope still spells. The rename map is applied on the AST, and the visitor
    // gives a TypedefType no children, so a cast's type name is not touched —
    // only the declaration and its references move.
    for (const v of func.localVariables ?? []) {
      if (!v.name || v.name in bodyRenames) continue;
      const emitted = emittedParameterName(v.name, sigType(v.dataType ?? ''));
      if (emitted !== v.name) bodyRenames[v.name] = emitted;
    }
  }

  if (override?.action === 'replace') {
    // Full replacement — body will be loaded async, so we use a sync placeholder.
    // The actual async loading happens in generateImplementationAsync() below.
    // For sync callers, we mark it for later resolution.
    body = `    // [OVERRIDE:REPLACE] ${override.sourceFile ?? 'unknown'}`;
    overrideApplied = true;
  } else {
    // Start with decompiled code or placeholder
    if (func.decompiled) {
      const slotVarTypes: Record<string, string> = {};
      for (const p of func.parameters ?? []) {
        const n = cleanParamName(p.name);
        if (n && p.dataType) slotVarTypes[n] = p.dataType;
      }
      for (const v of func.localVariables ?? []) {
        if (!v.name || !v.dataType) continue;
        const n = emittedParameterName(v.name, sigType(v.dataType));
        if (!(n in slotVarTypes)) slotVarTypes[n] = v.dataType;
      }
      const transformed = transformDecompiledCode(
        func.decompiled, options, func.name, func.address, context, slotVarTypes,
        {
          thisName,
          returnsNonPointer: !!func.returnType && !func.returnType.includes('*'),
          returnsVoid: (func.returnType ?? '').replace(/\bconst\b/g, '').trim() === 'void',
          // The wrapper the body is parsed inside carries the definition's own
          // signature, spelled by the same code that emits it, so the two cannot
          // drift apart.
          signature: wrapperSignature(func),
          renames: bodyRenames,
          namespaceSegments: enclosingNamespace?.segments,
          // Ghidra's own path for this scope, taken from the resolution — NOT
          // the emitted one: `D2Client::Forms::D2WinList::Draw` is emitted as a
          // bare `Draw` inside `namespace D2Client::Forms`, because the unit
          // segment would shadow the same-named struct. The signature tables are
          // keyed by the Ghidra path, so that is what an unqualified name has to
          // be resolved against.
          ghidraNamespaceSegments: enclosingNamespace?.ghidraSegments,
          stackSlots: frameSlots(func),
        },
      );
      body = func.name ? rewriteQuestUnionMembers(transformed.code, func.name, context?.sourceFileName, [...(func.parameters ?? []), ...(func.localVariables ?? [])]) : transformed.code;
      bodyIdentifiers = transformed.identifiers;
      // A body can DECLARE a local of a funcdef type Ghidra applied to the
      // variable (`pfnEHHandlerRoutine pExcHandler = …`) without any signature
      // in this file naming it, so no header declares it. Restricted to the
      // `fp`/`fn`/`pfn` + CamelCase spelling of a function-pointer typedef, so a
      // local that merely shares a FUNCTION_DEFINITION name is not caught.
      if (context) {
        for (const name of transformed.typeNames ?? []) {
          if (!isFuncDefTypedefName(name)) continue;
          if (!context._castTypedefs) context._castTypedefs = new Set();
          context._castTypedefs.add(name);
        }
      }
      const castTypedefs = takeFuncPtrArgCastTypedefs();
      if (context && castTypedefs.length > 0) {
        if (!context._castTypedefs) context._castTypedefs = new Set();
        for (const name of castTypedefs) context._castTypedefs.add(name);
      }
      if (transformed.preamble) {
        // Store preamble on the context for accumulation by generateImplementation
        if (context) {
          if (!context._preambles) context._preambles = new Set();
          context._preambles.add(transformed.preamble);
        }
      }
    } else {
      body = '    // TODO: Decompilation not available';
    }

    // Apply patches if override is a "patch" type
    if (override?.action === 'patch' && override.patches) {
      const result = applyPatches(body, override.patches);
      body = result.code;
      overrideApplied = true;
    }
  }

  if (overrideApplied) {
    lines.push(`// [override: ${override!.action}]`);
  }

  // Generate function signature
  if (isMethod) {
    // Method implementation with class prefix
    const methodInfo = classInfo!.methods.find(m => m.address === func.address);
    // For method conversions, skip the this-param by index instead of by name
    const conversion = context?.methodConversions?.get(func.address);
    const isStatic = methodInfo?.isStatic || false;
    // For registry entries use configured thisParam; for auto-detected instance methods default to 0
    const thisParamIndex = conversion ? (conversion.thisParam ?? 0) : (isStatic ? undefined : 0);
    const signature = generateMethodSignature(func, classInfo!.name, isStatic, thisParamIndex);
    lines.push(signature + ' {');
  } else {
    // Standalone function — prefix with `static` if internal to this unit
    const staticPrefix = isInternal ? 'static ' : '';
    const signature = generateFunctionSignature(func);
    lines.push(staticPrefix + signature + ' {');
  }

  // Inject static-local globals owned by this function
  if (context?.analyzedGlobals) {
    // The block lands inside the file's namespace block, so its pointer
    // initializers resolve from in there — same shadowing rule as the bodies.
    setInitializerNamespace(context._enclosingResolvedNamespace);
    const block = generateStaticLocalsBlock(
      context.analyzedGlobals, func.name, options.includeAddressComments, bodyIdentifiers
    );
    setInitializerNamespace(undefined);
    // Drop spurious `&` on Ghidra array globals (`&X_ARRAY_<hex>` is `T(*)[N]`, but
    // the array name alone decays to the `T*` the pointer-array element expects).
    if (block) lines.push(block.replace(/&\s*(\w+_ARRAY_[0-9a-fA-F]+)\b(?!\s*\[)/g, '$1'));
  }

  // (`this` → the declared parameter name, `nullptr` → `0` where an integer is
  //  meant, the spurious `&` on a `<name>_ARRAY_<hex>` global, and a repeated
  //  `case` value in one switch are all done on the AST by `this-param-rewrite`,
  //  `nullptr-cleanup`, `array-global-address-of`, `switch-case-dedup`,
  //  `duplicate-label-uniquify` and `underscore-storage-alias` — see
  //  transformDecompiledCode.)
  //
  // Nothing between here and the closing brace rewrites the body's text any
  // more. One text pass over a body is left in the pipeline and it runs
  // earlier: `rewriteQuestUnionMembers`, at the transform call above, which
  // still regexes the emitted code and is owed the same move.
  //
  // `hoistSwitchPreCaseDecls` stood here and is GONE, not moved: it hoisted a
  // declaration-with-initializer sitting between `switch (x) {` and the first
  // `case`, and over the whole corpus it fires on zero bodies. Nothing puts a
  // declaration there any more - `decl-scope-sink` is the pass that used to, and
  // it now refuses to sink into a switch body for this exact reason.

  // Add function body
  lines.push(body);
  lines.push('}');

  // Accumulate body identifiers onto the context for file-local global filtering
  if (bodyIdentifiers && context) {
    if (!context._fileIdentifiers) context._fileIdentifiers = new Set();
    for (const id of bodyIdentifiers) context._fileIdentifiers.add(id);
    // Cross-file tally: count how many distinct function bodies name each
    // identifier. `bodyIdentifiers` is one set per function, so a single bump
    // per id here equals one referencing function body.
    if (!context.bodyIdentifierFnCounts) context.bodyIdentifierFnCounts = new Map();
    const counts = context.bodyIdentifierFnCounts;
    for (const id of bodyIdentifiers) counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  let result = lines.join('\n');

  return result;
}

/**
 * Resolve all override placeholders in generated implementation code.
 *
 * This is the async counterpart that reads override source files from disk.
 * Call this after generateImplementation() to replace [OVERRIDE:REPLACE] markers.
 */
export async function resolveOverridePlaceholders(
  code: string,
  overrides: OverrideRegistry
): Promise<{ code: string; warnings: string[] }> {
  const fsModule = await import('node:fs/promises');
  const pathModule = await import('node:path');

  const warnings: string[] = [];
  const regex = /    \/\/ \[OVERRIDE:REPLACE\] (.+)/g;
  let result = code;
  let match: RegExpExecArray | null;

  // Collect all matches first (to avoid mutation during iteration)
  const replacements: { full: string; sourceFile: string }[] = [];
  while ((match = regex.exec(code)) !== null) {
    replacements.push({ full: match[0], sourceFile: match[1] });
  }

  for (const { full, sourceFile } of replacements) {
    try {
      const filePath = pathModule.resolve(overrides.getProjectDir(), sourceFile);
      const content = await fsModule.readFile(filePath, 'utf-8');
      const indented = content
        .trim()
        .split('\n')
        .map(line => (line.trim() ? '    ' + line : ''))
        .join('\n');
      result = result.replace(full, indented);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Could not read override file ${sourceFile}: ${msg}`);
    }
  }

  return { code: result, warnings };
}

/**
 * Generate function signature for standalone function
 */
function signatureParameterList(func: ExtractedFunction): string {
  let params = renumberParams(func.parameters)
    .map(p => {
      const type = sigType(p.dataType);
      // Avoid param name shadowing its own type
      return `${type} ${emittedParameterName(p.name, type)}`;
    })
    .join(', ');
  if (func.hasVarArgs) params = params ? `${params}, ...` : '...';
  return params;
}

/**
 * The return type and parameter list the emitted definition declares, for the
 * wrapper the body is parsed inside. Returns undefined when the return type is
 * not spellable, so the caller keeps the signature-less wrapper rather than
 * emitting one that will not parse.
 */
function wrapperSignature(func: ExtractedFunction): { returnType: string; params: string } | undefined {
  const returnType = returnSigType(func.returnType).trim();
  if (!returnType) return undefined;
  return { returnType, params: signatureParameterList(func) };
}

function generateFunctionSignature(func: ExtractedFunction): string {
  const params = signatureParameterList(func);
  // The declaration side spells the name with the SAME function, so a definition
  // and its declaration cannot legalize a Ghidra name differently.
  const cleanName = emittedFunctionName(func, returnSigType(func.returnType));
  return `${declarationHead(returnSigType(func.returnType), func.callingConvention)}${cleanName}(${params})`;
}

/**
 * Generate method signature with class prefix
 *
 * @param thisParamIndex - If set, skip param at this index (for method conversions
 *   where the this-param has a real name like "pDrlg" instead of "this")
 */
function generateMethodSignature(
  func: ExtractedFunction,
  className: string,
  isStatic: boolean,
  thisParamIndex?: number
): string {
  // Filter out 'this' parameter for methods
  const filtered = func.parameters
    .filter((p, i) => p.name === 'this' || i === thisParamIndex ? false : true);
  let params = renumberParams(filtered)
    .map(p => `${sigType(p.dataType)} ${p.name}`)
    .join(', ');
  if (func.hasVarArgs) params = params ? `${params}, ...` : '...';

  // Check if this is a constructor or destructor
  if (func.name === className || func.name.includes('constructor')) {
    return `${className}::${className}(${params})`;
  } else if (func.name === `~${className}` || func.name.includes('destructor')) {
    return `${className}::~${className}()`;
  }

  return `${sigType(func.returnType)} ${className}::${func.name}(${params})`;
}

/**
 * Result from transforming decompiled code
 */
interface TransformDecompiledResult {
  code: string;
  preamble?: string;
  identifiers?: Set<string>;
  /** Names the body used as TYPES (see TransformResult.typeNames). */
  typeNames?: Set<string>;
}

/**
 * The function's stack frame as Ghidra models it: parameters (whose offsets come
 * out of their `Stack[0xN]:size` storage) and locals with a committed stack
 * offset. Both are frame slots; a `&stack0xNNNN` address is resolved against them.
 */
type FrameSlot = { name: string; offset: number; size: number; isParameter?: boolean; isArray?: boolean };

/** Ghidra spells an array slot `undefined1[260]`, `char[250]`, `int16_t[3]`. */
function isArrayTypeName(dataType: string | undefined): boolean {
  return !!dataType && /\[\s*\d+\s*\]\s*$/.test(dataType);
}

function frameSlots(func: ExtractedFunction): FrameSlot[] {
  const slots: FrameSlot[] = [];
  for (const p of func.parameters ?? []) {
    const m = /^Stack\[(-?0x[0-9a-fA-F]+)\]:(\d+)/.exec(p.storage ?? '');
    if (!m) continue;
    const name = cleanParamName(p.name);
    if (!name) continue;
    slots.push({ name, offset: Number.parseInt(m[1], 16), size: Number.parseInt(m[2], 10), isParameter: true, isArray: isArrayTypeName(p.dataType) });
  }
  for (const v of func.localVariables ?? []) {
    if (!v.name || typeof v.stackOffset !== 'number' || typeof v.size !== 'number') continue;
    // The same name the body was renamed to — a slot address has to resolve to
    // an identifier the body actually declares.
    const name = emittedParameterName(v.name, sigType(v.dataType ?? ''));
    slots.push({ name, offset: v.stackOffset, size: v.size, isArray: isArrayTypeName(v.dataType) });
  }
  return slots;
}

/**
 * The `struct-field` options for this run: the aggregate-type names, listed once.
 * Cached on the set itself so a per-function call does not rebuild a 3000-entry
 * array 15,000 times.
 */
const structFieldOptionsCache = new WeakMap<Set<string>, { aggregateTypeNames: string[] }>();

function structFieldPluginOptions(): { aggregateTypeNames: string[] } | undefined {
  const names = getAggregateTypeNames();
  if (!names || names.size === 0) return undefined;
  let entry = structFieldOptionsCache.get(names);
  if (!entry) {
    entry = { aggregateTypeNames: [...names] };
    structFieldOptionsCache.set(names, entry);
  }
  return entry;
}

/**
 * Replace Ghidra stack-variable artifacts: stack0xNNNNNNNN → 0.
 *
 * ONLY for a body that never reached the AST — a decompilation with no parsable
 * `{ … }`, or one the transform threw on. Those are emitted as Ghidra wrote them,
 * best-effort, and `&stack0xNNNN` is not an identifier anything declares. A body
 * that did parse is handled by the `stack-frame-address` pass, which binds the
 * address to the frame slot that owns it and leaves the rest to fail loudly;
 * substituting `0` there was a silent read of the wrong address.
 *
 * The rest of what this used to do is on the AST now — CRT/compiler namespace
 * qualifiers, the `_exref` import-thunk suffix and the `A::A::` duplicate are
 * `qualified-name-cleanup`; the `--2147483648` double negative is
 * `signed-literal`; the non-ASCII char literal is `char-literal-escape`.
 * (Ghidra's `type[N]*` pointer-to-array is flattened by `pointer-array-flatten`.)
 */
function stripStackArtifacts(code: string): string {
  return code.replace(/&?stack0x[0-9a-fA-F]+/g, '0');
}

/**
 * Replace inline Diablo 2 PRNG LCG expressions with D2_SEED_NEXT(seed) macro calls.
 * (Text-level fallback for expressions the AST transformer can't handle)
 */
export function replacePrngWithMacro(code: string): string {
  // Pattern: (D2SeedStrc)(/* PRNG: ... */ ... * 0x6ac690c5 + ...)
  // We need to match balanced parens for the outer cast expression.
  // Strategy: find "(D2SeedStrc)(" anchors, then scan for the matching close paren.
  const anchor = '(D2SeedStrc)(';
  let result = '';
  let pos = 0;

  while (pos < code.length) {
    const idx = code.indexOf(anchor, pos);
    if (idx === -1) {
      result += code.slice(pos);
      break;
    }

    result += code.slice(pos, idx);

    // Find matching close paren for the cast expression
    const exprStart = idx + anchor.length;
    let depth = 1;
    let i = exprStart;
    while (i < code.length && depth > 0) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') depth--;
      i++;
    }

    if (depth !== 0) {
      // Unbalanced — emit as-is
      result += anchor;
      pos = exprStart;
      continue;
    }

    const innerExpr = code.slice(exprStart, i - 1);

    // Check if this contains the LCG multiplier
    if (!innerExpr.includes('0x6ac690c5')) {
      result += code.slice(idx, i);
      pos = i;
      continue;
    }

    // Try to extract seed source from nSeedLow/nSeedHigh member accesses.
    // The expression contains chains of casts like (uint64_t)(uint32_t)X->sSeed.nSeedLow
    // We want to extract "X->sSeed" (i.e. everything between the last cast and .nSeedLow).
    //
    // Strategy: find ".nSeedLow" or "->nSeedLow", walk backwards to get the object,
    // then strip casts.
    const nSeedLowIdx = innerExpr.indexOf('.nSeedLow');
    const arrowSeedLowIdx = innerExpr.indexOf('->nSeedLow');

    if (nSeedLowIdx !== -1 || arrowSeedLowIdx !== -1) {
      // Pick the first occurrence
      const seedLowPos = arrowSeedLowIdx !== -1 && (nSeedLowIdx === -1 || arrowSeedLowIdx < nSeedLowIdx)
        ? arrowSeedLowIdx
        : nSeedLowIdx;

      // Extract everything before .nSeedLow
      let beforeSeedLow = innerExpr.slice(0, seedLowPos).trim();

      // Strip PRNG comment
      beforeSeedLow = beforeSeedLow.replace(/\/\*[^*]*\*\//g, '').trim();

      // Strip all leading C-style casts: (uint64_t), (uint32_t), (uint), (int), etc.
      // These appear as (type) prefixes
      while (/^\(\s*(?:u?int(?:8|16|32|64)_t|uint|int|unsigned\s+int|ulonglong|uint64_t|uint32_t)\s*\)/.test(beforeSeedLow)) {
        beforeSeedLow = beforeSeedLow.replace(/^\(\s*(?:u?int(?:8|16|32|64)_t|uint|int|unsigned\s+int|ulonglong|uint64_t|uint32_t)\s*\)\s*/, '');
      }

      // Also strip (uint64_t) or (uint32_t) that may appear after other content (rare)
      beforeSeedLow = beforeSeedLow.trim();

      // Strip trailing -> or . (accessor to nSeedLow)
      let seedExpr = beforeSeedLow.replace(/(?:->|\.)$/, '').trim();

      // Handle "this" special case: this->nSeedLow means the seed is *this
      if (seedExpr === 'this') {
        result += 'D2_SEED_NEXT(*this)';
      } else {
        result += `D2_SEED_NEXT(${seedExpr})`;
      }
      pos = i;
      continue;
    }

    // Pattern 2: value form — ((uint64_t)DVar1 & -1) * 0x6ac690c5 + ((uint64_t)DVar1 >> 0x20)
    const valueFormMatch = innerExpr.match(
      /\((?:uint64_t|ulonglong)\)\s*(\w+)\s*&\s*-1\)\s*\*\s*0x6ac690c5/
    );
    if (valueFormMatch) {
      result += `D2_SEED_NEXT_VAL(${valueFormMatch[1]})`;
      pos = i;
      continue;
    }

    // Pattern 3: mixed form — nSeedLow was extracted to a local but nSeedHigh still
    // references the seed object: ... nRandom * 0x6ac690c5 + ... X->sSeed.nSeedHigh
    const nSeedHighMatch = innerExpr.match(
      /(\b[\w.>-]+?)(?:->|\.)\s*nSeedHigh\b/
    );
    if (nSeedHighMatch) {
      let highObj = nSeedHighMatch[1].trim();
      // Strip casts from the high-side too
      while (/^\(\s*(?:u?int(?:8|16|32|64)_t|uint|int|unsigned\s+int|ulonglong)\s*\)/.test(highObj)) {
        highObj = highObj.replace(/^\(\s*(?:u?int(?:8|16|32|64)_t|uint|int|unsigned\s+int|ulonglong)\s*\)\s*/, '');
      }
      highObj = highObj.replace(/(?:->|\.)$/, '').trim();
      if (highObj === 'this') {
        result += 'D2_SEED_NEXT(*this)';
      } else {
        result += `D2_SEED_NEXT(${highObj})`;
      }
      pos = i;
      continue;
    }

    // No recognized pattern — emit as-is
    result += code.slice(idx, i);
    pos = i;
  }

  return result;
}

/**
 * Transform decompiled code using cpp-parser
 */
/**
 * Symbol tables for the `root-scope-qualify` pass: which data-symbol names the
 * generator emits at global scope, and which fully qualified names really do
 * live in a namespace. Cached per analyzed-globals array — the tables are
 * project-wide, but every function body needs them.
 */
interface RootScopeSymbolTables {
  rootScopeSymbols: string[];
  scopedSymbols: string[];
  /**
   * Root-scope data symbols a function of the same name hides. They are NOT in
   * `rootScopeSymbols` — a qualified reference to one of these names means the
   * function — but a BARE reference means the global and has to say `::name`.
   */
  functionShadowedGlobals: string[];
}
const rootScopeSymbolCache = new WeakMap<AnalyzedDataSymbol[], RootScopeSymbolTables>();

function collectRootScopeSymbols(context?: ImplGenContext): RootScopeSymbolTables | undefined {
  const globals = context?.analyzedGlobals;
  if (!globals || globals.length === 0) return undefined;

  const cached = rootScopeSymbolCache.get(globals);
  if (cached) return cached;

  const rootScopeSymbols = new Set<string>();
  const scopedSymbols = new Set<string>();
  for (const g of globals) {
    if (g.scope !== 'global') continue;
    const name = g.suggestedName || g.name;
    if (!name || !/^[A-Za-z_]\w*$/.test(name)) continue;
    const ns = g.namespace ? collapseConsecutiveDuplicates(g.namespace) : undefined;
    if (ns && !/[<>,*]/.test(ns)) scopedSymbols.add(`${ns}::${name}`);
    else rootScopeSymbols.add(name);
  }

  // A name that also denotes a function must keep its qualifier — the call is
  // resolved by the function declaration, not by the same-named global. The
  // reverse case is the bare spelling, which still means the global.
  const functionShadowedGlobals = new Set<string>();
  if (context?.functionNameToHeader) {
    for (const fn of context.functionNameToHeader.keys()) {
      const bare = fn.includes('::') ? fn.slice(fn.lastIndexOf('::') + 2) : fn;
      if (rootScopeSymbols.delete(bare)) functionShadowedGlobals.add(bare);
    }
  }

  const tables: RootScopeSymbolTables = {
    rootScopeSymbols: [...rootScopeSymbols],
    scopedSymbols: [...scopedSymbols],
    functionShadowedGlobals: [...functionShadowedGlobals],
  };
  rootScopeSymbolCache.set(globals, tables);
  return tables;
}

/**
 * Options for `namespace-shadow-qualify`, memoised per namespace-table identity —
 * the table is project-wide and every function body in the run needs it.
 */
interface ShadowQualifyOptions {
  enclosingNamespace: string;
  knownNamespaces: string[];
  scopedSymbols: string[];
}
const shadowQualifyCache = new WeakMap<Set<string>, Map<string, ShadowQualifyOptions>>();

function shadowQualifyOptions(
  context?: ImplGenContext,
  scopedSymbols: string[] = [],
): ShadowQualifyOptions | undefined {
  const enclosing = context?._enclosingNamespace;
  const known = context?.knownNamespaces;
  if (!enclosing || !known || known.size === 0) return undefined;

  let perNamespace = shadowQualifyCache.get(known);
  if (!perNamespace) {
    perNamespace = new Map();
    shadowQualifyCache.set(known, perNamespace);
  }
  let entry = perNamespace.get(enclosing);
  if (!entry) {
    entry = { enclosingNamespace: enclosing, knownNamespaces: [...known], scopedSymbols };
    perNamespace.set(enclosing, entry);
  } else if (entry.scopedSymbols.length === 0 && scopedSymbols.length > 0) {
    // The symbol table comes from the analyzed globals, which a caller may not
    // have had on the first body through this namespace. The plugin memoises its
    // transformer on the options OBJECT, so the table has to arrive as a new one
    // rather than as a mutation of the one already handed out.
    entry = { enclosingNamespace: enclosing, knownNamespaces: entry.knownNamespaces, scopedSymbols };
    perNamespace.set(enclosing, entry);
  }
  return entry;
}

/**
 * The shadowed-type table is project-wide and identical for every body, so the
 * array form the plugin wants is built once per (Set) rather than per function.
 */
const shadowedTypeCache = new WeakMap<Set<string>, { shadowedTypeNames: string[] }>();

function shadowedTypeQualifyOptions(
  context?: ImplGenContext,
): { shadowedTypeNames: string[] } | undefined {
  const names = context?.shadowedTypeNames;
  if (!names || names.size === 0) return undefined;
  let entry = shadowedTypeCache.get(names);
  if (!entry) {
    entry = { shadowedTypeNames: [...names] };
    shadowedTypeCache.set(names, entry);
  }
  return entry;
}

/**
 * Global names for `underscore-storage-alias`, memoized per context.
 *
 * Built from the analyzed globals' own `name`, which is the spelling Ghidra
 * refers to the reused slot by (`_<name>`). Rebuilding the set per function
 * would cost a pass over every global in the unit, 15k times over.
 */
const underscoreAliasCache = new WeakMap<object, { globalNames: string[]; crtFunctionNames: string[] }>();
function underscoreAliasOptions(context?: ImplGenContext): { globalNames: string[]; crtFunctionNames: string[] } {
  const crt = crtFunctionNames();
  if (!context) return { globalNames: [], crtFunctionNames: crt };
  const hit = underscoreAliasCache.get(context);
  if (hit) return hit;
  const built = {
    globalNames: (context.analyzedGlobals ?? []).map(g => g.name),
    crtFunctionNames: crt,
  };
  underscoreAliasCache.set(context, built);
  return built;
}

function transformDecompiledCode(
  decompiled: string,
  options: ReconstructOptions,
  funcName?: string,
  funcAddress?: string,
  context?: ImplGenContext,
  // name → Ghidra type string for this function's params + locals. The transform
  // wraps the body as `void dummy() {...}` (no signature), so the underscore-slot
  // plugin can't see param types from the AST — pass them in.
  varTypes?: Record<string, string>,
  // Facts about the ENCLOSING function that the body AST cannot show, because
  // the body is parsed on its own inside a `void dummy()` wrapper.
  enclosing?: {
    thisName?: string;
    returnsNonPointer?: boolean;
    /**
     * The function's own signature, spelled exactly as the emitted definition
     * spells it. The body is parsed inside a wrapper that carries it, so the
     * AST holds the real return type and the real parameter declarations - the
     * type environment every cast pass needs, from the AST rather than from a
     * side channel.
     */
    signature?: { returnType: string; params: string };
    /** Segments of the enclosing namespace block, from the resolution. */
    namespaceSegments?: readonly string[];
    /** @see the call site — the function's own Ghidra namespace path. */
    ghidraNamespaceSegments?: readonly string[];
    /** Only read when no `signature` is available - see the goto-cleanup option. */
    returnsVoid?: boolean;
    renames?: Record<string, string>;
    /**
     * Ghidra's stack frame for this function: every parameter and local with
     * committed stack storage. `stack-frame-address` resolves a bare
     * `&stack0xNNNN` frame address against it; the AST cannot show the frame,
     * because the body is parsed without one.
     */
    stackSlots?: FrameSlot[];
  },
): TransformDecompiledResult {
  try {
    // Extract just the function body (remove signature and braces)
    // CRITICAL: Match from the LAST opening paren to avoid matching { inside comments
    // Strategy: Find the function signature's closing paren, then match the next { ... }
    // This avoids false matches on {field:size} notation in PLATE comments
    let bodyMatch: RegExpMatchArray | null = null;

    // Try to match: function signature ending with ) followed by {body}
    // This handles both "func(...) {" and "func(...)\n{"
    const funcBodyMatch = decompiled.match(/\)[\s\n]*\{([\s\S]*)\}[\s\S]*$/);
    if (funcBodyMatch) {
      bodyMatch = funcBodyMatch;
    } else {
      // Fallback: Try to find the LAST { before the LAST }
      // This handles cases where there's no function signature
      const lastBraceIndex = decompiled.lastIndexOf('}');
      if (lastBraceIndex !== -1) {
        const beforeLastBrace = decompiled.substring(0, lastBraceIndex);
        const lastOpenBraceIndex = beforeLastBrace.lastIndexOf('{');
        if (lastOpenBraceIndex !== -1) {
          const body = decompiled.substring(lastOpenBraceIndex + 1, lastBraceIndex);
          bodyMatch = [decompiled, body] as RegExpMatchArray;
        }
      }
    }

    if (!bodyMatch) {
      return { code: stripStackArtifacts(indentCode(decompiled, 4)) };
    }

    const body = bodyMatch[1];

    // Pre-process Ghidra quirks before parsing
    const preprocessedBody = preprocessGhidraCode(body);

    // Try to transform through cpp-parser.
    // The wrapper carries the function's REAL signature, so the AST knows the
    // return type and the parameters. `void dummy()` used to stand here and lied
    // about both: it told `goto-cleanup` every function returned void, and it
    // hid every parameter from the type environment.
    const sig = enclosing?.signature;
    const wrapped = sig
      ? `${sig.returnType} dummy(${sig.params}) {${preprocessedBody}}`
      : `void dummy() {${preprocessedBody}}`;

    // Build plugin options for method-call-rewrite when mappings or current context exist
    let pluginOptions: Record<string, unknown> | undefined;
    const registry = context?.methodConversions;
    const mappings = context?.methodMappings ?? registry?.buildPluginMappings();

    // Check if THIS function is a converted method (for body rewriting)
    let currentFunction: { className: string; thisParamName: string } | undefined;
    if (registry && funcAddress) {
      const conversion = registry.get(funcAddress);
      if (conversion && conversion.thisParamName) {
        currentFunction = {
          className: conversion.className,
          thisParamName: conversion.thisParamName,
        };
      }
    }
    const enablePlugins: string[] = [];
    const perPluginOptions: Record<string, unknown> = {};

    // Method-conversion is dropped (free functions only), so mappings/currentFunction
    // are normally empty; keep the original guard so any stray mapping still no-ops.
    if ((mappings && Object.keys(mappings).length > 0) || currentFunction) {
      enablePlugins.push('method-call-rewrite');
      perPluginOptions['method-call-rewrite'] = { methodMappings: mappings ?? {}, currentFunction };
    }

    if (context?.functionAddressMap && context.functionAddressMap.size > 0) {
      perPluginOptions['func-ptr-literal'] = { functionAddressMap: context.functionAddressMap };
    }

    if (context?.functionRefAliases && Object.keys(context.functionRefAliases).length > 0) {
      perPluginOptions['function-name-reconcile'] = { aliases: context.functionRefAliases };
    }

    if (context?.bitfieldCatalog && context.bitfieldCatalog.size > 0) {
      perPluginOptions['bitfield-access'] = { bitfieldCatalog: context.bitfieldCatalog };
    }

    if (varTypes && Object.keys(varTypes).length > 0) {
      perPluginOptions['underscore-slot-local'] = { varTypes };
    }

    // The two `_<name>` aliases that are NOT a stack slot: a global's reused slot
    // and an MSVC-decorated CRT call. Both are name-resolution facts the AST
    // cannot hold — which symbols this unit's globals are, and which names the
    // CRT headers declare — so they arrive here. Memoized per context so the
    // plugin's transformer cache (keyed on the options object) still hits.
    perPluginOptions['underscore-storage-alias'] = {
      ...underscoreAliasOptions(context),
      varTypes: varTypes ?? {},
    };


    const fieldRenames = getStructFieldRenames();
    if (Object.keys(fieldRenames).length > 0) {
      perPluginOptions['reserved-field-rename'] = { fieldRenames };
    }

    const rootScope = collectRootScopeSymbols(context);
    if (rootScope) {
      perPluginOptions['root-scope-qualify'] = rootScope;
      if (rootScope.functionShadowedGlobals.length > 0) {
        perPluginOptions['function-shadowed-global'] = {
          functionShadowedGlobals: rootScope.functionShadowedGlobals,
        };
      }
    }

    const shadowOptions = shadowQualifyOptions(context, rootScope?.scopedSymbols ?? []);
    if (shadowOptions) {
      perPluginOptions['namespace-shadow-qualify'] = shadowOptions;
    }

    // The body is parsed inside a `void dummy()` wrapper, so the AST never
    // shows a PARAMETER's type — and a parameter handed straight on to
    // another call is the commonest argument there is. Pass them in, spelled
    // the way the signature spells them.
    const enclosingVarTypes: Record<string, string> = {};
    for (const [n, t] of Object.entries(varTypes ?? {})) {
      const spelled = sigType(t);
      enclosingVarTypes[n] = spelled;
      const renamed = enclosing?.renames?.[n];
      if (renamed) enclosingVarTypes[renamed] = spelled;
    }

    if (context?.funcPtrArgCasts) {
      // The tables are shared, but the enclosing scope is not: a bare `Draw`
      // resolves to a different function in each `D2Client::Forms::*` unit. Hand
      // the plugin the scope it must look the name up in — memoized per scope so
      // the plugin's own transformer cache (keyed on the options object) still
      // hits.
      perPluginOptions['funcptr-arg-cast'] = funcPtrArgCastsForScope(
        context.funcPtrArgCasts,
        enclosing?.ghidraNamespaceSegments ?? enclosing?.namespaceSegments,
      );
      perPluginOptions['pointer-assign-cast'] = {
        voidPointerFunctions: context.funcPtrArgCasts.voidPointerFunctions,
      };
      perPluginOptions['assign-cast'] = {
        functionReturnTypes: context.funcPtrArgCasts.functionReturnTypes,
        functionParamTypes: context.funcPtrArgCasts.functionParamTypes,
        functionConventions: context.funcPtrArgCasts.functionConventions,
        overloadedFunctionNames: context.funcPtrArgCasts.overloadedFunctionNames,
        enclosingSegments: enclosing?.ghidraNamespaceSegments ?? enclosing?.namespaceSegments,
        functionNames: context.funcPtrArgCasts.functionNames,
        variableNames: context.funcPtrArgCasts.variableNames,
        globalTypes: context.funcPtrArgCasts.globalTypes,
        funcdefNames: Object.keys(context.funcPtrArgCasts.funcdefSignatures ?? {}),
        zeroArityCallbackSlots: context.funcPtrArgCasts.zeroArityCallbackSlots,
        fieldTypes: context.funcPtrArgCasts.fieldTypes,
        typedefTargets: context.funcPtrArgCasts.typedefTargets,
        structFields: context.funcPtrArgCasts.structFields,
        funcdefDecls: context.funcPtrArgCasts.funcdefDecls,
        structFieldFuncdefs: context.funcPtrArgCasts.structFieldFuncdefs,
        fieldFuncdefs: context.funcPtrArgCasts.fieldFuncdefs,
        rootQualifiedTypedefs: context.funcPtrArgCasts.rootQualifiedTypedefs,
        enclosingVarTypes,
      };
      perPluginOptions['bitfield-alias-lower'] = {
        aggregateMembers: context.funcPtrArgCasts.aggregateMembers,
        structFields: context.funcPtrArgCasts.structFields,
        fieldTypes: context.funcPtrArgCasts.fieldTypes,
        globalTypes: context.funcPtrArgCasts.globalTypes,
        returnTypes: context.funcPtrArgCasts.functionReturnTypes,
        typedefTargets: context.funcPtrArgCasts.typedefTargets,
        enclosingVarTypes,
      };
      perPluginOptions['pointer-compare-cast'] = {
        globalTypes: context.funcPtrArgCasts.globalTypes,
        fieldTypes: context.funcPtrArgCasts.fieldTypes,
        structFields: context.funcPtrArgCasts.structFields,
        typedefTargets: context.funcPtrArgCasts.typedefTargets,
        functionReturnTypes: context.funcPtrArgCasts.functionReturnTypes,
        enclosingVarTypes,
      };
      perPluginOptions['array-block-assign'] = {
        globalTypes: context.funcPtrArgCasts.globalTypes,
      };
      perPluginOptions['indirect-call-cleanup'] = {
        globalTypes: context.funcPtrArgCasts.globalTypes,
        fieldTypes: context.funcPtrArgCasts.fieldTypes,
        structFields: context.funcPtrArgCasts.structFields,
        fieldFuncdefs: context.funcPtrArgCasts.fieldFuncdefs,
        structFieldFuncdefs: context.funcPtrArgCasts.structFieldFuncdefs,
        typedefTargets: context.funcPtrArgCasts.typedefTargets,
        enclosingVarTypes,
      };
      perPluginOptions['narrow-cast-through-uintptr'] = {
        globalTypes: context.funcPtrArgCasts.globalTypes,
        fieldTypes: context.funcPtrArgCasts.fieldTypes,
        structFields: context.funcPtrArgCasts.structFields,
        typedefTargets: context.funcPtrArgCasts.typedefTargets,
        functionReturnTypes: context.funcPtrArgCasts.functionReturnTypes,
        funcdefNames: Object.keys(context.funcPtrArgCasts.funcdefSignatures ?? {}),
        enclosingVarTypes,
      };
      perPluginOptions['float-pointer-bitcast'] = {
        globalTypes: context.funcPtrArgCasts.globalTypes,
        fieldTypes: context.funcPtrArgCasts.fieldTypes,
        structFields: context.funcPtrArgCasts.structFields,
        convertingAggregates: context.funcPtrArgCasts.convertingAggregates,
        typedefTargets: context.funcPtrArgCasts.typedefTargets,
        functionReturnTypes: context.funcPtrArgCasts.functionReturnTypes,
        enclosingVarTypes,
      };
      perPluginOptions['call-arg-cast'] = {
        functionParamTypes: context.funcPtrArgCasts.functionParamTypes,
        pointerOnlyParamTypes: context.funcPtrArgCasts.pointerOnlyParamTypes,
        functionReturnTypes: context.funcPtrArgCasts.functionReturnTypes,
        functionNames: context.funcPtrArgCasts.functionNames,
        variableNames: context.funcPtrArgCasts.variableNames,
        globalTypes: context.funcPtrArgCasts.globalTypes,
        varArgFunctions: context.funcPtrArgCasts.varArgFunctions,
        funcdefNames: Object.keys(context.funcPtrArgCasts.funcdefSignatures ?? {}),
        fieldTypes: context.funcPtrArgCasts.fieldTypes,
        typedefTargets: context.funcPtrArgCasts.typedefTargets,
        structFields: context.funcPtrArgCasts.structFields,
        funcdefDecls: context.funcPtrArgCasts.funcdefDecls,
        structFieldFuncdefs: context.funcPtrArgCasts.structFieldFuncdefs,
        fieldFuncdefs: context.funcPtrArgCasts.fieldFuncdefs,
        enclosingVarTypes,
      };
    }

    if (enclosing?.thisName) {
      perPluginOptions['this-param-rewrite'] = { thisName: enclosing.thisName };
    }

    if (enclosing?.stackSlots && enclosing.stackSlots.length > 0) {
      perPluginOptions['stack-frame-address'] = { slots: enclosing.stackSlots };
    }

    const shadowedTypes = shadowedTypeQualifyOptions(context);
    if (shadowedTypes) {
      perPluginOptions['shadowed-type-qualify'] = shadowedTypes;
    }

    // goto-cleanup reads the enclosing return type off the AST. It is the real one
    // whenever the wrapper carries a signature; a caller that parses a bare body
    // without one still has to say so, or a fabricated bare `return;` at the tail
    // of a non-void function would drop the value the caller reads.
    if (!sig) perPluginOptions['goto-cleanup'] = { enclosingReturnsVoid: enclosing?.returnsVoid === true };

    // `x = nullptr` / `return nullptr` where an integer is meant does not compile
    // ("cannot convert nullptr_t to uint32_t"); `0` is valid for both pointers and
    // integers. The return form is only safe once the return type is known not to
    // be a pointer, which only the caller can say.
    perPluginOptions['nullptr-cleanup'] = {
      zeroForAssignedNullptr: true,
      zeroForReturnedNullptr: enclosing?.returnsNonPointer === true,
    };

    // Inside a namespace block the enclosing scopes are already open, so the
    // callee's full path is redundant — but only where the shortened form still
    // resolves to the same entity. Segments come from the resolution.
    const enclosingSegments = enclosing?.namespaceSegments;
    if (enclosingSegments && enclosingSegments.length > 0) {
      perPluginOptions['enclosing-namespace-strip'] = {
        enclosingSegments: [...enclosingSegments],
        knownNamespaces: context?.knownNamespaces ? [...context.knownNamespaces] : undefined,
      };
    }

    // Ghidra hangs a class's members under a namespace named after the class;
    // the emitter puts them in the parent. The reference side has to agree, and
    // it is decided on the name node.
    const collisionTypeNames = context?._namespaceCollisionTypeNames;
    if (collisionTypeNames && collisionTypeNames.length > 0) {
      perPluginOptions['qualified-name-cleanup'] = { typeQualifierNames: collisionTypeNames };
    }

    // Which pointee types have members. Without it `struct-field` reads a Win32
    // pointer typedef as a struct and writes `((HANDLE*)p)->field_10`, which
    // Ghidra never said and nothing declares.
    const structFieldOptions = structFieldPluginOptions();
    if (structFieldOptions) perPluginOptions['struct-field'] = structFieldOptions;

    const funcdefTypedefs = getKnownFuncDefTypedefs();
    if (funcdefTypedefs.length > 0) {
      perPluginOptions['funcdef-cast-collapse'] = { funcdefTypedefs };
    }

    // A case label must be a constant expression; only an enumerator identifier
    // is one. Without this set switch-reconstruct treats every identifier as a
    // constant and manufactures a switch over pointer-typed globals.
    const enumConstants = getKnownEnumConstants();
    if (enumConstants.length > 0) {
      perPluginOptions['switch-reconstruct'] = { enumConstants };
    }

    // A constant name several enums number differently is exported by none of
    // them, so the only spelling that resolves is the qualified one. Which enum
    // is meant comes from the controlling type, which needs the same object-type
    // tables `call-arg-cast` reads.
    const ambiguousEnumConstants = context?._ambiguousEnumConstants;
    if (ambiguousEnumConstants && ambiguousEnumConstants.length > 0) {
      perPluginOptions['enum-constant-qualify'] = {
        ambiguousConstants: ambiguousEnumConstants,
        enumMembers: context?._enumMembers,
        structFields: context?.funcPtrArgCasts?.structFields,
        fieldTypes: context?.funcPtrArgCasts?.fieldTypes,
        globalTypes: context?.funcPtrArgCasts?.globalTypes,
        returnTypes: context?.funcPtrArgCasts?.functionReturnTypes,
        functionParamTypes: context?.funcPtrArgCasts?.functionParamTypes,
        enclosingSegments: enclosing?.ghidraNamespaceSegments ?? enclosing?.namespaceSegments,
        enclosingVarTypes,
      };
    }

    if (enablePlugins.length > 0 || Object.keys(perPluginOptions).length > 0) {
      pluginOptions = {
        ...(enablePlugins.length > 0 ? { enablePlugins } : {}),
        pluginOptions: perPluginOptions,
      };
    }

    const result = transformGhidraCode(wrapped, {
      preset: options.transformPreset === 'custom' ? 'quick' : options.transformPreset,
      tolerateErrors: true,
      usePluginRegistry: true,  // Enable all registered plugins including fourcc
      pluginOptions: pluginOptions as any,
      // Signature-driven identifier renames, applied on the AST after the pipeline
      renames: enclosing?.renames,
      // Always brace single-statement control-flow bodies (no `if (c) return;`)
      // and space loops/blocks apart with blank lines for readability.
      emitOptions: { alwaysUseBraces: true, blankLineAroundControlFlow: true },
    });

    if (result.success) {
      // Extract transformed body
      const transformedMatch = result.code.match(/\{([\s\S]*)\}/);
      if (transformedMatch) {
        return {
          // NOT stripStackArtifacts: `stack-frame-address` has already bound every
          // frame address the frame can account for, and a name that survives it
          // is one no local owns. Rewriting it to `0` here is what turned sixteen
          // of them into silent reads of the wrong address.
          code: indentCode(transformedMatch[1], 4),
          preamble: result.preamble,
          identifiers: result.identifiers,
          typeNames: result.typeNames,
        };
      }
    }

    // Log parse failure with all available context
    const errorDetail = result.error ?? 'transform returned success=false';
    logParseError(
      errorDetail,
      funcName ?? '<unknown>',
      funcAddress ?? '???',
      wrapped,
      result.warnings
    );

    // Fall back to original body if transformation fails
    return { code: stripStackArtifacts(indentCode(body, 4)) };
  } catch (err) {
    // Stack overflow: do minimal work to avoid overflowing again in the handler
    if (err instanceof RangeError && /call stack|stack size/i.test(err.message)) {
      parseErrorCount++;
      console.error(`[STACK OVERFLOW] ${funcName ?? '<unknown>'} @ ${funcAddress ?? '???'} — using raw body`);
      return { code: stripStackArtifacts(indentCode(decompiled, 4)) };
    }

    const msg = err instanceof Error
      ? `${err.message}${err.stack ? '\n' + err.stack : ''}`
      : String(err);
    logParseError(msg, funcName ?? '<unknown>', funcAddress ?? '???', decompiled);

    // If transformation fails, return original code indented
    return { code: stripStackArtifacts(indentCode(decompiled, 4)) };
  }
}

/**
 * Indent code by specified amount, preserving relative indentation
 */
function indentCode(code: string, baseSpaces: number): string {
  const lines = code.split('\n');

  // Strip blank lines at the top/bottom WITHOUT touching interior indentation.
  // (Callers must not .trim() the input: trimming dedents the first line, which
  // would collapse minIndent to 0 and under-indent that line vs the rest.)
  while (lines.length && lines[0].trim().length === 0) lines.shift();
  while (lines.length && lines[lines.length - 1].trim().length === 0) lines.pop();

  // Find minimum indentation (ignoring empty lines)
  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const leadingSpaces = line.match(/^ */)?.[0].length ?? 0;
    minIndent = Math.min(minIndent, leadingSpaces);
  }
  if (minIndent === Infinity) minIndent = 0;

  return lines
    .map(line => {
      if (line.trim().length === 0) return '';
      const leadingSpaces = line.match(/^ */)?.[0].length ?? 0;
      const relativeIndent = leadingSpaces - minIndent;
      return ' '.repeat(baseSpaces + relativeIndent) + line.trimStart();
    })
    .join('\n');
}

/**
 * Generate implementation for all functions in a class
 */
export function generateClassImplementation(
  classInfo: DetectedClass,
  functions: ExtractedFunction[],
  options: ReconstructOptions,
  context?: ImplGenContext
): string {
  const lines: string[] = [];

  // Group methods by type
  const constructors = classInfo.methods.filter(m => m.isConstructor);
  const destructors = classInfo.methods.filter(m => m.isDestructor);
  const virtualMethods = classInfo.methods.filter(m => m.isVirtual && !m.isDestructor);
  const regularMethods = classInfo.methods.filter(
    m => !m.isConstructor && !m.isDestructor && !m.isVirtual
  );

  // Constructor implementations
  for (const method of constructors) {
    const func = functions.find(f => f.address === method.address);
    if (func) {
      lines.push(generateFunctionImplementation(func, classInfo, options, context));
      lines.push('');
    }
  }

  // Destructor implementations
  for (const method of destructors) {
    const func = functions.find(f => f.address === method.address);
    if (func) {
      lines.push(generateFunctionImplementation(func, classInfo, options, context));
      lines.push('');
    }
  }

  // Virtual method implementations
  for (const method of virtualMethods) {
    const func = functions.find(f => f.address === method.address);
    if (func) {
      lines.push(generateFunctionImplementation(func, classInfo, options, context));
      lines.push('');
    }
  }

  // Regular method implementations
  for (const method of regularMethods) {
    const func = functions.find(f => f.address === method.address);
    if (func) {
      lines.push(generateFunctionImplementation(func, classInfo, options, context));
      lines.push('');
    }
  }

  return lines.join('\n');
}
