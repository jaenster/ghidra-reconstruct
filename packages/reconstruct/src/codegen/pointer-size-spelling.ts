/**
 * Ghidra spells a pointer whose size is pinned explicitly as `T *32` — its
 * `pointer32` datatype, which on this 32-bit program is the ordinary pointer.
 * 716 global declarations, 84 datatype fields and one function local carry that
 * spelling in v707.
 *
 * Nothing downstream understands it. `stripTypeName('D2DataArrayStrc *32')`
 * does not yield `D2DataArrayStrc`, so the module graph records no dependency
 * and `D2Client/Draw/Weather.cpp` never includes the header that defines it
 * ("invalid use of incomplete type", 27 diagnostics in that one file). Where a
 * declaration IS emitted the spelling leaks verbatim — `static void *32
 * gStormCmdListHeadPriority;` — and where it is not, the symbol is referenced
 * with no declaration at all.
 *
 * So the whole model is normalized once, before any emission, exactly like the
 * template flattening beside it: `*<bits>` becomes `*` in every TYPE-BEARING
 * FIELD. Decompiled bodies are deliberately left alone — `x *32` there is a
 * multiplication, and the one function that declares such a local declares it
 * through `localVariables`, not through body text.
 */

import type { ExtractedDataType, ExtractedStruct, ExtractedTypedef, ExtractedFunctionDefinition, ExtractedFunction } from '../types.js';

/** `T *32` → `T *`, `void *32[9]` → `void *[9]`, `T * *32` → `T * *`. */
export function normalizePointerSizeSpelling(type: string): string {
  if (!type.includes('*')) return type;
  return type.replace(/\*\s*\d+/g, '*');
}

/**
 * Normalize every pointer-size spelling in the model, in place. Returns the
 * number of fields rewritten.
 */
export function normalizePointerSizeSpellings(
  dataTypes: ExtractedDataType[],
  functions: ExtractedFunction[],
  globals: Array<{ dataType?: string; suggestedType?: string }>,
): number {
  let changed = 0;
  const r = (t: string | undefined): string | undefined => {
    if (t === undefined) return t;
    const out = normalizePointerSizeSpelling(t);
    if (out !== t) changed++;
    return out;
  };

  for (const dt of dataTypes) {
    const s = dt as ExtractedStruct;
    for (const f of s.fields ?? []) f.dataType = r(f.dataType)!;
    const td = dt as ExtractedTypedef;
    if (dt.kind === 'TYPEDEF' && td.underlyingType) td.underlyingType = r(td.underlyingType)!;
    const fd = dt as ExtractedFunctionDefinition;
    if (dt.kind === 'FUNCTION_DEFINITION') {
      if (fd.returnType) fd.returnType = r(fd.returnType)!;
      for (const p of fd.parameters ?? []) p.dataType = r(p.dataType)!;
    }
  }

  for (const f of functions) {
    if (f.returnType) f.returnType = r(f.returnType)!;
    for (const p of f.parameters ?? []) p.dataType = r(p.dataType)!;
    for (const v of f.localVariables ?? []) v.dataType = r(v.dataType)!;
  }

  for (const g of globals) {
    if (g.dataType) g.dataType = r(g.dataType);
    if (g.suggestedType) g.suggestedType = r(g.suggestedType);
  }

  return changed;
}
