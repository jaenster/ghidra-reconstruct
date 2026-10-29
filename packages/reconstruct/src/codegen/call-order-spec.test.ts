import { describe, it } from 'node:test';
import assert from 'node:assert';
import { callOrderLines } from './call-order-spec.js';
import { parseCallOrder, callOrderBatches, callOrderScript } from '../extract/call-order.js';

// The two calls of Q04_ActiveFilter (00592fb0) as a small decompile, with the script's row.
const DECOMPILED = [
  '',
  'int Q04_ActiveFilter(D2UnitStrc *pUnit)',
  '',
  '{',
  '  D2GameStrc *pGame;',
  '  int r;',
  '  ',
  '  pGame = GetGamePointer(pUnit);',
  '  r = HasQuestItem(pGame,pUnit,0x20736b62);',
  '  return r;',
  '}',
  '',
].join('\n');
const ROW = '00592fb0\t11\t8:GetGamePointer,56,,1,0;9:HasQuestItem,5f,56,0,0.0.1\n';

function split(decompiled: string): { brace: number; body: string } {
  const m = decompiled.match(/\)[\s\n]*\{([\s\S]*)\}[\s\S]*$/)!;
  return { brace: m.index! + m[0].indexOf('{'), body: m[1] };
}

describe('call order facts', () => {
  it('parses the script rows: no previous call, register and stack slots, unknown and none', () => {
    const facts = parseCallOrder(ROW + 'ROWS 2\n00401000\t3\t2:printf,-4,,2,?|Get,10,8,0,-\n');
    const q = facts.get('00592fb0')!;
    assert.deepStrictEqual(q.calls[0], [8, [{ name: 'GetGamePointer', at: 0x56, prev: null, pushes: 1, slots: [0] }]]);
    assert.deepStrictEqual(q.calls[1][1][0], { name: 'HasQuestItem', at: 0x5f, prev: 0x56, pushes: 0, slots: [0, 0, 1] });
    const p = facts.get('00401000')!.calls[0][1];
    assert.deepStrictEqual(p.map(c => [c.at, c.slots]), [[-4, null], [0x10, []]]);
  });

  it('keys the facts by line of the parsed wrapper', () => {
    const { brace, body } = split(DECOMPILED);
    const ev = callOrderLines(parseCallOrder(ROW).get('00592fb0'), DECOMPILED, brace, body, body, 'int dummy(D2UnitStrc *pUnit) {')!;
    // Decompile line 8 is the fifth line of the body: the wrapper's line 5.
    assert.strictEqual(ev.lines.get(5)![0].name, 'GetGamePointer');
    assert.strictEqual(ev.lines.get(6)![0].name, 'HasQuestItem');
  });

  it('drops facts from another text', () => {
    const { brace, body } = split(DECOMPILED);
    const facts = parseCallOrder(ROW).get('00592fb0')!;
    assert.strictEqual(callOrderLines({ ...facts, lineCount: 12 }, DECOMPILED, brace, body, body, 'int dummy() {'), undefined);
    const moved = { ...facts, calls: [[7, facts.calls[0][1]] as typeof facts.calls[0]] };
    assert.strictEqual(callOrderLines(moved, DECOMPILED, brace, body, body, 'int dummy() {'), undefined);
    assert.strictEqual(callOrderLines(facts, DECOMPILED, brace, body, body + '\n', 'int dummy() {'), undefined);
  });

  it('batches only functions where a call result can feed a call', () => {
    const fns = [
      { address: '00592fb0', decompiled: DECOMPILED },
      { address: '0x401000', decompiled: '{\n  x = 1;\n  f(x);\n}' },
    ];
    assert.deepStrictEqual(callOrderBatches(fns), [['00592fb0']]);
    assert.ok(callOrderScript(['00592fb0']).includes('String items = "00592fb0";'));
  });
});
