import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseArithSiteRow, printsArithSite } from './arith-sites.js';
import { parseFunctionFacts, selectFacts } from './function-facts.js';

describe('arith-sites row', () => {
  it('parses multiplies, sums and CONCATs in token order', () => {
    assert.deepStrictEqual(parseArithSiteRow('20\t13:m8h|m-;15:a-i|a0id0.nRandDamage;16:c2w|c3n'), {
      lineCount: 20,
      lines: [
        [13, [{ kind: 'mul', log2: 8, evidence: 'highbyte' }, { kind: 'mul' }]],
        [15, [{ kind: 'add', width: 'int' }, { kind: 'add', consumer: 0, width: 'int', into: { input: 0, name: 'nRandDamage' } }]],
        [16, [{ kind: 'concat', bytes: 2, widened: true }, { kind: 'concat', bytes: 3, widened: false }]],
      ],
    });
    assert.deepStrictEqual(parseArithSiteRow('9\t4:m4s|m10x|a-p'), {
      lineCount: 9,
      lines: [[4, [{ kind: 'mul', log2: 4, evidence: 'shift' }, { kind: 'mul', log2: 16, evidence: 'other' }, { kind: 'add', width: 'ptr' }]]],
    });
  });

  it('rejects a malformed or empty row', () => {
    assert.strictEqual(parseArithSiteRow('20\t'), null);
    assert.strictEqual(parseArithSiteRow('20\t13:m8q'), null);
    assert.strictEqual(parseArithSiteRow('20\t13:m0s'), null);
    assert.strictEqual(parseArithSiteRow('20\t13:a-z'), null);
    assert.strictEqual(parseArithSiteRow('x\t13:m8s'), null);
  });

  it('reaches the facts through the script output', () => {
    const text = 'void f(uint x) {\n  x = (uint)b * 0x100;\n}\n';
    const out = parseFunctionFacts('F\t004bde00\tself\t1f\t10\t1\nG\t004bde00\t3\t2:m8h\nD\t\n');
    const row = out.rows.get('004bde00');
    assert.ok(row);
    assert.deepStrictEqual(selectFacts(text, '004bde00', row, false).arithSites, { lineCount: 3, lines: [[2, [{ kind: 'mul', log2: 8, evidence: 'highbyte' }]]] });
    assert.ok(printsArithSite(text));
    assert.ok(printsArithSite('x = x + a + b;'));
    assert.ok(printsArithSite('y = CONCAT11(a,b);'));
    assert.strictEqual(selectFacts('void f() {}\n', '004bde00', row, false).arithSites, undefined);
  });
});
