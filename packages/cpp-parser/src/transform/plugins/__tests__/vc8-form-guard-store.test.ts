import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { transformGhidraCode } from '../../../index.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormTables, type Vc8FormSite } from '../builtins/vc8-form.js';

const source = `void update(Q* q, AI* pCopy) {
  AI** ppMap = &q->map;
  *ppMap = pCopy;
  if (!q->spawned) { return; }
  q->after += 1;
}`;
const form = parseVc8Form('dup(*ppMap = pCopy)')!;
const tables: Vc8FormTables = {
  targetPointerSize: 4, aggregateSizes: { Q: 12 }, unionNames: [],
  structLayouts: { Q: [
    { name: 'map', offset: 0, size: 4, type: 'AI*' },
    { name: 'spawned', offset: 4, size: 1, type: 'uint8_t' },
    { name: 'after', offset: 8, size: 4, type: 'uint32_t' },
  ] },
};
function run(code = source, config = tables, requested = form): { code: string; sites: Vc8FormSite[] } {
  const sites: Vc8FormSite[] = [];
  const ast = applyVc8Forms(parse(code), [{ form: requested }], s => sites.push(s), config);
  return { code: emit(ast), sites };
}
function refused(code = source, config = tables): void {
  const r = run(code, config); assert.equal(r.code, emit(parse(code))); assert.equal(r.sites[0].applied, false);
}
describe('dup before a typed field return guard', () => {
  it('copies the store onto both guard paths without changing its evaluation count', () => {
    const r = run(); assert.equal(r.sites[0].applied, true);
    assert.match(r.code, /if \(!q->spawned\) \{\s*\*ppMap = pCopy;\s*return;\s*\}\s*\*ppMap = pCopy;/);
    assert.equal(r.code.match(/\*ppMap = pCopy;/g)?.length, 2);
  });
  it('also proves a direct member destination', () => {
    const direct = source.replace('AI** ppMap = &q->map;', '').replace('*ppMap = pCopy;', 'q->map = pCopy;');
    const r = run(direct, tables, parseVc8Form('dup(q->map=pCopy)')!); assert.equal(r.sites[0].applied, true);
  });
  it('is idempotent when the form is replayed', () => { const a = run(); assert.equal(run(a.code).code, a.code); });
  it('accepts the unbraced return guard the reconstruction pipeline produces', () => {
    const r = run(source.replace('{ return; }', 'return;')); assert.equal(r.sites[0].applied, true);
    assert.match(r.code, /if \(!q->spawned\) \{\s*\*ppMap = pCopy;\s*return;/);
  });
  it('refuses an alias that captured a global before a local receiver hid it', () => {
    refused(`Q* q; void update(AI* pCopy, Q* other) {
      AI** ppMap = &q->map;
      Q* q = other;
      *ppMap = pCopy;
      if (!q->spawned) { return; }
      q->after += 1;
    }`);
  });
  it('uses the same proof at 64-bit pointer width', () => {
    const c = structuredClone(tables); c.targetPointerSize = 8; c.aggregateSizes!.Q = 16;
    c.structLayouts!.Q = [{ name: 'map', offset: 0, size: 8, type: 'AI*' }, { name: 'spawned', offset: 8, size: 1, type: 'uint8_t' }, { name: 'after', offset: 12, size: 4, type: 'uint32_t' }];
    assert.equal(run(source, c).sites[0].applied, true);
  });
  for (const [name, edit] of [
    ['a different receiver', (s: string) => s.replace('Q* q,', 'Q* other, Q* q,').replace('!q->spawned', '!other->spawned')],
    ['a changed alias', (s: string) => s.replace('*ppMap = pCopy;', 'ppMap = &q->map; *ppMap = pCopy;')],
    ['an escaped alias variable', (s: string) => s.replace('*ppMap = pCopy;', 'mutate(&ppMap); *ppMap = pCopy;')],
    ['a changed receiver', (s: string) => s.replace('*ppMap = pCopy;', 'q = other(); *ppMap = pCopy;')],
    ['an escaped receiver variable', (s: string) => s.replace('*ppMap = pCopy;', 'mutate(&q); *ppMap = pCopy;')],
    ['a changed RHS binding', (s: string) => s.replace('*ppMap = pCopy;', 'pCopy = other(); *ppMap = pCopy;')],
    ['a volatile receiver', (s: string) => s.replace('Q* q', 'volatile Q* q')],
    ['a volatile alias variable', (s: string) => s.replace('AI** ppMap', 'AI** volatile ppMap')],
    ['a call RHS', (s: string) => s.replace('*ppMap = pCopy;', '*ppMap = make();')],
    ['a call in the guard', (s: string) => s.replace('!q->spawned', '!read(q)')],
    ['an else arm', (s: string) => s.replace('{ return; }', '{ return; } else { q->after = 2; }')],
    ['an arm with effects', (s: string) => s.replace('{ return; }', '{ q->after = 2; return; }')],
    ['a return expression', (s: string) => s.replace('void update', 'int update').replace('return;', 'return 0;')],
    ['a label', (s: string) => s.replace('*ppMap = pCopy;', 'label: *ppMap = pCopy;')],
    ['a loop', (s: string) => s.replace('q->after += 1;', 'while (q->spawned) { q->after += 1; }')],
    ['a shadowed receiver', (s: string) => s.replace('q->after += 1;', '{ Q* q = other(); q->after += 1; }')],
    ['two matching sites', (s: string) => s.replace('q->after += 1;', '*ppMap = pCopy; if (!q->spawned) { return; } q->after += 1;')],
  ] as const) it(`refuses ${name}`, () => refused(edit(source)));
  for (const [name, edit] of [
    ['unknown pointer size', (c: Vc8FormTables) => { delete c.targetPointerSize; }],
    ['unknown object size', (c: Vc8FormTables) => { delete c.aggregateSizes; }],
    ['a union', (c: Vc8FormTables) => { c.unionNames = ['Q']; }],
    ['an overlapping field', (c: Vc8FormTables) => { c.structLayouts!.Q = [...c.structLayouts!.Q, { name: 'overlap', offset: 2, size: 4, type: 'uint32_t' }]; }],
    ['a volatile flag', (c: Vc8FormTables) => { c.structLayouts!.Q = c.structLayouts!.Q.map(f => f.name === 'spawned' ? { ...f, type: 'volatile uint8_t' } : f); }],
    ['an unknown-width bitfield', (c: Vc8FormTables) => { c.structLayouts!.Q = c.structLayouts!.Q.map(f => f.name === 'spawned' ? { ...f, bitSize: 0 } : f); }],
    ['a pointer-size mismatch', (c: Vc8FormTables) => { c.targetPointerSize = 8; }],
    ['a field outside the aggregate', (c: Vc8FormTables) => { c.aggregateSizes!.Q = 4; }],
  ] as const) it(`refuses ${name}`, () => { const c = structuredClone(tables); edit(c); refused(source, c); });
  it('is reached through the complete transform pipeline', () => {
    const direct = source.replace('AI** ppMap = &q->map;', '').replace('*ppMap = pCopy;', 'q->map = pCopy;');
    const r = transformGhidraCode(direct, { usePluginRegistry: true, preset: 'full', vc8Forms: { forms: [{ form: parseVc8Form('dup(q->map=pCopy)')! }], selectTables: tables } });
    assert.ok(r.success, r.error); assert.equal(r.code.match(/q->map = pCopy;/g)?.length, 2);
  });
  it('preserves all flag values, pointer choices and unsigned counter boundaries in an optimized native build', { skip: !hasNativeGpp() }, () => {
    const code = `struct AI { int unused; }; struct Q { AI* map; uint8_t spawned; uint32_t after; };
      namespace Expected { ${source} } namespace Actual { ${run().code} } namespace Unbraced { ${run(source.replace('{ return; }', 'return;')).code} }`;
    const output = compileAndRun(code, `AI objects[3]; AI* choices[4] = {0, &objects[0], &objects[1], &objects[2]};
      uint32_t counts[4] = {0,1,0xfffffffeU,0xffffffffU};
      for (unsigned flag=0; flag<256; ++flag) for (unsigned old=0; old<4; ++old) for (unsigned next=0; next<4; ++next) for (unsigned n=0; n<4; ++n) {
        Q a = {choices[old], (uint8_t)flag, counts[n]}, b = a, c = a;
        Expected::update(&a, choices[next]); Actual::update(&b, choices[next]); Unbraced::update(&c, choices[next]);
        if (a.map != b.map || a.spawned != b.spawned || a.after != b.after || a.map != c.map || a.spawned != c.spawned || a.after != c.after) return 1;
      }
      printf("ok");`);
    assert.equal(output, 'ok');
  });
});
