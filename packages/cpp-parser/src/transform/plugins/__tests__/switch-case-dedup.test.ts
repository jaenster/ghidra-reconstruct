/**
 * Duplicate Switch-Case Label Plugin Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { switchCaseDedupPlugin } from '../builtins/switch-case-dedup.js';

describe('switchCaseDedupPlugin', () => {
  const transformer = switchCaseDedupPlugin.createTransformer();
  const transform = (code: string): string =>
    emit(transformer(parse(code)) as AnyNode).replace(/\s+/g, ' ').trim();
  const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

  it('drops a repeated case value and keeps its statement', () => {
    const out = transform(`void f(int x) { switch (x) { case 1: a(); break; case 1: b(); break; } }`);
    assert.strictEqual(count(out, /case 1\s*:/g), 1, `one label left: ${out}`);
    assert.ok(out.includes('b()'), `the duplicate's body is kept: ${out}`);
  });

  it('drops a second default', () => {
    const out = transform(`void f(int x) { switch (x) { default: a(); break; default: b(); break; } }`);
    assert.strictEqual(count(out, /default\s*:/g), 1, out);
    assert.ok(out.includes('b()'), out);
  });

  it('keeps every distinct QUALIFIED enum case label', () => {
    // The regex this replaces matched the label as `[^:]+`, which stopped at the
    // scope operator: both labels reduced to `eMode_ns` and the second was
    // struck out as a duplicate.
    const out = transform(
      `void f(int x) { switch (x) { case eMode_ns::WALK: a(); break; case eMode_ns::RUN: b(); break; } }`);
    assert.ok(out.includes('eMode_ns::WALK'), `first qualified label kept: ${out}`);
    assert.ok(out.includes('eMode_ns::RUN'), `second qualified label kept: ${out}`);
    assert.strictEqual(count(out, /case /g), 2, out);
  });

  it('still deduplicates two labels naming the SAME qualified constant', () => {
    const out = transform(
      `void f(int x) { switch (x) { case eMode_ns::WALK: a(); break; case eMode_ns::WALK: b(); break; } }`);
    assert.strictEqual(count(out, /case /g), 1, out);
  });

  it('compares literal values, not their spelling', () => {
    const out = transform(`void f(int x) { switch (x) { case 0: a(); break; case 0x0: b(); break; } }`);
    assert.strictEqual(count(out, /case /g), 1, `0 and 0x0 are one label: ${out}`);
  });

  it('leaves distinct cases alone', () => {
    const out = transform(`void f(int x) { switch (x) { case 1: a(); break; case 2: b(); break; default: c(); } }`);
    assert.strictEqual(count(out, /case /g), 2, out);
    assert.strictEqual(count(out, /default\s*:/g), 1, out);
  });

  it('keeps a stacked `case A: case B:` pair', () => {
    const out = transform(`void f(int x) { switch (x) { case 1: case 2: a(); break; } }`);
    assert.strictEqual(count(out, /case /g), 2, out);
  });

  it('scopes case values to their own switch', () => {
    const out = transform(
      `void f(int x, int y) { switch (x) { case 1: switch (y) { case 1: a(); break; } break; case 2: b(); break; } }`);
    assert.strictEqual(count(out, /case 1\s*:/g), 2, `the inner case 1 is a different switch: ${out}`);
    assert.strictEqual(count(out, /case 2\s*:/g), 1, out);
  });
});
