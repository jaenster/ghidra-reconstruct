import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { memberCopyAssignPlugin } from '../builtins/member-copy-assign.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

const LAYOUTS = {
  // D2GSPacketSrv0x5D.
  PKT: [
    { name: 'nId', offset: 0, size: 1, type: 'uint8_t' }, { name: 'nQuest', offset: 1, size: 1, type: 'uint8_t' },
    { name: 'nFlags', offset: 2, size: 2, type: 'uint16_t' }, { name: 'nExtra', offset: 4, size: 2, type: 'uint16_t' },
  ],
  // D2GSPacketSrv0x2A, cut down: members off the dword grid.
  TRADE: [
    { name: 'nId', offset: 0, size: 1, type: 'byte' }, { name: 'field_0x1', offset: 1, size: 1, type: 'undefined' },
    { name: 'nGold', offset: 2, size: 4, type: 'int' },
  ],
};
const SIZES = { PKT: 6, TRADE: 6, OTHER: 6 };

function run(src: string, globalTypes: Record<string, string> = {}): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = memberCopyAssignPlugin.createTransformer({
    structLayouts: { ...LAYOUTS, OTHER: LAYOUTS.PKT }, aggregateSizes: SIZES, typedefTargets: {}, globalTypes,
    onSite: e => sites.push(`${e.target}=*${e.source}:${e.type}:${e.pieces}`),
  });
  return { out: flat(emit(t(parse(src)) as AnyNode)), sites };
}

// NET_D2GS_SERVER_Send_0x5D_QuestState 0053d710.
const SITE = 'void f(void *pClient, PKT *pPacket) { PKT a; a.nId = pPacket->nId; a.nQuest = pPacket->nQuest; '
  + 'a.nFlags = pPacket->nFlags; a.nExtra = pPacket->nExtra; send(&a.nId, 6, pClient); }';

describe('member-copy-assign', () => {
  it('writes member copies of every byte of *P into a local as the assignment', () => {
    const r = run(SITE);
    assert.deepStrictEqual(r.sites, ['a=*pPacket:PKT:4']);
    assert.ok(r.out.includes('PKT a; a = *pPacket; send(&a.nId, 6, pClient); }'), r.out);
  });

  it('NPCMENU_HandleTradePacket 004b6390: puns at byte offsets into a global', () => {
    const src = 'void f(TRADE *p) { G.nId = p->nId; G.field_0x1 = p->field_0x1; '
      + '*(uint16_t*)((char*)&G + 2) = *(uint16_t*)((uintptr_t)&p->nGold); '
      + '*(uint16_t*)((char*)&G.nGold + 2) = *(uint16_t*)((uintptr_t)&p->nGold + 2); g(); }';
    const r = run(src, { G: 'TRADE' });
    assert.deepStrictEqual(r.sites, ['G=*p:TRADE:4']);
    assert.ok(r.out.includes('{ G = *p; g(); }'), r.out);
  });

  it('leaves a byte uncovered, a piece read from another offset, and another type', () => {
    assert.deepStrictEqual(run(SITE.replace(' a.nExtra = pPacket->nExtra;', '')).sites, []);
    assert.deepStrictEqual(run(SITE.replace('a.nExtra = pPacket->nExtra', 'a.nExtra = pPacket->nFlags')).sites, []);
    assert.deepStrictEqual(run(SITE.replace('PKT *pPacket', 'OTHER *pPacket')).sites, []);
  });

  it('leaves a local whose address was taken before the run', () => {
    assert.deepStrictEqual(run(SITE.replace('PKT a;', 'PKT a; keep(&a);')).sites, []);
  });
});
