import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite } from '../builtins/vc8-form.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
function run(source: string, tag: string) {
  const form = parseVc8Form(tag);
  assert.ok(form, tag);
  const sites: Vc8FormSite[] = [];
  const output = applyVc8Forms(parse(source) as TranslationUnit, [{ form, tag }], s => sites.push(s));
  return { before: flat(emit(parse(source) as AnyNode)), out: flat(emit(output as AnyNode)), site: sites[0]! };
}
function refused(source: string, tag: string) {
  const { before, out, site } = run(source, tag);
  assert.equal(site.applied, false, source);
  assert.equal(out, before, source);
}

describe('vc8form tailcopy', () => {
  it('parses a condition and optional index', () => {
    assert.deepEqual(parseVc8Form('tailcopy(s != 1)'), { op: 'tailcopy', cond: 's != 1', index: 1 });
    assert.deepEqual(parseVc8Form('tailcopy(x,2)'), { op: 'tailcopy', cond: 'x', index: 2 });
    for (const bad of ['tailcopy()', 'tailcopy(x,0)', 'tailcopy(x,1,2)']) assert.equal(parseVc8Form(bad), undefined);
  });

  // Q05_Callback13_PlayerStartedGame 00595860: the step-4 test falls into the copy, the
  // step-3 test inside the arm jumps back into it.
  it('copies the tail of a void function onto the path that skips the arm', () => {
    const src = 'void f(D* d, int s) { if (a()) return; s = g(4); if (s != 1) { s = g(6); if (s == 1) { d->p = 4; return; } s = g(3); if (s != 1) { return; } } d->f = 3; d->p = 1; }';
    const { out, site } = run(src, 'tailcopy(s != 1)');
    assert.equal(site.applied, true, site.why);
    assert.equal(out, flat('void f(D* d, int s) { if (a()) return; s = g(4); if (s == 1) { d->f = 3; d->p = 1; return; } { s = g(6); if (s == 1) { d->p = 4; return; } s = g(3); if (s != 1) { return; } } d->f = 3; d->p = 1; }'));
  });

  it('copies a tail that ends in a return, in any block', () => {
    const { out, site } = run('int f(int c) { while (c) { if (c > 2) { c = h(c); } k(); return c; } return 0; }', 'tailcopy(c > 2)');
    assert.equal(site.applied, true, site.why);
    assert.match(out, /if \(c <= 2\) \{ k\(\); return c; \} \{ c = h\(c\); \} k\(\); return c; \}/);
  });

  it('refuses an arm that always leaves, a tail without a return, labels, statics and floats', () => {
    refused('void f(int c) { if (c) { g(); return; } h(); }', 'tailcopy(c)');
    refused('int f(int c) { if (c) { g(); } h(); return 1; }'.replace('return 1;', ''), 'tailcopy(c)');
    refused('void f(int c) { while (c) { if (c) { g(); } h(); } }', 'tailcopy(c)');
    refused('void f(int c) { if (c) { g(); } L: h(); }', 'tailcopy(c)');
    refused('void f(int c) { if (c) { g(); } static int n = 0; n++; }', 'tailcopy(c)');
    refused('void f(float x) { if (x < 0.0f) { g(); } h(); }', 'tailcopy(x < 0.0f)');
    refused('void f(int c) { if (c) { g(); } else { k(); } h(); }', 'tailcopy(c)');
  });
});

describe('vc8form elems', () => {
  it('parses a name and optional index', () => {
    assert.deepEqual(parseVc8Form('elems(gaState)'), { op: 'elems', name: 'gaState', index: 0 });
    assert.deepEqual(parseVc8Form('elems(a,2)'), { op: 'elems', name: 'a', index: 2 });
  });

  // UI_ConfigHandleMouseClick 004a5e60: seven dword stores, not a 28-byte memset.
  it('writes a small memset of an array as its element stores', () => {
    const { out, site } = run('void f() { g = 0; memset(gaState, 0, 7 * sizeof(gaState[0])); }', 'elems(gaState)');
    assert.equal(site.applied, true, site.why);
    assert.equal(out, flat('void f() { g = 0; gaState[0] = 0; gaState[1] = 0; gaState[2] = 0; gaState[3] = 0; gaState[4] = 0; gaState[5] = 0; gaState[6] = 0; }'));
  });

  it('keeps the offset, and a byte count over a local array of scalars', () => {
    const { out } = run('void f() { uint16_t a[32]; memset(a + 2, 0, 6); g(a); }', 'elems(a)');
    assert.match(out, /a\[2\] = 0; a\[3\] = 0; a\[4\] = 0; g\(a\);/);
  });

  it('refuses more than 16 elements, an odd byte count, a pointer loop, and two memsets without an index', () => {
    refused('void f() { uint16_t a[32]; memset(a, 0, 32 * sizeof(a[0])); g(a); }', 'elems(a)');
    refused('void f() { uint16_t a[32]; memset(a, 0, 7); g(a); }', 'elems(a)');
    refused('void f() { int n; uint32_t* p; uint32_t a[4]; p = a; for (n = 2; n; n--) { p[0] = 0; p[1] = 0; p += 2; } g(a); }', 'elems(a)');
    refused('void f() { int a[4]; memset(a, 0, 4 * sizeof(a[0])); g(a); memset(a, 0, 4 * sizeof(a[0])); }', 'elems(a)');
  });
});
