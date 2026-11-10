import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite } from '../builtins/vc8-form.js';

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
