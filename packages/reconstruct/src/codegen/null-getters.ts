/**
 * The null default of each field the original reads through a null-guarded getter, from the
 * getters it keeps out of line and the copies it inlined (cpp-parser `null-getter.ts`). The
 * `compare-form` and `branch-layout` passes write the getter back with this default where a decompiled
 * `p && p->f == K` was compiled from it.
 */

import { nullGetterEvidence, nullGetterTable, type NullGetterEvidence, type NullGetterTable } from '@ghidra-mcp/cpp-parser';
import type { ExtractedDataType, ExtractedEnum, ExtractedFunction } from '../types.js';
import { pipelineFunction } from './inlined-calls.js';

/** Enumerator name -> value, for the names every enum that declares them gives one value. */
export function enumeratorValues(dataTypes: readonly ExtractedDataType[]): Map<string, number> {
  const values = new Map<string, number>();
  const clash = new Set<string>();
  for (const dt of dataTypes) {
    if (dt.kind !== 'ENUM') continue;
    for (const v of (dt as ExtractedEnum).values ?? []) {
      const seen = values.get(v.name);
      if (seen !== undefined && seen !== v.value) clash.add(v.name);
      else values.set(v.name, v.value);
    }
  }
  for (const n of clash) values.delete(n);
  return values;
}

export interface NullGetterDefaults {
  table: NullGetterTable;
  /** Fields whose evidence names more than one default. */
  conflicts: string[];
  /** How many bodies gave evidence. */
  evidence: number;
  /** Enumerator name -> value, as the evidence was valued. */
  enums: Record<string, number>;
}

/** The table over every function with a decompile. */
export function nullGetterDefaults(functions: readonly ExtractedFunction[], dataTypes: readonly ExtractedDataType[]): NullGetterDefaults {
  const enums = enumeratorValues(dataTypes);
  const all: NullGetterEvidence[] = [];
  for (const f of functions) {
    if (!f.decompiled) continue;
    const fn = pipelineFunction(f);
    if (!fn) continue;
    all.push(...nullGetterEvidence(fn, n => enums.get(n)));
  }
  const { table, conflicts } = nullGetterTable(all);
  return { table, conflicts, evidence: all.length, enums: Object.fromEntries(enums) };
}
