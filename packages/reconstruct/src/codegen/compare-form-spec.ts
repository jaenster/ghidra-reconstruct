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
 *   X == 0 / X != 0      cc in {b,ae}  1          X < 1 / X >= 1, an unsigned compare
 *   P rel Q              rel                      unchanged
 *   P rel Q              MIR(rel)                 Q MIR(rel) P
 *
 * Every constant step is checked in the machine's domain (signedness from the Jcc, which
 * must agree with the pcode opcode, at the CMP's width): k and B are read there as integers
 * and must differ by exactly the step, so a wrap never matches. Anything else - an opcode the
 * Jcc disagrees with, a step larger than one (strength reduction), a bit test, a constant the
 * instructions hold in a register (except an ordered compare against 0, `heldZero`), two
 * non-constant operands compared for equality (the relation does not say which side is the
 * CMP's first) - gets no decision. The C++ side
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
  const sign = signTest(site, form);
  if (sign) return sign;
  const reused = flagsReusedPair(site, form);
  if (reused) return reused;
  if (!site.user || !site.setter || !site.onPair) return { reason: 'no CMP/TEST and Jcc pair' };
  const cc = conditionCode(site.user.mnemonic);
  if ((site.width !== site.size && !widenedEquality(site, cc)) || ![1, 2, 4].includes(site.width)) {
    return { reason: `width ${site.width} for a ${site.size}-byte op` };
  }
  if (!cc) return { reason: `flags read by ${site.user.mnemonic}` };
  const ccRel = RELATION[cc];
  const F = new Set([ccRel, NEGATE[ccRel]]);
  const w = site.width;
  const base = {
    ord: site.ord, text: site.text, fp: site.fp, width: w, address: site.setter.at,
    ...(cc && site.user.mnemonic.toUpperCase().startsWith('SET') ? { set: true } : {}),
  };
  const ordered = form.signed !== undefined;
  // An unsigned op read by a signed Jcc: Ghidra typed the operand unsigned where the machine
  // compares signed. Decided as signed, and `zextSum` asks the pass to prove the operand is
  // a sum of zero-extended narrow values, which no compare can tell from a signed one.
  let zextSum = false;
  // The same for two non-constant operands: `zextPair` asks the pass to prove both are
  // values zero-extended from 8 or 16 bits (CLIENT_UpdateUnitLightRadius 00460930:
  // `MOVZX ECX,byte; MOVZX EAX,AL; CMP EAX,ECX; JGE`), where the two compares agree.
  let zextPair = false;
  if (ordered) {
    const ccSigned = SIGNED_CC.has(cc) ? true : UNSIGNED_CC.has(cc) ? false : undefined;
    if (ccSigned === true && form.signed === false && site.width === 4
      && (site.constSide === 0 || site.constSide === 1) && site.bKind === 'i') zextSum = true;
    else if (ccSigned === true && form.signed === false && site.width === 4
      && site.constSide !== 0 && site.constSide !== 1 && (site.bKind === 'r' || site.bKind === 'm')) zextPair = true;
    else if (ccSigned !== form.signed) return { reason: `${site.opcode} read by ${site.user.mnemonic}` };
  }

  if (site.constSide === 0 || site.constSide === 1) {
    if (site.k === undefined) return { reason: 'no constant' };
    if (site.bKind === 'r' && ordered) return heldZero(site, F, base, form.signed!);
    if (site.bKind === 'r') return heldZeroEquality(site, cc, base);
    if (site.bKind !== 'i' && site.bKind !== 'z') return { reason: `constant against ${site.bKind}` };
    const B = site.bKind === 'z' ? 0n : site.bValue;
    if (B === undefined) return { reason: 'no immediate' };
    const swap = site.constSide === 0;
    // G with the non-constant operand on the left.
    const rel = swap ? MIRROR[site.text] : site.text;
    const k = Number(site.k & 0xffffffffn);
    if (zextSum) {
      // Both domains agree only on constants in 0..0x7fffffff.
      if (site.k > 0x7fffffffn || B > 0x7fffffffn) return { reason: 'constant outside both domains' };
      const step = STEP[rel];
      if (F.has(rel) && site.k === B) return { decision: { ...base, op: rel, swap, delta: 0, k, signed: true, zextSum } };
      if (step && F.has(step.op) && site.k + BigInt(step.delta) === B) {
        return { decision: { ...base, op: step.op, swap, delta: step.delta, k, signed: true, zextSum } };
      }
      return { reason: `${rel} ${site.k} against ${[...F].join('/')} ${B}` };
    }
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
    // `CMP X,1; JB/JAE`: an unsigned X is below 1 exactly when it is 0. A signed JL/JGE
    // against 1 also takes the negatives, so it is not this equality and gets no decision.
    if (k0 === 0n && b0 === 1n && UNSIGNED_CC.has(cc) && (ccRel === '<' || ccRel === '>=')) {
      return { decision: { ...base, op: rel === '==' ? '<' : '>=', swap, delta: 1, k, unsigned: true } };
    }
    if (F.has(rel) && k0 === b0) {
      // `MOV r,[X+d]; CMP r,K`: the operand was loaded into a register first, which a field
      // compared in place (`CMP [X+d],K`) is not.
      const load = site.aKind === 'r' && site.bKind === 'i' ? { load: true } : {};
      return swap
        ? { decision: { ...base, op: rel, swap, delta: 0, k } }
        : { decision: { ...base, keep: true, k, ...load } };
    }
    return { reason: `${rel} ${k0} against ${[...F].join('/')} ${b0}` };
  }

  // Two non-constant operands.
  if (site.bKind !== 'r' && site.bKind !== 'm') return { reason: `variables against ${site.bKind}` };
  if (!ordered) return { decision: { ...base, keep: true } };
  const inF = F.has(site.text), mirInF = F.has(MIRROR[site.text]);
  const pair = zextPair ? { signed: true, zextPair } : {};
  if (inF && !mirInF) return { decision: { ...base, keep: true, ...pair } };
  if (mirInF && !inF) return { decision: { ...base, op: MIRROR[site.text], swap: true, delta: 0, ...pair } };
  return { reason: `${site.text} against ${[...F].join('/')}` };
}

