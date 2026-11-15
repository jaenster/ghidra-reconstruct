/**
 * Tested Value Arm Plugin Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { testedValueArmPlugin } from '../builtins/tested-value-arm.js';

describe('testedValueArmPlugin', () => {
  const transformer = testedValueArmPlugin.createTransformer();
  const transform = (code: string): string =>
    emit(transformer(parse(code)) as AnyNode).replace(/\s+/g, ' ').trim();

  it('collapses the cpuid leaf chain to one call on the argument', () => {
    const out = transform(`uint32_t f(int32_t nLeaf) { int r;
      if (nLeaf == 0) { r = D2_Cpuid(0); }
      else if (nLeaf == 1) { r = D2_Cpuid(1); }
      else if (nLeaf == 0xb) { r = D2_Cpuid(0xb); }
      else if (nLeaf == -0x7ffffffe) { r = D2_Cpuid(0x80000002); }
      else { r = D2_Cpuid(nLeaf); }
      return *(uint32_t*)(r + 8); }`);
    assert.ok(!out.includes('if'), out);
    assert.ok(out.includes('r = D2_Cpuid(nLeaf);'), out);
    assert.ok(!out.includes('0x80000002'), out);
  });

  it('accepts `!V` as the test for 0', () => {
    const out = transform(`void f(int n) { if (!n) g(0); else g(n); }`);
    assert.strictEqual(out, 'void f(int n) { g(n); }');
  });

  it('keeps an arm that does something else and drops the rest', () => {
    const out = transform(`void f(int n) { if (n == 1) g(1); else if (n == 2) h(2); else if (n == 3) g(3); else g(n); }`);
    assert.ok(out.includes('n == 2'), out);
    assert.ok(out.includes('h(2)'), out);
    assert.ok(!out.includes('n == 1') && !out.includes('n == 3'), out);
  });

  it('keeps a modulo-2^32 literal for a callee of unknown parameter width', () => {
    // g might take an int64_t: 0x80000002 and (int)-0x7ffffffe differ there.
    const out = transform(`void f(int n) { if (n == -0x7ffffffe) g(0x80000002); else g(n); }`);
    assert.ok(out.includes('n == -0x7ffffffe'), out);
  });

  it('reads a negative constant as V + 2^32 for a 32-bit unsigned V', () => {
    const kept = transform(`void f(uint32_t n) { if (n == -1) g(-1); else g(n); }`);
    assert.ok(kept.includes('if'), `g(-1) is not g(0xffffffff): ${kept}`);
    const gone = transform(`void f(uint32_t n) { if (n == -1) g(0xffffffff); else g(n); }`);
    assert.strictEqual(gone, 'void f(uint32_t n) { g(n); }');
  });

  it('does not substitute outside a direct call argument', () => {
    // n + 1 and 5 + 1 differ in type (and so in value) for some n types: arithmetic is left alone.
    const out = transform(`void f(int n) { int r; if (n == 5) r = 5 + 1; else r = n + 1; }`);
    assert.ok(out.includes('if'), out);
  });

  it('leaves a variable whose address is taken', () => {
    const out = transform(`void f(int n) { h(&n); if (n == 1) g(1); else g(n); }`);
    assert.ok(out.includes('n == 1'), out);
  });

  it('leaves an else arm that writes the variable', () => {
    const out = transform(`void f(int n) { if (n == 1) g(n = 1); else g(n = n); }`);
    assert.ok(out.includes('n == 1'), out);
  });

  it('leaves a 64-bit or untyped variable', () => {
    const a = transform(`void f(int64_t n) { if (n == 1) g(1); else g(n); }`);
    assert.ok(a.includes('n == 1'), a);
    const b = transform(`void f(Foo n) { if (n == 1) g(1); else g(n); }`);
    assert.ok(b.includes('n == 1'), b);
  });

  it('leaves a chain over two variables and a chain without a final else', () => {
    const a = transform(`void f(int n, int m) { if (n == 1) g(1); else if (m == 2) g(2); else g(n); }`);
    assert.ok(a.includes('n == 1') && a.includes('m == 2'), a);
    const b = transform(`void f(int n) { if (n == 1) g(1); }`);
    assert.ok(b.includes('n == 1'), b);
  });

  it('leaves an arm of more than one statement', () => {
    const out = transform(`void f(int n) { if (n == 1) { g(1); h(); } else g(n); }`);
    assert.ok(out.includes('n == 1'), out);
  });

  it('handles return arms', () => {
    const out = transform(`int f(int n) { if (n == 2) return g(2); else return g(n); }`);
    assert.strictEqual(out, 'int f(int n) { return g(n); }');
  });
});

describe('testedValueArmPlugin qualifiers', () => {
  const transformer = testedValueArmPlugin.createTransformer();
  const transform = (code: string): string =>
    emit(transformer(parse(code)) as AnyNode).replace(/\s+/g, ' ').trim();

  it('leaves a volatile or static local', () => {
    const a = transform(`void f() { volatile int n = h(); if (n == 1) g(1); else g(n); }`);
    assert.ok(a.includes('n == 1'), a);
    const b = transform(`void f() { static int n; if (n == 1) g(1); else g(n); }`);
    assert.ok(b.includes('n == 1'), b);
  });

  it('drops the braces of a fully collapsed chain', () => {
    const out = transform(`void f(int n) { if (n == 1) { g(1); } else { g(n); } }`);
    assert.strictEqual(out, 'void f(int n) { g(n); }');
  });
});
