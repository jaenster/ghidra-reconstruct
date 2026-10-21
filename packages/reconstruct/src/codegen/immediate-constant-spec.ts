/**
 * The immediates of a function that are constants, as `immediate-not-address` needs them.
 *
 * An `S` row (extract/operand-refs.ts) is a 32-bit immediate operand whose value is a
 * mapped address while its instruction carries no reference to that address. Kept only
 * when nothing else in the function says the value is an address, because the decompile's
 * `&UNK_v` could then be that other instruction's:
 *  - an operand reference of the function to v (encoded or propagated), or an offset
 *    reference whose base is v;
 *  - an address the function derives as v (a folded MOV X; ADD d);
 *  - v as an unreferenced DISPLACEMENT (`[EAX + v]` is an array base Ghidra did not
 *    reference, not a constant).
 */

import type { ExtractedFunction } from '../types.js';

export interface ImmediateConstantFact {
  value: number;
  ins: string;
}

export function immediateConstantFacts(func: Pick<ExtractedFunction, 'operandRefs'>): ImmediateConstantFact[] {
  const facts = func.operandRefs;
  if (!facts?.scalars || facts.scalars.length === 0) return [];
  const addressed = new Set<string>();
  for (const r of facts.refs) {
    addressed.add(r.to);
    if (r.base) addressed.add(r.base);
  }
  for (const d of facts.derived) addressed.add(d.value);
  for (const s of facts.scalars) if (!s.immediate) addressed.add(s.value);
  const out = new Map<number, ImmediateConstantFact>();
  for (const s of facts.scalars) {
    if (!s.immediate || addressed.has(s.value)) continue;
    const value = Number.parseInt(s.value, 16);
    if (!out.has(value)) out.set(value, { value, ins: s.ins });
  }
  return [...out.values()];
}

type Extents = ReadonlyArray<readonly [number, number, string]>;
const reachCache = new WeakMap<Extents, number[]>();

/** The datum whose extent covers `v` in [start, end, name] extents sorted by start, or null. */
export function dataAtAddress(extents: Extents, v: number): string | null {
  // reach[i]: the furthest end among extents[0..i], so the backward scan can stop exactly.
  let reach = reachCache.get(extents);
  if (!reach) {
    reach = [];
    let m = -Infinity;
    for (const e of extents) { m = Math.max(m, e[1]); reach.push(m); }
    reachCache.set(extents, reach);
  }
  let lo = 0, hi = extents.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (extents[mid][0] <= v) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  for (let i = best; i >= 0 && reach[i] > v; i--) {
    if (extents[i][1] > v) return extents[i][2];
  }
  return null;
}