/**
 * A narrow operand the instructions compare for equality at four bytes against an
 * immediate: `MOVSX EAX,word ptr [..]; CMP EAX,0x43; JZ`, where Ghidra prints the op at the
 * operand's width (PLRSKILLS_CheckSkillWhipAndLeap 004d8520). The relation is the same at
 * either width; the decision carries the CMP's width, which is how `narrow-local-widen`
 * learns the source compared an int. Only constants whose top bit at the narrow width is
 * clear and that the immediate holds unchanged, so the sign and zero extensions agree.
 */
function widenedEquality(site: CompareSite, cc: string | undefined): boolean {
  if (site.width !== 4 || (site.size !== 1 && site.size !== 2)) return false;
  if (site.opcode !== 'INT_EQUAL' && site.opcode !== 'INT_NOTEQUAL') return false;
  if (!cc || (RELATION[cc] !== '==' && RELATION[cc] !== '!=')) return false;
  if ((site.constSide !== 0 && site.constSide !== 1) || site.bKind !== 'i') return false;
  if (site.k === undefined || site.bValue === undefined) return false;
  return site.k < 1n << BigInt(8 * site.size - 1) && site.bValue === site.k;
}

/**
 * An ordered compare against a register the extraction did not see zeroed in the CMP's own
 * block (`z` is block-local), but which Ghidra proved constant and printed one step from 0:
 * `CMP AX,SI; JL` with SI the zero VC8 keeps for the whole function, printed `-1 < set`
 * (TXT_AllocTxt_setitems 00634dc0), or `CMP EAX,EBX; SETLE` printed `n < 1`
 * (TXT_AllocTxt_pettype 00618d90). It is decided as `z` would be: only where the member of F
 * it takes compares against 0. A register holding any other constant is not this: VC8
 * itself moves a constant by one to share a register it already holds (`0x1ff < n` against
 * a register of 0x200 that the next store writes, TXT_AllocTxt_superuniques 006552e0), so
 * the register's value says nothing about the source's spelling.
 */
function heldZero(site: CompareSite, F: ReadonlySet<string>, base: Omit<CompareFormDecision, 'op'>,
  signed: boolean): CompareFormOutcome {
  const swap = site.constSide === 0;
  const rel = swap ? MIRROR[site.text] : site.text;
  const k = Number(site.k! & 0xffffffffn);
  const kv = inDomain(site.k!, site.width, signed);
  if (F.has(rel) && kv === 0n) {
    return swap
      ? { decision: { ...base, op: rel, swap, delta: 0, k, signed } }
      : { decision: { ...base, keep: true } };
  }
  const step = STEP[rel];
  if (step && F.has(step.op) && kv + BigInt(step.delta) === 0n) {
    return { decision: { ...base, op: step.op, swap, delta: step.delta, k, signed } };
  }
  return { reason: `${rel} ${kv} against ${[...F].join('/')} in a register` };
}

