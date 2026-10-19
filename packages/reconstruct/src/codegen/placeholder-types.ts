/**
 * Ghidra placeholder type names, respelled as the C++ types they stand for.
 *
 * Ghidra's built-in and listing types - `byte`, `uint`, `ushort`, `ulong`, `dword`,
 * `pointer`, `vtable`, ... - reach the tree from every declaration path: signatures,
 * struct fields, globals, typedefs, funcdefs. `d2_platform.h` used to typedef each one
 * so the tree compiled. Every mapping below is exactly that typedef, so the respelling
 * changes no type: it removes the Ghidra name. `code` is not here: `code *` is an
 * untyped function pointer, a different problem with no faithful one-word spelling.
 *
 * Applied to the model's TYPE strings only (never to names), once, at the start of
 * generation, so every emitter downstream sees one spelling. Bodies are respelled on the
 * AST by type-normalize.
 */

import type { ExtractedDataType, ExtractedFunction } from '../types.js';

export const PLACEHOLDER_TYPE_SPELLINGS: Readonly<Record<string, string>> = {
  byte: 'uint8_t', uchar: 'uint8_t', sbyte: 'int8_t',
  uint: 'uint32_t', ulong: 'uint32_t', dword: 'uint32_t', sdword: 'int32_t',
  ushort: 'uint16_t', word: 'uint16_t', sword: 'int16_t',
  qword: 'uint64_t', sqword: 'int64_t', longlong: 'int64_t', ulonglong: 'uint64_t',
  wchar16: 'uint16_t', unicode: 'uint16_t',
  pointer: 'void *', pointer32: 'uint32_t', ImageBaseOffset32: 'uint32_t',
  vtable: 'void',
};

const RE = new RegExp(`\\b(${Object.keys(PLACEHOLDER_TYPE_SPELLINGS).join('|')})\\b`, 'g');

/** One type spelling, with every placeholder name respelled. */
export function respellPlaceholderType(type: string): string;
export function respellPlaceholderType(type: string | undefined): string | undefined;
export function respellPlaceholderType(type: string | undefined): string | undefined {
  if (!type) return type;
  return type.replace(RE, (m) => PLACEHOLDER_TYPE_SPELLINGS[m]);
}

interface TypedSlot { dataType?: string }
interface GlobalLike { dataType?: string; suggestedType?: string }

/** Respell every type string in the model, in place. Idempotent. Returns how many changed. */
export function respellPlaceholderTypes(
  functions: ExtractedFunction[],
  globals: GlobalLike[],
  dataTypes: ExtractedDataType[],
): number {
  let changed = 0;
  const fix = <T extends object, K extends keyof T>(o: T, k: K) => {
    const v = o[k];
    if (typeof v !== 'string') return;
    const r = respellPlaceholderType(v);
    if (r !== v) { (o as Record<K, unknown>)[k] = r; changed++; }
  };
  for (const f of functions) {
    fix(f, 'returnType');
    for (const p of f.parameters ?? []) fix(p as TypedSlot, 'dataType');
    for (const v of f.localVariables ?? []) fix(v as TypedSlot, 'dataType');
  }
  for (const g of globals) { fix(g, 'dataType'); fix(g, 'suggestedType'); }
  for (const dt of dataTypes) {
    const d = dt as unknown as {
      fields?: TypedSlot[]; parameters?: TypedSlot[]; underlyingType?: string; returnType?: string;
    };
    for (const f of d.fields ?? []) fix(f, 'dataType');
    for (const p of d.parameters ?? []) fix(p, 'dataType');
    fix(d, 'underlyingType');
    fix(d, 'returnType');
  }
  return changed;
}
