import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite, type Vc8FormTables } from '../builtins/vc8-form.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

function run(code: string, tag: string, tables: Vc8FormTables = {}) {
  const form = parseVc8Form(tag); assert.ok(form, tag);
  const before = parse(code), sites: Vc8FormSite[] = [];
  const out = applyVc8Forms(before, [{ form }], s => sites.push(s), tables);
  return { before: emit(before), after: emit(out), site: sites[0] };
}
const bad: Array<[string, string, string, Vc8FormTables?]> = [
  ['overloaded not', 'int f(const A& x) { return !x; }', 'bool(x)'],
  ['overloaded equality', 'int f(const B& x) { return x == 0; }', 'bool(x)'],
  ['integral lhs of overloaded and', 'int f(int x, const Marker& m) { if (x && m) return 7; return 0; }', 'bool(x)'],
  ['integral lhs changed to a comparison', 'int f(int x, const Marker& m) { if (x && m) return 7; return 0; }', 'nonzero(x)'],
  ['not replaced by unrelated equality', 'int f(const A& x) { return !x; }', 'zero(x)'],
  ['integral rhs of overloaded or', 'int f(const Marker& m, int x) { if (m || x) return 7; return 0; }', 'bool(x)'],
  ['proxy from an overloaded comparison', 'int f(int x, const C& c) { if (x && (c == 0)) return 7; return 0; }', 'bool(x)'],
  ['shadowed declaration', 'int f(int x) { { A x; return !x; } }', 'bool(x)'],
  ['nested method scope', 'int f(int x) { struct Local { int g(A x) { return !x; } }; return 0; }', 'bool(x)'],
  ['shadowed callable', 'int f(const Callable& next) { return !next(); }', 'bool(next())', { functionReturnTypes: { next: 'int' } }],
  ['shadowed function pointer', 'int f(int (*next)()) { { Callable next; return !next(); } }', 'bool(next())'],
  ['unknown member type', 'int f(U* p) { return !(p->flags >> 2 & 1); }', 'bool(p->flags >> 2 & 1)'],
];
for (const [name, code, tag, tables] of bad) it(`refuses ${name} without changing the body`, () => {
  const r = run(code, tag, tables); assert.equal(r.site.applied, false, name); assert.equal(r.after, r.before);
});
const good: Array<[string, string, string, Vc8FormTables?]> = [
  ['integral test', 'int f(int x) { if(x) return 1; return 0; }', 'bool(x)'],
  ['primitive zero', 'int f(int x) { return !x; }', 'zero(x)'],
  ['primitive nonzero', 'int f(int x) { if(x) return 1; return 0; }', 'nonzero(x)'],
  ['resolved aliases', 'int f(Word x) { return !x; }', 'bool(x)', { typedefTargets: { Word: 'unsigned int' } }],
  ['primitive reference', 'int f(const int& x) { return !x; }', 'bool(x)'],
  ['volatile scalar', 'int f(volatile unsigned x) { return !x; }', 'zero(x)'],
  ['pointer test', 'int f(void* p) { if(p) return 1; return 0; }', 'nonzero(p)'],
  ['function pointer test', 'int f(int (*p)()) { if(p) return 1; return 0; }', 'bool(p)'],
  ['function pointer return', 'int f(int (*p)()) { return !p(); }', 'bool(p())'],
  ['known call', 'int f() { return !next(); }', 'bool(next())', { functionReturnTypes: { next: 'int' } }],
  ['explicit scalar conversion', 'int f(const A& x) { if((bool)x) return 1; return 0; }', 'bool((bool)x)'],
  ['typed member bit extraction', 'int f(U* p) { if(p && (p->flags >> 2 & 1)) return 1; return 0; }', 'bool(p->flags >> 2 & 1)', { structFields: { U: { flags: 'unsigned int' } } }],
  ['primitive logical neighbour', 'int f(int x) { if(x && next()) return 7; return 0; }', 'bool(x)', { functionReturnTypes: { next: 'int' } }],
  ['primitive postincrement', 'int f(unsigned x) { if(x++) return 1; return 0; }', 'bool(x++)'],
  ['local aggregate field', 'int f(int x) { struct Frame { unsigned x; }; Frame frame; frame.x = x; return !frame.x; }', 'bool(frame.x)'],
];
for (const [name, code, tag, tables] of good) it(`keeps ${name}`, () => {
  const r = run(code, tag, tables); assert.ok(r.site.applied, r.site.why); assert.notEqual(r.after, r.before);
});

