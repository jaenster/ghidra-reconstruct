/**
 * The two whole-list steps the extraction applies to Ghidra's type listing before the
 * snapshot is written: the exclude filter and the dedup by bare name. They live here
 * so a single re-read type (the live daemon's refresh and verifier) goes through the
 * same code as the full extraction, and its record comes out in the same form.
 */

import type { ExtractedDataType, ExtractedEnum } from '../types.js';

/** True when an exclude pattern matches the type's name or one of its category segments. */
export function isExcludedDataType(
  dt: { name: string; category?: string },
  excludePatterns: readonly (string | RegExp)[] | undefined,
): boolean {
  if (!excludePatterns || excludePatterns.length === 0) return false;
  // Category segments, e.g. "/VisualStudio/DName" -> ["VisualStudio", "DName"].
  const categorySegments = dt.category ? dt.category.split('/').filter(Boolean) : [];
  for (const pattern of excludePatterns) {
    if (typeof pattern === 'string') {
      if (dt.name.includes(pattern)) return true;
      if (categorySegments.some(seg => seg.includes(pattern))) return true;
    } else {
      if (pattern.test(dt.name)) return true;
      if (categorySegments.some(seg => pattern.test(seg))) return true;
    }
  }
  return false;
}

/**
 * Keep the first type of each bare name. Ghidra may file the same type in several
 * categories (eD2UnitType in "/" and "/Diablo2/UNIT"), and C++ can declare it once.
 * ENUMs MERGE the values of the later same-named entries into the first instead of
 * dropping them: D2 ships two `eCollisionFlags` enums, /Diablo2/COLLISION (17 COLLIDE_*
 * primitives) and /_Source/Collision (34 values, adding the composite masks
 * COLLISION_LOS=0x805, MONSTER_COLLISION_DEFAULT, SPAWN_UNIT_COLLISION, ...). Bodies use
 * the composites, so dropping the richer one left them undeclared. The kept enum's
 * `values` array is extended in place.
 */
export function dedupeDataTypesByName(dataTypes: readonly ExtractedDataType[]): {
  result: ExtractedDataType[];
  mergedValues: number;
} {
  const kept = new Map<string, ExtractedDataType>();
  const result: ExtractedDataType[] = [];
  let mergedValues = 0;
  for (const dt of dataTypes) {
    const existing = kept.get(dt.name);
    if (!existing) {
      kept.set(dt.name, dt);
      result.push(dt);
      continue;
    }
    if (dt.kind === 'ENUM' && existing.kind === 'ENUM') {
      const e = existing as ExtractedEnum;
      const have = new Set(e.values.map(v => v.name.trim()));
      for (const v of (dt as ExtractedEnum).values) {
        if (!have.has(v.name.trim())) { e.values.push(v); have.add(v.name.trim()); mergedValues++; }
      }
    }
    // A non-enum duplicate, or an enum already merged: dropped.
  }
  return { result, mergedValues };
}
