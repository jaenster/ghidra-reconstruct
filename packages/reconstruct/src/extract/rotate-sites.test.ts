import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseRotateSiteRow, printsShiftPair } from './rotate-sites.js';
import { parseFunctionFacts, selectFacts } from './function-facts.js';

describe('rotate-sites row', () => {
  it('parses lines of rotates in instruction order', () => {
    assert.deepStrictEqual(parseRotateSiteRow('26\t21:l5;22:l1e|r2'), {
      lineCount: 26,
      lines: [[21, [{ left: true, count: 5 }]], [22, [{ left: true, count: 30 }, { left: false, count: 2 }]]],
    });
  });

  it('rejects a malformed or empty row', () => {
    assert.strictEqual(parseRotateSiteRow('26\t'), null);
    assert.strictEqual(parseRotateSiteRow('26\t21:x5'), null);
    assert.strictEqual(parseRotateSiteRow('x\t21:l5'), null);
    assert.strictEqual(parseRotateSiteRow('26\t21:l40'), null);
  });

  it('reaches the facts through the script output', () => {
    const text = 'void f(uint x) {\n  x = x << 0x1e | x >> 2;\n}\n';
    const out = parseFunctionFacts('F\t00425730\tself\t1f\t10\t1\nQ\t00425730\t3\t2:l1e\nD\t\n');
    const row = out.rows.get('00425730');
    assert.ok(row);
    assert.deepStrictEqual(selectFacts(text, '00425730', row, false).rotateSites, { lineCount: 3, lines: [[2, [{ left: true, count: 30 }]]] });
    assert.ok(printsShiftPair(text));
    assert.strictEqual(selectFacts('void f() {}\n', '00425730', row, false).rotateSites, undefined);
  });
});
