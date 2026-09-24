/**
 * A virtual call through a receiver whose declared type carries a typed vtable is
 * emitted through that table, with the slot's own signature - including the object
 * a `__thiscall` slot takes first, which Ghidra's untyped call drops. The tables
 * come from the model's types; the wiring test pins that the generator hands them,
 * and the body's own variable types, to the `vtable-calls` pass.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildVtableDispatch } from '../codegen/vtable-dispatch.js';
import { generateImplementation, type FuncPtrArgCastTables } from '../codegen/impl.js';
import type {
  ExtractedDataType, ExtractedFunction, ExtractedFunctionDefinition, ReconstructOptions,
} from '../types.js';

const fd = (name: string, callingConvention: string, params: string[], hasVarArgs = false): ExtractedFunctionDefinition => ({
  name,
  category: '/Owner',
  size: -1,
  kind: 'FUNCTION_DEFINITION',
  returnType: 'void',
  parameters: params.map((dataType, ordinal) => ({ name: `p${ordinal}`, dataType, ordinal })),
  callingConvention,
  hasVarArgs,
} as unknown as ExtractedFunctionDefinition);

const struct = (name: string, fields: Array<[string, string, number]>, category = '/'): ExtractedDataType => ({
  name,
  category,
  size: 4 * fields.length,
  kind: 'STRUCTURE',
  fields: fields.map(([n, dataType, offset]) => ({ name: n, dataType, offset, size: 4 })),
} as unknown as ExtractedDataType);

const funcDefs = [
  fd('FUN_004bf8c0', '__thiscall', ['ListBoxImplementation *', 'byte']),
  fd('FUN_004bee90', '__thiscall', ['ListBoxImplementation *']),
  fd('FUN_00604150', '__stdcall', ['void *']),
  fd('FUN_006044f0', '__thiscall', ['void *', 'int', 'int', 'uint']),
  fd('VARARGS_SLOT', '__cdecl', ['int'], true),
  fd('DUP', '__stdcall', []),
];
// The same funcdef name in a second category is no evidence about either.
const dupElsewhere = { ...fd('DUP', '__thiscall', ['void *']), category: '/Other' } as ExtractedFunctionDefinition;

const dataTypes: ExtractedDataType[] = [
  struct('ListBoxImplementationVtable', [
    ['ScalarDeletingDestructor', 'FUN_004bf8c0 *', 0],
    ['Draw', 'FUN_004bee90 *', 4],
    ['Varargs', 'VARARGS_SLOT *', 8],
    ['Ambiguous', 'DUP *', 12],
  ], '/ListBoxImplementation'),
  struct('ListBoxImplementation', [['pVtable', 'ListBoxImplementationVtable *', 0], ['nCount', 'int', 4]]),
  struct('PureVtable', [['__purecall', 'DUP *', 0], ['__purecall', 'DUP *', 4]]),
  struct('Pure', [['_vfptr', 'PureVtable *', 0]]),
  struct('CelListVtable', [['InternalDelete', 'FUN_00604150 *', 0], ['InternalNew', 'FUN_006044f0 *', 4]]),
  struct('TSHashTable_CELLIST', [['_vfptr', 'CelListVtable *', 0]]),
  struct('TSHashTableReuse_CELLIST', [['super_TSHashTable<struct_CELLIST>', 'TSHashTable_CELLIST', 0]]),
  struct('NotAClass', [['pNext', 'int *', 0]]),
  ...funcDefs as unknown as ExtractedDataType[],
];

describe('buildVtableDispatch', () => {
  const t = buildVtableDispatch(dataTypes, [...funcDefs, dupElsewhere]);

  it('finds the vtable pointer at offset 0 and reads each slot\'s arity and `this`', () => {
    assert.deepStrictEqual(t.classes.ListBoxImplementation, { vfptrPath: ['pVtable'], vtable: 'ListBoxImplementationVtable' });
    assert.deepStrictEqual(t.vtables.ListBoxImplementationVtable[0], { member: 'ScalarDeletingDestructor', arity: 2, takesThis: true });
    assert.deepStrictEqual(t.vtables.CelListVtable[0], { member: 'InternalDelete', arity: 1, takesThis: false });
  });

  it('reaches the vtable pointer through an embedded base at offset 0', () => {
    assert.deepStrictEqual(t.classes.TSHashTableReuse_CELLIST, {
      vfptrPath: ['super_TSHashTable<struct_CELLIST>', '_vfptr'], vtable: 'CelListVtable',
    });
  });

  it('spells a member the way the header emits it, and drops one it cannot tell', () => {
    const emitted = (dt: ExtractedDataType) => new Set(
      dt.name === 'TSHashTableReuse_CELLIST' ? ['super_TSHashTable_struct_CELLIST_'] : [],
    );
    const u = buildVtableDispatch(dataTypes, funcDefs, emitted);
    assert.deepStrictEqual(u.classes.TSHashTableReuse_CELLIST?.vfptrPath, ['super_TSHashTable_struct_CELLIST_', '_vfptr']);
    const none = buildVtableDispatch(dataTypes, funcDefs, (dt) => new Set(dt.name === 'ListBoxImplementation' ? ['nCount'] : []));
    assert.strictEqual(none.classes.ListBoxImplementation, undefined);
  });

  it('publishes no signature for a varargs slot, an ambiguous funcdef, or a repeated member name', () => {
    assert.strictEqual(t.vtables.ListBoxImplementationVtable[8], undefined);
    assert.strictEqual(t.vtables.ListBoxImplementationVtable[12], undefined);
    assert.deepStrictEqual(t.vtables.PureVtable, {});
  });

  it('is not fooled by a struct whose first field is an ordinary pointer', () => {
    assert.strictEqual(t.classes.NotAClass, undefined);
  });
});

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

const tables = (): FuncPtrArgCastTables => ({
  paramFuncdefs: {},
  funcdefSignatures: {},
  functionSignatures: {},
  variableNames: [],
  voidPointerFunctions: [],
  rootQualifiedTypedefs: [],
  globalTypes: { gpNpcMenuMercListBox: 'ListBoxImplementation *' },
  vtableDispatch: buildVtableDispatch(dataTypes, funcDefs),
});

function func(thisType: string, body: string): ExtractedFunction {
  return {
    name: 'CELCMP_RemoveAndDelete',
    address: '0x00602620',
    signature: `void CELCMP_RemoveAndDelete(${thisType} this, int32_t nEntry)`,
    returnType: 'void',
    parameters: [
      { name: 'this', dataType: thisType, size: 4, ordinal: 0, storage: 'ECX:4 (auto)' },
      { name: 'nEntry', dataType: 'int32_t', size: 4, ordinal: 1, storage: 'Stack[0x4]:4' },
    ],
    localVariables: [],
    callingConvention: '__thiscall',
    size: 31,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    decompiled: [`void __thiscall CELCMP_RemoveAndDelete(${thisType} this,int32_t nEntry)`, '{', body, '}'].join('\n'),
  } as unknown as ExtractedFunction;
}

const gen = (f: ExtractedFunction): string =>
  generateImplementation('CelCmp', [f], undefined, 'CelCmp.h', options, { funcPtrArgCasts: tables() } as any, undefined, new Set<string>());

const code = (impl: string) => impl.split('\n').filter(l => !l.trim().startsWith('//')).join('\n').replace(/\s+/g, '');

describe('the generator dispatches through a typed receiver', () => {
  it('a typed `this` calls its vtable slot, not an untyped code* that drops the object', () => {
    const impl = code(gen(func('TSHashTableReuse_CELLIST *', '  (**(code **)*(undefined4 *)this)(nEntry);')));
    assert.ok(impl.includes('pThis->super_TSHashTable<struct_CELLIST>._vfptr->InternalDelete(nEntry)'), impl);
    assert.ok(!impl.includes('(code**)'), impl);
  });

  it('a __thiscall slot gets its object back as the first argument', () => {
    const impl = code(gen(func('TSHashTableReuse_CELLIST *', '  (**(code **)(*(int *)this + 4))(nEntry,0,8);')));
    assert.ok(impl.includes('._vfptr->InternalNew(pThis,nEntry,0,8)'), impl);
  });

  it('a global receiver resolves from its declared type', () => {
    const impl = code(gen(func('void *', '  (**(code **)*gpNpcMenuMercListBox)(1);')));
    assert.ok(impl.includes('gpNpcMenuMercListBox->pVtable->ScalarDeletingDestructor(gpNpcMenuMercListBox,1)'), impl);
  });

  it('a `void *` receiver keeps the untyped call: the type is Ghidra\'s to give', () => {
    const impl = code(gen(func('void *', '  (**(code **)*(undefined4 *)this)(nEntry);')));
    assert.ok(impl.includes('(**(code**)(char*)*(void**)(uintptr_t)pThis)(nEntry)'), impl);
    assert.ok(!impl.includes('vmethod_'), impl);
  });
});
