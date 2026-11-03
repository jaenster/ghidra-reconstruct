import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseFunctionFacts, selectFacts, FACT_KEYS } from './function-facts.js';
import { javaStringHash } from './compare-sites.js';
import { parseZextSiteRow, printsZextCast, ZEXT_OPERATORS, ZEXT_SITES_JAVA } from './zext-sites.js';

// MISSILE_CreateRandomSubInRadius 004cea00: the INT_ADD of `nRadius * 2 + 1` feeds an INT_ZEXT
// the decompiler prints as `(ulonglong)(...)`; its `+` is the first of the function's.
const TEXT = 'uint f(int nRadius, uint s)\n{\n  return (uint)((ulonglong)s % (ulonglong)(nRadius * 2 + 1));\n}\n';
const row = (text: string, x = 'X\t004cea00\t1,0,1,0,0,0,0,0,0,0;0:0') => [
  'P\tGame.exe:1857',
  `F\t004cea00\tself\t${javaStringHash(text).toString(16)}\t${text.length}\t1`,
  x,
  'D\t',
].join('\n');

describe('zext sites', () => {
  it('parses a row', () => {
    const f = parseZextSiteRow('2,0,1,0,0,0,0,0,0,0;0:1;2:0');
    assert.deepStrictEqual(f?.sites, [{ operator: '+', ord: 1 }, { operator: '*', ord: 0 }]);
    assert.strictEqual(f?.counts['+'], 2);
    assert.strictEqual(Object.keys(f!.counts).length, ZEXT_OPERATORS.length);
  });

  it('rejects a malformed row or a position past the count', () => {
    assert.strictEqual(parseZextSiteRow('1,0,0;0:0'), null);
    assert.strictEqual(parseZextSiteRow('1,0,0,0,0,0,0,0,0,0;0:1'), null);
    assert.strictEqual(parseZextSiteRow('1,0,0,0,0,0,0,0,0,0;10:0'), null);
    assert.strictEqual(parseZextSiteRow('1,0,0,0,0,0,0,0,0,0'), null);
  });

  it('recognises the decompiles that print the cast', () => {
    assert.ok(printsZextCast(TEXT));
    assert.ok(!printsZextCast('return (ulonglong)s;'));
  });

  it('attaches the row only to the text it was read from', () => {
    const r = parseFunctionFacts(row(TEXT)).rows.get('004cea00')!;
    assert.strictEqual(r.zextRow, '1,0,1,0,0,0,0,0,0,0;0:0');
    assert.deepStrictEqual(selectFacts(TEXT, '004cea00', r, false).zextSites?.sites, [{ operator: '+', ord: 0 }]);
    assert.strictEqual(selectFacts(TEXT + ' ', '004cea00', r, false).zextSites, undefined);
  });

  it('is a cached fact and part of the script', () => {
    assert.ok((FACT_KEYS as readonly string[]).includes('zextSites'));
    assert.ok(ZEXT_SITES_JAVA.includes('INT_ZEXT') && ZEXT_SITES_JAVA.includes('"<<", ">>"'));
  });
});
