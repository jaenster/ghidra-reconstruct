/**
 * `x = x +- 1` becomes a step that keeps the assignment's value: the prefix form wherever the
 * value is read, the postfix form only where it is discarded. Both rewriters that make steps
 * from an assignment run through the same cases.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { incrementSimplifyPlugin } from '../builtins/increment-simplify.js';
import { loopCanonicalizePlugin } from '../builtins/loop-canonicalize.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

const rewriters = [
  ['increment-simplify', incrementSimplifyPlugin],
  ['loop-canonicalize', loopCanonicalizePlugin],
] as const;

for (const [id, plugin] of rewriters) {
  const run = (src: string) => flat(emit(plugin.createTransformer()(parse(src)) as AnyNode));

  describe(`${id}: a step keeps the assignment's value`, () => {
    it('a while condition tests the new value (GenDecodeTabs, CONTAINER_InitializeBuffer 00403040)', () => {
      const out = run('void f(int n) { while ((n = n - 1) >= 0) { g(); } }');
      assert.ok(out.includes('while (--n >= 0)'), out);
    });

    it('an if condition, a negation and an increment', () => {
      assert.ok(run('void f(int n) { if (!(n = n - 1)) { g(); } }').includes('if (!--n)'), run('void f(int n) { if (!(n = n - 1)) { g(); } }'));
      const out = run('void f(int n) { while ((n = n + 1) < 9) { g(); } }');
      assert.ok(out.includes('while (++n < 9)'), out);
    });

    it('an argument, an initialiser and a return value', () => {
      assert.ok(run('void f(int n) { g(n = n + 1); }').includes('g(++n);'));
      const init = run('void f(int n) { int m = (n = n - 1); }');
      assert.ok(/int m = \(?--n\)?;/.test(init), init);
      assert.ok(run('int f(int n) { return n = n - 1; }').includes('return --n;'));
    });

    it('a comma: operands before the last are discarded, the last is the value', () => {
      const out = run('int f(int n, int m) { return (n = n + 1, m = m - 1); }');
      assert.ok(out.includes('n++') && out.includes('--m'), out);
      assert.ok(!out.includes('++n') && !out.includes('m--'), out);
    });

    it('a while condition whose comma operand steps and then tests', () => {
      const out = run('void f(int n) { while (n = n - 1, -1 < n) { g(); } }');
      assert.ok(out.includes('n--') && !out.includes('--n'), out);
    });

    it('a statement, a for-increment and a (void) cast stay postfix', () => {
      assert.ok(run('void f(int i) { i = i + 1; }').includes('i++;'));
      const loop = run('void f() { int i; for (i = 0; i < 4; i = i + 1) { g(i); } }');
      assert.ok(loop.includes('i < 4; i++)'), loop);
      assert.ok(run('void f(int i) { (void)(i = i - 1); }').includes('i--'));
      const both = run('void f() { int i; int j; for (i = 0; i < 4; i = i + 1, j = j - 1) { g(i); } }');
      assert.ok(/i\+\+ ?, j--\)/.test(both), both);
    });

    it('a member keeps the prefix form in a condition', { skip: id === 'loop-canonicalize' ? 'steps plain names only' : false }, () => {
      const out = run('void f(S *p) { while ((p->n = p->n - 1) != 0) { g(); } }');
      assert.ok(out.includes('(--p->n != 0)'), out);
    });
  });
}
