/**
 * Tests for Early-Return (Guard Clause) Plugin
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { earlyReturnPlugin } from '../builtins/early-return.js';

describe('earlyReturnPlugin', () => {
  function tx(code: string): string {
    const ast = parse(code);
    return emit(earlyReturnPlugin.createTransformer({})(ast) as AnyNode).trim();
  }

  it('flattens a nested guard chain into early returns', () => {
    const out = tx(`uint32_t f(int a) {
      int x = g(a);
      if (!x) {
        int y = h(a);
        if (y) { return 5; }
      }
      return 0;
    }`);
    assert.ok(/if \(x\)\s*return 0;/.test(out), out);        // !x inverted → x
    assert.ok(/if \(!y\)\s*return 0;/.test(out), out);       // y inverted → !y
    assert.ok(out.includes('return 5;'), out);
    assert.ok(!out.includes('if (!x)'), out);                // original guard gone
  });

  it('leaves an if with else alone', () => {
    const out = tx(`int f(int a) { if (a) { return 1; } else { return 2; } return 0; }`);
    assert.ok(out.includes('else'), out);
  });

  it('does not transform a non-void block with no trailing return (unsafe)', () => {
    // bare block (not a void function body) → no terminal to anchor case A
    const out = tx(`int f(int a) { while (a) { if (a) { g(); } } return 0; }`);
    assert.ok(/while \(a\)\s*\{[\s\S]*if \(a\)/.test(out), out); // inner if untouched
  });

  it('flips relational operators rather than wrapping in !', () => {
    const out = tx(`int f(int n) { if (n == 2) { side(); } return 0; }`);
    assert.ok(/if \(n != 2\)\s*return 0;/.test(out), out);
    assert.ok(out.includes('side();'), out);
  });

  it('void function ending in a guard → if (!C) return; body (no trailing return)', () => {
    const out = tx(`void f(int a) { setup(); if (a) { big1(); big2(); } }`);
    assert.ok(/if \(!a\)\s*return;/.test(out), out);
    assert.ok(out.includes('big1();') && out.includes('big2();'), out);
    assert.ok(!/if \(a\)\s*\{/.test(out), out);
  });

  it('does NOT synthesize a void return for a value-returning fn ending in a guard', () => {
    const out = tx(`int f(int a) { if (a) { big(); } }`);
    assert.ok(!out.includes('return'), out); // unsafe (unknown fall-through value) → left alone
  });
});
