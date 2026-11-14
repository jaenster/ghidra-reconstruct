import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { getterTwinPlugin, type GetterTwin } from '../builtins/getter-twin.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

// GetQuestBitBuffer(pGame, pUnit): return GetPlayerData(pUnit)->pQuestRecord[pGame->nDifficulty];
const TWIN: GetterTwin = {
  call: 'Q::GetQuestBitBufferInline', params: 2, callee: 'GetPlayerData', calleeArgs: [1],
  member: 'pQuestRecord', indexParam: 0, indexMember: 'nDifficulty',
};

function run(src: string) {
  const sites: string[] = [];
  const t = getterTwinPlugin.createTransformer({ twins: [TWIN], onSite: e => sites.push(e.held ?? '-') } as never);
  return { out: flat(emit(t(parse(src)) as AnyNode)), sites };
}

describe('getter-twin', () => {
  it('writes a held call read once by the next statement as the twin (00594140)', () => {
    const { out, sites } = run(`int f(G *pGame, U *pPlayer) {
      int BVar1; P *pPlayerData;
      pPlayerData = U::GetPlayerData(pPlayer);
      BVar1 = GetQuestState(pPlayerData->pQuestRecord[pGame->nDifficulty], 7, 0x10);
      if (BVar1) { return 1; }
      pPlayerData = U::GetPlayerData(pPlayer);
      BVar1 = GetQuestState(pPlayerData->pQuestRecord[pGame->nDifficulty], 0x17, 0);
      return BVar1;
    }`);
    assert.deepStrictEqual(sites, ['pPlayerData', 'pPlayerData']);
    assert.ok(out.includes('BVar1 = GetQuestState(Q::GetQuestBitBufferInline(pGame, pPlayer), 7, 0x10);'), out);
    assert.ok(out.includes('BVar1 = GetQuestState(Q::GetQuestBitBufferInline(pGame, pPlayer), 0x17, 0);'), out);
    assert.ok(!out.includes('pPlayerData'), out);
  });

  it('takes an initialised declaration and a declaration reading it', () => {
    const { out } = run(`int f(G *pGame, U *pUnit) {
      P *pDVar1 = GetPlayerData(pUnit);
      int BVar2 = GetQuestState(pDVar1->pQuestRecord[pGame->nDifficulty], 3, 0xd);
      return BVar2;
    }`);
    assert.ok(out.includes('int BVar2 = GetQuestState(Q::GetQuestBitBufferInline(pGame, pUnit), 3, 0xd);'), out);
    assert.ok(!out.includes('pDVar1'), out);
  });

  it('writes a whole expansion as the twin', () => {
    const { out } = run(`void f(G *pGame, U *pUnit) {
      SetQuestState(GetPlayerData(pUnit)->pQuestRecord[pGame->nDifficulty], 3, 0xd);
    }`);
    assert.ok(out.includes('SetQuestState(Q::GetQuestBitBufferInline(pGame, pUnit), 3, 0xd);'), out);
  });

  it('keeps a local the function reads elsewhere', () => {
    const src = `int f(G *pGame, U *pUnit) {
      P *pPlayerData = GetPlayerData(pUnit);
      int b = GetQuestState(pPlayerData->pQuestRecord[pGame->nDifficulty], 3, 0xd);
      return b + pPlayerData->nOther;
    }`;
    const { out, sites } = run(src);
    assert.deepStrictEqual(sites, []);
    assert.ok(out.includes('pPlayerData->pQuestRecord'), out);
  });

  it('keeps a held call when the reading statement calls something else first', () => {
    const { sites } = run(`int f(G *pGame, U *pUnit) {
      P *pPlayerData = GetPlayerData(pUnit);
      return GetQuestState(pPlayerData->pQuestRecord[pGame->nDifficulty], Next(pUnit), 0xd);
    }`);
    assert.deepStrictEqual(sites, []);
  });

  it('keeps a held call read only in a later statement', () => {
    const { sites } = run(`int f(G *pGame, U *pUnit) {
      P *pPlayerData = GetPlayerData(pUnit);
      Log(1);
      return GetQuestState(pPlayerData->pQuestRecord[pGame->nDifficulty], 1, 0xd);
    }`);
    assert.deepStrictEqual(sites, []);
  });
});
