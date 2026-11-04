import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { pointeeClearMemsetPlugin } from '../builtins/pointee-clear-memset.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

const LAYOUTS = {
  POINT: [{ name: 'x', offset: 0, size: 4, type: 'int' }, { name: 'y', offset: 4, size: 4, type: 'int' }],
};
const SIZES = { POINT: 8 };

function run(src: string, rows: Array<{ name: string; size: number; value: number; register: boolean }>): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = pointeeClearMemsetPlugin.createTransformer({
    structLayouts: LAYOUTS, aggregateSizes: SIZES, typedefTargets: { tagPOINT: 'POINT' }, registerStores: rows,
    onSite: e => sites.push(`${e.pointer}:${e.type}:${e.members}`),
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
});
