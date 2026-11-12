import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite } from '../builtins/vc8-form.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
function run(source: string, tag = 'tailguard(!c)') {
  const form = parseVc8Form(tag);
  assert.ok(form);
  const sites: Vc8FormSite[] = [];
  const output = applyVc8Forms(parse(source) as TranslationUnit, [{ form, tag }], s => sites.push(s));
  return { before: flat(emit(parse(source) as AnyNode)), out: flat(emit(output as AnyNode)), site: sites[0]! };
}

describe('vc8form tailguard', () => {
  it('parses a condition and optional index', () => {
    assert.deepEqual(parseVc8Form('tailguard(!uVar1)'), { op: 'tailguard', cond: '!uVar1', index: 1 });
    assert.deepEqual(parseVc8Form('tailguard(x,2)'), { op: 'tailguard', cond: 'x', index: 2 });
    for (const bad of ['tailguard()', 'tailguard(x,0)', 'tailguard(x,abc)', 'tailguard(x,1,2)']) assert.equal(parseVc8Form(bad), undefined);
  });

  it('duplicates only the common two-call tail and preserves the body scope', () => {
    const source = 'void f(int c) { setup(); if (!c) { int n = 3; work(n); } tail(a,b); tail(b,a); }';
    const { out, site } = run(source);
    assert.equal(site.applied, true, site.why);
    assert.match(out, /if \(c\) \{ tail\(a, b\); tail\(b, a\); return; \} \{ int n = 3; work\(n\); \} tail\(a, b\); tail\(b, a\);/);
    assert.equal((out.match(/tail\(/g) ?? []).length, 4);
  });

  it('refuses a nonvoid result, other tail, or different tail callees', () => {
    const bad = [
      'int f(int c) { if (!c) work(); tail(a,b); tail(b,a); return 0; }',
      'void f(int c) { if (!c) work(); tail(a,b); tail(b,a); log(); }',
      'void f(int c) { if (!c) work(); tail(a,b); other(b,a); }',
      'void f(int c) { if (!c) work(); tail(a,b); }',
    ];
    for (const source of bad) {
      const { before, out, site } = run(source);
      assert.equal(site.applied, false, source);
      assert.equal(out, before, source);
    }
  });

  it('refuses an exit, label, else arm, or nested if', () => {
    const bad = [
      'void f(int c) { if (!c) { if (c) return; work(); } tail(a,b); tail(b,a); }',
      'void f(int c) { if (!c) { L: work(); } tail(a,b); tail(b,a); }',
      'void f(int c) { if (!c) work(); else log(); tail(a,b); tail(b,a); }',
      'void f(int c) { if constexpr (!c) { work(); } tail(a,b); tail(b,a); }',
      'void f(int c) { { if (!c) work(); tail(a,b); tail(b,a); } }',
    ];
    for (const source of bad) {
      const { before, out, site } = run(source);
      assert.equal(site.applied, false, source);
      assert.equal(out, before, source);
    }
  });

  it('refuses floating comparisons and floating flags instead of inverting a NaN test', () => {
    for (const [source, tag] of [
      ['void f(float x) { if (x < 0.0f) { work(); } tail(a,b); tail(b,a); }', 'tailguard(x<0.0f)'],
      ['void f(float x) { if (!x) { work(); } tail(a,b); tail(b,a); }', 'tailguard(!x)'],
    ]) {
      const { before, out, site } = run(source, tag);
      assert.equal(site.applied, false, source);
      assert.equal(out, before, source);
    }
  });

  it('refuses flags without a unique visible integral binding', () => {
    const bad = [
      'void f() { if (!c) { int c = 1; work(c); } tail(a,b); tail(b,a); }',
      'void f() { int c = 0; if (!c) { int c = 1; work(c); } tail(a,b); tail(b,a); }',
      'void f(float c) { if (!c) { int c = 1; work(c); } tail(a,b); tail(b,a); }',
      'void f() { { int c = 0; } if (!c) { work(); } tail(a,b); tail(b,a); }',
    ];
    for (const source of bad) {
      const { before, out, site } = run(source);
      assert.equal(site.applied, false, source);
      assert.equal(out, before, source);
    }
  });
});
