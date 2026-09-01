import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  normalizePointerSizeSpelling,
  normalizePointerSizeSpellings,
} from '../codegen/pointer-size-spelling.js';
import type { ExtractedDataType, ExtractedStruct, ExtractedFunction } from '../types.js';

describe('Ghidra pointer-size spelling', () => {
  it('rewrites T *32 to T *', () => {
    assert.strictEqual(normalizePointerSizeSpelling('D2DataArrayStrc *32'), 'D2DataArrayStrc *');
    assert.strictEqual(normalizePointerSizeSpelling('void *32'), 'void *');
    assert.strictEqual(normalizePointerSizeSpelling('DC6 *32'), 'DC6 *');
  });

  it('keeps an array extent attached', () => {
    assert.strictEqual(normalizePointerSizeSpelling('void *32[64]'), 'void *[64]');
    assert.strictEqual(normalizePointerSizeSpelling('undefined *32 *[6]'), 'undefined * *[6]');
  });

  it('leaves an ordinary type alone', () => {
    for (const t of ['D2UnitStrc *', 'char', 'uint8_t[40]', 'int']) {
      assert.strictEqual(normalizePointerSizeSpelling(t), t);
    }
  });

  it('normalizes struct fields, function signatures and globals in place', () => {
    const struct: ExtractedStruct = {
      name: 'S', category: '/', size: 4, kind: 'STRUCTURE',
      fields: [{ name: 'p', dataType: 'DC6 *32', offset: 0, size: 4 }],
    };
    const dataTypes: ExtractedDataType[] = [struct];
    const func = {
      name: 'f', returnType: 'void *32',
      parameters: [{ name: 'a', dataType: 'D2UnitStrc *32' }],
      localVariables: [{ name: 'l', dataType: 'D2InventoryStrc *32' }],
    } as unknown as ExtractedFunction;
    const globals = [{ dataType: 'D2DataArrayStrc *32', suggestedType: 'undefined *32' }];

    const changed = normalizePointerSizeSpellings(dataTypes, [func], globals);

    assert.strictEqual(changed, 6);
    assert.strictEqual(struct.fields[0].dataType, 'DC6 *');
    assert.strictEqual(func.returnType, 'void *');
    assert.strictEqual(func.parameters[0].dataType, 'D2UnitStrc *');
    assert.strictEqual(func.localVariables![0].dataType, 'D2InventoryStrc *');
    assert.strictEqual(globals[0].dataType, 'D2DataArrayStrc *');
    assert.strictEqual(globals[0].suggestedType, 'undefined *');
  });

  it('does not touch decompiled bodies, where `x *32` is a multiplication', () => {
    const func = {
      name: 'f', returnType: 'void', parameters: [], localVariables: [],
      decompiled: 'void f(void) { int n = x *32; }',
    } as unknown as ExtractedFunction;
    normalizePointerSizeSpellings([], [func], []);
    assert.ok(func.decompiled!.includes('x *32'), func.decompiled);
  });
});

describe('type ownership sees body locals', () => {
  it('scores a type reached only through a local variable', async () => {
    const { countTypeReferences, collectReferencedTypeNames } = await import('../modules/type-ownership.js');
    const func = {
      name: 'ZLIB_InflateReset', returnType: 'int', parameters: [],
      localVariables: [{ name: 'pState', dataType: 'inflate_state *' }],
      decompiled: 'int ZLIB_InflateReset(void) { return 0; }',
    } as any;
    // `inflate_state` appears in no signature anywhere; before this it scored
    // zero, got no owning header, and was never declared (10 diagnostics in
    // Storm/Source/SSComp.cpp plus 8 cascaded `pState` uses).
    assert.strictEqual(countTypeReferences([func], undefined, 'inflate_state'), 1);
    assert.ok(collectReferencedTypeNames([func]).has('inflate_state'));
  });
});

describe('root-category winsock types stay platform-guarded', () => {
  it('treats sockaddr_in as a library type despite its root category', async () => {
    const { isLibraryType } = await import('../codegen/platform-types.js');
    assert.strictEqual(isLibraryType('sockaddr_in', '/'), true);
    assert.strictEqual(isLibraryType('sockaddr', '/winsock.h'), true);
    assert.strictEqual(isLibraryType('D2UnitStrc', '/Diablo2/UNIT'), false);
  });
});
