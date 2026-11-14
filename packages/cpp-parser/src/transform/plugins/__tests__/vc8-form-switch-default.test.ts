import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite, type Vc8FormTables } from '../builtins/vc8-form.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const code = 'int f(int x) { switch (x) { case 0: case 1: return 1; } return 0; }';
const tag = 'swdefault(x,3,4,5)';
function run(source = code, text = tag, tables: Vc8FormTables = {}) {
  const form = parseVc8Form(text); assert.ok(form, text);
  const tu = parse(source), before = emit(tu), sites: Vc8FormSite[] = [];
  const after = emit(applyVc8Forms(tu, [{ form, tag: text }], s => sites.push(s), tables));
  return { before, after, site: sites[0] };
}
it('parses distinct numeric case values and an optional positive occurrence', () => {
  assert.deepEqual(parseVc8Form(tag), { op: 'swdefault', expr: 'x', values: ['3', '4', '5'] });
  assert.deepEqual(parseVc8Form('swdefault(x,-1,0xff,@2)'), { op: 'swdefault', expr: 'x', values: ['-1', '0xff'], index: 2 });
  for (const bad of ['swdefault()', 'swdefault(x)', 'swdefault(,1)', 'swdefault(x,3,0x3)', 'swdefault(x,1.2)',
    'swdefault(x,Maker)', 'swdefault(x,01)', 'swdefault(x,1,@0)', 'swdefault(x,1,@-1)',
    'swdefault(x,1,@1.5)', 'swdefault(x,1,@9007199254740992)', 'swdefault(x,18446744073709551616)']) {
    assert.equal(parseVc8Form(bad), undefined, bad);
  }
});
it('adds one case group while retaining the original fallback', () => {
  const r = run(); assert.ok(r.site.applied, r.site.why);
  assert.match(r.after, /case 3:\s*case 4:\s*case 5:\s*return 0;/);
  assert.equal((r.after.match(/return 0;/g) ?? []).length, 2);
  const again = run(r.after); assert.equal(again.site.applied, false); assert.equal(again.after, r.after);
});
it('copies a primitive explicit default before its existing label', () => {
  const r = run('int f(int x) { switch (x) { case 0: return 1; default: { return 0; } } }');
  assert.ok(r.site.applied, r.site.why); assert.match(r.after, /case 5:\s*return 0;\s*default:/);
});
it('restores a void fallthrough, including a terminal conditional scope', () => {
  for (const source of ['void f(int x) { switch(x) { case 0: use(); } }',
    'void f(int x) { if (x) { switch(x) { case 0: use(); } } }',
    'void f(int x) { switch(x) { case 0: use(); } return; }']) {
    const r = run(source); assert.ok(r.site.applied, r.site.why); assert.match(r.after, /case 5:\s*return;/);
  }
});
it('handles selectors typed by a global, a field or a known call without evaluating them again', () => {
  for (const [expr, source, tables] of [
    ['gMode', 'int f() { switch(gMode) { case 0: return 1; } return 0; }', { globalTypes: { gMode: 'int' } }],
    ['p->mode', 'int f(S* p) { switch(p->mode) { case 0: return 1; } return 0; }', { structFields: { S: { mode: 'int' } } }],
    ['next(x)', code.replace('switch (x)', 'switch(next(x))'), { functionReturnTypes: { next: 'int' } }],
  ] as const) {
    const r = run(source, `swdefault(${expr},3)`, tables); assert.ok(r.site.applied, r.site.why);
    assert.equal(r.after.split(expr).length, r.before.split(expr).length);
  }
});
it('resolves enum aliases before accepting an absent case', () => {
  const source = 'int f(E x) { switch(x) { case EXISTING: return 1; } return 0; }';
  const tables = { typedefTargets: { E: 'unsigned int' }, enumValues: { EXISTING: 57, ALIAS: 57 } };
  assert.equal(run(source, 'swdefault(x,57)', tables).site.applied, false);
  assert.ok(run(source, 'swdefault(x,58)', tables).site.applied);
  assert.equal(run(source.replace('EXISTING', 'ALIAS'), 'swdefault(x,57)', tables).site.applied, false);
  assert.ok(run(source.replace('EXISTING', 'E::A'), 'swdefault(x,58)', { ...tables, enumValues: { 'E::A': 57 } }).site.applied);
});
it('checks promoted selector ranges and spells both 64-bit boundaries legally', () => {
  assert.ok(run(code.replace('int x', 'unsigned char x'), 'swdefault(x,-1)').site.applied);
  assert.equal(run(code.replace('int x', 'unsigned int x'), 'swdefault(x,-1)').site.applied, false);
  assert.equal(run(code, 'swdefault(x,0xffffffff)').site.applied, false);
  assert.match(run(code.replace('int x', 'unsigned long long x'), 'swdefault(x,0xffffffffffffffff)').after, /0xffffffffffffffffULL/);
  assert.match(run(code.replace('int x', 'long long x'), 'swdefault(x,-9223372036854775808)').after, /-9223372036854775807 - 1/);
});
it('requires an occurrence when the selector appears more than once', () => {
  const source = 'int f(int x) { switch(x) { case 0: break; } switch(x) { case 0: return 1; } return 0; }';
  assert.equal(run(source).site.applied, false);
  const r = run(source, 'swdefault(x,3,@2)'); assert.ok(r.site.applied, r.site.why);
  assert.equal((r.after.match(/case 3:/g) ?? []).length, 1);
  assert.equal(run(source, 'swdefault(x,3,@3)').site.applied, false);
});
const refused: Array<[string, string, Vc8FormTables?]> = [
  ['existing numeric case', code.replace('case 0:', 'case 3:')],
  ['unresolved enum case', code.replace('case 0:', 'case UNKNOWN:')],
  ['unproven constant expression', code.replace('case 0:', 'case 1 + 2:')],
  ['unknown selector', code.replace('int x', 'Unknown x')],
  ['pointer selector', code.replace('int x', 'int* x')],
  ['floating selector', code.replace('int x', 'double x')],
  ['class return conversion', code.replace('int f', 'Maker f')],
  ['effectful fallback', code.replace('return 0;', 'return touch();')],
  ['class conversion in fallback', code.replace('return 0;', 'return (Maker)0;')],
  ['effectful explicit default', 'int f(int x) { switch(x) { case 0: return 1; default: { touch(); return 0; } } }'],
  ['unbraced declaration', code.replace('case 1: return 1;', 'case 1:; int y = 1; return y;')],
  ['static declaration', code.replace('case 1: return 1;', 'case 1: { static int y; return y; }')],
  ['label', code.replace('case 1: return 1;', 'case 1: label: return 1;')],
  ['goto', code.replace('case 1: return 1;', 'case 1: goto outside;')],
  ['non-flat case', code.replace('case 1: return 1;', 'case 1: { case 2: return 1; }')],
  ['shadowed selector', code.replace('return 0;', '{ int x; } return 0;')],
  ['later void work', 'void f(int x) { switch(x) { case 0: use(); } later(); }'],
  ['loop continuation', 'void f(int x) { while(next()) { switch(x) { case 0: use(); } } }'],
  ['void case in a value-returning function', 'int f(int x) { switch(x) { case 0: return 1; } }'],
];
for (const [name, source, tables] of refused) it(`refuses ${name} without changing the body`, () => {
  const r = run(source, tag, tables); assert.equal(r.site.applied, false, name); assert.equal(r.after, r.before, name);
});

