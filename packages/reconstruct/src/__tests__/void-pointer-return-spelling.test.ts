/**
 * A `void*`-returning call filling a typed-pointer slot, when the model spells
 * that return with one of the SDK's ALIASES rather than `void *`.
 *
 * Ghidra records `CRT_CreateTLS` as returning `LPVOID`, and the header emits it
 * that way — `LPVOID __stdcall CRT_CreateTLS();`. The cast-insertion tables
 * compared the spelling against the two literal forms `void *` / `void*`, so an
 * alias missed, and worse: the miss put the name in the AMBIGUOUS set, which
 * deletes it even when a platform stub had already vouched for it. The result is
 * the error the C++ compiler gives and the C one never did:
 *
 *   compiler/compiler.cpp:214: invalid conversion from 'LPVOID' {aka 'void*'}
 *                              to 'int (*)(...)'
 *
 * A return type that carries NO information is a separate case: Ghidra's
 * `undefined*` family means "never curated", and a second record of the same
 * name carrying one is a silence, not a contradiction — letting it veto drops
 * the curated answer the first record gave.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { buildFuncPtrArgCastTables } from '../codegen/index.js';
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

function fn(over: Partial<ExtractedFunction> & { name: string }): ExtractedFunction {
  return {
    address: '0x00688c4f',
    signature: `${over.returnType ?? 'void'} ${over.name}(void)`,
    returnType: 'void',
    parameters: [],
    localVariables: [],
    callingConvention: '__stdcall',
    size: 16,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    decompiled: '',
    ...over,
  } as ExtractedFunction;
}

function tables(functions: ExtractedFunction[]) {
  return buildFuncPtrArgCastTables(functions, [], [], []);
}

describe('a model return type spelled with a void-pointer alias', () => {
  it('counts LPVOID as a void* return', () => {
    const t = tables([fn({ name: 'CRT_CreateTLS', returnType: 'LPVOID' })]);
    assert.ok(
      t.voidPointerFunctions.includes('CRT_CreateTLS'),
      `LPVOID is void* — got ${JSON.stringify(t.voidPointerFunctions)}`,
    );
  });

  it('counts PVOID and Ghidra’s own `pointer` alias too', () => {
    const t = tables([
      fn({ name: 'GetSlot', returnType: 'PVOID' }),
      fn({ name: 'GetBlock', returnType: 'pointer' }),
    ]);
    assert.ok(t.voidPointerFunctions.includes('GetSlot'), 'PVOID');
    assert.ok(t.voidPointerFunctions.includes('GetBlock'), 'pointer');
  });

  it('does not let an alias spelling erase a platform name of the same shape', () => {
    const t = tables([fn({ name: 'GlobalLock', returnType: 'LPVOID' })]);
    assert.ok(t.voidPointerFunctions.includes('GlobalLock'));
  });

  it('keeps a curated void* answer when a same-named record has none', () => {
    const t = tables([
      fn({ name: '__calloc_crt', returnType: 'void *' }),
      fn({ name: '__calloc_crt', returnType: 'undefined4', address: '0x0068fdcc' }),
    ]);
    assert.ok(
      t.voidPointerFunctions.includes('__calloc_crt'),
      '`undefined4` is Ghidra saying nothing, not saying "not void*"',
    );
  });

  it('still drops a name two records genuinely disagree about', () => {
    const t = tables([
      fn({ name: 'Alloc', returnType: 'void *' }),
      fn({ name: 'Alloc', returnType: 'int', address: '0x00401000' }),
    ]);
    assert.ok(!t.voidPointerFunctions.includes('Alloc'));
  });
});

describe('the cast that alias reaches', () => {
  const caller = (body: string[]): ExtractedFunction => fn({
    name: 'CRT_GetThreadData',
    address: '0x00688d96',
    returnType: 'DWORD *',
    decompiled: ['DWORD * CRT_GetThreadData(void)', '{', ...body, '}'].join('\n'),
  });

  function emit(body: string[], callees: ExtractedFunction[]): string {
    const context: ImplGenContext = { funcPtrArgCasts: tables(callees) };
    return generateImplementation(
      'compiler/compiler', [caller(body)], undefined, 'compiler/compiler.h',
      options, context, undefined, new Set<string>(),
    );
  }

  const createTLS = fn({ name: 'CRT_CreateTLS', returnType: 'LPVOID' });

  it('casts into a FUNCTION-pointer destination', () => {
    const impl = emit(
      ['  code *pcVar1;', '  pcVar1 = CRT_CreateTLS();', '  return (DWORD *)pcVar1;'],
      [createTLS],
    );
    assert.match(impl, /pcVar1 = \(code\s*\*\)\s*CRT_CreateTLS/);
  });

  it('casts a declaration initializer', () => {
    const impl = emit(
      ['  D2UnitDataItemStrc *p = CRT_CreateTLS();', '  return (DWORD *)p;'],
      [createTLS],
    );
    assert.match(impl, /p = \(D2UnitDataItemStrc\s*\*\)\s*CRT_CreateTLS/);
  });

  it('casts a return statement', () => {
    const impl = emit(['  return CRT_CreateTLS();'], [createTLS]);
    assert.match(impl, /return \(DWORD\s*\*\)\s*CRT_CreateTLS/);
  });

  it('leaves a void* destination alone', () => {
    const impl = emit(
      ['  void *p = CRT_CreateTLS();', '  return (DWORD *)p;'],
      [createTLS],
    );
    assert.ok(!/\(void\s*\*\)\s*CRT_CreateTLS/.test(impl), impl);
  });
});
