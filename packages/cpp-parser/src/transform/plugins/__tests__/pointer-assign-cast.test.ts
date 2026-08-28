/**
 * Pointer Assignment Cast-Insertion Plugin Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { pointerAssignCastPlugin } from '../builtins/pointer-assign-cast.js';

describe('pointerAssignCastPlugin', () => {
  const transformer = pointerAssignCastPlugin.createTransformer();
  const transform = (code: string): string =>
    emit(transformer(parse(code)) as AnyNode).replace(/\s+/g, ' ').trim();

  it('casts a differing-pointer assignment (char* = int*)', () => {
    const out = transform(`void f() { char* x; int* y; x = y; }`);
    assert.ok(out.includes('x = (char*)y'), out);
  });

  it('casts a differing-pointer initialization (char* x = int* y)', () => {
    const out = transform(`void f() { int* y; char* x = y; }`);
    assert.ok(out.includes('char* x = (char*)y'), out);
  });

  it('casts the &*(T*)const assert idiom', () => {
    const out = transform(`void f() { char* x; x = &*(int*)4; }`);
    assert.ok(out.includes('x = (char*)&*(int*)4') || out.includes('x = (char*)(&*(int*)4)'), out);
  });

  it('leaves a same-type pointer assignment untouched', () => {
    const out = transform(`void f() { char* y; char* x; x = y; }`);
    assert.ok(!out.includes('(char*)y'), out);
    assert.ok(out.includes('x = y'), out);
  });

  it('leaves a non-pointer assignment untouched', () => {
    const out = transform(`void f() { int x; int y; x = y; }`);
    assert.ok(out.includes('x = y') && !out.includes('(int'), out);
  });

  it('is idempotent (no double cast on re-run)', () => {
    const once = transform(`void f() { char* x; int* y; x = y; }`);
    const twice = emit(transformer(parse(`void f() { char* x; int* y; x = (char*)y; }`)) as AnyNode)
      .replace(/\s+/g, ' ').trim();
    assert.ok(!twice.includes('(char*)(char*)'), twice);
    assert.ok(once.includes('(char*)y'), once);
  });
  it('widens a pointer through uintptr_t before a narrowing cast', () => {
    const out = transform(`void f() { char* pEnd; short n; n = (short)pEnd; }`);
    assert.ok(out.includes('(uintptr_t)pEnd'), out);
  });

  it('widens the pointer side of pointer arithmetic too', () => {
    const out = transform(`void f() { char* pEnd; short n; n = (short)(pEnd + 1); }`);
    assert.ok(out.includes('(uintptr_t)(pEnd + 1)'), out);
  });

  it('leaves a WORD-width cast of a pointer alone (no precision lost)', () => {
    const out = transform(`void f() { char* p; int n; n = (int)p; }`);
    assert.ok(!out.includes('uintptr_t'), out);
  });

  it('leaves a narrowing cast of a non-pointer alone', () => {
    const out = transform(`void f() { int v; short n; n = (short)v; }`);
    assert.ok(!out.includes('uintptr_t'), out);
  });

  it('does not double-widen on a re-run', () => {
    const once = transform(`void f() { char* pEnd; short n; n = (short)pEnd; }`);
    const twice = emit(transformer(parse(once)) as AnyNode).replace(/\s+/g, ' ').trim();
    assert.ok(!twice.includes('(uintptr_t)(uintptr_t)'), twice);
  });
});