it('preserves results, state and selector call counts with optimized native code', { skip: !hasNativeGpp() }, () => {
  const snippets = [
    'int f(unsigned x, unsigned* state) { switch(next(x)) { case 0: *state += 7; break; case 1: case 2: *state ^= 0x1234u; } return 0; }',
    'int g(unsigned x, unsigned* state) { switch(x) { case 0: *state += 7; return 1; default: return 0; } }',
    'void h(unsigned x, unsigned* state) { *state += 13; if (*state) { switch(x) { case 0: *state <<= 8; } } }',
  ];
  const after = snippets.map((s, i) => { const r = run(s, `swdefault(${i ? 'x' : 'next(x)'},3,4,5)`, { functionReturnTypes: { next: 'unsigned int' } }); assert.ok(r.site.applied, r.site.why); return r.after; });
  const wide = [
    ['long long', '-9223372036854775808'], ['unsigned long long', '0xffffffffffffffff'],
  ].map(([t, n], i) => { const s = `int wide${i}(${t} x) { switch(x) { case 0: return 1; } return 0; }`; const r = run(s, `swdefault(x,${n})`); assert.ok(r.site.applied, r.site.why); return r.after; });
  const prelude = `namespace ref { unsigned calls; unsigned next(unsigned x) { ++calls; return x; } ${snippets.join('\n')} }
    namespace candidate { unsigned calls; unsigned next(unsigned x) { ++calls; return x; } ${after.join('\n')} ${wide.join('\n')} }`;
  const body = `unsigned cases = 0;
    for (unsigned i=0; i<65536; ++i) for (unsigned mode=0; mode<4; ++mode) {
      unsigned x = mode==0 ? i : mode==1 ? 0xffffffffu-i : mode==2 ? i*0x1040301u : (i^0x80000000u);
      unsigned a=i*0x12345u, b=a; ref::calls=candidate::calls=0;
      if (ref::f(x,&a)!=candidate::f(x,&b) || a!=b || ref::calls!=1 || candidate::calls!=1) return 1;
      if (ref::g(x,&a)!=candidate::g(x,&b) || a!=b) return 2;
      ref::h(x,&a); candidate::h(x,&b); if(a!=b) return 3;
      ++cases;
    }
    if(candidate::wide0((-9223372036854775807LL-1))!=0 || candidate::wide1(0xffffffffffffffffULL)!=0) return 4;
    printf("%u\\n",cases);`;
  assert.equal(compileAndRun(prelude, body, { optimize: true }).trim(), '262144');
});
