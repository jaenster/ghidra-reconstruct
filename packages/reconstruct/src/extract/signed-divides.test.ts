import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseFunctionFacts, selectFacts, FACT_KEYS } from './function-facts.js';
import { javaStringHash } from './compare-sites.js';
import { parseSignedDivideRow, printsCastDividend, SIGNED_DIVIDE_OPERATORS, SIGNED_DIVIDES_JAVA } from './signed-divides.js';

// OpenLogFileWithTimestamp 0040ebd0: `movzx eax, word ptr [esi]; cdq; mov ecx, 0x64; idiv ecx`
// is the decompile's one `%`.
const TEXT = 'void f(SYSTEMTIME *pSystemTime)\n{\n  g((uint)pSystemTime->wYear % 100,(uint)pSystemTime->wMonth);\n}\n';
const row = (text: string, i = 'I\t0040ebd0\t0,1;1:0') => [
  'P\tGame.exe:1936',
  `F\t0040ebd0\tself\t${javaStringHash(text).toString(16)}\t${text.length}\t1`,
  i,
  'D\t',
].join('\n');

describe('signed divides', () => {
  it('parses a row', () => {
    const f = parseSignedDivideRow('2,1;0:1;1:0');
    assert.deepStrictEqual(f?.sites, [{ operator: '/', ord: 1 }, { operator: '%', ord: 0 }]);
    assert.strictEqual(f?.counts['/'], 2);
    assert.strictEqual(Object.keys(f!.counts).length, SIGNED_DIVIDE_OPERATORS.length);
  });

  it('rejects a malformed row or a position past the count', () => {
    assert.strictEqual(parseSignedDivideRow('1;0:0'), null);
    assert.strictEqual(parseSignedDivideRow('1,0;0:1'), null);
    assert.strictEqual(parseSignedDivideRow('1,0;2:0'), null);
    assert.strictEqual(parseSignedDivideRow('1,0'), null);
  });

  it('recognises the decompiles that divide a cast value by a constant', () => {
    assert.ok(printsCastDividend(TEXT));
    assert.ok(printsCastDividend('x = (uint)p[2] / 0x18;'));
    assert.ok(!printsCastDividend('x = n % 100;'));
    assert.ok(!printsCastDividend('x = (uint)n % m;'));
  });

  it('attaches the row only to the text it was read from', () => {
    const r = parseFunctionFacts(row(TEXT)).rows.get('0040ebd0')!;
    assert.strictEqual(r.signedDivideRow, '0,1;1:0');
    assert.deepStrictEqual(selectFacts(TEXT, '0040ebd0', r, false).signedDivides?.sites, [{ operator: '%', ord: 0 }]);
    assert.strictEqual(selectFacts(TEXT + ' ', '0040ebd0', r, false).signedDivides, undefined);
  });

  it('is a cached fact and part of the script', () => {
    assert.ok((FACT_KEYS as readonly string[]).includes('signedDivides'));
    assert.ok(SIGNED_DIVIDES_JAVA.includes('"IDIV"') && SIGNED_DIVIDES_JAVA.includes('"/", "%"'));
  });
});
