import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTruncatingRoundRow, printsRound } from './truncating-rounds.js';
import { parseFunctionFacts, selectFacts, FACT_KEYS } from './function-facts.js';
import { javaStringHash } from './compare-sites.js';

describe('truncating ROUND facts', () => {
  it('parses partial 32-bit and 64-bit site selections', () => {
    assert.deepEqual(parseTruncatingRoundRow('3;0:4;2:8'), {
      count: 3, sites: [{ ord: 0, width: 4 }, { ord: 2, width: 8 }],
    });
  });
  it('rejects invalid widths, duplicate ordinals, unsafe counts and out-of-range sites', () => {
    for (const row of ['0;0:4', '1', '1;1:4', '1;0:2', '2;0:4;0:8', '1;-1:4',
      '9007199254740992;0:4', '1;0:4;']) assert.equal(parseTruncatingRoundRow(row), null, row);
  });
  it('attaches only to the exact decompile, including when compare-site extraction is disabled', () => {
    const text = 'int f(double x) { return (int)ROUND(x); }';
    const output = `F\t0061bce0\tself\t${javaStringHash(text).toString(16)}\t${text.length}\t1\nU\t0061bce0\t1;0:4\nD\t\n`;
    const row = parseFunctionFacts(output).rows.get('0061bce0')!;
    assert.deepEqual(selectFacts(text, '0061bce0', row, false).truncatingRounds,
      { count: 1, sites: [{ ord: 0, width: 4 }] });
    assert.equal(selectFacts(text + ' ', '0061bce0', row, false).truncatingRounds, undefined);
    assert.equal(selectFacts(text.replace('x);', 'y);'), '0061bce0', row, false).truncatingRounds, undefined);
    assert.ok(printsRound(text));
    assert.ok(!printsRound('int f() { return OTHER_ROUND(x); }'));
    assert.ok((FACT_KEYS as readonly string[]).includes('truncatingRounds'));
  });
});
