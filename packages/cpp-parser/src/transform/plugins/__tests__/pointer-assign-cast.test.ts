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

  // The parser splits a multi-word builtin into a head plus modifiers, so
  // `unsigned char` arrives as `{ name: 'char', modifiers: ['unsigned'] }`. A
  // key read off the head alone made these two types EQUAL and wrote no cast.
  it('casts between the two signednesses of char', () => {
    const out = transform(`void f() { unsigned char* x; char* y; x = y; }`);
    assert.ok(out.includes('x = (unsigned char*)y'), out);
  });

  // The other direction of the same defect: short/long/long long all reduce to
  // the head `int`, so a genuinely differing width looked identical.
  it('casts between short* and int*', () => {
    const out = transform(`void f() { short* x; int* y; x = y; }`);
    // The emitter spells the modifier out - `short int*` - which is the same type.
    assert.ok(/x = \(short\s*(int)?\*\)y/.test(out), out);
  });

  it('leaves a same-modified-builtin assignment alone', () => {
    const out = transform(`void f() { unsigned char* x; unsigned char* y; x = y; }`);
    assert.ok(!out.includes('(unsigned char*)y'), out);
  });

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

  // `underscore-storage-alias` spells a decompiler slot that overlays a narrower
  // declaration as a deref of a cast, so the destination type is written right
  // there. A multidimensional member decays to a pointer to its ROW; the
  // decompiler walks it one ELEMENT at a time and types the slot by that stride,
  // so the two extents differ and C++ rejects what C only warned about.
  it('casts an array member assigned into a pointer-to-array slot', () => {
    const out = transform(
      `void f(uint16_t nServerId, D2GameStrc* pGame) { *(D2UnitStrc* (**)[5])&nServerId = pGame->pUnitList; }`);
    assert.ok(/= \(D2UnitStrc\* ?\(\*\)\[5\]\)pGame->pUnitList/.test(out), out);
  });

  // Ghidra put the reinterpretation there itself on the statement that advances
  // the same slot; a second one would be noise.
  it('leaves a right-hand side that already carries a cast alone', () => {
    const out = transform(
      `void f(uint16_t n) { *(D2UnitStrc* (**)[5])&n = (D2UnitStrc* (*)[5])(**(D2UnitStrc* (**)[5])&n + 1); }`);
    assert.ok(!/\(D2UnitStrc\* ?\(\*\)\[5\]\)\s*\(D2UnitStrc/.test(out), out);
  });

  // The extent is part of the type. Two slots of the same extent are the same
  // type and need nothing.
  it('leaves a same-extent pointer-to-array assignment alone', () => {
    const out = transform(
      `void f(uint16_t n) { D2UnitStrc* (*pRow)[5]; *(D2UnitStrc* (**)[5])&n = pRow; }`);
    assert.ok(!/= \(D2UnitStrc\* ?\(\*\)\[5\]\)pRow/.test(out), out);
  });

  // There is no address to reinterpret in `= 0`, and the pass only ever writes
  // back a reinterpretation of one.
  it('leaves a literal assigned into such a slot alone', () => {
    const out = transform(`void f(uint16_t n) { *(D2UnitStrc* (**)[5])&n = 0; }`);
    assert.ok(!out.includes('(D2UnitStrc* (*)[5])0'), out);
  });

  // The pointee must be a pointer to an ARRAY; an ordinary pointer slot has a
  // declared type the identifier path can compare and is not this rule's.
  it('leaves an ordinary pointer slot alone', () => {
    const out = transform(`void f(uint16_t n, D2GameStrc* pGame) { *(D2UnitStrc**)&n = pGame->pFirstUnit; }`);
    assert.ok(!/\(D2UnitStrc\*\)pGame->pFirstUnit/.test(out), out);
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

/**
 * A STORE through a const-qualified base.
 *
 * `D2Client/UI/ui.cpp`'s `UI_LoadFileToMemory` inlines a `strcpy` that MSVC
 * strength-reduced: `LEA EDX,[EBP-0x10c]; SUB EDX,EBX; MOV [EDX+EAX*1],CL`
 * addresses the writable destination off the SOURCE pointer, and the decompiler
 * keeps the base it was given. The object written is the writable one; only C++
 * objects, so the base is re-spelled as the writable pointer it is a view of.
 */
describe('pointerAssignCastPlugin: a store through a const base', () => {
  const transformer = pointerAssignCastPlugin.createTransformer();
  const transform = (code: string): string =>
    emit(transformer(parse(code)) as AnyNode).replace(/\s+/g, ' ').trim();

  it('re-spells an LPCSTR base that is subscripted and STORED into', () => {
    const out = transform(
      'void f() { LPCSTR pSrcName; char cChar; pSrcName[(int)(szNameCopy - (int)szFilename)] = cChar; }');
    assert.ok(/\(\(char\s*\*\)pSrcName\)\[/.test(out), out);
  });

  it('re-spells a directly const-qualified base', () => {
    const out = transform('void f(const char* p) { char c; p[3] = c; }');
    assert.ok(/\(\(char\s*\*\)p\)\[3\] = c/.test(out), out);
  });

  it('re-spells a store through a dereference of a const base', () => {
    const out = transform('void f() { LPCSTR p; char c; *(p + 3) = c; }');
    assert.ok(/\*\(\(char\s*\*\)p \+ 3\) = c/.test(out), out);
  });

  it('leaves a READ through the same const base alone', () => {
    // Reading through a `const char*` is well-formed; a cast there would be
    // noise that hides which sites really write.
    const out = transform('void f() { LPCSTR p; char c; c = p[3]; }');
    assert.ok(!out.includes('(char*)p'), out);
    assert.ok(out.includes('c = p[3]'), out);
  });

  it('leaves a store through a WRITABLE base alone', () => {
    const out = transform('void f() { char* p; char c; p[3] = c; }');
    assert.ok(!out.includes('(char*)p'), out);
  });

  it('leaves a store through a base of unknown type alone', () => {
    const out = transform('void f() { char c; pUnknown[3] = c; }');
    assert.ok(!out.includes('(char*)'), out);
  });

  it('re-spells the wide and void const typedefs on their own pointee', () => {
    const wide = transform('void f() { LPCWSTR p; wchar_t c; p[1] = c; }');
    assert.ok(/\(\(wchar_t\s*\*\)p\)\[1\]/.test(wide), wide);
    const raw = transform('void f() { LPCVOID p; *(char*)p = 0; }');
    // The store is through a CAST, which already says what it writes through.
    assert.ok(!raw.includes('(void*)p'), raw);
  });
});
