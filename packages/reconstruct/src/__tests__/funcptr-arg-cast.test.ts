/**
 * A parameter declared with a function-pointer typedef is handed the address of
 * a function with a different prototype:
 *
 *   D2Client/CharSel.cpp: error: invalid conversion from 'void (*)(uint16_t*)'
 *                         to 'CONTAINER_TypeInitialValue' {aka 'void (*)(void*)'}
 *
 * Both sides are correct — `CONTAINER_InitializeBuffer` is authentically generic
 * and its callers genuinely disagree with each other — and function pointer
 * types are invariant in C++, so the original source had to write the cast. The
 * emitter reconstructs it, but ONLY where the model says the prototypes differ.
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

function caller(body: string): ExtractedFunction {
  return {
    name: 'CHARSEL_Init',
    address: '0x00401070',
    signature: 'void CHARSEL_Init(void)',
    returnType: 'void',
    parameters: [],
    localVariables: [],
    callingConvention: '__fastcall',
    size: 64,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    decompiled: ['void CHARSEL_Init(void)', '{', `  ${body}`, '  return;', '}'].join('\n'),
  };
}

const context = (): ImplGenContext => ({
  funcPtrArgCasts: {
    paramFuncdefs: {
      CONTAINER_InitializeBuffer: { 3: 'CONTAINER_TypeInitialValue' },
    },
    funcdefSignatures: {
      CONTAINER_TypeInitialValue: 'void(void *)',
    },
    functionSignatures: {
      STRING_ZeroOneWCHAR: 'void(uint16_t *)',
      D2COMP_ZeroBuffer512: 'void(void *)',
      TAKES_TWO: 'void(void *,int32_t)',
      gbSomeFlag: 'void(void *)',
    },
    variableNames: ['gbSomeFlag'],
    voidPointerFunctions: [],
    rootQualifiedTypedefs: [],
  },
});

function emit(body: string): string {
  return generateImplementation(
    'D2Client/CharSel', [caller(body)], undefined, 'D2Client/CharSel.h',
    options, context(), undefined, new Set<string>(),
  );
}

describe('function address passed to a differing funcdef parameter', () => {
  it('casts to the parameter\'s funcdef type', () => {
    const impl = emit('CONTAINER_InitializeBuffer(0, 2, 100, STRING_ZeroOneWCHAR);');
    assert.match(impl, /\(CONTAINER_TypeInitialValue\)\s*STRING_ZeroOneWCHAR/);
  });

  it('leaves a function whose prototype already matches alone', () => {
    const impl = emit('CONTAINER_InitializeBuffer(0, 2, 100, D2COMP_ZeroBuffer512);');
    assert.ok(
      !impl.includes('(CONTAINER_TypeInitialValue)'),
      `void(void*) needs no cast — got:\n${impl}`,
    );
  });

  it('leaves an arity mismatch alone — a cast does not reconcile that', () => {
    const impl = emit('CONTAINER_InitializeBuffer(0, 2, 100, TAKES_TWO);');
    assert.ok(
      !impl.includes('(CONTAINER_TypeInitialValue)'),
      `differing arity is a real disagreement, not a cast — got:\n${impl}`,
    );
  });

  it('leaves parameters that are not funcdef slots alone', () => {
    const impl = emit('CONTAINER_InitializeBuffer(STRING_ZeroOneWCHAR, 2, 100, D2COMP_ZeroBuffer512);');
    assert.ok(
      !impl.includes('(CONTAINER_TypeInitialValue)'),
      `only slot 3 is a funcdef parameter — got:\n${impl}`,
    );
  });

  it('leaves a name that also denotes data alone', () => {
    // `gbSomeFlag` is a data symbol here; the argument denotes the variable, and
    // casting it to a funcdef would be wrong (and often a syntax error, since the
    // typedef need not be visible in this translation unit).
    const impl = emit('CONTAINER_InitializeBuffer(0, 2, 100, gbSomeFlag);');
    assert.ok(
      !impl.includes('(CONTAINER_TypeInitialValue)'),
      `a data name is not proof of a function — got:\n${impl}`,
    );
  });

  it('root-qualifies a typedef a same-named function would hide', () => {
    // `fpRequiredUserAction` is BOTH a funcdef typedef and a function name. Inside
    // the function's namespace the function wins, so `(fpRequiredUserAction)f`
    // parses as a call: "error: expected ')' before 'f'". The typedef itself is
    // emitted at root scope, so the cast says so.
    const ctx: ImplGenContext = {
      funcPtrArgCasts: {
        paramFuncdefs: { CONTAINER_InitializeBuffer: { 3: 'fpRequiredUserAction' } },
        funcdefSignatures: { fpRequiredUserAction: 'bool()' },
        functionSignatures: { INSERT_ExpansionCd: 'uint32_t()' },
        variableNames: [],
        voidPointerFunctions: [],
        rootQualifiedTypedefs: ['fpRequiredUserAction'],
      },
    };
    const impl = generateImplementation(
      'D2Client/CharSel',
      [caller('CONTAINER_InitializeBuffer(0, 2, 100, INSERT_ExpansionCd);')],
      undefined, 'D2Client/CharSel.h', options, ctx, undefined, new Set<string>(),
    );
    assert.match(impl, /\(::fpRequiredUserAction\)\s*INSERT_ExpansionCd/);
  });

  it('does nothing without the tables', () => {
    const impl = generateImplementation(
      'D2Client/CharSel',
      [caller('CONTAINER_InitializeBuffer(0, 2, 100, STRING_ZeroOneWCHAR);')],
      undefined, 'D2Client/CharSel.h', options, {}, undefined, new Set<string>(),
    );
    assert.ok(
      !impl.includes('(CONTAINER_TypeInitialValue)'),
      `no tables means no decision to make — got:\n${impl}`,
    );
  });
});


/**
 * The same invariance rule in the other direction: a function address stored
 * into a slot typed `void*`. C++ has no implicit function-pointer-to-`void*`
 * conversion at all, so the original source carried the cast at every site.
 */
