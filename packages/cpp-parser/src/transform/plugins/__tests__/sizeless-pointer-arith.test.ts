/**
 * Sizeless Pointer Arithmetic Plugin Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { sizelessPointerArithPlugin } from '../builtins/sizeless-pointer-arith.js';
import type { SizelessPointerArithOptions } from '../builtins/sizeless-pointer-arith.js';

describe('sizelessPointerArithPlugin', () => {
  const transform = (code: string, options?: SizelessPointerArithOptions): string => {
    const transformer = sizelessPointerArithPlugin.createTransformer(options);
    return emit(transformer(parse(code)) as AnyNode).replace(/\s+/g, ' ').trim();
  };

  // Dungeon.cpp TILEPROJECT_AllocSlot: the offset sits under a cast already.
  it('does a void* offset on uint8_t* under an existing pointer cast', () => {
    const out = transform(`int f(void * pTileProject, int i) { return *(int*)(pTileProject + i * 4); }`);
    assert.ok(out.includes('*(int*)((uint8_t*)pTileProject + i * 4)'), out);
    assert.ok(!out.includes('(void*)'), out);
  });

  it('converts back to void* where the sum is used as a value', () => {
    const out = transform(`void g(void*); void f(void * p, int n) { g(p + n); }`);
    assert.ok(out.includes('g((void*)((uint8_t*)p + n))'), out);
  });

  it('keeps const on the converted-back type', () => {
    const out = transform(`void g(const void*); void f(const void * p, int n) { g(p + n); }`);
    assert.ok(/g\(\(const void\s*\*\)\(\(uint8_t\*\)p \+ n\)\)/.test(out), out);
  });

  // Items.cpp: a void* field of a global struct.
  it('types a void* struct field through the field tables', () => {
    const out = transform(`uint32_t f(int n) { return *(uint32_t*)(sgptDataTable->pTxtItemTypesUnknown + n * 4); }`, {
      globalTypes: { sgptDataTable: 'D2DataTablesStrc *' },
      structFields: { D2DataTablesStrc: { pTxtItemTypesUnknown: 'void *' } },
    });
    assert.ok(out.includes('*(uint32_t*)((uint8_t*)sgptDataTable->pTxtItemTypesUnknown + n * 4)'), out);
  });

  it('folds a chain onto one byte expression', () => {
    const out = transform(`void g(void*); void f(void * p, int a, int b) { g(p + a - b); }`);
    assert.ok(out.includes('g((void*)((uint8_t*)p + a - b))'), out);
  });

  it('measures a void* distance in bytes', () => {
    const out = transform(`int f(void * p, void * q) { return p - q; }`);
    assert.ok(out.includes('return (uint8_t*)p - (uint8_t*)q;'), out);
  });

  it('puts an integer on the left of a sum through the same rule', () => {
    const out = transform(`void g(void*); void f(void * p, int n) { g(n + p); }`);
    assert.ok(out.includes('g((void*)(n + (uint8_t*)p))'), out);
  });

  // Drlg.cpp DRLGLEVEL_ParseLevelData: a local typed as a funcdef, counted.
  it('steps a function-pointer local as bytes, statement and cast forms', () => {
    const out = transform(`void f(int* a) { fpLevelDataFn1 fn; int x; x = a[(int)(fn + 1)]; fn++; }`, {
      funcdefNames: ['fpLevelDataFn1'],
    });
    assert.ok(out.includes('a[(int)((uint8_t*)fn + 1)]'), out);
    assert.ok(out.includes('fn = (fpLevelDataFn1)((uint8_t*)fn + 1);'), out);
  });

  it('rewrites += and prefix ++ on a pure sizeless lvalue', () => {
    const out = transform(`void f(void * p, int n) { p += n; ++p; }`);
    assert.ok(out.includes('p = (void*)((uint8_t*)p + n);'), out);
    assert.ok(/\(?p = \(void\*\)\(\(uint8_t\*\)p \+ 1\)\)?;/.test(out), out);
  });

  it('spells a funcdef field through its typedef, root-qualified when shadowed', () => {
    const out = transform(`void f(S* s, int n) { DrawEx d; d = s->fp - n; }`, {
      funcdefNames: ['DrawEx'],
      rootQualifiedTypedefs: ['DrawEx'],
      structFields: { S: { fp: 'DrawEx' } },
    });
    assert.ok(out.includes('d = (::DrawEx)((uint8_t*)s->fp - n);'), out);
  });

  it('leaves a postfix step whose value is used', () => {
    const out = transform(`void g(void*); void f(void * p) { g(p++); }`);
    assert.ok(out.includes('g(p++)'), out);
  });

  it('leaves arithmetic on sized pointers and integers alone', () => {
    const src = `int f(int * p, char * c, int n) { return *(p + n) + *(c - n) + n + 1; }`;
    const out = transform(src);
    assert.ok(!out.includes('uint8_t'), out);
  });

  it('does not take a call through a void* lvalue as pure', () => {
    const out = transform(`void** h(); void f(int n) { *h() += n; }`);
    assert.ok(!out.includes('uint8_t'), out);
  });
});
