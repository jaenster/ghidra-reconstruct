/**
 * Ghidra's decompiler emits C, where `void*` converts to any object pointer
 * implicitly. The tree is C++, where it never has:
 *
 *   D2CMP/CelCmp.cpp: error: invalid conversion from 'void*' to 'uint32_t*'
 *
 * The allocators really do return `void*` — `SMemAlloc`, `AllocClientMemory`,
 * `AllocServerMemory` are correctly typed — so the original MSVC source had to
 * write the cast at every one of these points. Reconstructing it is faithful.
 *
 * Scoped: only a call to a function the MODEL says returns `void*`, only into a
 * concrete object-pointer destination. A `void*`-to-integer destination is a
 * different conversion and is left alone.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateImplementation, type ImplGenContext } from '../codegen/impl.js';
import type { ExtractedFunction, ReconstructOptions } from '../types.js';

const options: ReconstructOptions = {
  outputDir: '/tmp/test',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
  promoteStaticGlobals: false,
};

function caller(body: string[]): ExtractedFunction {
  return {
    name: 'CELCMP_Decode',
    address: '0x00401070',
    signature: 'void CELCMP_Decode(void)',
    returnType: 'void',
    parameters: [],
    localVariables: [],
    callingConvention: '__fastcall',
    size: 64,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    decompiled: ['void CELCMP_Decode(void)', '{', ...body, '  return;', '}'].join('\n'),
  };
}

const context = (): ImplGenContext => ({
  funcPtrArgCasts: {
    paramFuncdefs: {},
    funcdefSignatures: {},
    functionSignatures: {},
    variableNames: [],
    voidPointerFunctions: ['SMemAlloc', 'Fog::SMem::SMemAlloc'],
    rootQualifiedTypedefs: [],
  },
});

function emit(body: string[]): string {
  return generateImplementation(
    'D2CMP/CelCmp', [caller(body)], undefined, 'D2CMP/CelCmp.h',
    options, context(), undefined, new Set<string>(),
  );
}

describe('a void*-returning call filling an object-pointer slot', () => {
  it('casts a declaration initializer', () => {
    const impl = emit(['  uint32_t *pBlock = Fog::SMem::SMemAlloc(0x24);']);
    assert.match(impl, /pBlock = \(uint32_t\s*\*\)\s*(::)?Fog::SMem::SMemAlloc/);
  });

  it('casts an assignment to a declared pointer local', () => {
    const impl = emit([
      '  uint8_t *pBuf;',
      '  pBuf = SMemAlloc(0x40);',
    ]);
    assert.match(impl, /pBuf = \(uint8_t\s*\*\)\s*SMemAlloc/);
  });

  it('leaves an integer destination alone — that is a different conversion', () => {
    const impl = emit([
      '  uint32_t nHandle;',
      '  nHandle = SMemAlloc(0x40);',
    ]);
    assert.ok(
      !/\(uint32_t\)\s*SMemAlloc/.test(impl),
      `pointer-to-integer is not this rule — got:\n${impl}`,
    );
  });

  it('leaves a call whose return type is not void* alone', () => {
    const impl = emit(['  uint32_t *pBlock = SOME_OtherAlloc(0x24);']);
    assert.ok(
      !/\(uint32_t\s*\*\)\s*SOME_OtherAlloc/.test(impl),
      `only functions the model types as void* qualify — got:\n${impl}`,
    );
  });
});
