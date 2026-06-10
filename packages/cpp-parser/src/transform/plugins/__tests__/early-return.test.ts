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

  it('does not transform when there is no trailing return', () => {
    const out = tx(`void f(int a) { if (a) { g(); } }`);
    assert.ok(out.includes('if (a)'), out);
    assert.ok(!out.includes('return'), out);
  });

  it('flips relational operators rather than wrapping in !', () => {
    const out = tx(`int f(int n) { if (n == 2) { side(); } return 0; }`);
    assert.ok(/if \(n != 2\)\s*return 0;/.test(out), out);
    assert.ok(out.includes('side();'), out);
  });
});
