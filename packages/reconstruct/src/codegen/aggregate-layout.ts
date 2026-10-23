/**
 * Size and alignment of every struct and union as the EMITTED declaration lays
 * it out, for the passes that have to place an aggregate local on the frame.
 *
 * `frame-group-locals` keeps a run of frame slots together when an escaping
 * address's callee walks across them. It used to know scalar sizes only, so a
 * struct-typed local ended every run that reached it - and a run cut there is
 * wrong when the callee reads past the cut. `AUTOMAP_SaveCurrentLayer`
 * @0x004584c0 lost 32 of the 44 bytes `AUTOMAP_SaveLayerToFile` reads that way.
 *
 * The size is Ghidra's committed size, which is what the emitter reproduces. The
 * alignment follows the emitter's own packing decision (`requiresPacking`, the
 * same call `generateStructDeclaration` makes): a packed struct is 1-aligned, an
 * unpacked one aligns like its widest member. A member whose alignment cannot be
 * derived (a bitfield, an opaque typedef) leaves the aggregate unknown, and an
 * unknown aggregate is never sized - the caller then stops where it stopped
 * before and reports it.
 */

import type { ExtractedDataType, StructField } from '../types.js';
import { fieldAlignment, requiresPacking } from './struct-packing.js';

export interface AggregateLayout {
  size: number;
  align: number;
}

type Aggregate = ExtractedDataType & { fields?: StructField[]; alignment?: number; packed?: boolean };

/**
 * Every aggregate whose emitted layout is known, by bare name. A name two
 * aggregates share with different sizes is left out: a lookup by name could
 * not tell which one a local means.
 */
export function buildAggregateLayouts(
  dataTypes: readonly ExtractedDataType[],
  typedefTargets: Readonly<Record<string, string>> = {},
): Record<string, AggregateLayout> {
  const byName = new Map<string, Aggregate>();
  const ambiguous = new Set<string>();
  for (const dt of dataTypes) {
    if ((dt.kind !== 'STRUCTURE' && dt.kind !== 'UNION') || !dt.name) continue;
    // A cross-check build's type is emitted under its own guard, not as this one.
    if (dt.platform) continue;
    const prev = byName.get(dt.name);
    if (prev && prev.size !== dt.size) ambiguous.add(dt.name);
    if (!prev) byName.set(dt.name, dt as Aggregate);
  }

  const memo = new Map<string, AggregateLayout | null>();
  const visiting = new Set<string>();

  /** Alignment of a member spelling, or undefined when it cannot be derived. */
  const alignOf = (spelling: string, depth: number): number | undefined => {
    if (depth > 16) return undefined;
    let t = (spelling || '').trim();
    while (true) {
      const arr = /^(.*?)\s*\[\s*\d+\s*\]$/.exec(t);
      if (!arr) break;
      t = arr[1].trim();
    }
    if (t.endsWith('*') || t === 'pointer') return 4;
    const direct = fieldAlignment(t);
    if (direct !== undefined) return direct;
    const bare = t.replace(/^(const|volatile|struct|union)\s+/, '').trim();
    if (byName.has(bare)) return layoutOf(bare)?.align;
    const target = typedefTargets[bare];
    if (target && target !== bare) return alignOf(target, depth + 1);
    return undefined;
  };

  const layoutOf = (name: string): AggregateLayout | null => {
    if (memo.has(name)) return memo.get(name)!;
    if (visiting.has(name) || ambiguous.has(name)) return null;
    const dt = byName.get(name);
    if (!dt || typeof dt.size !== 'number' || dt.size <= 0) return null;
    const fields = dt.fields ?? [];
    if (fields.length === 0) { memo.set(name, null); return null; }
    visiting.add(name);
    let result: AggregateLayout | null;
    if (dt.kind === 'STRUCTURE'
        && (dt.packed || requiresPacking(fields, dt.alignment, dt.size))) {
      result = { size: dt.size, align: 1 };
    } else {
      let align = 1;
      let known = true;
      for (const f of fields) {
        if (!f.dataType || f.dataType.includes(':')) { known = false; break; }
        const a = alignOf(f.dataType, 0);
        if (a === undefined) { known = false; break; }
        align = Math.max(align, a);
      }
      // sizeof is a multiple of the alignment; a size that is not cannot be what
      // the compiler makes of this declaration.
      result = known && dt.size % align === 0 ? { size: dt.size, align } : null;
    }
    visiting.delete(name);
    memo.set(name, result);
    return result;
  };

  const out: Record<string, AggregateLayout> = {};
  for (const name of byName.keys()) {
    const layout = layoutOf(name);
    if (layout) out[name] = layout;
  }
  return out;
}
