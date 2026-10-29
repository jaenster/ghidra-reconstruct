/**
 * The source form of each comparison, as `compare-form` needs it.
 *
 * MSVC 2005 /O2 keeps the constant as the second CMP operand (a 0 against a register becomes
 * `TEST r,r`), keeps two non-constant operands in source order, and branches on either the
 * source relation or its negation: a fall-through then-block jumps on NEG(rel), an early exit
 * or a loop's back edge on rel, a `return c` sets on rel. JL/JLE/JG/JGE mean a signed compare,
 * JB/JBE/JA/JAE an unsigned one. So for `CMP A,B; Jcc` the source was `A rel B` with rel in
 * F = {cc, NEG(cc)}, and Ghidra's G, which prints only `<`/`<=` and moves the constant to fit,
 * is rewritten to the member of F that means the same:
 *
 *   G (X non-constant)   needs in F    and B      written
 *   X rel k              rel           k          unchanged (constant moved right if printed left)
 *   X < k                <=            k-1        X <= k-1
 *   X <= k               <             k+1        X < k+1
 *   X > k                >=            k+1        X >= k+1
 *   X >= k               >             k-1        X > k-1
 *   X == 0 / X != 0      cc in {be,a}  0          X <= 0 / X > 0, an unsigned compare
 *   P rel Q              rel                      unchanged
 *   P rel Q              MIR(rel)                 Q MIR(rel) P
 *
 * Every constant step is checked in the machine's domain (signedness from the Jcc, which
 * must agree with the pcode opcode, at the CMP's width): k and B are read there as integers
 * and must differ by exactly the step, so a wrap never matches. Anything else - an opcode the
 * Jcc disagrees with, a step larger than one (strength reduction), a bit test, a constant the
 * instructions hold in a register, two non-constant operands compared for equality (the
 * relation does not say which side is the CMP's first) - gets no decision. The C++ side
 * (literal spelling, the 32-bit domains, the operand's type) is checked by the pass, which
 * sees the printed literal.
 */

import type { CompareFormDecision } from '@ghidra-mcp/cpp-parser';
import { compareSiteRows, type CompareSite } from '../extract/compare-sites.js';

/** The relation a Jcc/SETcc condition code tests between the CMP's operands. */
const RELATION: Record<string, string> = {
  E: '==', Z: '==', NE: '!=', NZ: '!=',
  B: '<', C: '<', NAE: '<', AE: '>=', NB: '>=', NC: '>=',
  BE: '<=', NA: '<=', A: '>', NBE: '>',
  L: '<', NGE: '<', GE: '>=', NL: '>=',
  LE: '<=', NG: '<=', G: '>', NLE: '>',
};
const SIGNED_CC = new Set(['L', 'NGE', 'GE', 'NL', 'LE', 'NG', 'G', 'NLE']);
const UNSIGNED_CC = new Set(['B', 'C', 'NAE', 'AE', 'NB', 'NC', 'BE', 'NA', 'A', 'NBE']);
const NEGATE: Record<string, string> = { '==': '!=', '!=': '==', '<': '>=', '>=': '<', '<=': '>', '>': '<=' };
export const MIRROR: Record<string, string> = { '==': '==', '!=': '!=', '<': '>', '>': '<', '<=': '>=', '>=': '<=' };

/** What each integer comparison opcode prints as, and whether it is signed. */
const OPCODE: Record<string, { text: string; signed?: boolean }> = {
  INT_EQUAL: { text: '==' }, INT_NOTEQUAL: { text: '!=' },
  INT_LESS: { text: '<', signed: false }, INT_LESSEQUAL: { text: '<=', signed: false },
  INT_SLESS: { text: '<', signed: true }, INT_SLESSEQUAL: { text: '<=', signed: true },
};

/** The constant steps: G's relation -> the relation that needs B one away, and the step. */
const STEP: Record<string, { op: string; delta: -1 | 1 }> = {
  '<': { op: '<=', delta: -1 }, '<=': { op: '<', delta: 1 },
  '>': { op: '>=', delta: 1 }, '>=': { op: '>', delta: -1 },
};

/** The condition code of a Jcc or SETcc mnemonic, or undefined. */
export function conditionCode(mnemonic: string): string | undefined {
  const m = /^(?:J|SET)([A-Z]+)$/.exec(mnemonic.toUpperCase());
  if (!m || m[1] === 'MP') return undefined;
  return m[1] in RELATION ? m[1] : undefined;
}

/** `x` (an unsigned `width`-byte value) as an integer of the domain. */
function inDomain(x: bigint, width: number, signed: boolean): bigint {
  const bits = BigInt(8 * width);
  const v = x & ((1n << bits) - 1n);
  return signed && v >= 1n << (bits - 1n) ? v - (1n << bits) : v;
}