describe('function address stored in a void* slot', () => {
  const voidSlotContext = (): ImplGenContext => ({
    funcPtrArgCasts: {
      paramFuncdefs: { SUnit_IterateAllUnits: { 1: 'void*' } },
      funcdefSignatures: {},
      functionSignatures: {
        DATATBLS_LookupStringId: 'uint32_t(uint16_t *)',
        ITEM_RemoveFromOwnerInventory: 'void(D2UnitStrc *)',
      },
      variableNames: [],
      voidPointerFunctions: [],
      rootQualifiedTypedefs: [],
      voidPointerFields: ['fpLinker'],
    },
  });

  function emitVoidSlot(body: string): string {
    return generateImplementation(
      'D2Client/CharSel', [caller(body)], undefined, 'D2Client/CharSel.h',
      options, voidSlotContext(), undefined, new Set<string>(),
    );
  }

  it('casts a function assigned to a void* struct field', () => {
    const impl = emitVoidSlot('charstats[0x18].fpLinker = DATATBLS_LookupStringId;');
    assert.match(impl, /fpLinker = \(void\*\)DATATBLS_LookupStringId/, impl);
  });

  it('casts a function passed to a void* parameter', () => {
    const impl = emitVoidSlot('SUnit_IterateAllUnits(pGame, ITEM_RemoveFromOwnerInventory, 0);');
    assert.match(impl, /\(void\*\)ITEM_RemoveFromOwnerInventory/, impl);
  });

  it('leaves a field the model does not call void* alone', () => {
    const impl = emitVoidSlot('charstats[0x18].pOther = DATATBLS_LookupStringId;');
    assert.ok(!/pOther = \(void\*\)/.test(impl), impl);
  });

  it('leaves a non-function right-hand side alone', () => {
    const impl = emitVoidSlot('charstats[0x18].fpLinker = pSomething;');
    assert.ok(!/\(void\*\)pSomething/.test(impl), impl);
  });
});
