/**
 * Tests for the pointer-to-pointer store cast plugin.
 *
 * `*(uint8_t***)pThis = vftable;` has a left side of type uint8_t** and a right side
 * that decays to void**. Same thing in Ghidra's C, a hard type error in C++.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { vtableStoreCastPlugin } from '../builtins/vtable-store-cast.js';

function run(code: string): string {
  const ast = parse(code);
  const t = vtableStoreCastPlugin.createTransformer({});
  return emit(t(ast) as AnyNode).trim();
}

describe('vtable-store-cast', () => {
  it('casts a bare name stored through a pointer-to-pointer cast', () => {
    const out = run('void f(void) { *(uint8_t***)pThis = vftable; }');
    assert.match(out, /\*\(uint8_t\s*\*\*\*\)pThis\s*=\s*\(uint8_t\s*\*\*\)vftable;/);
  });

  it('handles a qualified name', () => {
    const out = run('void f(void) { *(uint8_t***)pThis = D2Client::UIWidget::vftable; }');
    assert.ok(out.includes('UIWidget::vftable'), `qualifier kept, got: ${out}`);
    assert.match(out, /=\s*\(uint8_t\s*\*\*\)/);
  });

  it('leaves a single-level pointer store alone', () => {
    const out = run('void f(void) { *(uint8_t*)p = x; }');
    assert.ok(!out.includes('(uint8_t)x'), `should not cast, got: ${out}`);
  });

  it('leaves an expression that already carries a cast alone', () => {
    const out = run('void f(void) { *(uint8_t***)pThis = (uint8_t**)vftable; }');
    assert.equal((out.match(/\(uint8_t\s*\*\*\)/g) || []).length, 1);
  });

  it('leaves a computed right-hand side alone', () => {
    const out = run('void f(void) { *(uint8_t***)pThis = a + b; }');
    assert.match(out, /=\s*a \+ b;/);
  });
});
