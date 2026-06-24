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
} from '../types.js';
import { isPlatformOrBuiltinType, isStructType, castPointerInitializer } from './platform-types.js';
import { resolveCrtInclude } from './crt-mapping.js';
import { CPP_KEYWORDS } from './header.js';

// Import cpp-parser for code transformation
import { transformGhidraCode, preprocessGhidraCode, isGhidraGeneratedName, suggestBetterName, type TransformResult } from '@ghidra-mcp/cpp-parser';
import { parseTemplateName, collapseConsecutiveDuplicates } from './namespace.js';
import { cleanFunctionComment } from './header.js';
import { normalizeSignatureType, collapseFuncPtrTypedef } from './platform-types.js';
import { generateStaticLocalsBlock, emitDataValue, inferArrayDeclaration, normalizeArrayDeclaration, isFuncDefTypedefName } from './globals-header.js';

/** normalizeSignatureType + fn-ptr-typedef double-indirection collapse, for
 *  emitting function parameter and return types ("fpFoo *" → "fpFoo"). */
function sigType(type: string): string {
  return collapseFuncPtrTypedef(normalizeSignatureType(type), isFuncDefTypedefName);
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

/**
 * Synthesize declarations for `_<base>` storage-slot locals Ghidra references
 * but never declares.
 *
 * Ghidra's decompiler sometimes reuses a parameter/local's STORAGE SLOT as a
 * fresh local after the original value is dead, naming it `_<base>` (one leading
 * underscore over the original `<base>`). It emits no declaration for it, so the
 * copied-verbatim body USES `_<base>` but never DECLARES it → a compile error
 * ("'_foo' was not declared in this scope; did you mean 'foo'?").
 *
 * For every `_<base>` that is (a) used in the body, (b) not already declared
 * (not a param, not a body-declared local), and (c) whose `<base>` resolves to a
 * known parameter or local, we prepend `<baseType> _<base>;` to the body, reusing
 * the base's type (falling back to `int` when it can't be resolved).
 *
 * Deliberately skips `_DAT_*` / `_LAB_*` and any `_<base>` whose base is unknown
 * — those are globals/labels handled by globals.h / the safety net, not slot reuse.
 */
function declareUnderscoreSlotLocals(
  body: string,
  func: ExtractedFunction,
  globalNames?: Set<string>
): string {
  // Type by name for params and decompiler-declared locals.
  const typeByName = new Map<string, string>();
  for (const p of func.parameters ?? []) {
    const n = cleanParamName(p.name);
    if (n && p.dataType) typeByName.set(n, p.dataType);
  }
  for (const v of func.localVariables ?? []) {
    if (v.name && v.dataType && !typeByName.has(v.name)) typeByName.set(v.name, v.dataType);
  }

  // Names declared inline in the body text (`  type name;` / `type name [= ...];`).
  // Also feeds the type map for locals not present in func.localVariables.
  const declaredInBody = new Set<string>();
  const declRe = /^[ \t]*([A-Za-z_][\w:<>,* ]*?[ *])([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*(?:=|;)/gm;
  let dm: RegExpExecArray | null;
  while ((dm = declRe.exec(body)) !== null) {
    const declType = dm[1].trim();
    const declName = dm[2];
    // Filter out control-flow / call statements masquerading as declarations.
    if (/^(if|for|while|switch|return|do|else|case|goto|sizeof)$/.test(declName)) continue;
    declaredInBody.add(declName);
    if (!typeByName.has(declName)) typeByName.set(declName, declType);
  }

  const declared = new Set<string>([...typeByName.keys(), ...declaredInBody]);

  // MSVC-decorated CRT calls: Ghidra emits `_memmove(...)`, `_isspace(...)` etc.
  // for the standard CRT functions. The leading underscore is MS decoration; the
  // include resolver already strips it to pick the header, but the call site stays
  // `_memmove(` and is undeclared. Rewrite undeclared `_<base>(` to `<base>(` when
  // <base> resolves to a CRT function so it binds to the included header.
  body = body.replace(/\b_([a-z]\w*)\s*\(/g, (m, base) => {
    if (declared.has('_' + base)) return m;
    return resolveCrtInclude(base) ? `${base}(` : m;
  });

  // `_<global>` storage aliases: Ghidra references a global's reused slot as
  // `_<global>` (one leading underscore) without declaring it. When <global> is a
  // known program global, the underscore form is the same storage — rewrite it to
  // the real global so it binds to the emitted declaration.
  if (globalNames && globalNames.size > 0) {
    body = body.replace(/\b_([A-Za-z]\w*)\b/g, (m, base) =>
      !declared.has('_' + base) && globalNames.has(base) ? base : m,
    );
  }

  // Collect `_<base>` identifiers actually referenced in the body.
  const synth = new Map<string, string>(); // name → type
  const useRe = /\b(_[A-Za-z_]\w*)\b/g;
  let um: RegExpExecArray | null;
  while ((um = useRe.exec(body)) !== null) {
    const name = um[1];
    if (declared.has(name) || synth.has(name)) continue;
    const base = name.slice(1); // strip ONE leading underscore
    // Skip globals/labels: _DAT_*, _LAB_*, and bases that aren't known params/locals.
    if (base.startsWith('DAT_') || base.startsWith('LAB_')) continue;
    if (!declared.has(base)) continue;
    const baseType = typeByName.get(base) ?? 'int';
    synth.set(name, baseType);
  }

  if (synth.size === 0) return body;

  const decls = [...synth.entries()]
    .map(([name, type]) => `    ${type} ${name};`)
    .join('\n');
  return `${decls}\n${body}`;
}

/**
 * Ghidra's control-flow recovery sometimes emits the SAME address-labeled block
 * twice in one function (identical code, each region with its own gotos to it),
 * producing duplicate `LAB_xxxx:` definitions — a C++ error, and `goto` targets
 * become ambiguous. Uniquify the 2nd+ definition of each duplicated label and
 * retarget each `goto` to the most-recent PRECEDING definition (these blocks use
 * backward gotos). Safe for compilability: every goto still resolves to an
 * existing label; at worst a forward goto picks an earlier copy (control flow was
 * already approximate). Only touches Ghidra label names (LAB_/switchD_/…).
 */
function uniquifyDuplicateLabels(body: string): string {
  const isGhidraLabel = (n: string) => /^(LAB|switchD|caseD|joined|code|UNRECOVERED)_/.test(n);
  const labelDef = /^(\s*)([A-Za-z_]\w*):(\s*(?:\/\/.*)?)$/;
  const lines = body.split('\n');

  const totalDefs = new Map<string, number>();
  for (const line of lines) {
    const m = labelDef.exec(line);
    if (m && isGhidraLabel(m[2])) totalDefs.set(m[2], (totalDefs.get(m[2]) ?? 0) + 1);
  }
  const dup = new Set([...totalDefs].filter(([, c]) => c >= 2).map(([n]) => n));
  if (dup.size === 0) return body;

  const seen = new Map<string, number>(); // definitions of each dup label seen so far
  const out = lines.map(line => {
    const dm = labelDef.exec(line);
    if (dm && dup.has(dm[2])) {
      const n = (seen.get(dm[2]) ?? 0) + 1;
      seen.set(dm[2], n);
      const name = n === 1 ? dm[2] : `${dm[2]}__dup${n}`;
      return `${dm[1]}${name}:${dm[3]}`;
    }
    return line.replace(/\bgoto\s+([A-Za-z_]\w*)\s*;/g, (g, lbl) => {
      if (!dup.has(lbl)) return g;
      const n = seen.get(lbl) ?? 0; // most recent PRECEDING definition
      return n <= 1 ? `goto ${lbl};` : `goto ${lbl}__dup${n};`;
    });
  });
  return out.join('\n');
}

/**
 * Ghidra emits a declaration-with-initializer between `switch (x) {` and the
 * first `case` — unreachable code that the case labels jump over, so C++ rejects
 * it ("jump to case label crosses initialization of 'T x'"). Hoist such
 * declarations to before the switch (they become reachable, the value is still
 * available to the cases). Conservative: bails on any nesting in the pre-case
 * region; only moves simple `TYPE name = expr;` lines.
 */
function hoistSwitchPreCaseDecls(body: string): string {
  const lines = body.split('\n');
  const declRe = /^(\s*)((?:[A-Za-z_][\w:<>]*\s*[*&]?\s+)+)([A-Za-z_]\w*)\s*=\s*[^;]+;\s*$/;
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*switch\s*\(.*\)\s*\{\s*$/.test(lines[i])) { result.push(lines[i]); continue; }
    const hoisted: string[] = [];
    const keep: string[] = [];
    let j = i + 1;
    let reachedCase = false;
    for (; j < lines.length; j++) {
      if (/^\s*(case\b|default\s*:)/.test(lines[j])) { reachedCase = true; break; }
      if (/[{}]/.test(lines[j])) break; // bail on nesting
      const dm = declRe.exec(lines[j]);
      if (dm && !/^(if|for|while|switch|return|do|else|goto|sizeof)$/.test(dm[3])) {
        hoisted.push(lines[j].trimStart());
      } else {
        keep.push(lines[j]);
      }
    }
    if (reachedCase && hoisted.length > 0) {
      const indent = lines[i].match(/^\s*/)?.[0] ?? '';
      for (const h of hoisted) result.push(indent + h);
      result.push(lines[i]);
      for (const k of keep) result.push(k);
      i = j - 1;
    } else {
      result.push(lines[i]);
    }
  }
  return result.join('\n');
}

/**
 * Ghidra's switch recovery sometimes emits the same `case` value (or `default`)
 * twice in one switch — a malformed double-block where the 2nd occurrence is
 * unreachable (the 1st already matches that value). C++ rejects duplicate case
 * values / multiple defaults. Comment out the duplicate LABEL (keeping its body
 * as now-explicitly-unreachable code) so the switch compiles. Brace-depth stack
 * tracks nested switches.
 */
function dedupSwitchCases(body: string): string {
  const lines = body.split('\n');
  let depth = 0;
  const stack: Array<{ depth: number; seen: Set<string>; hasDefault: boolean }> = [];
  const out = lines.map(line => {
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    let res = line;
    const cur = stack.length ? stack[stack.length - 1] : null;
    if (cur) {
      const cm = /^(\s*)case\s+([^:]+):(.*)$/.exec(line);
      const dm = /^(\s*)default\s*:(.*)$/.exec(line);
      if (cm) {
        const val = cm[2].trim();
        if (cur.seen.has(val)) res = `${cm[1]}/* dup case ${val} */${cm[3]}`;
        else cur.seen.add(val);
      } else if (dm) {
        if (cur.hasDefault) res = `${dm[1]}/* dup default */${dm[2]}`;
        else cur.hasDefault = true;
      }
    }
    if (/\bswitch\s*\(.*\)\s*\{/.test(line)) stack.push({ depth: depth + 1, seen: new Set(), hasDefault: false });
    depth += opens - closes;
    while (stack.length && depth < stack[stack.length - 1].depth) stack.pop();
    return res;
  });
  return out.join('\n');
}

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
 * Rewrite wrong quest union member accesses based on function name or source file.
 * e.g. in Q04_xxx: `.pA1Q1->` → `.pA1Q4->`
 *
 * Matches three patterns (in priority order):
 * 1. QNN_ prefix (quest callback naming): Q04_DespawnRogueGuards
 * 2. A#Q# in function name (object/operation naming): OBJOP_A1Q4_ActivateInifussTree
 * 3. A#Q# in source file path: D2Game/Quests/A1Q4.cpp
 */
function rewriteQuestUnionMembers(code: string, funcName: string, sourceFile?: string): string {
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
  if (member) code = code.replace(/\.p(A[1-5]Q\d+)\b/g, `.${member}`);

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
 * Strip namespace components that collide with struct/union/enum type names.
 * e.g. "D2Client::Forms::D2WinImage" → "D2Client::Forms" if D2WinImage is a struct.
 * Returns the cleaned namespace (or undefined if all components were stripped).
 */
function stripCollidingNamespaceComponents(ns: string, typeNames: Set<string>): string | undefined {
  const parts = ns.split('::');
  const cleaned = parts.filter(p => !typeNames.has(p));
  return cleaned.length > 0 ? cleaned.join('::') : undefined;
}

/**
 * Build a regex and replacement map for rewriting qualified references
 * that include type-name namespace components.
 * e.g. "Forms::D2WinImage::FuncName" → "Forms::FuncName"
 *
 * Only strips the type-name when it is the PENULTIMATE component (directly
 * before the function/member name), never when it is a true intermediate
 * namespace with further sub-components.  Without this guard, a path like
 * "D2Common::Item::ItemMods::Fn" (where Item is both a struct name and a
 * real namespace) would have ::Item:: stripped, leaving the sibling-scope
 * "D2Common::ItemMods::Fn" which is unreachable from a file in D2Common::Items.
 */
function buildNamespaceCollisionRewriter(typeNames: Set<string>): (body: string) => string {
  if (!typeNames || typeNames.size === 0) return (body) => body;
  // Remove "TypeName::" from qualified namespace paths ONLY when preceded by "::"
  // This preserves class-qualified uses like "D2QuestDataStrc::Method()" (first qualifier)
  // but strips mid-path namespace uses like "Forms::D2WinImage::Func()" → "Forms::Func()"
  const escaped = [...typeNames].filter(n => /^[A-Za-z_]\w*$/.test(n)).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (escaped.length === 0) return (body) => body;
  // Only match ::TypeName:: (mid-path) when NOT followed by another identifier::
  // (i.e. TypeName must be the penultimate qualifier, not an intermediate namespace)
  const pattern = new RegExp(`(::)(${escaped.join('|')})::(?![A-Za-z_]\\w*::)`, 'g');
  return (body: string) => body.replace(pattern, (match, prefix) => prefix);
}

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
  /** Internal: accumulated preambles from injection-aware plugins */
  _preambles?: Set<string>;
  /** Enum type names moved to shared d2_enums.h — skip in per-file headers */
  _sharedEnumTypes?: Set<string>;
  /**
   * Full set of namespace paths that exist in the project (e.g.
   * "D2Common::Unit::Path", "D2Common::Path::DynamicPath"). Used to make
   * redundant-qualifier stripping collision-aware: a prefix is only stripped
   * if the remaining leading segment can't be captured by a sibling namespace
   * reachable from a deeper enclosing scope.
   */
  knownNamespaces?: Set<string>;
  /** Map from function address (bigint) to function name for pointer literal resolution */
  functionAddressMap?: Map<bigint, string>;
  /** Map from function name to its header path — for adding includes when func-ptr-literal resolves references */
  functionNameToHeader?: Map<string, string>;
  /** Bitfield catalog: "field_0xNN:mask" → bitfield member name */
  bitfieldCatalog?: Map<string, string>;
  /** Current source file name (e.g., "D2Game/Quests/A1Q4") — used for quest union rewriting */
  sourceFileName?: string;
  /** BuildInfo output — populated by generateFilesForFunctions after graph resolution */
  _buildInfo?: import('../modules/buildinfo.js').BuildInfo;
  /** Internal: accumulated identifiers from all function bodies in the current file */
  _fileIdentifiers?: Set<string>;
  /**
   * Internal: for each body identifier, how many distinct function bodies (across
   * ALL files) reference it. Drives the globals.h "referenced-but-undeclared"
   * safety net — a static-local symbol named in >1 body needs an extern so those
   * other bodies compile. Unlike `_fileIdentifiers`, this is NOT reset per file.
   */
  bodyIdentifierFnCounts?: Map<string, number>;
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
  /** Set of data type names (struct/union/enum) that collide with namespace components */
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

  // Cross-file includes
  if (extraIncludes && extraIncludes.length > 0) {
    for (const inc of [...extraIncludes].sort()) {
      lines.push(`#include "${inc}"`);
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
  let namespace = allMethods ? undefined : (rawNamespace ?? undefined);

  // Collapse consecutive duplicate namespace segments (e.g., Monsters::Monsters → Monsters)
  if (namespace) {
    namespace = collapseConsecutiveDuplicates(namespace);
  }

  // Strip namespace components that collide with struct/union/enum type names
  if (namespace && dataTypeNames && dataTypeNames.size > 0) {
    namespace = stripCollidingNamespaceComponents(namespace, dataTypeNames);
  }

  // Only emit namespace block if it's a valid C++ namespace (not a template instantiation)
  const useNamespace = namespace && options.organization === 'namespace' && isValidNamespace(namespace);

  // Open namespace
  if (useNamespace) {
    lines.push(`namespace ${namespace} {`);
    lines.push('');
  }

  // File-local globals are deferred until after function bodies are generated,
  // so we can filter out globals whose names don't appear in any function body.
  const fileLocalInsertIndex = lines.length;
  // Reset accumulated identifiers for this file
  if (context) context._fileIdentifiers = undefined;

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
      impl = generateFunctionImplementation(func, classInfo, options, context, isInternal);
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
    const fileIds = context._fileIdentifiers;
    const fileLocalLines: string[] = [];
    for (const global of context.fileLocalGlobals) {
      let type = global.suggestedType || global.dataType;
      let name = global.suggestedName || global.name;

      // Sanitize name
      name = name.replace(/[^A-Za-z0-9_]/g, '_');
      if (/^\d/.test(name)) name = '_' + name;
      if (!name || name === '_') name = `_global_${global.address}`;

      // Skip globals not referenced in any function body
      if (fileIds && !fileIds.has(name)) continue;

      if (type === 'auto') type = 'int';

      if (global.initializedData) {
        const arrayInfo = inferArrayDeclaration(global);
        const initializer = emitDataValue(global.initializedData, 0);
        if (arrayInfo && global.initializedData.kind === 'array') {
          fileLocalLines.push(`static ${arrayInfo.type} ${name}[${arrayInfo.count}] = ${initializer};`);
        } else {
          fileLocalLines.push(`static ${normalizeArrayDeclaration(type, name)} = ${initializer};`);
        }
      } else if (global.isInitialized) {
        let value = global.value ?? '0';
        if (/^[0-9a-fA-F]+$/.test(value) && /[a-fA-F]/.test(value)) {
          value = `0x${value}`;
        }
        if ((value === '0' || value === '0x0') && isStructType(type)) {
          value = '{}';
        }
        const arrayInfo = inferArrayDeclaration(global);
        if (arrayInfo) {
          fileLocalLines.push(`static ${arrayInfo.type} ${name}[${arrayInfo.count}] = { ${value} };`);
        } else {
          value = castPointerInitializer(type, value);
          const decl = normalizeArrayDeclaration(type, name);
          const isArray = /\[\d+\]/.test(decl);
          if (isArray) {
            fileLocalLines.push(`static ${decl} = { ${value} };`);
          } else {
            fileLocalLines.push(`static ${decl} = ${value};`);
          }
        }
      } else {
        if (type === 'auto') type = 'int';
        const arrayInfo = inferArrayDeclaration(global);
        if (arrayInfo) {
          fileLocalLines.push(`static ${arrayInfo.type} ${name}[${arrayInfo.count}];`);
        } else {
          fileLocalLines.push(`static ${normalizeArrayDeclaration(type, name)};`);
        }
      }
    }

    if (fileLocalLines.length > 0) {
      lines.splice(fileLocalInsertIndex, 0, ...fileLocalLines, '');
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

  // Collapse consecutive duplicate namespace segments in qualified references
  // e.g. "Dungeon::Dungeon::GetFunc" → "Dungeon::GetFunc"
  output = collapseConsecutiveDuplicateQualifiers(output);

  // Strip type-name namespace components from qualified references
  // e.g. "Forms::D2WinImage::FuncName" → "Forms::FuncName" when D2WinImage is a struct
  if (dataTypeNames && dataTypeNames.size > 0) {
    output = buildNamespaceCollisionRewriter(dataTypeNames)(output);
  }

  // Strip redundant namespace qualifiers from function bodies
  if (useNamespace && namespace) {
    output = stripRedundantNamespaceQualifiers(output, namespace, context?.knownNamespaces);
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
  isInternal?: boolean
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

  if (override?.action === 'replace') {
    // Full replacement — body will be loaded async, so we use a sync placeholder.
    // The actual async loading happens in generateImplementationAsync() below.
    // For sync callers, we mark it for later resolution.
    body = `    // [OVERRIDE:REPLACE] ${override.sourceFile ?? 'unknown'}`;
    overrideApplied = true;
  } else {
    // Start with decompiled code or placeholder
    if (func.decompiled) {
      const transformed = transformDecompiledCode(func.decompiled, options, func.name, func.address, context);
      body = func.name ? rewriteQuestUnionMembers(transformed.code, func.name, context?.sourceFileName) : transformed.code;
      bodyIdentifiers = transformed.identifiers;
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

  // Renumber param_N_NN names in body to match signature renumbering
  {
    let counter = 1;
    for (const p of func.parameters) {
      const origName = p.name === 'this' ? 'pThis' : p.name;
      if (/^param_\d+(_\d+)?$/.test(origName)) {
        const newName = `param_${counter}`;
        if (origName !== newName) {
          body = body.replace(new RegExp(`\\b${origName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), newName);
        }
        counter++;
      }
    }
  }

  // Generate function signature
  const isMethod = classInfo && classInfo.methods.some(m => m.address === func.address);

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
    const block = generateStaticLocalsBlock(
      context.analyzedGlobals, func.name, options.includeAddressComments, bodyIdentifiers
    );
    // Drop spurious `&` on Ghidra array globals (`&X_ARRAY_<hex>` is `T(*)[N]`, but
    // the array name alone decays to the `T*` the pointer-array element expects).
    if (block) lines.push(block.replace(/&\s*(\w+_ARRAY_[0-9a-fA-F]+)\b(?!\s*\[)/g, '$1'));
  }

  // If a parameter was renamed from `this` to `pThis`, apply the same rename in the body
  if (func.parameters?.some(p => p.name === 'this')) {
    body = body.replace(/\bthis\b/g, 'pThis');
  }

  // For non-method functions, replace `this` in the body.
  // Ghidra's decompiler uses `this` for thiscall-convention functions, but the codegen emits
  // these as standalone functions. If param is named `this`, it becomes `pThis`.
  // If the body uses `this` but no param is named `this`, replace with first param name.
  if (!isMethod && /\bthis\b/.test(body)) {
    const hasThisParam = func.parameters.some(p => p.name === 'this');
    if (hasThisParam) {
      body = body.replace(/\bthis\b/g, 'pThis');
    } else if (func.parameters.length > 0) {
      const firstParam = cleanParamName(func.parameters[0].name);
      body = body.replace(/\bthis\b/g, firstParam);
    }
  }

  // Replace "return nullptr" with "return 0" for functions returning non-pointer types
  // Ghidra decompiler sometimes emits nullptr for what should be integer zero
  if (func.returnType && !func.returnType.includes('*') && /\breturn\s+nullptr\b/.test(body)) {
    body = body.replace(/\breturn\s+nullptr\b/g, 'return 0');
  }

  // `x = nullptr` where x is a non-pointer (int) fails ("cannot convert nullptr_t
  // to uint32_t"). `0` is a valid initializer for BOTH pointers and integers, so
  // rewriting the assignment form is universally safe.
  body = body.replace(/=\s*nullptr\b/g, '= 0');

  // `&<name>_ARRAY_<hex>` is a spurious address-of on a Ghidra-named array global:
  // the array name already decays to a pointer-to-element (the target type), while
  // `&name` is pointer-to-ARRAY (`T(*)[N]`) and won't convert. Drop the `&` (but
  // not `&name[i]`, a valid element address).
  body = body.replace(/&\s*(\w+_ARRAY_[0-9a-fA-F]+)\b(?!\s*\[)/g, '$1');

  body = uniquifyDuplicateLabels(body);
  body = hoistSwitchPreCaseDecls(body);
  body = dedupSwitchCases(body);

  // Synthesize declarations for `_<base>` storage-slot locals Ghidra references
  // but never declares (else the body uses an undeclared identifier → compile error).
  const globalNames = context?.analyzedGlobals
    ? new Set(context.analyzedGlobals.map(g => g.name))
    : undefined;
  body = declareUnderscoreSlotLocals(body, func, globalNames);

  // A struct field auto-named after a C++ keyword is emitted with a `_` suffix
  // (header.ts); rewrite member accesses `.default`/`->class` to match. Only the
  // member-access forms — never `default:`/`case X:` switch labels.
  body = body.replace(
    /(\.|->)\s*([A-Za-z_]\w*)\b/g,
    (m, op, name) => (CPP_KEYWORDS.has(name) ? `${op}${name}_` : m),
  );

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
function generateFunctionSignature(func: ExtractedFunction): string {
  const params = renumberParams(func.parameters)
    .map(p => {
      const type = sigType(p.dataType);
      let name = p.name;
      // Avoid param name shadowing its own type
      const baseType = type.replace(/\s*[*&]+\s*$/, '').replace(/^(struct|class|union|enum)\s+/, '').trim();
      if (name === baseType) name = `n${name}`;
      return `${type} ${name}`;
    })
    .join(', ');

  // Strip trailing parens/invalid chars from function names (Ghidra artifacts)
  let cleanName = func.name.replace(/[()]+$/, '').replace(/[^A-Za-z0-9_]/g, '_');
  // Detect constructor pattern: function name matches return type (e.g., D2WinButton * D2WinButton(...))
  const returnType = sigType(func.returnType);
  if (returnType.startsWith(cleanName + ' ') || returnType === cleanName) {
    cleanName = `Create_${cleanName}`;
  }
  return `${sigType(func.returnType)} ${cleanName}(${params})`;
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
  const params = renumberParams(filtered)
    .map(p => `${sigType(p.dataType)} ${p.name}`)
    .join(', ');

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
}

/**
 * Collapse consecutive duplicate namespace segments in qualified references.
 * e.g. "Dungeon::Dungeon::GetFunc" → "Dungeon::GetFunc"
 *      "Monsters::Monsters::Spawn" → "Monsters::Spawn"
 */
function collapseConsecutiveDuplicateQualifiers(code: string): string {
  // Match Word::Word:: where both words are the same identifier
  return code.replace(/\b(\w+)::\1::/g, '$1::');
}

/**
 * Strip namespace prefixes that are redundant inside the enclosing namespace block.
 * Inside `namespace A::B::C`, `A::B::C::Foo()` → `Foo()`, `A::B::X()` → `X()`, etc.
 *
 * Stripping is collision-aware: removing a prefix is only safe if the segment that
 * becomes the new leading qualifier cannot be intercepted by a sibling namespace
 * reachable from a deeper enclosing scope. For example, inside
 * `D2Common::Unit::Monster`, the reference `D2Common::Path::DynamicPath::GetYPos`
 * must NOT be shortened to `Path::DynamicPath::...` when `D2Common::Unit::Path`
 * exists, because C++ would resolve `Path` to `D2Common::Unit::Path` (which has no
 * `DynamicPath`) instead of `D2Common::Path`. In that case the longest safely
 * strippable prefix is `D2Common::Unit::` → but that doesn't match here, so the
 * reference is left fully qualified.
 */
function stripRedundantNamespaceQualifiers(
  code: string,
  namespace: string,
  knownNamespaces?: Set<string>,
): string {
  const parts = namespace.split('::');
  // Candidate prefixes from longest to shortest: ["A::B::C::", "A::B::", "A::"]
  const prefixCandidates: string[] = [];
  for (let i = parts.length; i > 0; i--) {
    prefixCandidates.push(parts.slice(0, i).join('::') + '::');
  }
  const escaped = prefixCandidates.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Capture the prefix AND the next segment so we can verify the shortened name
  // still resolves to the same namespace.
  const pattern = new RegExp(`\\b(${escaped.join('|')})([A-Za-z_]\\w*)`, 'g');

  /**
   * Is it safe to strip `prefix` (= parts[0..k]::) leaving `nextSeg` as the new
   * leading qualifier? Unsafe when a deeper enclosing scope (parts[0..j], j>k)
   * has a child namespace also named `nextSeg` — C++ would bind to that first.
   */
  const canStrip = (prefix: string, nextSeg: string): boolean => {
    if (!knownNamespaces) return true;
    // k = number of leading parts the prefix covers
    const k = prefix.slice(0, -2).split('::').length;
    for (let j = k + 1; j <= parts.length; j++) {
      const sibling = parts.slice(0, j).join('::') + '::' + nextSeg;
      if (knownNamespaces.has(sibling)) return false;
    }
    return true;
  };

  return code.split('\n').map(line => {
    if (line.startsWith('namespace ') || line.startsWith('} // namespace')) return line;
    return line.replace(pattern, (match, prefix: string, nextSeg: string) =>
      canStrip(prefix, nextSeg) ? nextSeg : match,
    );
  }).join('\n');
}

/**
 * Strip CRT namespace prefixes that Ghidra adds from MSVC PDB symbols.
 * e.g. "VisualStudio::sprintf" → "sprintf"
 */
function stripCrtNamespacePrefixes(code: string): string {
  let result = code.replace(/\bVisualStudio::/g, '');
  // CRT/compiler-helper namespace: drop the prefix (the compiler module is not emitted)
  result = result.replace(/\bcompiler::/g, '');
  // Replace Ghidra stack variable artifacts: stack0xNNNNNNNN → 0 (stack cookie pattern)
  result = result.replace(/&?stack0x[0-9a-fA-F]+/g, '0');
  // Fix Ghidra's `type[N]*` syntax → `type*` (array-pointer type in local declarations)
  result = result.replace(/(\b\w+)\[(\d+)\]\s*\*/g, '$1 *');
  // Strip Ghidra's _exref suffix from external references (import thunks)
  result = result.replace(/(\w+)_exref\b/g, '$1');
  // Fix Ghidra double-negative on INT_MIN: --2147483648 → (-2147483648)
  result = result.replace(/--2147483648\b/g, '(-2147483648)');
  result = result.replace(/--0x80000000\b/g, '(int)0x80000000');
  // Fix non-ASCII char literals: '²' → '\xb2' (Ghidra emits raw Unicode in char context)
  result = result.replace(/'([^'\\])'/g, (match, ch) => {
    const code = ch.charCodeAt(0);
    if (code > 127) {
      return `'\\x${code.toString(16)}'`;
    }
    return match;
  });
  return result;
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
function transformDecompiledCode(
  decompiled: string,
  options: ReconstructOptions,
  funcName?: string,
  funcAddress?: string,
  context?: ImplGenContext
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
      return { code: stripCrtNamespacePrefixes(indentCode(decompiled, 4)) };
    }

    const body = bodyMatch[1];

    // Pre-process Ghidra quirks before parsing
    const preprocessedBody = preprocessGhidraCode(body);

    // Try to transform through cpp-parser
    // Wrap in a dummy function for parsing
    const wrapped = `void dummy() {${preprocessedBody}}`;

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

    if ((mappings && Object.keys(mappings).length > 0) || currentFunction) {
      enablePlugins.push('method-call-rewrite');
      perPluginOptions['method-call-rewrite'] = { methodMappings: mappings ?? {}, currentFunction };
    }

    if (context?.functionAddressMap && context.functionAddressMap.size > 0) {
      perPluginOptions['func-ptr-literal'] = { functionAddressMap: context.functionAddressMap };
    }

    if (context?.bitfieldCatalog && context.bitfieldCatalog.size > 0) {
      perPluginOptions['bitfield-access'] = { bitfieldCatalog: context.bitfieldCatalog };
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
      // Always brace single-statement control-flow bodies (no `if (c) return;`)
      // and space loops/blocks apart with blank lines for readability.
      emitOptions: { alwaysUseBraces: true, blankLineAroundControlFlow: true },
    });

    if (result.success) {
      // Extract transformed body
      const transformedMatch = result.code.match(/\{([\s\S]*)\}/);
      if (transformedMatch) {
        return {
          code: stripCrtNamespacePrefixes(indentCode(transformedMatch[1], 4)),
          preamble: result.preamble,
          identifiers: result.identifiers,
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
    return { code: stripCrtNamespacePrefixes(indentCode(body, 4)) };
  } catch (err) {
    // Stack overflow: do minimal work to avoid overflowing again in the handler
    if (err instanceof RangeError && /call stack|stack size/i.test(err.message)) {
      parseErrorCount++;
      console.error(`[STACK OVERFLOW] ${funcName ?? '<unknown>'} @ ${funcAddress ?? '???'} — using raw body`);
      return { code: stripCrtNamespacePrefixes(indentCode(decompiled, 4)) };
    }

    const msg = err instanceof Error
      ? `${err.message}${err.stack ? '\n' + err.stack : ''}`
      : String(err);
    logParseError(msg, funcName ?? '<unknown>', funcAddress ?? '???', decompiled);

    // If transformation fails, return original code indented
    return { code: stripCrtNamespacePrefixes(indentCode(decompiled, 4)) };
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
