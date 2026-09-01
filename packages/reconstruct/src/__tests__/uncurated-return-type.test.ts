/**
 * The emitter takes a function's return type from the raw database field
 * (`Function.getReturnType()`) but its BODY from the decompiler, which resolves
 * its own prototype through `HighFunction`. Where nobody has curated the field
 * it reads `undefined`, which normalises to `uint8_t`, and it gets paired with
 * the decompiler's `void` body full of bare `return;` statements:
 *
 *   error: return-statement with no value, in function returning 'uint8_t'
 *
 * `undefined` is the one case where the database has nothing to say, so the
 * answer is taken from the same prototype the body came from. A curated field
 * always wins — mapping `undefined` to `void` unconditionally would assert
 * something false about the functions that genuinely do return a value.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { decompiledReturnType } from '../codegen/impl.js';

describe('decompiledReturnType', () => {
  it('reads the return type off the decompiler prototype', () => {
    assert.strictEqual(
      decompiledReturnType('void __fastcall NS::Sub::FN(int a)\n\n{\n  return;\n}'),
      'void',
    );
  });

  it('keeps a pointer return type', () => {
    assert.strictEqual(
      decompiledReturnType('D2UnitStrc * __fastcall FN(int a)\n{\n}'),
      'D2UnitStrc *',
    );
  });

  it('strips the calling convention, which is not part of the type', () => {
    assert.strictEqual(decompiledReturnType('int __cdecl FN(void)\n{\n}'), 'int');
  });

  it('is not confused by a parenthesised parameter type', () => {
    assert.strictEqual(
      decompiledReturnType('void FN(int a,void (*cb)(int))\n{\n}'),
      'void',
    );
  });

  it('reads a prototype Ghidra wrapped across lines, past its PLATE comment', () => {
    const decompiled = [
      '/* @function RENDERER_D3D_CopyPixelsWithStride',
      '   @address Game.exe.ram:006b1d80 */',
      '',
      'void __fastcall',
      'D2Client::Renderer::Direct3D::RENDERER_D3D_CopyPixelsWithStride',
      '          (void *pSrc,void *pDest)',
      '',
      '{',
      '  return;',
      '}',
    ].join('\n');
    assert.strictEqual(decompiledReturnType(decompiled), 'void');
  });

  it('gives up rather than guess when there is no prototype', () => {
    assert.strictEqual(decompiledReturnType('/* no body here */'), undefined);
    assert.strictEqual(decompiledReturnType(undefined), undefined);
  });
});
