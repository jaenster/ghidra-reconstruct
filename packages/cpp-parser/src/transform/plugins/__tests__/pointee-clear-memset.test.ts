import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { pointeeClearMemsetPlugin } from '../builtins/pointee-clear-memset.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

const LAYOUTS = {
  POINT: [{ name: 'x', offset: 0, size: 4, type: 'int' }, { name: 'y', offset: 4, size: 4, type: 'int' }],
  // MEMORYSTATUS, cut to four members.
  MS: [
    { name: 'dwLength', offset: 0, size: 4, type: 'DWORD' }, { name: 'dwLoad', offset: 4, size: 4, type: 'DWORD' },
    { name: 'dwPhys', offset: 8, size: 4, type: 'DWORD' }, { name: 'dwVirt', offset: 12, size: 4, type: 'DWORD' },
  ],
  // ScreenMessage_t: an array member and members at odd offsets.
  MSG: [
    { name: 'aLines', offset: 0, size: 8, type: 'wchar_t *[2]' }, { name: 'nCount', offset: 8, size: 2, type: 'uint16_t' },
    { name: 'color', offset: 10, size: 4, type: 'int' },
  ],
  // D2Packet0x5aEventStructure, cut down.
  PKT: [
    { name: 'nId', offset: 0, size: 1, type: 'uint8_t' }, { name: 'nArg', offset: 1, size: 4, type: 'uint32_t' },
    { name: 'nTypes', offset: 5, size: 1, type: 'uint8_t' }, { name: 'szName', offset: 6, size: 16, type: 'char[16]' },
  ],
};
const SIZES = { POINT: 8, MS: 16, MSG: 14, PKT: 22 };

type Rows = Array<{ name: string; size: number; value: number; register: boolean }>;
function run(src: string, rows: Rows, zeroStores: Array<{ name: string; size: number; zero: [number, number][] }> = []): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = pointeeClearMemsetPlugin.createTransformer({
    structLayouts: LAYOUTS, aggregateSizes: SIZES, typedefTargets: { tagPOINT: 'POINT', LPMS: '_MS *', _MS: 'MS' }, registerStores: rows, zeroStores,
    onSite: e => sites.push(`${e.pointer}:${e.type}:${e.members}${e.partial ? ':partial' : ''}`),
  });
  return { out: flat(emit(t(parse(src)) as AnyNode)), sites };
}

const REG = [{ name: 'x', size: 4, value: 0, register: true }, { name: 'y', size: 4, value: 0, register: true }];

// FIELDTBLS_AllocPoint 0066a4b0: `xor ecx, ecx; mov [eax], ecx; mov [eax+4], ecx`.
const SITE = 'POINT* f() { POINT* pPoint = (POINT*)alloc(8); pPoint->x = 0; pPoint->y = 0; return pPoint; }';

