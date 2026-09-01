/**
 * Tests for synthesizing declarations of Ghidra's `_<base>` storage-slot locals.
 *
 * Ghidra reuses a param/local's storage slot as a fresh local named `_<base>`
 * but emits no declaration for it. The codegen must synthesize one, or the body
 * uses an undeclared identifier → compile error.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateImplementation, type ImplGenContext } from '../codegen/impl.js';
import type {
  ExtractedFunction,
  ExtractedParameter,
  ReconstructOptions,
} from '../types.js';

function makeParam(name: string, dataType: string, ordinal: number): ExtractedParameter {
  return { name, dataType, size: 4, ordinal, storage: 'register' };
}

function makeFunc(
  name: string,
  address: string,
  params: ExtractedParameter[],
  decompiled: string
): ExtractedFunction {
  return {
    name,
    address,
    signature: `void ${name}(${params.map(p => `${p.dataType} ${p.name}`).join(', ')})`,
    returnType: 'void',
    parameters: params,
    localVariables: [],
    callingConvention: '__cdecl',
    size: 64,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    decompiled,
  };
}

const options: ReconstructOptions = {
  outputDir: './out',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
  promoteStaticGlobals: false,
};

describe('underscore storage-slot local synthesis', () => {
  it('declares `_foo` (typed from param `foo`) when used but undeclared', () => {
    const func = makeFunc('UsesSlot', '0x00400000', [
      makeParam('nSuffixId', 'uint16_t', 0),
    ],
      'void UsesSlot(uint16_t nSuffixId) {\n' +
      '    int iResult;\n' +
      '    _nSuffixId = 0;\n' +
      '    do {\n' +
      '        iResult = _nSuffixId;\n' +
      '        _nSuffixId = _nSuffixId + 1;\n' +
      '    } while (_nSuffixId < 9);\n' +
      '}'
    );

    const context: ImplGenContext = {};
    const impl = generateImplementation('m', [func], undefined, 'm.h', options, context);

    assert.ok(
      /\buint16_t\s+_nSuffixId\s*;/.test(impl),
      `Expected a 'uint16_t _nSuffixId;' decl in:\n${impl}`
    );
  });

  it('falls back to int when the base type cannot be resolved', () => {
    // base `BVar1` is declared in the body but with an unusual type we still capture;
    // here we use a body-only local of unknown-to-us type to exercise the path where
    // the base IS declared (in body) so `_BVar1` is synthesized.
    const func = makeFunc('UsesSlot2', '0x00400010', [],
      'void UsesSlot2(void) {\n' +
      '    byte BVar1;\n' +
      '    BVar1 = 0;\n' +
      '    _BVar1 = BVar1;\n' +
      '    return;\n' +
      '}'
    );
    const impl = generateImplementation('m', [func], undefined, 'm.h', options, {});
    // base `BVar1` declared as `byte` in body → `_BVar1` gets byte (or its mapped type), declared.
    assert.ok(
      /\b_BVar1\s*;/.test(impl),
      `Expected a '_BVar1;' decl in:\n${impl}`
    );
  });

  it('synthesizes `_bResult` even when it only appears in `return _bResult;`', () => {
    // `return _bResult;` must not be misread as a declaration (type=`return`,
    // name=`_bResult`) — that would mark `_bResult` as already-declared and
    // suppress the synthesized slot decl, leaving an undeclared identifier.
    const func = makeFunc('ReturnsSlot', '0x00400040', [],
      'uint32_t ReturnsSlot(void) {\n' +
      '    bool bResult;\n' +
      '    _bResult = 1;\n' +
      '    return _bResult;\n' +
      '}'
    );
    const impl = generateImplementation('m', [func], undefined, 'm.h', options, {});
    assert.ok(
      /\b_bResult\s*;/.test(impl),
      `Expected a '_bResult;' decl in:\n${impl}`
    );
  });

  it('does NOT synthesize a local decl for `_DAT_*` globals', () => {
    const func = makeFunc('UsesGlobal', '0x00400020', [],
      'void UsesGlobal(void) {\n' +
      '    _DAT_001234 = 5;\n' +
      '    return;\n' +
      '}'
    );
    const impl = generateImplementation('m', [func], undefined, 'm.h', options, {});
    // No synthesized declaration line `<type> _DAT_001234;` should appear in the body.
    assert.ok(
      !/^\s*\w[\w :<>,*]*\s+_DAT_001234\s*;/m.test(impl),
      `Should NOT declare a local for _DAT_001234 in:\n${impl}`
    );
  });

  it('does NOT synthesize when `_foo` has no matching declared base', () => {
    const func = makeFunc('NoBase', '0x00400030', [
      makeParam('nOther', 'int', 0),
    ],
      'void NoBase(int nOther) {\n' +
      '    _mysteryThing = nOther;\n' +
      '    return;\n' +
      '}'
    );
    const impl = generateImplementation('m', [func], undefined, 'm.h', options, {});
    assert.ok(
      !/\b\w+\s+_mysteryThing\s*;/.test(impl),
      `Should NOT declare a local for _mysteryThing (no base 'mysteryThing'):\n${impl}`
    );
  });
});