/** A site's decision, or why it gets none. */
export type CompareFormOutcome =
  | { decision: CompareFormDecision }
  | { reason: string };

/** The decision for one site. */
export function compareFormDecision(site: CompareSite): CompareFormOutcome {
  if (!site.opcode) return { reason: 'no pcode op' };
  const form = OPCODE[site.opcode];
  if (!form) return { reason: `opcode ${site.opcode}` };
  if (form.text !== site.text) return { reason: `printed ${site.text} for ${site.opcode}` };
  if (!site.user || !site.setter || !site.onPair) return { reason: 'no CMP/TEST and Jcc pair' };
  if (site.width !== site.size || ![1, 2, 4].includes(site.width)) return { reason: `width ${site.width} for a ${site.size}-byte op` };
  const cc = conditionCode(site.user.mnemonic);
  if (!cc) return { reason: `flags read by ${site.user.mnemonic}` };
  const ccRel = RELATION[cc];
  const F = new Set([ccRel, NEGATE[ccRel]]);
  const w = site.width;
  const base = {
    ord: site.ord, text: site.text, fp: site.fp, width: w, address: site.setter.at,
  };
  const ordered = form.signed !== undefined;
  if (ordered) {
    const ccSigned = SIGNED_CC.has(cc) ? true : UNSIGNED_CC.has(cc) ? false : undefined;
    if (ccSigned !== form.signed) return { reason: `${site.opcode} read by ${site.user.mnemonic}` };
  }

  if (site.constSide === 0 || site.constSide === 1) {
    if (site.k === undefined) return { reason: 'no constant' };
    if (site.bKind !== 'i' && site.bKind !== 'z') return { reason: `constant against ${site.bKind}` };
    const B = site.bKind === 'z' ? 0n : site.bValue;
    if (B === undefined) return { reason: 'no immediate' };
    const swap = site.constSide === 0;
    // G with the non-constant operand on the left.
    const rel = swap ? MIRROR[site.text] : site.text;
    const k = Number(site.k & 0xffffffffn);
    if (ordered) {
      const signed = form.signed!;
      const kv = inDomain(site.k, w, signed), bv = inDomain(B, w, signed);
      if (F.has(rel) && kv === bv) {
        return swap
          ? { decision: { ...base, op: rel, swap, delta: 0, k, signed } }
          : { decision: { ...base, keep: true } };
      }
      const step = STEP[rel];
      if (step && F.has(step.op) && kv + BigInt(step.delta) === bv) {
        return { decision: { ...base, op: step.op, swap, delta: step.delta, k, signed } };
      }
      return { reason: `${rel} ${kv} against ${[...F].join('/')} ${bv}` };
    }
    // Equality.
    const k0 = inDomain(site.k, w, false), b0 = inDomain(B, w, false);
    if (k0 === 0n && b0 === 0n && (cc === 'BE' || cc === 'NA' || cc === 'A' || cc === 'NBE')) {
      return { decision: { ...base, op: rel === '==' ? '<=' : '>', swap, delta: 0, k, unsigned: true } };
    }
    if (F.has(rel) && k0 === b0) {
      return swap
        ? { decision: { ...base, op: rel, swap, delta: 0, k } }
        : { decision: { ...base, keep: true, k } };
    }
    return { reason: `${rel} ${k0} against ${[...F].join('/')} ${b0}` };
  }

  // Two non-constant operands.
  if (site.bKind !== 'r' && site.bKind !== 'm') return { reason: `variables against ${site.bKind}` };
  if (!ordered) return { decision: { ...base, keep: true } };
  const inF = F.has(site.text), mirInF = F.has(MIRROR[site.text]);
  if (inF && !mirInF) return { decision: { ...base, keep: true } };
  if (mirInF && !inF) return { decision: { ...base, op: MIRROR[site.text], swap: true, delta: 0 } };
  return { reason: `${site.text} against ${[...F].join('/')}` };
}

export interface CompareFormSpec {
  /** Every comparison token of the decompile, in text order: what the pass ties against. */
  sites: Array<{ text: string; fp: [string, string]; size: number }>;
  /** The tied sites: a rewrite, or `keep` for one already in the instruction's form. */
  decisions: CompareFormDecision[];
}

/** The pass's input for one function, from its `compareSites` rows; null without any. */
export function compareFormSpec(func: { compareSites?: string }): CompareFormSpec | null {
  const sites = compareSiteRows(func.compareSites);
  if (sites.length === 0) return null;
  // The ordinals must be 0..n-1, or the zip by position means nothing.
  if (sites.some((s, i) => s.ord !== i)) return null;
  const decisions: CompareFormDecision[] = [];
  for (const s of sites) {
    const o = compareFormDecision(s);
    if ('decision' in o) decisions.push(o.decision);
  }
  return { sites: sites.map(s => ({ text: s.text, fp: s.fp, size: s.size })), decisions };
}
