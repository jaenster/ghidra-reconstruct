import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite } from '../builtins/vc8-form.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(source: string, tag: string): { out: string; site: Vc8FormSite } {
  const form = parseVc8Form(tag);
  assert.ok(form, `parses ${tag}`);
  const sites: Vc8FormSite[] = [];
  const tu = applyVc8Forms(parse(source) as TranslationUnit, [{ form, tag }], s => sites.push(s));
  return { out: flat(emit(tu as AnyNode)), site: sites[0]! };
}

function refuses(source: string): void {
  const { out, site } = run(source, 'dec(v,1)');
  assert.strictEqual(site.applied, false, site.why);
  assert.strictEqual(out, flat(emit(parse(source) as AnyNode)));
}

describe('vc8-form dec: Rule 3 of Redivivus #241', () => {
  it('parses only a plain local and positive decimal amount', () => {
    assert.deepStrictEqual(parseVc8Form('dec(nTargetGUID,1)'), { op: 'dec', name: 'nTargetGUID', amount: 1 });
    for (const tag of ['dec(v)', 'dec(v,0)', 'dec(v,-1)', 'dec(v,1U)', 'dec(p->v,1)', 'dec(v,1,@2)']) {
      assert.strictEqual(parseVc8Form(tag), undefined, tag);
    }
  });

  // Live Win Ghidra 004e2410: SUB EAX,1 at 004e2491. The previous GUID read must stay put.
  it('decrements after an earlier use and a nested reassignment, before the first test', () => {
    const source = 'int f() { int32_t v = get(); use(v); if (ready()) { v = next(); if (v - 1 > 0) { set(v - 1); return 1; } } return 0; }';
    const { out, site } = run(source, 'dec(v,1)');
    assert.ok(site.applied, site.why);
    assert.strictEqual(out, 'int f() { int32_t v = get(); use(v); if (ready()) { v = next(); v -= 1; if (v > 0) { set(v); return 1; } } return 0; }');
  });

  // Live Win Ghidra 004f2160: SUB EAX,1 at 004f2188.
  it('decrements a charge count once for its test and call', () => {
    const source = 'int f() { int32_t v = get(); if (v - 1 > 0) { set(v - 1); } return 1; }';
    const { out, site } = run(source, 'dec(v,1)');
    assert.ok(site.applied, site.why);
    assert.strictEqual(out, 'int f() { int32_t v = get(); v -= 1; if (v > 0) { set(v); } return 1; }');
  });

  // Live Win Ghidra 005d68a0: SUB EDI,1 at 005d68ea. The later use is under a cast and sum.
  it('reaches a later subtraction inside an additive call argument', () => {
    const source = 'int f() { uint32_t v = get(); if ((int)(v - 1) <= 0) return 0; tick(); if (ready()) set(frame() + (v - 1)); return 1; }';
    const { out, site } = run(source, 'dec(v,1)');
    assert.ok(site.applied, site.why);
    assert.strictEqual(out, 'int f() { uint32_t v = get(); v -= 1; if ((int)v <= 0) return 0; tick(); if (ready()) set(frame() + v); return 1; }');
  });

  it('refuses a single subtraction or a different amount', () => {
    refuses('int f() { int v = get(); if (v - 1 > 0) return 1; return 0; }');
    refuses('int f() { int v = get(); if (v - 1 > 0) set(v - 2); return 0; }');
  });

  it('refuses a later plain read, store, or escaped address', () => {
    refuses('int f() { int v = get(); if (v - 1 > 0) set(v - 1); return v; }');
    refuses('int f() { int v = get(); if (ready()) { if (v - 1 > 0) set(v - 1); } return v; }');
    refuses('int f() { int v = get(); if (v - 1 > 0) set(v - 1); v = 4; return 0; }');
    refuses('int f() { int v = get(); send(&v); if (v - 1 > 0) set(v - 1); return 0; }');
  });

  it('refuses a parameter, noninteger local, or shadowed local', () => {
    refuses('int f(int v) { if (v - 1 > 0) set(v - 1); return 0; }');
    refuses('int f() { float v = get(); if (v - 1 > 0) set(v - 1); return 0; }');
    refuses('int f() { int v = get(); { int v = 3; if (v - 1 > 0) set(v - 1); } return 0; }');
  });

  it('refuses a loop, a side effect before the first read, and an unstructured jump', () => {
    refuses('int f() { int v = get(); while (ready()) { if (v - 1 > 0) set(v - 1); } return 0; }');
    refuses('int f() { int v = get(); if (tick() && v - 1 > 0) set(v - 1); return 0; }');
    refuses('int f() { int v = get(); goto L; if (v - 1 > 0) set(v - 1); L: return 0; }');
  });

  it('allows a later short-circuit call after the pure difference test', () => {
    const { out, site } = run('int f() { int v = get(); if (v - 1 > 0 && ready()) set(v - 1); return 0; }', 'dec(v,1)');
    assert.ok(site.applied, site.why);
    assert.strictEqual(out, 'int f() { int v = get(); v -= 1; if (v > 0 && ready()) set(v); return 0; }');
  });
});
