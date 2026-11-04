import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseStoreBaseRow, printsMemberAddress } from './store-bases.js';
import { parseFunctionFacts, selectFacts } from './function-facts.js';

describe('store-bases row', () => {
  it('parses stores off a register and LEAs into one', () => {
    assert.deepStrictEqual(parseStoreBaseRow('33\t24:0.l.EDX;26:0.s.EDX.4|1.s.EAX.-8'), {
      lineCount: 33,
      lines: [
        [24, [{ ord: 0, kind: 'l', reg: 'EDX', disp: 0 }]],
        [26, [{ ord: 0, kind: 's', reg: 'EDX', disp: 4 }, { ord: 1, kind: 's', reg: 'EAX', disp: -8 }]],
      ],
    });
  });

  it('rejects a malformed or empty row', () => {
    assert.strictEqual(parseStoreBaseRow('33\t'), null);
    assert.strictEqual(parseStoreBaseRow('33\t24:0.x.EDX'), null);
    assert.strictEqual(parseStoreBaseRow('33\t24:0.s.EDX'), null);
  });

  it('reaches the facts through the script output', () => {
    const text = 'void f(T *p) {\n  q = &p->m_link;\n  (p->m_link).m_next = 0;\n}\n';
    const out = parseFunctionFacts('F\t006023b0\tself\t1f\t10\t1\nW\t006023b0\t4\t2:0.l.EDX;3:0.s.EDX.4\nD\t\n');
    const row = out.rows.get('006023b0');
    assert.ok(row && printsMemberAddress(text));
    assert.strictEqual(selectFacts(text, '006023b0', row, false).storeBases?.lines.length, 2);
    assert.strictEqual(selectFacts('void f() {}\n', '006023b0', row, false).storeBases, undefined);
  });
});
