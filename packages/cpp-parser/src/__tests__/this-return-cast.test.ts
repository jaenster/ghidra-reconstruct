/**
 * A `__thiscall` function returning its own `void *this` as a typed pointer.
 *
 * Ghidra's C writes `return this;` and relies on C's implicit `void*` conversion;
 * C++ needs the cast, which `return-cast` inserts - but only if the returned name
 * is still the parameter when it runs. `preprocessGhidraCode` used to rename
 * `return this` to `return self` (it took `return` for a type), so `return-cast`
 * saw an undeclared name and left 26 strict errors in the pure regen tree
 * (UNICODE_FindWideChar 00526670, Nth 00517fd0, the CELLIST/SGAMEDATA scalar
 * deleting destructors).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { transformGhidraCode, preprocessGhidraCode } from '../ghidra.js';

function run(signature: string, body: string, pluginOptions: Record<string, unknown>): string {
  const wrapped = `${signature} {${preprocessGhidraCode(body)}}`;
  const r = transformGhidraCode(wrapped, {
    preset: 'full', tolerateErrors: true, usePluginRegistry: true,
    pluginOptions: { pluginOptions } as any,
  } as any);
  assert.ok(r.success, r.error);
  return r.code.replace(/\s+/g, ' ');
}

describe('preprocessGhidraCode and `this`', () => {
  it('legalizes a declaration named `this`', () => {
    assert.match(preprocessGhidraCode('BigBuffer *this;'), /BigBuffer \*self;/);
    assert.match(preprocessGhidraCode('LPCSTR this;'), /LPCSTR self;/);
  });

  it('does not take a keyword for a type: `return this` stays an expression', () => {
    for (const kw of ['return', 'case', 'else', 'sizeof', 'delete']) {
      assert.equal(preprocessGhidraCode(`${kw} this;`), `${kw} this;`, kw);
    }
  });
});

describe('a `void *this` returned as a typed pointer', () => {
  const opts = { 'this-param-rewrite': { thisName: 'pThis' } };

  it('is cast to the declared return type (Nth 00517fd0)', () => {
    const out = run(
      'char * dummy(void * pThis, char * szText)',
      '\n  if (szText == (char *)0x0) {\n    return this;\n  }\n  this = szText;\n  return this;\n',
      opts,
    );
    assert.ok(!/\bself\b/.test(out), out);
    assert.equal((out.match(/return \(char\*\)pThis;/g) ?? []).length, 2, out);
  });

  it('is cast in a scalar deleting destructor (00604870)', () => {
    const out = run(
      'TSExportTableSimple_struct_CELLIST_struct_HCELLIST____0_ * dummy(void * pThis, byte byFlags)',
      '\n  TSHASH_Dtor(this);\n  if (((byFlags & 1) != 0) && (this != (void *)0x0)) {\n    SMemFree(this,"delete",-1,0);\n  }\n  return this;\n',
      opts,
    );
    assert.match(out, /return \(TSExportTableSimple_struct_CELLIST_struct_HCELLIST____0_\*\)pThis;/);
  });

  it('still binds `return this` to a local Ghidra named `this`', () => {
    const out = run(
      'BigBuffer * dummy(uint * pnResult)',
      '\n  BigBuffer *this;\n  this = (BigBuffer *)g();\n  return this;\n',
      { 'this-param-rewrite': { thisName: 'pnResult' } },
    );
    assert.match(out, /return self;/);
    assert.ok(!/return pnResult/.test(out), out);
  });
});
