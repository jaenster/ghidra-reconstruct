/**
 * The verdict on a proposal's oracle evidence, from what the re-check measured on the head.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { oracleRank, verdictOf } from '../proposal-apply/verdict.js';

const item = { function: '0x0054aec0', before: 'OUR+3', after: 'MATCH' };

describe('proposal oracle verdict', () => {
  it('ranks statuses by distance from MATCH', () => {
    assert.deepStrictEqual(['OUR-3', 'MATCH', 'REF_DIFF', 'INSN_COUNT_MATCH', 'OUR+1', 'INSN_MATCH'].sort((a, b) => oracleRank(a) - oracleRank(b)),
      ['MATCH', 'INSN_MATCH', 'INSN_COUNT_MATCH', 'OUR+1', 'OUR-3', 'REF_DIFF']);
  });

  it('gains when the measured op moves the head closer to MATCH', () => {
    assert.strictEqual(verdictOf(item, { head: 'OUR+3', withOp: 'MATCH' }).verdict, 'gains');
    assert.strictEqual(verdictOf(item, { head: 'OUR+3', withOp: 'OUR+1' }).verdict, 'gains');
  });

  it('refuses what no longer gains on the head', () => {
    assert.match(verdictOf(item, { head: 'MATCH' }).why, /MATCH on the head already/);
    assert.strictEqual(verdictOf(item, { head: 'MATCH', withOp: 'MATCH' }).verdict, 'no_gain');
    assert.match(verdictOf(item, { head: 'OUR+3', withOp: 'OUR+3' }).why, /no longer gains on the head: the op takes 0x0054aec0 from OUR\+3 to OUR\+3/);
    assert.strictEqual(verdictOf(item, { head: 'OUR+1', withOp: 'OUR+2' }).verdict, 'no_gain');
    assert.match(verdictOf(item, { head: 'OUR+3', withOp: 'MATCH', bh: { tag: '142-00000000', original: '142-1a2b3c4d' } }).why, /bh 142-00000000 is not the original's 142-1a2b3c4d/);
    // An op a trial cannot apply: refused only when the head is already where the claim ends.
    assert.strictEqual(verdictOf({ ...item, after: 'OUR+1' }, { head: 'OUR+1' }).verdict, 'no_gain');
  });

  it('leaves an op it cannot measure unmeasured, saying where the head is', () => {
    const v = verdictOf(item, { head: 'OUR+2', note: 'a set_prototype changes the regenerated tree' });
    assert.strictEqual(v.verdict, 'unmeasured');
    assert.match(v.why, /changes the regenerated tree; the head is OUR\+2, the proposal measured OUR\+3/);
    assert.strictEqual(verdictOf(item, { note: 'not in the function map' }).verdict, 'unmeasured');
  });
});
