/**
 * Duplicate Goto-Label Uniquify Plugin Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { duplicateLabelUniquifyPlugin } from '../builtins/duplicate-label-uniquify.js';

describe('duplicateLabelUniquifyPlugin', () => {
  const transformer = duplicateLabelUniquifyPlugin.createTransformer();
  const transform = (code: string): string =>
    emit(transformer(parse(code)) as AnyNode).replace(/\s+/g, ' ').trim();

  it('renames the second copy of a duplicated Ghidra label', () => {
    const out = transform(`void f(int c) { LAB_1: use(1); if (c) { LAB_1: use(2); } }`);
    assert.ok(out.includes('LAB_1:'), out);
    assert.ok(out.includes('LAB_1__dup2:'), `second copy must be renamed: ${out}`);
  });

  it('leaves a label defined once alone', () => {
    const out = transform(`void f() { goto LAB_1; LAB_1: use(1); }`);
    assert.ok(!out.includes('__dup'), out);
    assert.ok(out.includes('goto LAB_1'), out);
  });

  it('leaves non-Ghidra label names alone', () => {
    const out = transform(`void f(int c) { done: use(1); if (c) { done: use(2); } }`);
    assert.ok(!out.includes('__dup'), `only Ghidra label names are touched: ${out}`);
  });

  it('keeps a backward goto on the preceding copy', () => {
    const out = transform(`void f(int c) { LAB_1: use(1); goto LAB_1; if (c) { LAB_1: use(2); } }`);
    assert.ok(/goto LAB_1\s*;/.test(out), `backward goto keeps the first copy: ${out}`);
  });

  it('sends a goto to the copy that shares its scope, not to the most recent preceding one', () => {
    // The regex pass this replaces resolved every goto to "the most recent
    // PRECEDING definition", so this goto reached the copy in the OTHER branch.
    // Both copies are equally far in source; only the structure says which
    // region the goto belongs to.
    const out = transform(
      `void f(int c) { if (c) { LAB_1: use(1); } else { goto LAB_1; LAB_1: use(2); } }`);
    assert.ok(out.includes('goto LAB_1__dup2'),
      `goto must reach the copy in its own branch: ${out}`);
  });

  it('resolves each region\'s goto to that region\'s own copy', () => {
    const out = transform(
      `void f(int c) { if (c) { LAB_1: use(1); goto LAB_1; } else { LAB_1: use(2); goto LAB_1; } }`);
    const first = out.indexOf('goto LAB_1;');
    const second = out.indexOf('goto LAB_1__dup2');
    assert.ok(first >= 0, `then-branch goto keeps the bare name: ${out}`);
    assert.ok(second > first, `else-branch goto takes the second copy: ${out}`);
  });

  it('numbers a third copy __dup3', () => {
    const out = transform(
      `void f(int c) { LAB_1: use(1); if (c) { LAB_1: use(2); } while (c) { LAB_1: use(3); } }`);
    assert.ok(out.includes('LAB_1__dup2:') && out.includes('LAB_1__dup3:'), out);
  });

  it('every goto still names a label that exists', () => {
    const out = transform(
      `void f(int c) { goto LAB_1; if (c) { LAB_1: use(1); goto LAB_1; } LAB_1: use(2); }`);
    const defined = new Set([...out.matchAll(/(LAB_1(?:__dup\d+)?):/g)].map(m => m[1]));
    for (const m of out.matchAll(/goto (LAB_1(?:__dup\d+)?)\s*;/g)) {
      assert.ok(defined.has(m[1]), `goto ${m[1]} has no definition in: ${out}`);
    }
  });
});
