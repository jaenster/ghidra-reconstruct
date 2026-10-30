/**
 * Selecting one member of a shared qualified name by the address the code takes.
 *
 * Ghidra v1775 files both `BOOL Draw(D2WinImage *)` (004fd1f0) and
 * `BOOL Draw(D2WinImageEx *)` (004fd470) under `D2Win::Src::D2WinImage`. Every
 * name-keyed table drops `D2Win::Src::D2WinImage::Draw` as ambiguous and the
 * decompile spells both identically, so `fpDraw = D2Win::Src::D2WinImage::Draw;`
 * came out uncast: an overload set with no exact target type, two strict errors.
 * The instruction that stores it holds the address (operand-refs `C` rows), and a
 * data initializer holds it outright; either says which member is meant.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import { buildFuncPtrArgCastTables } from '../codegen/index.js';
import { pinnedOverloadTables } from '../codegen/impl.js';
import { parseOperandRefs } from '../extract/operand-refs.js';
import {
  emitDataValue,
  renderGlobalScalarInitializer,
  setGlobalInitializerTypes,
  setInitializerAddressTable,
  setInitializerFunctionAddresses,
  setInitializerOwnerAddress,
  setInitializerSignatureTables,
  setKnownFuncDefTypedefs,
  setMultidimArrayGlobals,
} from '../codegen/globals-header.js';
import type {
  DataValue, ExtractedDataType, ExtractedFunction, ExtractedFunctionDefinition,
} from '../types.js';

function fn(
  name: string, namespace: string, address: string, paramType: string, extra: Partial<ExtractedFunction> = {},
): ExtractedFunction {
  return {
    name, namespace, address,
    signature: '', returnType: 'BOOL',
    parameters: [{ name: 'pControl', dataType: paramType, ordinal: 0, storage: 'ECX:4' }],
    localVariables: [], callingConvention: '__fastcall', size: 0x40,
    isThunk: false, isExternal: false, hasVarArgs: false,
    ...extra,
  } as unknown as ExtractedFunction;
}

const IMAGE_DRAW = fn('Draw', 'D2Win::Src::D2WinImage', '004fd1f0', 'D2WinImage *');
const IMAGE_EX_DRAW = fn('Draw', 'D2Win::Src::D2WinImage', '004fd470', 'D2WinImageEx *');
// A thunk carries its target's name; it is no second member.
const FREE_REALMS = fn('MAINMENU_FreeRealmList', 'D2Launch::MainMenus', '00430a20', 'int');
const FREE_REALMS_THUNK = fn('MAINMENU_FreeRealmList', 'D2Launch::MainMenus', '00437a60', 'int', { isThunk: true });
// Two copies with one parameter list are a redefinition, not an overload set.
const WRITE_CHAR_A = fn('write_char', 'Crt', '0068b4d7', 'char');
const WRITE_CHAR_B = fn('write_char', 'Crt', '00695fc3', 'char');
const FUNCTIONS = [IMAGE_DRAW, IMAGE_EX_DRAW, FREE_REALMS, FREE_REALMS_THUNK, WRITE_CHAR_A, WRITE_CHAR_B];

const DRAW_FUNCDEF = {
  name: 'Draw', kind: 'FUNCTION_DEFINITION', returnType: 'BOOL', callingConvention: '__fastcall',
  parameters: [{ name: 'pControl', dataType: 'D2ControlStrc *', ordinal: 0 }],
} as unknown as ExtractedFunctionDefinition;

const tables = () => buildFuncPtrArgCastTables(
  FUNCTIONS, [], [DRAW_FUNCDEF], [DRAW_FUNCDEF as unknown as ExtractedDataType], []);

describe('the members of a shared qualified name', () => {
  it('are kept by address, with each one\'s own entries', () => {
    const t = tables();
    const image = t.pinnableOverloads?.['004fd1f0'];
    const imageEx = t.pinnableOverloads?.['004fd470'];
    assert.ok(image && imageEx, JSON.stringify(t.pinnableOverloads));
    assert.ok(image.keys.includes('D2Win::Src::D2WinImage::Draw'));
    assert.deepStrictEqual(image.paramTypes, ['D2WinImage *']);
    assert.deepStrictEqual(imageEx.paramTypes, ['D2WinImageEx *']);
    assert.strictEqual(image.convention, '__fastcall');
    // Program-wide the name stays ambiguous.
    assert.strictEqual(t.functionSignatures['D2Win::Src::D2WinImage::Draw'], undefined);
    assert.ok(t.overloadedFunctionNames?.includes('Draw'));
  });

  it('leave out a thunk and a same-parameter redefinition', () => {
    const t = tables();
    assert.strictEqual(t.pinnableOverloads?.['00430a20'], undefined);
    assert.strictEqual(t.pinnableOverloads?.['0068b4d7'], undefined);
    assert.ok(!t.overloadedFunctionNames?.includes('MAINMENU_FreeRealmList'));
  });
});

describe('a body that takes one member\'s address', () => {
  // D2WinImage's constructor (004fd6c0) stores 004fd1f0 into fpDraw.
  const refs = parseOperandRefs('F\t004fd6c0\nC\t004fd72d\t1\t004fd1f0\nC\t004fd737\t1\t004fd5d0\n')
    .get('004fd6c0')!.functions!;

  it('parses the C rows', () => {
    assert.deepStrictEqual(refs[0], { ins: '004fd72d', op: 1, to: '004fd1f0' });
  });

  it('gets that member under the shared name', () => {
    const pinned = pinnedOverloadTables(tables(), refs)!;
    assert.ok(pinned);
    assert.strictEqual(pinned.functionSignatures['D2Win::Src::D2WinImage::Draw'], 'BOOL(D2WinImage *)');
    assert.deepStrictEqual(pinned.functionParamTypes?.['D2Win::Src::D2WinImage::Draw'], ['D2WinImage *']);
    assert.deepStrictEqual(pinned.pinnedFunctions?.['D2Win::Src::D2WinImage::Draw'], {
      returnType: 'BOOL', paramTypes: ['D2WinImage *'], convention: '__fastcall',
    });
  });

  it('gets nothing when it takes no member, or both', () => {
    assert.strictEqual(pinnedOverloadTables(tables(), [{ to: '004fd5d0' }]), undefined);
    assert.strictEqual(pinnedOverloadTables(tables(), undefined), undefined);
    assert.strictEqual(pinnedOverloadTables(tables(), [{ to: '004fd1f0' }, { to: '004fd470' }]), undefined);
  });
});

describe('a global initializer holding a member\'s address', () => {
  beforeEach(() => {
    setMultidimArrayGlobals([]);
    setGlobalInitializerTypes(undefined);
    setKnownFuncDefTypedefs(['Draw']);
    const t = tables();
    setInitializerSignatureTables(
      t.functionSignatures, t.funcdefSignatures, t.functionConventions, t.funcdefConventionKeywords,
      t.pinnableOverloads);
    setInitializerAddressTable({ globalAddresses: {}, stringConstantNames: [], referenceableNames: new Set(), imageBase: '0x400000' });
    setInitializerFunctionAddresses(new Map([
      [0x004fd1f0n, { name: 'Draw', namespaceSegments: ['D2Win', 'Src', 'D2WinImage'] }],
      [0x004fd470n, { name: 'Draw', namespaceSegments: ['D2Win', 'Src', 'D2WinImage'] }],
    ]));
    setInitializerOwnerAddress('006ce2f0');
  });

  it('selects the member in a funcdef slot, then casts to the slot', () => {
    assert.strictEqual(
      renderGlobalScalarInitializer('004fd470', 'Draw *'),
      '(Draw)(BOOL (__fastcall *)(D2WinImageEx *))&D2Win::Src::D2WinImage::Draw',
    );
  });

  it('selects each member of a dispatch table', () => {
    const scalar = (v: string): DataValue => ({ kind: 'scalar', value: v });
    const out = emitDataValue({ kind: 'array', elements: [scalar('0x004fd1f0'), scalar('0x004fd470')] }, 0, 'void*[2]');
    assert.ok(out.includes('(void*)(BOOL (__fastcall *)(D2WinImage *))&D2Win::Src::D2WinImage::Draw'), out);
    assert.ok(out.includes('(void*)(BOOL (__fastcall *)(D2WinImageEx *))&D2Win::Src::D2WinImage::Draw'), out);
  });
});