it('keeps overloaded results after refusal in optimized native code', { skip: !hasNativeGpp() }, () => {
  const cases = bad.slice(0,5), bodies: string[] = [];
  for (const [i, [, code, tag, tables]] of cases.entries()) bodies.push(`namespace n${i} { ${run(code,tag,tables).after} }`);
  const prelude = `struct A { operator bool() const { return true; } };
    bool operator!(const A&) { return true; } bool operator==(const A&,int) { return false; }
    struct B { operator bool() const { return true; } }; bool operator==(const B&,int) { return true; }
    struct Marker {}; bool operator&&(int,const Marker&) { return true; } bool operator&&(bool,const Marker&) { return false; }
    ${bodies.join('\n')}`;
  assert.equal(compileAndRun(prelude, 'printf("%d %d %d %d %d\\n",n0::f(A()),n1::f(B()),n2::f(1,Marker()),n3::f(1,Marker()),n4::f(A()));', { optimize: true }).trim(), '1 1 7 7 1');
});
it('preserves shadowed locals, nested method parameters and callable bindings in native code', { skip: !hasNativeGpp() }, () => {
  const cases: Array<[string, string, string, Vc8FormTables?]> = [
    ['int f(int x) { { A x; return !x; } }', 'bool(x)', '0'],
    ['int f(int x) { struct Local { int g(A x) { return !x; } }; Local v; return v.g(A()); }', 'bool(x)', '0'],
    ['int f(const Callable& next) { return !next(); }', 'bool(next())', 'Callable()', { functionReturnTypes: { next: 'int' } }],
  ];
  let source = 'struct A { operator bool() const { return true; } }; bool operator!(const A&) { return true; } struct Callable { A operator()() const { return A(); } };\n';
  let body = '';
  for (const [i, [code, tag, args, tables]] of cases.entries()) {
    const result = run(code, tag, tables);
    assert.equal(result.site.applied, false);
    source += `namespace reference${i} { ${code} } namespace candidate${i} { ${result.after} }\n`;
    body += `printf("%d %d\\n",reference${i}::f(${args}),candidate${i}::f(${args}));\n`;
  }
  assert.equal(compileAndRun(source, body, { optimize: true }).trim(), '1 1\n1 1\n1 1');
});
it('preserves effects, short-circuit order and volatile values for builtin operators', { skip: !hasNativeGpp() }, () => {
  const codes = [
    ['bool((*p)++)','int f(volatile unsigned* p,unsigned x) { if((*p)++ && tick(x)) return 7; return 0; }'],
    ['nonzero(x)','int g(unsigned x) { if(x && tick(x)) return 9; return 0; }'],
    ['zero(*p)','int h(volatile unsigned* p) { return !*p; }'],
  ];
  const after = codes.map(([tag, code]) => { const r = run(code,tag,{ functionReturnTypes: { tick: 'int' } }); assert.ok(r.site.applied,r.site.why); return r.after; });
  const prelude = `namespace ref { unsigned calls; int tick(unsigned n) { ++calls; return n&1; } ${codes.map(x=>x[1]).join('\n')} }
    namespace candidate { unsigned calls; int tick(unsigned n) { ++calls; return n&1; } ${after.join('\n')} }`;
  const body = `unsigned cases=0;
    for(unsigned i=0;i<65536;++i) for(unsigned mode=0;mode<4;++mode) {
      unsigned x=mode==0?i:mode==1?0xffffffffu-i:mode==2?i*0x1040301u:(i^0x80000000u);
      volatile unsigned a=x,b=x;ref::calls=candidate::calls=0;
      if(ref::f(&a,x)!=candidate::f(&b,x) || a!=b || ref::calls!=candidate::calls) return 1;
      if(ref::g(x)!=candidate::g(x) || ref::calls!=candidate::calls) return 2;
      if(ref::h(&a)!=candidate::h(&b) || a!=b) return 3;
      ++cases;
    } printf("%u\\n",cases);`;
  assert.equal(compileAndRun(prelude, body, { optimize: true }).trim(), '262144');
});
