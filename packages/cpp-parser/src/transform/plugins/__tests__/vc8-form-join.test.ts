import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite, type Vc8FormTables } from '../builtins/vc8-form.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(source: string, tag: string, tables?: Vc8FormTables): { code: string; site: Vc8FormSite } {
  const form = parseVc8Form(tag);
  assert.ok(form, `parse ${tag}`);
  const sites: Vc8FormSite[] = [];
  const out = applyVc8Forms(parse(source) as TranslationUnit, [{ form, tag }], s => sites.push(s), tables);
  return { code: flat(emit(out as AnyNode)), site: sites[0] };
}

function refused(source: string, tag: string, tables?: Vc8FormTables): void {
  const result = run(source, tag, tables);
  assert.equal(result.site.applied, false, source);
  assert.equal(result.code, flat(emit(parse(source) as AnyNode)));
}

describe('vc8-form: join', () => {
  it('preserves signed comparisons across alias refusals and a proven signed join', { skip: !hasNativeGpp() }, () => {
    const inputs = [
      'int f(int x) { typedef unsigned int BOOL; BOOL y = x + 1; return y > 0; }',
      'int f(int x) { typedef unsigned int int32_t; int32_t y = x + 1; return y > 0; }',
      'int f(int x) { BOOL y = x + 1; return y > 0; }',
    ];
    const prelude = 'typedef int BOOL;\n' + inputs.map((source, i) => {
      const result = run(source, 'join(y,x)', { typedefTargets: { BOOL: 'int', int32_t: 'int' } });
      assert.equal(result.site.applied, i === 2);
      return `namespace Before${i} { ${emit(parse(source) as AnyNode)} } namespace After${i} { ${result.code} }`;
    }).join('\n');
    const body = 'unsigned checks = 0;\n' + inputs.map((_, i) =>
      `for (int x = -65536; x < 65536; ++x) { if (Before${i}::f(x) != After${i}::f(x)) return ${i + 1}; ++checks; }`
    ).join('\n') + '\nstd::printf("checks=%u\\n", checks);';
    assert.equal(compileAndRun(prelude, body, { optimize: true }), 'checks=393216\n');
  });

  it('refuses local aliases and classes that hide the word types, without changing values', () => {
    for (const alias of ['typedef unsigned int BOOL;',
      'typedef bool BOOL;', 'struct BOOL { int value; };', 'enum BOOL { off, on };',
      'typedef unsigned int int32_t;']) {
      const name = alias.includes('int32_t') ? 'int32_t' : 'BOOL';
      refused(`int f(int x) { ${alias} ${name} y = x + 1; return y > 0; }`, 'join(y,x)',
        { typedefTargets: { BOOL: 'int', int32_t: 'int' } });
    }
  });

  it('honors supplied alias targets and refuses cycles or hidden intermediate aliases', () => {
    const source = 'int f(int x) { BOOL y = x + 1; return y > 0; }';
    for (const target of ['', 'unsigned int', 'bool', 'short', 'float', 'C', 'const int', 'volatile int', 'int&']) {
      refused(source, 'join(y,x)', { typedefTargets: { BOOL: target } });
    }
    refused(source, 'join(y,x)', { typedefTargets: { BOOL: 'Alias', Alias: 'BOOL' } });
    refused('int f() { typedef unsigned int BOOL; BOOL x = 1; int y = x + 1; return y > 0; }',
      'join(y,x)', { typedefTargets: { BOOL: 'int' } });
    refused('int f(int x) { typedef unsigned int Alias; BOOL y = x + 1; return y > 0; }',
      'join(y,x)', { typedefTargets: { BOOL: 'Alias', Alias: 'int' } });
    const result = run(source, 'join(y,x)', { typedefTargets: { BOOL: 'Alias', Alias: 'int' } });
    assert.equal(result.site.applied, true);
    assert.match(result.code, /x = x \+ 1; return x > 0;/);
  });

  it('parses two distinct names only', () => {
    assert.deepEqual(parseVc8Form('join(nRemainingTotal,nCount)'),
      { op: 'join', into: 'nRemainingTotal', from: 'nCount' });
    assert.equal(parseVc8Form('join(x,x)'), undefined);
    assert.equal(parseVc8Form('join(x)'), undefined);
    assert.equal(parseVc8Form('join(x,y,z)'), undefined);
  });

  it('updates a preceding local as in Q32', () => {
    const { code, site } = run(`int32_t f(int delta) {
      int nCount = 0;
      int32_t nRemainingTotal = nCount + delta;
      if (nRemainingTotal < 0) nRemainingTotal = 0;
      return nRemainingTotal;
    }`, 'join(nRemainingTotal,nCount)');
    assert.equal(site.applied, true, site.why);
    assert.match(code, /nCount = nCount \+ delta;/);
    assert.match(code, /if \(nCount < 0\)/);
    assert.match(code, /return nCount;/);
    assert.doesNotMatch(code, /nRemainingTotal/);
  });

  it('updates a parameter as in WALL2', () => {
    const { code, site } = run(`int f(int nX, int origin, int limit) {
      int iVar1 = nX - origin;
      if (iVar1 < 0) return 0;
      return iVar1 < limit;
    }`, 'join(iVar1,nX)');
    assert.equal(site.applied, true, site.why);
    assert.match(code, /nX = nX - origin;/);
    assert.match(code, /return nX < limit;/);
    assert.doesNotMatch(code, /iVar1/);
  });

  it('drops a simple copy and renames later updates', () => {
    const { code, site } = run(`int f(int32_t input) {
      int value = input;
      if (value) value = 0;
      return value;
    }`, 'join(value,input)');
    assert.equal(site.applied, true, site.why);
    assert.doesNotMatch(code, /int value|input = input/);
    assert.match(code, /if \(input\) input = 0;/);
  });

  it('refuses a loop backedge that rereads the old value', () => {
    refused(`void f(int x) {
      start: Use(x);
      int y = x + 1;
      Use(y);
      if (Again()) goto start;
    }`, 'join(y,x)');
  });

  it('refuses an indirect read through an alias of the parameter', () => {
    refused(`void f(int x) {
      int* p = &x;
      int y = x + 1;
      Use(*p, y);
    }`, 'join(y,x)');
  });

  it('refuses a branch store that does not dominate every use', () => {
    refused(`void f(int x, int flag) {
      int y;
      if (flag) y = x + 1; else y = 0;
      Use(y);
    }`, 'join(y,x)');
  });

  it('refuses a live old value, duplicate binding, or unsigned target', () => {
    refused('int f(int x) { int y = x + 1; Use(x); return y; }', 'join(y,x)');
    refused('int f(int x) { { int x = 2; Use(x); } int y = x + 1; return y; }', 'join(y,x)');
    refused('int f(uint32_t x) { int y = x + 1; return y; }', 'join(y,x)');
  });

  it('refuses const and volatile source bindings', () => {
    refused('int f() { const int x = 1; int y = x + 1; return y; }', 'join(y,x)');
    refused('int f() { volatile int x = 1; int y = x + 1; return y; }', 'join(y,x)');
    refused('int f(const int x) { int y = x + 1; return y; }', 'join(y,x)');
    refused('int f(volatile int x) { int y = x + 1; return y; }', 'join(y,x)');
  });

  it('refuses static source storage', () => {
    refused('int f() { static int x = 1; int y = x + 1; return y; }', 'join(y,x)');
  });

  it('refuses a path that bypasses the defining declaration', () => {
    refused(`void f(int x) {
      if (Skip()) goto after;
      int y = x + 1;
      after: Use(y);
    }`, 'join(y,x)');
  });

  it('refuses a destination name used in the label namespace', () => {
    refused('int f(int x) { x: ; int y = x + 1; y: return y; }', 'join(y,x)');
    refused('int f(int x) { int y = x + 1; if (y) goto y; return y; }', 'join(y,x)');
  });

  it('refuses a destination name used in a type', () => {
    refused('struct y {}; int f(int x) { int y = x + 1; struct y z; return y; }', 'join(y,x)');
  });

  it('refuses a reference alias of the old value', () => {
    refused('int f(int x) { int& r = x; int y = x + 1; return r + y; }', 'join(y,x)');
  });

  it('refuses a source value passed to a call with unknown parameter mode', () => {
    refused('int f(int x) { Hold(x); int y = x + 1; return ReadHeld() + y; }', 'join(y,x)');
  });
});
