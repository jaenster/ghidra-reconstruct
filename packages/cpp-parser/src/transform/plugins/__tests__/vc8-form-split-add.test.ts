import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite, type Vc8FormTables } from '../builtins/vc8-form.js';
const tables: Vc8FormTables = { functionParamTypes: { Use: ['int'], Emit: ['int', 'int'] }, typedefTargets: { int32_t: 'int' } };
function run(input: string, tag = 'split(v,int,nFinal,add)', facts: Vc8FormTables = tables) {
  const ast = parse(input), before = emit(ast), form = parseVc8Form(tag); assert.ok(form);
  const sites: Vc8FormSite[] = []; const after = emit(applyVc8Forms(ast, [{ form }], s => sites.push(s), facts));
  assert.equal(emit(ast), before, 'input tree is never mutated');
  return { before, after, site: sites[0] };
}
it('parses explicit add mode while preserving the original three-argument record', () => {
  assert.deepEqual(parseVc8Form('split(v,int,nFinal)'), { op: 'split', name: 'v', type: 'int', rename: 'nFinal' });
  assert.deepEqual(parseVc8Form('split(v,int,nFinal,add)'), { op: 'split', name: 'v', type: 'int', rename: 'nFinal', add: true });
  for (const s of ['split(v,int,nFinal,sub)', 'split(v,int,nFinal,add,extra)']) assert.equal(parseVc8Form(s), undefined);
});
it('splits the final compound addition with the same type and value-call sequence', () => {
  const r = run('void f(int start) { int v = start; Use(v); v += 3; Emit(v, v); Use(v); }');
  assert.ok(r.site.applied, r.site.why); assert.match(r.after, /int nFinal = v \+ (?:3|\(3\));/);
  assert.match(r.after, /Use\(v\);/); assert.match(r.after, /Emit\(nFinal, nFinal\);/); assert.match(r.after, /Use\(nFinal\);/);
  const old = run('void f(int start) { int v = start; Use(v); v += 3; Use(v); }', 'split(v,int,nFinal)');
  assert.equal(old.after, old.before); assert.equal(old.site.applied, false);
});
it('accepts a negative signed-int literal and proven signed-int aliases', () => {
  const r = run('void f(int start) { int v = start; v += -3; Use(v); }'); assert.ok(r.site.applied, r.site.why);
  const alias = run('void f(int start) { int32_t v = start; v += 3; Use(v); }', 'split(v,int32_t,nFinal,add)'); assert.ok(alias.site.applied, alias.site.why);
});
it('refuses unknown aliases, class operands, narrowing, unsigned and wide arithmetic', () => {
  for (const input of [
    'void f(int start) { Other v = start; v += 3; Use(v); }',
    'void f(int start) { short v = start; v += 3; Use(v); }',
    'void f(int start) { unsigned int v = start; v += 3; Use(v); }',
    'void f(int start, Other rhs) { int v = start; v += rhs; Use(v); }',
    'void f(int start) { int v = start; v += 3U; Use(v); }',
    'void f(int start) { int v = start; v += 2147483648; Use(v); }',
    'void f(int start) { volatile int v = start; v += 3; Use(v); }',
  ]) { const r = run(input); assert.equal(r.after, r.before); assert.equal(r.site.applied, false, input); }
});
it('refuses implicit/explicit slot exposure and incomplete callable facts', () => {
  const input = 'void f(int start) { int v = start; Use(v); v += 3; Use(v); }';
  for (const facts of [{}, { functionParamTypes: { Use: ['int&'] } }, { functionParamTypes: { Use: ['Alias'] }, typedefTargets: { Alias: 'const int &' } }]) {
    const r = run(input, undefined, facts); assert.equal(r.after, r.before); assert.equal(r.site.applied, false);
  }
  for (const source of [
    'void f(int start) { int v = start; int &r = v; v += 3; Use(v); }',
    'void f(int start) { int v = start; Leak(&v); v += 3; Use(v); }',
    'void f(int start) { int w = 0; int v = start; Leak(&w); v += 3; Use(v); }',
    'void f(int start, Other rhs) { int v = start; Use(v + rhs); v += 3; Use(v); }',
  ]) { const r = run(source); assert.equal(r.after, r.before); assert.equal(r.site.applied, false); }
});
it('refuses immutable aliases and unproven replacement types', () => {
  const source = 'void f(int start) { Alias v = start; v += 3; Use(v); }';
  for (const underlying of ['const int', 'volatile int', 'int&', 'Other']) {
    const r = run(source, 'split(v,Alias,nFinal,add)', { ...tables, typedefTargets: { Alias: underlying } });
    assert.equal(r.after, r.before); assert.equal(r.site.applied, false);
  }
  const r = run('void f(int start) { int v = start; v += 3; Use(v); }', 'split(v,double,nFinal,add)');
  assert.equal(r.after, r.before); assert.equal(r.site.applied, false);
});
it('refuses changed scopes, later stores, loops, labels and fresh-name collisions', () => {
  for (const source of [
    'void f(int start) { int v = start; if(start) { int v = 3; Use(v); } v += 3; Use(v); }',
    'void f(int start) { int v = start; v += 3; v = 0; Use(v); }',
    'void f(int start) { int v = start; while(start) { v += 3; Use(v); } }',
    'void f(int start) { int v = start; v += 3; done: Use(v); }',
    'void f(int start) { int nFinal = 0; int v = start; v += 3; Use(v); }',
    'void f(int start) { int v = start; v += 3; Use(v + 1); }',
  ]) { const r = run(source); assert.equal(r.after, r.before); assert.equal(r.site.applied, false, source); }
  const keyword = run('void f(int start) { int v = start; v += 3; Use(v); }', 'split(v,int,int,add)'); assert.equal(keyword.site.applied, false);
});
