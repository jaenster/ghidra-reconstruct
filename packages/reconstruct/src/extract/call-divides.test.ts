import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseCallDivideRow, printsHalvedValue } from './call-divides.js';
import { parseFunctionFacts, selectFacts } from './function-facts.js';

describe('call-divides row', () => {
  it('parses lines of divided calls', () => {
    assert.deepStrictEqual(parseCallDivideRow('404\t189:DRAW_text0,2;200:g,4|h,2'), {
      lineCount: 404,
      lines: [[189, [{ name: 'DRAW_text0', k: 2 }]], [200, [{ name: 'g', k: 4 }, { name: 'h', k: 2 }]]],
    });
  });

  it('rejects a malformed row or a divisor that is no power of two', () => {
    assert.strictEqual(parseCallDivideRow('404\t'), null);
    assert.strictEqual(parseCallDivideRow('404\t189:g,3'), null);
    assert.strictEqual(parseCallDivideRow('x\t189:g,2'), null);
  });

  it('reaches the facts through the script output', () => {
    const text = 'int f() {\n  w = g();\n  return 1 - w / 2;\n}\n';
    const out = parseFunctionFacts('F\t00495410\tself\t1f\t10\t1\nV\t00495410\t4\t2:g,2\nD\t\n');
    const row = out.rows.get('00495410');
    assert.ok(row);
    assert.ok(printsHalvedValue(text));
    assert.deepStrictEqual(selectFacts(text, '00495410', row, false).callDivides, { lineCount: 4, lines: [[2, [{ name: 'g', k: 2 }]]] });
  });
});