/**
 * An equality with 0 whose CMP takes the 0 from a register: `CMP dword ptr [EBP-0xc],ESI; JBE`
 * with ESI the zero VC8 keeps for the whole function, which Ghidra proved and printed
 * `nAdjacentRoomCount != 0` (GAME_CollectNearbyUnitPositions 00537fd0). Decided as `z` would
 * be, and only for JBE/JA: an unsigned X is at most 0 exactly when it is 0, so the register's
 * value is the only thing taken from Ghidra, and it is the constant the op prints.
 */
function heldZeroEquality(site: CompareSite, cc: string, base: Omit<CompareFormDecision, 'op'>): CompareFormOutcome {
  const swap = site.constSide === 0;
  const rel = swap ? MIRROR[site.text] : site.text;
  const k = Number(site.k! & 0xffffffffn);
  if (inDomain(site.k!, site.width, false) === 0n && (cc === 'BE' || cc === 'NA' || cc === 'A' || cc === 'NBE')) {
    return { decision: { ...base, op: rel === '==' ? '<=' : '>', swap, delta: 0, k, unsigned: true } };
  }
  return { reason: `${rel} ${site.k} against a register read by J${cc}` };
}

/**
 * A signed compare against zero read off the sign flag: `JS`/`JNS` after `TEST r,r`, or
 * straight after the arithmetic that computed the operand (`SUB`, `DEC`: Ghidra ties the
 * compare to that instruction, and the branch reads its result, so the flags are the
 * operand's own). JS is `x < 0`, JNS `x >= 0`, so F = {<, >=} against 0, decided as a signed
 * `TEST x,x; JL/JGE` would be: `-1 < x` -> `x >= 0`, `x < 0` kept (UseQuanityAndDurability
 * 005daa40: `-1 < n` after a SUB and JS). Any other setter (a CMP, a bit test), or an
 * unsigned opcode, gets no decision.
 */
/**
 * An unsigned op of two 32-bit variables whose Jcc is signed and reads the flags of an
 * earlier CMP rather than one of its own (TXT_BuildCharTemplateLevelIndex 00664b10:
 * `CMP EAX,EDX; JL; JLE`, the JLE printed as the second compare `nPrevLevel < nLevel`).
 * It has no operand order or constant to decide, only the signedness: `zextPair`, so
 * the pass writes it signed where it proves both operands non-negative, as for the
 * compare that owns the CMP. Null for anything else.
 */
function flagsReusedPair(site: CompareSite, form: { text: string; signed?: boolean }): CompareFormOutcome | null {
  if (!site.user || site.setter || form.signed !== false || site.size !== 4) return null;
  const cc = conditionCode(site.user.mnemonic);
  if (!cc || !SIGNED_CC.has(cc)) return null;
  if (!site.fp[0].startsWith('v:') || !site.fp[1].startsWith('v:')) return null;
  return {
    decision: {
      ord: site.ord, text: site.text, fp: site.fp, width: 4, address: site.user.at,
      keep: true, signed: true, zextPair: true,
    },
  };
}

function signTest(site: CompareSite, form: { text: string; signed?: boolean }): CompareFormOutcome | null {
  const um = site.user?.mnemonic.toUpperCase();
  if (um !== 'JS' && um !== 'JNS') return null;
  if (form.signed !== true) return { reason: `${site.opcode} read by ${um}` };
  if (site.constSide !== 0 && site.constSide !== 1) return { reason: `variables against ${um}` };
  if (site.k === undefined) return { reason: 'no constant' };
  let width: number;
  if (site.setter) {
    if (site.setter.mnemonic.toUpperCase() !== 'TEST' || site.bKind !== 'z' || !site.onPair) {
      return { reason: `${site.setter.mnemonic} ${site.bKind} read by ${um}` };
    }
    if (site.width !== site.size) return { reason: `width ${site.width} for a ${site.size}-byte op` };
    width = site.width;
  } else {
    width = site.size;
  }
  if (![1, 2, 4].includes(width)) return { reason: `width ${width}` };
  const F = new Set(['<', '>=']);
  const base = { ord: site.ord, text: site.text, fp: site.fp, width, address: site.user!.at };
  const swap = site.constSide === 0;
  const rel = swap ? MIRROR[site.text] : site.text;
  const k = Number(site.k & 0xffffffffn);
  const kv = inDomain(site.k, width, true);
  if (F.has(rel) && kv === 0n) {
    return swap
      ? { decision: { ...base, op: rel, swap, delta: 0, k, signed: true } }
      : { decision: { ...base, keep: true } };
  }
  const step = STEP[rel];
  if (step && F.has(step.op) && kv + BigInt(step.delta) === 0n) {
    return { decision: { ...base, op: step.op, swap, delta: step.delta, k, signed: true } };
  }
  return { reason: `${rel} ${kv} against ${um} 0` };
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
