/**
 * The addresses a function derives from a global's start, as `folded-address-rebase`
 * needs them: V, and the X it was derived from (extract/operand-refs.ts).
 *
 *  - a derived row: the function loads X's address into a register and ADD/SUB/LEA
 *    turns it into V on straight-line code (`MOV EAX,lbase; SUB EAX,0x202`);
 *  - an offset reference Ghidra carries: the operand encodes V, annotated X + d.
 *
 * Dropped, because the decompile's spelling of V could then belong to another
 * instruction and nothing says which:
 *  - a V some instruction of the function ENCODES with a plain reference (an immediate
 *    or a displacement that is V itself, and not an offset reference to X);
 *  - a V derived from two different bases.
 * V == X (no adjustment) is not a fold.
 */

import type { ExtractedFunction } from '../types.js';

export interface FoldedAddressFact {
  value: number;
  base: number;
  ins: string;
}

export function foldedAddressFacts(func: Pick<ExtractedFunction, 'operandRefs'>): FoldedAddressFact[] {
  const facts = func.operandRefs;
  if (!facts) return [];
  const hex = (a: string) => Number.parseInt(a, 16);
  const candidates: FoldedAddressFact[] = [];
  for (const d of facts.derived) {
    if (d.value !== d.to) candidates.push({ value: hex(d.value), base: hex(d.to), ins: d.ins });
  }
  for (const r of facts.refs) {
    if (r.base && r.base !== r.to && r.encoded) candidates.push({ value: hex(r.to), base: hex(r.base), ins: r.ins });
  }
  // Plain encodings of an address: the instruction itself names V.
  const encoded = new Set<number>();
  for (const r of facts.refs) if (r.encoded && !r.base) encoded.add(hex(r.to));
  const byValue = new Map<number, FoldedAddressFact | null>();
  for (const c of candidates) {
    if (encoded.has(c.value)) continue;
    const prev = byValue.get(c.value);
    if (prev === undefined) byValue.set(c.value, c);
    else if (prev && prev.base !== c.base) byValue.set(c.value, null);
  }
  return [...byValue.values()].filter((f): f is FoldedAddressFact => f !== null);
}
