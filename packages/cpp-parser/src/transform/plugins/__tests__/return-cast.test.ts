/**
 * Return-value cast insertion.
 *
 * Ghidra's output is C, where `void*` converts to any object pointer implicitly. C++ has
 * never allowed that, so a decompiled `return pThis;` in a function typed `short*` is not
 * valid C++ and the original MSVC source must have carried a cast.
 *
 * `assign-cast` does this for a store and `call-arg-cast` for an argument. `return` was
 * the missing third position, and it cost a hand patch in `UNICODE_FindWideChar`
 * (D2Lang/Unicode/UNISYS.cpp:204, `00526670`) that survived every regen until now:
 *
 *     short int* UNICODE_FindWideChar(void* pThis, int16_t wChar) { ... return pThis; }
 *     -> error: invalid conversion from 'void*' to 'short int*'
 *
 * The cast is RECONSTRUCTED, not invented: the parameter really is `void*` in the binary,
 * and the conversion is one the machine performs for free.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { returnCastPlugin } from '../builtins/return-cast.js';

function transform(code: string): string {
  const ast = parse(code);
  return emit(returnCastPlugin.createTransformer({})(ast) as AnyNode).trim();
}

describe('returnCastPlugin', () => {
  it('casts a void* parameter returned from a typed-pointer function', () => {
    // The exact shape from UNICODE_FindWideChar.
    const out = transform('short int* f(void* pThis) { return pThis; }');
    assert.ok(out.includes('return (short int*)pThis;'), out);
  });

  it('casts a void* local returned from a typed-pointer function', () => {
    const out = transform('D2UnitStrc* f() { void* p = alloc(); return p; }');
    assert.ok(out.includes('return (D2UnitStrc*)p;'), out);
  });

  it('casts between two unrelated object pointers', () => {
    const out = transform('D2UnitStrc* f(D2RoomStrc* pRoom) { return pRoom; }');
    assert.ok(out.includes('return (D2UnitStrc*)pRoom;'), out);
  });

  it('casts a pointer produced by a cast expression', () => {
    // The inner reinterpret stays: it is what the binary does, and collapsing the pair is
    // a separate concern. `short*` is spelled `short int*` once parsed.
    const out = transform('short* f(char* p) { return (void*)p; }');
    assert.ok(out.includes('return (short int*)(void*)p;'), out);
  });

  describe('leaves alone what is already correct', () => {
    it('a matching pointer type', () => {
      const out = transform('D2UnitStrc* f(D2UnitStrc* pUnit) { return pUnit; }');
      assert.strictEqual(out, 'D2UnitStrc* f(D2UnitStrc* pUnit) {\n  return pUnit;\n}');
    });

    it('a null pointer', () => {
      const out = transform('short* f() { return nullptr; }');
      assert.ok(!out.includes('nullptr)'), out);
      assert.ok(out.includes('return nullptr;'), out);
    });

    it('a bare return in a void function', () => {
      const out = transform('void f() { return; }');
      assert.strictEqual(out, 'void f() {\n  return;\n}');
    });

    it('a scalar returned from a scalar function', () => {
      const out = transform('int f(int x) { return x; }');
      assert.strictEqual(out, 'int f(int x) {\n  return x;\n}');
    });

    it('a value whose type it cannot determine', () => {
      // Casting on a guess would silently reinterpret a value. Say nothing instead.
      const out = transform('short* f() { return SomethingUnknown(); }');
      assert.ok(!out.includes('(short*)Something'), out);
    });

    it('a pointer returned into void* — the widening C++ does allow', () => {
      const out = transform('void* f(D2UnitStrc* pUnit) { return pUnit; }');
      assert.strictEqual(out, 'void* f(D2UnitStrc* pUnit) {\n  return pUnit;\n}');
    });
  });

  it('is idempotent — a second run reads its own cast and adds nothing', () => {
    const once = transform('short int* f(void* pThis) { return pThis; }');
    const twice = transform(once);
    assert.strictEqual(twice, once);
  });

  it('casts inside a nested scope, not only at the top level', () => {
    const out = transform('short* f(void* p) { if (p) { return p; } return nullptr; }');
    assert.ok(out.includes('return (short int*)p;'), out);
    assert.ok(!out.includes('(short int*)nullptr'), out);
  });
});
