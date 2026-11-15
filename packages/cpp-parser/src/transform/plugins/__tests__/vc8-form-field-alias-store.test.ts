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
  Observe(ppMap);
}`;
const form = parseVc8Form('fieldalias(ppMap)')!;
const tables: Vc8FormTables = {
  functionReturnTypes: {Make:'AI*',Produce:'AI*'},
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
describe('direct field store before retaining its address alias', () => {
  it('writes the field once before retaining its address for later calls', () => {
    const r=run(); assert.equal(r.sites[0].applied,true);
    assert.match(r.code,/q->map = pCopy;\s*AI\*\* ppMap = &q->map;\s*if \(!q->spawned\)/);
    assert.equal(r.code.match(/q->map = pCopy;/g)?.length,1);assert.match(r.code,/Observe\(ppMap\);/);
    assert.doesNotMatch(r.code,/\*ppMap =/);
  });
  it('folds a single-use typed producer while retaining its evaluation position',()=>{
    const code=source.replace('*ppMap = pCopy;','AI* value = Make(pCopy); *ppMap = value;');
    const r=run(code);assert.equal(r.sites[0].applied,true);
    assert.match(r.code,/q->map = Make\(pCopy\);\s*AI\*\* ppMap = &q->map;/);
    assert.doesNotMatch(r.code,/AI\* value/);
  });
  it('also folds a producer immediately before the alias declaration',()=>{
    const code=source.replace('AI** ppMap = &q->map;','AI* value=Make(pCopy); AI** ppMap = &q->map;').replace('*ppMap = pCopy;','*ppMap = value;');
    const r=run(code);assert.equal(r.sites[0].applied,true);
    assert.match(r.code,/q->map = Make\(pCopy\);\s*AI\*\* ppMap = &q->map;/);
  });
  it('retains a producer local with another later value use',()=>{
    const code=source.replace('*ppMap = pCopy;','AI* value=Make(pCopy); *ppMap = value;').replace('Observe(ppMap);','Observe(ppMap); Consume(value);');
    const r=run(code);assert.equal(r.sites[0].applied,true);
    assert.match(r.code,/AI\* value = Make\(pCopy\);\s*q->map = value;\s*AI\*\* ppMap/);
    assert.match(r.code,/Consume\(value\);/);
  });
  for(const returns of [undefined,'Proxy'])it(`retains a producer with ${returns??'unknown'} return type`,()=>{
    const config=structuredClone(tables);config.functionReturnTypes=returns?{Make:returns}:{};
    const code=source.replace('*ppMap = pCopy;','AI* value=Make(pCopy); *ppMap=value;');
    const r=run(code,config);assert.equal(r.sites[0].applied,true);
    assert.match(r.code,/AI\* value = Make\(pCopy\);\s*q->map = value;/);
  });
  it('leaves an already direct field store alone',()=>{
    refused(source.replace('AI** ppMap = &q->map;','').replace('*ppMap = pCopy;','q->map = pCopy;'));
  });
  it('is idempotent when the form is replayed', () => { const a = run(); assert.equal(run(a.code).code, a.code); });
  it('accepts the unbraced return guard the reconstruction pipeline produces', () => {
    const r = run(source.replace('{ return; }', 'return;')); assert.equal(r.sites[0].applied, true);
    assert.match(r.code, /q->map = pCopy;\s*AI\*\* ppMap = &q->map;\s*if \(!q->spawned\)/);
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
    ['a static alias', (s: string) => s.replace('AI** ppMap', 'static AI** ppMap')],
    ['a static producer', (s: string) => s.replace('*ppMap = pCopy;', 'static AI* value = Make(pCopy); *ppMap = value;')],
    ['a producer that already reads the alias', (s: string) => s.replace('*ppMap = pCopy;', 'AI* value = Make(ppMap); *ppMap = value;')],
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
    const r=transformGhidraCode(source,{usePluginRegistry:true,preset:'full',vc8Forms:{forms:[{form}],selectTables:tables}});
    assert.ok(r.success,r.error);assert.equal(r.code.match(/q->map = pCopy;/g)?.length,1);
    assert.match(r.code,/Observe\(ppMap\);/);assert.doesNotMatch(r.code,/\*ppMap =/);
  });
  it('preserves all flag values, pointer choices and unsigned counter boundaries in an optimized native build', { skip: !hasNativeGpp() }, () => {
    const code = `struct AI { int unused; }; struct Q { AI* map; uint8_t spawned; uint32_t after; }; AI** observed; void Observe(AI** p) { observed=p; }
      namespace Expected { ${source} } namespace Actual { ${run().code} } namespace Unbraced { ${run(source.replace('{ return; }', 'return;')).code} }`;
    const output = compileAndRun(code, `AI objects[3]; AI* choices[4] = {0, &objects[0], &objects[1], &objects[2]};
      uint32_t counts[4] = {0,1,0xfffffffeU,0xffffffffU};
      for (unsigned flag=0; flag<256; ++flag) for (unsigned old=0; old<4; ++old) for (unsigned next=0; next<4; ++next) for (unsigned n=0; n<4; ++n) {
        Q a = {choices[old], (uint8_t)flag, counts[n]}, b = a, c = a;
        observed=0; Expected::update(&a, choices[next]); if(observed!=(flag?&a.map:0)) return 2;
        observed=0; Actual::update(&b, choices[next]); if(observed!=(flag?&b.map:0)) return 3;
        observed=0; Unbraced::update(&c, choices[next]); if(observed!=(flag?&c.map:0)) return 4;
        if (a.map != b.map || a.spawned != b.spawned || a.after != b.after || a.map != c.map || a.spawned != c.spawned || a.after != c.after) return 1;
      }
      printf("ok");`,{optimize:true});
    assert.equal(output, 'ok');
  });
  it('evaluates a folded producer exactly once on both guard paths in optimized native code',{skip:!hasNativeGpp()},()=>{
    const input=source.replace('*ppMap = pCopy;','AI* value=Produce(pCopy); *ppMap=value;');
    const r=run(input);assert.equal(r.sites[0].applied,true);
    const code=`struct AI {int unused;}; struct Q {AI* map; uint8_t spawned; uint32_t after;};
      unsigned calls; AI** observed; AI* Produce(AI* p){++calls;return p;} void Observe(AI** p){observed=p;}
      namespace Expected {${input}} namespace Actual {${r.code}}`;
    const output=compileAndRun(code,`AI objects[3]; AI* choices[4]={0,&objects[0],&objects[1],&objects[2]};
      uint32_t counts[4]={0,1,0xfffffffeU,0xffffffffU};
      for(unsigned flag=0;flag<256;++flag)for(unsigned old=0;old<4;++old)for(unsigned next=0;next<4;++next)for(unsigned n=0;n<4;++n){
        Q a={choices[old],(uint8_t)flag,counts[n]},b=a;
        calls=0;observed=0;Expected::update(&a,choices[next]);if(calls!=1||observed!=(flag?&a.map:0))return 1;
        calls=0;observed=0;Actual::update(&b,choices[next]);if(calls!=1||observed!=(flag?&b.map:0))return 2;
        if(a.map!=b.map||a.spawned!=b.spawned||a.after!=b.after)return 3;
      }puts("16384 producer cases ok");`,{optimize:true});
    assert.equal(output.trim(),'16384 producer cases ok');
  });
});
