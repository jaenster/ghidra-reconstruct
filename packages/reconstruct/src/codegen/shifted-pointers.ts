/**
 * Shifted pointers in the emitted tree (extract/shifted-pointers.ts reads them).
 *
 * A shifted pointer T (`Container *` with component offset k) holds the address of
 * whatever sits k bytes into a Container. C has no such type; the source this came from
 * declared a pointer to that MEMBER and reached the container from it - the
 * `CONTAINING_RECORD` idiom. So:
 *   - the typedef is declared as a pointer to the member at offset k (`typedef
 *     D2LinkNodeStrc *T;` for D2TaskQueueSlotStrc.sSlotLink at +0x10); with no member
 *     starting exactly at k it points at a byte;
 *   - every `ADJ(p)` the decompiler prints for an access through T is the container,
 *     `CONTAINING_RECORD(p, Container, member)`, or `(Container *)((char *)p - k)` when no
 *     member starts at k (the `adj-shifted-pointer` pass).
 * This runs once over the model, before anything is emitted, and returns the facts the
 * pass needs: typedef name -> container, offset and member.
 */

import type { ExtractedDataType, ExtractedStruct, ExtractedTypedef } from '../types.js';

export interface ShiftedPointerSpec {
  container: string;
  offset: number;
  /** The member that starts at `offset`, when one does. */
  member?: string;
}

/** Typedef name -> container, offset and the member at it: read off the model, no change to it. */
export function shiftedPointerSpecs(dataTypes: readonly ExtractedDataType[]): Record<string, ShiftedPointerSpec & { memberType?: string }> {
  const out: Record<string, ShiftedPointerSpec & { memberType?: string }> = {};
  const structs = new Map<string, ExtractedStruct>();
  for (const dt of dataTypes) {
    if ((dt.kind === 'STRUCTURE' || dt.kind === 'UNION') && !structs.has(dt.name)) structs.set(dt.name, dt as ExtractedStruct);
  }
  for (const dt of dataTypes) {
    if (dt.kind !== 'TYPEDEF') continue;
    const s = (dt as ExtractedTypedef).shifted;
    if (!s || !Number.isInteger(s.offset) || s.offset === 0) continue;
    const field = s.offset > 0
      ? structs.get(s.base)?.fields?.find(f => f.offset === s.offset && !!f.name && !/^(_pad_|padding)/.test(f.name))
      : undefined;
    out[dt.name] = {
      container: s.base, offset: s.offset,
      // A member that is itself an array: the pointer is to its first element.
      ...(field ? { member: field.name, memberType: field.dataType.replace(/\s*\[\d*\]\s*$/, '').trim() } : {}),
    };
  }
  return out;
}

/** Declare every shifted typedef as a pointer to the member at its offset (a byte where none starts there). */
export function lowerShiftedPointerTypedefs(dataTypes: ExtractedDataType[]): number {
  const specs = shiftedPointerSpecs(dataTypes);
  let n = 0;
  for (const dt of dataTypes) {
    const spec = dt.kind === 'TYPEDEF' ? specs[dt.name] : undefined;
    if (!spec) continue;
    (dt as ExtractedTypedef).underlyingType = spec.memberType ? `${spec.memberType} *` : 'uint8_t *';
    n++;
  }
  return n;
}
