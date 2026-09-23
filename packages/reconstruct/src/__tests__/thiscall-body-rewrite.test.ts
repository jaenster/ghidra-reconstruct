/**
 * Ghidra spells the hidden ECX argument of a `__thiscall` function `this`, and
 * hands out `nullptr` where the declared type is an integer. Both used to be
 * fixed by substituting over the emitted body text, which cannot tell code from
 * a comment or a string. They are now decided on the AST — this test pins the
 * wiring: the generator has to tell the body transform the name the signature
 * gave that argument, and whether the return type is a pointer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateImplementation } from '../codegen/impl.js';
import type { ExtractedFunction, ReconstructOptions } from '../types.js';

const options: ReconstructOptions = {
  outputDir: '/tmp/test',
  format: 'cpp',
  organization: 'flat',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
  promoteStaticGlobals: false,
};

function func(overrides: Partial<ExtractedFunction>): ExtractedFunction {
  return {
    name: 'UNIT_GetOwner',
    address: '0x00401070',
    signature: 'int32_t UNIT_GetOwner(void * this)',
    returnType: 'int32_t',
    parameters: [{ name: 'this', dataType: 'void *', size: 4, ordinal: 0 }],
    localVariables: [],
    callingConvention: '__thiscall',
    size: 64,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    ...overrides,
  } as ExtractedFunction;
}

const gen = (f: ExtractedFunction): string =>
  generateImplementation('Unit', [f], undefined, 'Unit.h', options, {}, undefined, new Set<string>());

describe('thiscall body rewrites reach the AST passes', () => {
  it('renames the `this` expression to the parameter the signature declares', () => {
    const impl = gen(func({
      decompiled: [
        'int32_t UNIT_GetOwner(void *this)',
        '{',
        '  return *(int32_t *)((int)this + 0x14);',
        '}',
      ].join('\n'),
    }));

    assert.ok(/pThis\b/.test(impl), `expected the renamed parameter — got:\n${impl}`);
    assert.ok(
      !/(?<![\w>])this(?![\w])/.test(impl.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')),
      `no bare \`this\` may survive in code — got:\n${impl}`,
    );
  });

  it('does NOT rename `this` inside a string literal in the body', () => {
    const impl = gen(func({
      decompiled: [
        'int32_t UNIT_GetOwner(void *this)',
        '{',
        '  FOG_Trace("this unit has no owner");',
        '  return 0;',
        '}',
      ].join('\n'),
    }));

    assert.ok(
      impl.includes('"this unit has no owner"'),
      `the message string must be untouched — got:\n${impl}`,
    );
  });

  it('uses the first parameter when Ghidra did not name one `this`', () => {
    const impl = gen(func({
      signature: 'int32_t UNIT_GetOwner(D2UnitStrc * pUnit)',
      parameters: [{ name: 'pUnit', dataType: 'D2UnitStrc *', size: 4, ordinal: 0 }],
      decompiled: [
        'int32_t UNIT_GetOwner(D2UnitStrc *pUnit)',
        '{',
        '  return *(int32_t *)((int)this + 0x14);',
        '}',
      ].join('\n'),
    }));

    assert.ok(/pUnit \+ 0x14/.test(impl), `expected the first parameter — got:\n${impl}`);
  });

  it('turns `return nullptr` into `return 0` for a non-pointer return type', () => {
    const impl = gen(func({
      returnType: 'int32_t',
      decompiled: [
        'int32_t UNIT_GetOwner(void *this)',
        '{',
        '  return nullptr;',
        '}',
      ].join('\n'),
    }));

    assert.ok(/return 0;/.test(impl), `expected return 0 — got:\n${impl}`);
  });

  it('leaves `return nullptr` alone for a pointer return type', () => {
    const impl = gen(func({
      returnType: 'D2UnitStrc *',
      signature: 'D2UnitStrc * UNIT_GetOwner(void * this)',
      decompiled: [
        'D2UnitStrc * UNIT_GetOwner(void *this)',
        '{',
        '  return nullptr;',
        '}',
      ].join('\n'),
    }));

    assert.ok(/return nullptr;/.test(impl), `expected return nullptr — got:\n${impl}`);
  });

  it('drops the spurious & on a Ghidra _ARRAY_ global but keeps it on an element', () => {
    const impl = gen(func({
      decompiled: [
        'int32_t UNIT_GetOwner(void *this)',
        '{',
        '  SOUND_Play(&eD2Sounds_ARRAY_00728cc8);',
        '  SOUND_Play(&eD2Sounds_ARRAY_00728cc8[2]);',
        '  return 0;',
        '}',
      ].join('\n'),
    }));

    assert.ok(
      /SOUND_Play\(eD2Sounds_ARRAY_00728cc8\)/.test(impl),
      `expected the & dropped on the whole array — got:\n${impl}`,
    );
    assert.ok(
      /SOUND_Play\(&eD2Sounds_ARRAY_00728cc8\[2\]\)/.test(impl),
      `expected the & kept on the element address — got:\n${impl}`,
    );
  });
});

describe('signature-driven parameter renames reach the body through the rename map', () => {
  it('renumbers Ghidra mixed-convention param_N_NN names to match the signature', () => {
    const impl = gen(func({
      name: 'ITEMS_Apply',
      signature: 'int32_t ITEMS_Apply(int32_t param_1_2, int32_t param_2)',
      returnType: 'int32_t',
      parameters: [
        { name: 'param_1_2', dataType: 'int32_t', size: 4, ordinal: 0 },
        { name: 'param_2', dataType: 'int32_t', size: 4, ordinal: 1 },
      ] as ExtractedFunction['parameters'],
      decompiled: [
        'int32_t ITEMS_Apply(int32_t param_1_2, int32_t param_2)',
        '{',
        '  return param_1_2 + param_2;',
        '}',
      ].join('\n'),
    }));

    assert.ok(!/param_1_2/.test(impl), `param_1_2 must be renumbered — got:\n${impl}`);
    assert.ok(/param_1 \+ param_2/.test(impl), `expected param_1 + param_2 — got:\n${impl}`);
  });

  it('renames a parameter that shadows its own type', () => {
    const impl = gen(func({
      name: 'LEVEL_Init',
      signature: 'int32_t LEVEL_Init(fpLevelDataFn1 fpLevelDataFn1)',
      returnType: 'int32_t',
      parameters: [
        { name: 'fpLevelDataFn1', dataType: 'fpLevelDataFn1', size: 4, ordinal: 0 },
      ] as ExtractedFunction['parameters'],
      decompiled: [
        'int32_t LEVEL_Init(fpLevelDataFn1 fpLevelDataFn1)',
        '{',
        '  return (int)fpLevelDataFn1;',
        '}',
      ].join('\n'),
    }));

    assert.ok(/nfpLevelDataFn1/.test(impl), `expected the n-prefixed name — got:\n${impl}`);
  });

  it('does not rename the same word inside a string literal', () => {
    const impl = gen(func({
      name: 'ITEMS_Apply',
      signature: 'int32_t ITEMS_Apply(int32_t param_1_2)',
      returnType: 'int32_t',
      parameters: [
        { name: 'param_1_2', dataType: 'int32_t', size: 4, ordinal: 0 },
      ] as ExtractedFunction['parameters'],
      decompiled: [
        'int32_t ITEMS_Apply(int32_t param_1_2)',
        '{',
        '  FOG_Trace("param_1_2 out of range");',
        '  return param_1_2;',
        '}',
      ].join('\n'),
    }));

    assert.ok(
      impl.includes('"param_1_2 out of range"'),
      `the message string must be untouched — got:\n${impl}`,
    );
  });

  it('casts a returned `void *this` to the typed-pointer return type (UNICODE_FindWideChar 00526670)', () => {
    const impl = gen(func({
      name: 'UNICODE_FindWideChar',
      signature: 'short * UNICODE_FindWideChar(void * this, int16_t wCharToFind)',
      returnType: 'short *',
      parameters: [
        { name: 'this', dataType: 'void *', size: 4, ordinal: 0 },
        { name: 'wCharToFind', dataType: 'int16_t', size: 2, ordinal: 1 },
      ] as ExtractedFunction['parameters'],
      decompiled: [
        'short * __thiscall UNICODE_FindWideChar(void *this,int16_t wCharToFind)',
        '{',
        '  if (*(short *)this == 0) {',
        '    return (short *)0x0;',
        '  }',
        '  return this;',
        '}',
      ].join('\n'),
    }));
    assert.match(impl, /return \(short\s*(int)?\s*\*\)pThis;/, `expected the cast — got:\n${impl}`);
    assert.ok(!/\bself\b/.test(impl), `the preprocessor's \`self\` must not reach the tree — got:\n${impl}`);
  });

  it('calls a vtable slot through a free function\'s `this` indirectly, not as ->vmethod_N (00602620)', () => {
    const impl = gen(func({
      name: 'CELCMP_CelDataHash_RemoveAndCallbackSingle',
      signature: 'void CELCMP_CelDataHash_RemoveAndCallbackSingle(void * this, int32_t nEntry)',
      returnType: 'void',
      parameters: [
        { name: 'this', dataType: 'void *', size: 4, ordinal: 0 },
        { name: 'nEntry', dataType: 'int32_t', size: 4, ordinal: 1 },
      ] as ExtractedFunction['parameters'],
      decompiled: [
        'void __thiscall CELCMP_CelDataHash_RemoveAndCallbackSingle(void *this,int32_t nEntry)',
        '{',
        '  (*(code *)**(undefined4 **)this)(nEntry);',
        '  return;',
        '}',
      ].join('\n'),
    }));
    assert.ok(!/->vmethod_/.test(impl), `void* has no members — got:\n${impl}`);
    assert.ok(impl.replace(/\s+/g, '').includes('(**(code**)(char*)*(void**)(uintptr_t)pThis)(nEntry)'),
      `expected the faithful indirect call — got:\n${impl}`);
  });
});

