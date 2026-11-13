/**
 * The verdict on one `oracle` evidence item of a redivivus.app proposal, from what the re-check
 * (scripts/proposal-recheck/recheck.ts) measured on the current head with oracle-zig.
 */

/** How far a status is from MATCH: 0 for MATCH, lower is better (redivivus-app schema.ts oracleRank). */
export function oracleRank(status: string): number {
  if (status === 'MATCH') return 0;
  if (status === 'INSN_MATCH') return 1;
  if (status === 'INSN_COUNT_MATCH') return 2;
  const our = /^OUR[+-](\d+)$/.exec(status);
  if (our) return 2 + Number(our[1]);
  return 1_000_000;
}

export interface OracleItem { function: string; before: string; after: string }
export interface Measured { head?: string; withOp?: string; bh?: { tag: string; original: string }; note?: string }
export type Verdict = 'gains' | 'no_gain' | 'unmeasured';
export interface ItemResult extends OracleItem, Measured { verdict: Verdict; why: string }

/** The verdict of one oracle item from what was measured. */
export function verdictOf(item: OracleItem, m: Measured): { verdict: Verdict; why: string } {
  if (m.head === undefined) return { verdict: 'unmeasured', why: m.note ?? 'the function could not be compiled on the head' };
  if (m.head === 'MATCH') return { verdict: 'no_gain', why: `${item.function} is MATCH on the head already` };
  if (m.bh && m.bh.tag !== m.bh.original) return { verdict: 'no_gain', why: `the tag's bh ${m.bh.tag} is not the original's ${m.bh.original}` };
  if (m.withOp !== undefined) {
    if (oracleRank(m.withOp) < oracleRank(m.head)) return { verdict: 'gains', why: `${m.head} -> ${m.withOp} on the head` };
    return { verdict: 'no_gain', why: `no longer gains on the head: the op takes ${item.function} from ${m.head} to ${m.withOp}, no closer to MATCH` };
  }
  if (oracleRank(m.head) <= oracleRank(item.after)) return { verdict: 'no_gain', why: `${item.function} is ${m.head} on the head, already where the proposal claimed to take it (${item.after})` };
  const drift = m.head !== item.before ? `; the head is ${m.head}, the proposal measured ${item.before}` : '';
  return { verdict: 'unmeasured', why: `${m.note ?? 'not measurable by a trial'}${drift}` };
}
