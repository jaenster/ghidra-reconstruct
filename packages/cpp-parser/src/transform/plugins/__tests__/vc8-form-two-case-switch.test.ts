import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite } from '../builtins/vc8-form.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(source: string, tag: string): { out: string; site: Vc8FormSite } {
  const form = parseVc8Form(tag);
  assert.ok(form, `parse ${tag}`);
  const sites: Vc8FormSite[] = [];
  const tu = applyVc8Forms(parse(source) as TranslationUnit, [{ form, tag }], s => sites.push(s));
  assert.equal(sites.length, 1);
  return { out: flat(emit(tu as AnyNode)), site: sites[0] };
}

describe('vc8-form two-case switch', () => {
  it('keeps explicit-comparison occurrence indexes ahead of implicit zero cases', () => {
    const src = 'int f(int x) { if (x) { if (x != 2) return -1; return 20; } if (x == 3) return 30; else if (x == 4) return 40; return 10; }';
    const { out, site } = run(src, 'switch(x)');
    assert.equal(site.applied, true, site.why);
    assert.match(out, /if \(x\)/);
    assert.match(out, /case 4:/);
    assert.match(out, /case 3:/);
    assert.doesNotMatch(out, /case 2:/);
  });

  it('refuses implicit-zero cases whose labels can narrow under promotions', () => {
    for (const value of ['-1', '0xffffffffu', '4294967296LL', 'UNKNOWN_STATUS']) {
      const src = `int f(unsigned x) { if (x) { if (x != ${value}) return -1; return 20; } return 10; }`;
      const { out, site } = run(src, 'switch(x)');
      assert.equal(site.applied, false, value);
      assert.equal(out, flat(emit(parse(src) as AnyNode)));
    }
  });

  it('keeps an unsigned negative-case comparison compilable after refusal', { skip: !hasNativeGpp() }, () => {
    const source = 'int f(unsigned x) { if (x) { if (x != -1) return -1; return 20; } return 10; }';
    const { out, site } = run(source, 'switch(x)');
    assert.equal(site.applied, false);
    assert.equal(compileAndRun(out, 'if(f(0)!=10 || f(1)!=-1 || f(2)!=-1 || f(~0u)!=20) return 1; printf("ok\\n");', { optimize: true }).trim(), 'ok');
  });

  it('preserves dispatch results and ordered call effects in optimized native code', { skip: !hasNativeGpp() }, () => {
    const source = `int f(char* p, unsigned mode) {
      if (*(int*)p) {
        if (*(int*)p != 2) return tick(11, mode);
        if (mode & 1) return tick(22, mode);
        return tick(33, mode);
      }
      if (mode & 2) return tick(44, mode);
      return tick(55, mode);
    }`;
    const { out, site } = run(source, 'switch(*(int*)p)');
    assert.equal(site.applied, true, site.why);
    const state = 'unsigned calls; unsigned trace[4]; int tick(unsigned n, unsigned mode) { trace[calls++] = n; return (int)(n * 16 + mode); }';
    const prelude = `namespace ref { ${state} ${source} } namespace candidate { ${state} ${out} }`;
    const body = `unsigned cases = 0;
      for (unsigned i = 0; i < 65536; ++i) for (unsigned mode = 0; mode < 4; ++mode) {
        unsigned word = mode == 0 ? i : mode == 1 ? 0xffffffffu-i : mode == 2 ? i*0x1040301u : i^0x80000000u;
        int a = (int)word, b = a; ref::calls = candidate::calls = 0;
        if (ref::f((char*)&a,mode) != candidate::f((char*)&b,mode)) return 1;
        if (a != b || ref::calls != candidate::calls) return 2;
        for (unsigned n = 0; n < ref::calls; ++n) if (ref::trace[n] != candidate::trace[n]) return 3;
        ++cases;
      }
      printf("%u\\n", cases);`;
    assert.equal(compileAndRun(prelude, body, { optimize: true }).trim(), '262144');
  });

  it('retains overloaded conversions and their effects after refusing a truth test', { skip: !hasNativeGpp() }, () => {
    const source = 'int f(Proxy p) { if (*(int*)p) { if (*(int*)p != 2) return -1; return 20; } return 10; }';
    const { out, site } = run(source, 'switch(*(int*)p)');
    assert.equal(site.applied, false);
    const prelude = `unsigned casts;
      struct Proxy { int* value; operator int*() const { ++casts; return value; } };
      namespace ref { ${source} } namespace candidate { ${out} }`;
    const body = `for (int v = -1; v <= 3; ++v) {
        Proxy p = { &v }; casts = 0; int a = ref::f(p); unsigned n = casts;
        casts = 0; int b = candidate::f(p); if (a != b || casts != n) return 1;
        if (casts != (v == 0 ? 1u : 2u)) return 2;
      } printf("ok\\n");`;
    assert.equal(compileAndRun(prelude, body, { optimize: true }).trim(), 'ok');
  });

  it('recognizes the integer truth test without depending on a later nonzero tag', () => {
    const src = 'int f(char* p) { if (*(int*)p) { if (*(int*)p != 2) return -1; return 20; } return 10; }';
    const { out, site } = run(src, 'switch(*(int*)p)');
    assert.equal(site.applied, true, site.why);
    assert.match(out, /switch \(\*\(int\*\)p\)/);
    assert.match(out, /case 2: \{ return 20; \}/);
    assert.match(out, /case 0: \{ return 10; \}/);
    assert.doesNotThrow(() => parse(out));
  });

  it('accepts builtin integer bindings and a negated zero case', () => {
    for (const type of ['int', 'unsigned int', 'short', 'unsigned long', 'bool']) {
      const src = `int f(${type} x) { if (x) { if (x != 2) return -1; return 20; } return 10; }`;
      const { out, site } = run(src, 'switch(x)');
      assert.equal(site.applied, true, `${type}: ${site.why}`);
      assert.match(out, /case 0:/);
    }
    const { out, site } = run('int f(int x) { if (!x) return 10; else if (x == 2) return 20; return -1; }', 'switch(x)');
    assert.equal(site.applied, true, site.why);
    assert.match(out, /case 0: \{ return 10; \}/);
    assert.match(out, /case 2: \{ return 20; \}/);
  });

  it('does not infer builtin truth semantics from aliases, classes or volatile reads', () => {
    const sources = [
      'int f(Unknown x) { if (x) { if (x != 2) return -1; return 20; } return 10; }',
      'int f(float x) { if (x) { if (x != 2) return -1; return 20; } return 10; }',
      'int f(volatile int x) { if (x) { if (x != 2) return -1; return 20; } return 10; }',
      'int f(int& x) { if (x) { if (x != 2) return -1; return 20; } return 10; }',
      'int f(int x) { { int x = 0; } if (x) { if (x != 2) return -1; return 20; } return 10; }',
    ];
    for (const src of sources) {
      const { out, site } = run(src, 'switch(x)');
      assert.equal(site.applied, false, src);
      assert.equal(out, flat(emit(parse(src) as AnyNode)));
    }
    for (const declaration of ['Unknown p', 'volatile char* p', 'char* volatile p', 'char*& p']) {
      const src = `int f(${declaration}) { if (*(int*)p) { if (*(int*)p != 2) return -1; return 20; } return 10; }`;
      const { site } = run(src, 'switch(*(int*)p)');
      assert.equal(site.applied, false, declaration);
    }
    const src = 'int f(char* p) { if (*(volatile int*)p) { if (*(volatile int*)p != 2) return -1; return 20; } return 10; }';
    assert.equal(run(src, 'switch(*(volatile int*)p)').site.applied, false);
  });

  it('parses only a target and optional positive index', () => {
    assert.deepEqual(parseVc8Form('switch(u->kind)'), { op: 'switch', expr: 'u->kind', index: 1 });
    assert.deepEqual(parseVc8Form('switch(u->kind,2)'), { op: 'switch', expr: 'u->kind', index: 2 });
    assert.equal(parseVc8Form('switch(u->kind,0)'), undefined);
    assert.equal(parseVc8Form('switch()'), undefined);
  });

  it('reconstructs the nested two-case form and keeps a guarded body', () => {
    const src = 'Unit* f(Unit* u) { if (u->kind != UNIT_PLAYER) { if (u->kind == UNIT_MONSTER && u->alive) { return u; } } else { return u; } return nullptr; }';
    const { out, site } = run(src, 'switch(u->kind)');
    assert.equal(site.applied, true, site.why);
    assert.match(out, /switch \(u->kind\)/);
    assert.match(out, /case UNIT_MONSTER: \{ if \(u->alive\) \{ return u; \} \} break;/);
    assert.match(out, /case UNIT_PLAYER: \{ return u; \}/);
    assert.match(out, /return nullptr;/);
    assert.doesNotThrow(() => parse(out));
  });

  it('handles else-if with the same case order', () => {
    const src = 'int f(int x) { if (x == 0) { return 10; } else if (x == 1) { return 20; } return -1; }';
    const { out, site } = run(src, 'switch(x)');
    assert.equal(site.applied, true, site.why);
    assert.ok(out.indexOf('case 1:') < out.indexOf('case 0:'), out);
    assert.doesNotThrow(() => parse(out));
  });

  it('moves the two-tail exit form without losing its default path', () => {
    const src = 'int f(int x) { if (x != 0) { if (x != 1) return -1; return 20; } return 10; }';
    const { out, site } = run(src, 'switch(x)');
    assert.equal(site.applied, true, site.why);
    assert.match(out, /case 1: \{ return 20; \}/);
    assert.match(out, /case 0: \{ return 10; \}/);
    assert.match(out, /\} return -1; \}/);
    assert.doesNotThrow(() => parse(out));
  });

  it('selects the requested occurrence', () => {
    const src = 'int f(int x) { if (x == 0) return 1; else if (x == 1) return 2; if (x == 3) return 4; else if (x == 5) return 6; return 0; }';
    const { out, site } = run(src, 'switch(x,2)');
    assert.equal(site.applied, true, site.why);
    assert.match(out, /if \(x == 0\)/);
    assert.match(out, /case 5:/);
    assert.doesNotThrow(() => parse(out));
  });

  it('refuses non-distinct cases, calling expressions, and break that would change target', () => {
    const duplicate = run('int f(int x) { if (x == 1) return 1; else if (x == 1) return 2; return 0; }', 'switch(x)');
    assert.equal(duplicate.site.applied, false);
    const equalSpellings = run('int f(int x) { if (x == 0) return 1; else if (x == 0x0) return 2; return 0; }', 'switch(x)');
    assert.equal(equalSpellings.site.applied, false);
    const call = run('int f() { if (get() == 0) return 1; else if (get() == 1) return 2; return 0; }', 'switch(get())');
    assert.equal(call.site.applied, false);
    const breaking = run('void f(int x) { while (x) { if (x == 0) break; else if (x == 1) break; x++; } }', 'switch(x)');
    assert.equal(breaking.site.applied, false);
  });

  it('refuses variable case labels and an expression that changes while compared', () => {
    const local = run('int f(int x, int k1) { int k2 = 2; if (x == k1) return 1; else if (x == k2) return 2; return 0; }', 'switch(x)');
    assert.equal(local.site.applied, false);
    const upperLocal = run('int f(int x, int UNIT_PLAYER) { if (x == UNIT_PLAYER) return 1; else if (x == UNIT_MONSTER) return 2; return 0; }', 'switch(x)');
    assert.equal(upperLocal.site.applied, false);
    const increment = run('int f(int x) { if (x++ == 0) return 1; else if (x++ == 1) return 2; return 0; }', 'switch(x++)');
    assert.equal(increment.site.applied, false);
    const assignment = run('int f(int x) { if ((x = 1) == 0) return 1; else if ((x = 1) == 1) return 2; return 0; }', 'switch(x = 1)');
    assert.equal(assignment.site.applied, false);
    const volatileLocal = run('int f(volatile int x) { if (x == 0) return 1; else if (x == 1) return 2; return 0; }', 'switch(x)');
    assert.equal(volatileLocal.site.applied, false);
    const constexprIf = run('int f(int x) { if constexpr (x == 0) return 1; else if (x == 1) return 2; return 0; }', 'switch(x)');
    assert.equal(constexprIf.site.applied, false);
  });

  it('refuses a relocated default arm with a declaration or label', () => {
    const declaration = run('int f(int x) { if (x != 0) { if (x != 1) { int y = 3; return y; } return 20; } return 10; }', 'switch(x)');
    assert.equal(declaration.site.applied, false);
    const label = run('int f(int x) { if (x != 0) { if (x != 1) { here: return -1; } return 20; } return 10; }', 'switch(x)');
    assert.equal(label.site.applied, false);
  });
});
