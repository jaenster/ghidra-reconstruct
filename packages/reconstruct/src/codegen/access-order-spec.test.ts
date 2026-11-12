import { describe, it } from 'node:test';
import assert from 'node:assert';
import { accessOrderLines } from './access-order-spec.js';
import { parseAccessOrderRow, printsAccess } from '../extract/access-order.js';

// Q32_PropagateCompleteToParty, 005887a0, as the facts script prints its `A` row.
const DECOMPILED = [
  '',
  'BOOL __fastcall Q32_PropagateCompleteToParty(SGAMEDATA *pGame,D2UnitStrc *pUnit,void *pArg)',
  '',
  '{',
  '  D2UnitDataPlayerStrc *pPlayerData;',
  '  BOOL bJustCompleted;',
  '  ',
  '  pPlayerData = GetPlayerData(pUnit);',
  '  bJustCompleted = GetQuestState(pPlayerData->pQuestRecord[pGame->nDifficulty],QUEST_RescueOnMountArreat,QUESTSTATE_JustCompleted);',
  '  if (bJustCompleted == 0) {',
  '    return 0;',
  '  }',
  '  return 0;',
  '}',
  '',
].join('\n');
const ROW = '005887a0\t14\t9:GetQuestState,19,3,0@EAX\t8:0,?,4,-;9:0,1e,4,-';

describe('access-order facts', () => {
  it('parses the row', () => {
    const r = parseAccessOrderRow(ROW)!;
    assert.strictEqual(r.entry, '005887a0');
    assert.deepStrictEqual(r.facts.args, [[9, [{ name: 'GetQuestState', at: 0x19, params: 3, loads: [{ param: 0, reg: 'EAX' }] }]]]);
    assert.deepStrictEqual(r.facts.stores, [[8, [{ ord: 0, at: null, size: 4, half: null }]], [9, [{ ord: 0, at: 0x1e, size: 4, half: null }]]]);
    assert.strictEqual(parseAccessOrderRow('005887a0\t15\t9:GetQuestState,19,0@EAX\t'), null);
  });

  it('keys the facts by line of the parsed wrapper', () => {
    const facts = parseAccessOrderRow(ROW)!.facts;
    const brace = DECOMPILED.indexOf('{');
    const body = DECOMPILED.slice(brace + 1, DECOMPILED.lastIndexOf('}'));
    const ev = accessOrderLines(facts, DECOMPILED, brace, body, body, 'BOOL dummy(SGAMEDATA *pGame) {')!;
    assert.deepStrictEqual([...ev.args.keys()], [6]);
    assert.deepStrictEqual([...ev.stores.keys()], [5, 6]);
  });

  it('drops facts that cannot be this text', () => {
    const facts = parseAccessOrderRow(ROW)!.facts;
    const brace = DECOMPILED.indexOf('{');
    const body = DECOMPILED.slice(brace + 1, DECOMPILED.lastIndexOf('}'));
    assert.strictEqual(accessOrderLines({ ...facts, lineCount: 13 }, DECOMPILED, brace, body, body, 'int dummy() {'), undefined);
    const moved = { ...facts, args: [[8, facts.args[0][1]]] as typeof facts.args };
    assert.strictEqual(accessOrderLines(moved, DECOMPILED, brace, body, body, 'int dummy() {'), undefined);
    const extra = { ...facts, stores: [[10, [{ ord: 0, at: 1, size: 4, half: null }]]] as typeof facts.stores };
    assert.strictEqual(accessOrderLines(extra, DECOMPILED, brace, body, body, 'int dummy() {'), undefined);
  });

  it('selects functions that call or assign', () => {
    assert.ok(printsAccess('{ x = 1; }'));
    assert.ok(printsAccess('{ f(); }'));
    assert.ok(!printsAccess('{ return; }'));
  });
});
