/**
 * Narrowing-Cast-Through-`uintptr_t` Plugin Tests
 *
 * The must-fix cases are the five shapes the tree actually carries: a struct
 * pointer, a `wchar_t*` behind a Win32 typedef, a funcdef-typed slot, a
 * subscript through a funcdef pointer, and a struct field.
 *
 * The must-NOT-fix cases are the guarantee the pass rests on: it may only touch
 * a cast that cannot compile today. A word-wide target, a pointer target, a
 * `bool` target and an integer operand all already build, and none of them may
 * grow a `uintptr_t`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { narrowCastThroughUintptrPlugin } from '../builtins/narrow-cast-through-uintptr.js';

describe('narrowCastThroughUintptrPlugin', () => {
  const transform = (code: string, options?: Record<string, unknown>): string => {
    const t = narrowCastThroughUintptrPlugin.createTransformer(options as never);
    return emit(t(parse(code)) as AnyNode).replace(/\s+/g, ' ').trim();
  };

  // --- must fix -----------------------------------------------------------

  it('routes a struct-pointer local narrowed to uint8_t through uintptr_t', () => {
    const out = transform(`void f() { D2SUnitMsgStrc* p; uint8_t b; b = (uint8_t)p; }`);
    assert.ok(/\(uint8_t\)\s*\(uintptr_t\)\s*p/.test(out), out);
  });

  it('routes a Win32 pointer typedef narrowed to char through uintptr_t', () => {
    const out = transform(
      `void f() { LPWSTR pSep; if ((char)pSep == 0) { return; } }`,
      { typedefTargets: { LPWSTR: 'wchar_t *' } },
    );
    assert.ok(/\(char\)\s*\(uintptr_t\)\s*pSep/.test(out), out);
  });

  // `Draw` is a funcdef typedef: the slot holds a code address, and g++ rejects
  // narrowing it exactly as it rejects narrowing an object pointer. The shape
  // is star-less in the declaration, so only `asCodeAddress` finds the pointer.
  it('routes a funcdef-typed slot narrowed to char through uintptr_t', () => {
    const out = transform(
      `void f() { Draw pColStyleFlags; if ((char)pColStyleFlags < 0) { return; } }`,
      { funcdefNames: ['Draw'] },
    );
    assert.ok(/\(char\)\s*\(uintptr_t\)\s*pColStyleFlags/.test(out), out);
  });

  it('routes a subscript through a funcdef pointer narrowed to short', () => {
    const out = transform(
      `void f() { Draw* pwszCursor; if ((short int)pwszCursor[-1] == 13) { return; } }`,
      { funcdefNames: ['Draw'] },
    );
    assert.ok(/\(uintptr_t\)\s*pwszCursor\[/.test(out), out);
  });

  it('routes a struct field of pointer type narrowed to uint8_t', () => {
    const out = transform(
      `void f() { D2SUnitMsgStrc* pMsg; g((uint8_t)pMsg[1].pNext); }`,
      { structFields: { D2SUnitMsgStrc: { pNext: 'D2SUnitMsgStrc *' } } },
    );
    assert.ok(/\(uint8_t\)\s*\(uintptr_t\)/.test(out), out);
  });

  // --- must NOT fix -------------------------------------------------------

  // `(uint32_t)ptr` and `(int)ptr` are legal on a 32-bit target and appear all
  // over the tree; touching one would be churn on code that already builds.
  it('leaves a word-wide target alone', () => {
    const out = transform(`void f() { D2UnitStrc* p; g((uint32_t)p); g((int)p); }`);
    assert.ok(!out.includes('uintptr_t'), out);
  });

  it('leaves a cast to uintptr_t alone (and does not double it)', () => {
    const out = transform(`void f() { D2UnitStrc* p; g((uintptr_t)p); }`);
    assert.ok(!/\(uintptr_t\)\s*\(uintptr_t\)/.test(out), out);
  });

  // `(bool)ptr` is a legal C++ conversion, so it is outside the set on purpose:
  // the pass's safety argument is that it only ever touches a hard error.
  it('leaves a cast to bool alone', () => {
    const out = transform(`void f() { D2UnitStrc* p; if ((bool)p) { return; } }`);
    assert.ok(!out.includes('uintptr_t'), out);
  });

  it('leaves a pointer target alone', () => {
    const out = transform(`void f() { D2UnitStrc* p; g((char*)p); }`);
    assert.ok(!out.includes('uintptr_t'), out);
  });

  it('leaves a narrowing cast of an INTEGER alone', () => {
    const out = transform(`void f() { int n; g((uint8_t)n); }`);
    assert.ok(!out.includes('uintptr_t'), out);
  });

  it('leaves an operand whose type the model cannot determine alone', () => {
    const out = transform(`void f() { g((uint8_t)someUnknownThing); }`);
    assert.ok(!out.includes('uintptr_t'), out);
  });

  it('is idempotent', () => {
    const src = `void f() { D2UnitStrc* p; g((uint8_t)p); }`;
    const once = transform(src);
    const twice = transform(once.replace(/^.*?\{ /, 'void f() { '));
    assert.ok(!/\(uintptr_t\)\s*\(uintptr_t\)/.test(once), once);
    assert.ok(!/\(uintptr_t\)\s*\(uintptr_t\)/.test(twice), twice);
  });
});