describe('pointee-clear-memset', () => {
  it('writes the zero stores of every member from one register as the memset', () => {
    const r = run(SITE, REG);
    assert.deepStrictEqual(r.sites, ['pPoint:POINT:2']);
    assert.ok(r.out.includes('memset(pPoint, 0, sizeof(*pPoint)); return pPoint;'), r.out);
  });

  it('resolves the pointee through a typedef', () => {
    const r = run(SITE.replace(/POINT\*/g, 'tagPOINT*'), REG);
    assert.deepStrictEqual(r.sites, ['pPoint:POINT:2']);
  });

  it('leaves immediate stores', () => {
    assert.deepStrictEqual(run(SITE, REG.map(r => ({ ...r, register: false }))).sites, []);
  });

  it('leaves a run that misses a member', () => {
    const src = 'POINT* f() { POINT* pPoint = (POINT*)alloc(8); pPoint->x = 0; g(); pPoint->y = 0; return pPoint; }';
    assert.deepStrictEqual(run(src, REG).sites, []);
  });

  it('changes nothing without the facts', () => {
    assert.deepStrictEqual(run(SITE, []).sites, []);
  });

  describe('a clear printed in pieces', () => {
    const ms = (tail: string) => `void f(MS *p) { p->dwLoad = 0; p->dwPhys = 0; p->dwVirt = 0; ${tail} g(p); }`;
    const msRows: Rows = ['dwLoad', 'dwPhys', 'dwVirt'].map(name => ({ name, size: 4, value: 0, register: true }));

    it('GetGlobalMemoryStatus 00410930: the member the zero run misses is stored next', () => {
      const r = run(ms('p->dwLength = 0x10;'), msRows);
      assert.deepStrictEqual(r.sites, ['p:MS:3:partial']);
      assert.ok(r.out.includes('{ memset(p, 0, sizeof(*p)); p->dwLength = 0x10; g(p); }'), r.out);
      // Through a pointer typedef.
      assert.deepStrictEqual(run(ms('p->dwLength = 0x10;').replace('MS *p', 'LPMS p'), msRows).sites, ['p:MS:3:partial']);
    });

    it('FINDTILE_AddTileToChain 0060cea0: one register zero store, the rest stored from other values', () => {
      const r = run('void f(POINT *p, int v, POINT *q) { p->y = 0; p->x = v; p->y = q->x; }', [{ name: 'y', size: 4, value: 0, register: true }]);
      assert.deepStrictEqual(r.sites, ['p:POINT:1:partial']);
      assert.ok(r.out.includes('{ memset(p, 0, sizeof(*p)); p->x = v; p->y = q->x; }'), r.out);
    });

    it('leaves a missing member stored after a call, from the object, or never', () => {
      assert.deepStrictEqual(run(ms('g(p); p->dwLength = 0x10;'), msRows).sites, []);
      assert.deepStrictEqual(run(ms('p->dwLength = p->dwLoad;'), msRows).sites, []);
      assert.deepStrictEqual(run(ms('p->dwLength = h();'), msRows).sites, []);
      assert.deepStrictEqual(run(ms(''), msRows).sites, []);
    });

    it('leaves a run with an immediate zero store, or no register one', () => {
      assert.deepStrictEqual(run(ms('p->dwLength = 0x10;'), msRows.map((r, i) => ({ ...r, register: i !== 1 }))).sites, []);
      assert.deepStrictEqual(run(ms('p->dwLength = 0x10;'), []).sites, []);
    });

    it('TEXT_AllocScreenMessage 0049db10: an array memset and stores at byte offsets', () => {
      const src = 'void f(MSG *p) { memset(p->aLines, 0, 2 * sizeof(p->aLines[0])); *(uint32_t*)&p->nCount = 0; *(uint16_t*)((uintptr_t)&p->color + 2) = 0; g(p); }';
      const r = run(src, [{ name: 'nCount', size: 4, value: 0, register: true }]);
      assert.deepStrictEqual(r.sites, ['p:MSG:3:partial']);
      assert.ok(r.out.includes('{ memset(p, 0, sizeof(*p)); g(p); }'), r.out);
      // A byte left uncovered.
      assert.deepStrictEqual(run(src.replace(' *(uint16_t*)((uintptr_t)&p->color + 2) = 0;', ''), [{ name: 'nCount', size: 4, value: 0, register: true }]).sites, []);
    });

    it('PLAYER_SendInventoryFullMessage 00549a60: a stack local whose opening stores clear it', () => {
      const src = 'void f() { PKT s; s.nTypes = 0; memset(s.szName, 0, 16 * sizeof(s.szName[0])); s.nId = 0x5a; s.nArg = 0; g(&s); }';
      const r = run(src, [], [{ name: 's', size: 22, zero: [[0, 22]] }]);
      assert.deepStrictEqual(r.sites, ['s:PKT:2:partial']);
      assert.ok(r.out.includes('PKT s; memset(&s, 0, sizeof(s)); s.nId = 0x5a; s.nArg = 0; g(&s); }'), r.out);
      assert.deepStrictEqual(run(src, [], [{ name: 's', size: 22, zero: [[0, 5]] }]).sites, []);
      assert.deepStrictEqual(run(src, []).sites, []);
    });
  });
});
