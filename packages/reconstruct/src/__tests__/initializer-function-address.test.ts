/**
 * A function address in a pointer slot is a function, not a number.
 *
 * `Game/Launcher.cpp` carries
 *
 *   static void* PTR_fAPPMODE_launcher_ReturnAppMode_Caller_0070896c = (void*)0x004359d0;
 *
 * and 0x004359d0 is `D2Launch::MainMenus::fAPPMODE_launcher_ReturnAppMode_Caller`.
 * `AppModeLauncherInit` returns `&PTR_…`, `ApplicationRunCurrentMode`
 * double-dereferences it and calls through — so with the absolute 1.14d address
 * the call lands on unrelated code (we watched it enter
 * `ITEMMODE_FindBestBodyLocForItem` and fault writing into `.text`). With the
 * symbol, that call is the main menu. The launcher, multiplayer and client app
 * modes each have one.
 *
 * `initializerAddressBases` is built from globals and string constants; a
 * function address is a third kind and was in neither, so the slot kept its
 * literal. The table it resolves against here is `func-ptr-literal`'s own — the
 * same map that already does this job for a function address in a BODY, and it
 * already carries the namespace segments the reference has to be spelled with.
 *
 * THE TRAP, and the reason this is gated: the tree carries the Mac build's data
 * symbols alongside the Windows ones, and the two address spaces OVERLAP.
 *
 *   globals.cpp:      void* PTR_DAT_00396304 = (void*)0x005cc240;
 *   globals.D2Client: void* PTR_DAT_00396178 = (void*)0x005c6910;
 *
 * Both values collide exactly with Windows function addresses, and both are Mac
 * pointers holding Mac addresses. Of the five sites in the tree whose value hits
 * a Windows function, two are these — a 40% false-positive rate for a rule that
 * looks only at the value. What separates them is the CONTAINING object: 0x396304
 * is below the Windows image base, so it is not a Windows image pointer and what
 * it holds is not a Windows address. Only an owner in the same image resolves.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  emitDataValue,
  generateStaticLocalDeclaration,
  setGlobalInitializerTypes,
  setInitializerAddressTable,
  setInitializerFunctionAddresses,
  setInitializerOwnerAddress,
  setInitializerSignatureTables,
  setMultidimArrayGlobals,
} from '../codegen/globals-header.js';
import { buildFuncPtrArgCastTables, buildGlobalAddressExtentTables } from '../codegen/index.js';
import type {
  AnalyzedDataSymbol, DataValue, ExtractedFunction, ExtractedString,
} from '../types.js';

function fn(name: string, namespace: string, address: string): ExtractedFunction {
  return {
    name, namespace, address,
    signature: '', returnType: 'int32_t',
    parameters: [{ name: 'pD2IniData', dataType: 'D2IniConfigStrc *', ordinal: 0 }],
    localVariables: [], callingConvention: '__fastcall', size: 0x40,
    isThunk: false, isExternal: false, hasVarArgs: false,
  } as unknown as ExtractedFunction;
}

const LAUNCHER_CALLER = fn(
  'fAPPMODE_launcher_ReturnAppMode_Caller', 'D2Launch::MainMenus', '004359d0');
const ROOT_CALLER = fn('WinMain_Trampoline', '', '00442150');
const FUNCTIONS = [LAUNCHER_CALLER, ROOT_CALLER];

/** One string constant and one data global, so the older resolutions stay observable. */
const STRINGS = [
  { address: '006cc8b8', value: 'Diablo II', length: 9, encoding: 'string', xrefCount: 1 },
] as ExtractedString[];

const GLOBALS = [
  { name: 'gnFrameCount', address: '006fb0a4', size: 4, dataType: 'int', scope: 'global' },
] as unknown as AnalyzedDataSymbol[];

/** Address of the object being initialised: the Windows `PTR_…` static local. */
const WINDOWS_OWNER = '0070896c';
/** The Mac pointer whose stored value collides with a Windows function. */
const MAC_OWNER = '00396304';

function install(): void {
  setMultidimArrayGlobals([]);
  setGlobalInitializerTypes(undefined);
  const casts = buildFuncPtrArgCastTables(FUNCTIONS, GLOBALS, [], [], STRINGS);
  setInitializerSignatureTables(casts.functionSignatures, casts.funcdefSignatures);
  const addresses = buildGlobalAddressExtentTables(GLOBALS, STRINGS);
  setInitializerAddressTable({
    globalAddresses: addresses.globalAddresses,
    stringConstantNames: addresses.stringConstantNames,
    referenceableNames: new Set([...addresses.stringConstantNames, 'gnFrameCount']),
    imageBase: '0x400000',
  });
  setInitializerFunctionAddresses(new Map([
    [0x004359d0n, {
      name: 'fAPPMODE_launcher_ReturnAppMode_Caller',
      namespaceSegments: ['D2Launch', 'MainMenus'],
    }],
    [0x00442150n, { name: 'WinMain_Trampoline', namespaceSegments: [] }],
  ]));
  setInitializerOwnerAddress(WINDOWS_OWNER);
}

const pointer = (v: string): DataValue => ({ kind: 'pointer', value: v });
const scalar = (v: string): DataValue => ({ kind: 'scalar', value: v });

describe('a function address in an initializer slot', () => {
  beforeEach(install);

  it('names the function the app-mode dispatcher will call', () => {
    assert.strictEqual(
      emitDataValue(pointer('0x004359d0'), 0, 'void*'),
      '(void*)&D2Launch::MainMenus::fAPPMODE_launcher_ReturnAppMode_Caller',
    );
  });

  it('emits the whole static-local line the way Launcher.cpp needs it', () => {
    const symbol = {
      name: 'PTR_fAPPMODE_launcher_ReturnAppMode_Caller_0070896c',
      address: WINDOWS_OWNER, size: 4, dataType: 'void*', suggestedType: 'void*',
      scope: 'static-local', ownerFunction: 'AppModeLauncherInit',
      isInitialized: true, value: '004359d0',
    } as unknown as AnalyzedDataSymbol;
    assert.strictEqual(
      generateStaticLocalDeclaration(symbol),
      'static void* PTR_fAPPMODE_launcher_ReturnAppMode_Caller_0070896c'
        + ' = (void*)&D2Launch::MainMenus::fAPPMODE_launcher_ReturnAppMode_Caller;',
    );
  });

  it('leaves a root-scope function unqualified', () => {
    assert.strictEqual(
      emitDataValue(pointer('0x00442150'), 0, 'void*'),
      '(void*)&WinMain_Trampoline',
    );
  });

  it('refuses a value whose OWNER lives in the other image', () => {
    // `PTR_DAT_00396304` is Mac data holding a Mac address that happens to equal
    // a Windows function's. The owner is below the Windows image base, so the
    // collision is a coincidence and the literal stands.
    setInitializerOwnerAddress(MAC_OWNER);
    const out = emitDataValue(pointer('0x004359d0'), 0, 'void*');
    assert.ok(out.includes('0x004359d0'), `the cross-image literal must stand: ${out}`);
    assert.ok(!out.includes('fAPPMODE'), `and must name no function: ${out}`);
  });

  it('refuses when no owner is known at all', () => {
    // Fail-safe: an emit path that never declared whose object it is renders
    // exactly what it rendered before.
    setInitializerOwnerAddress(undefined);
    const out = emitDataValue(pointer('0x004359d0'), 0, 'void*');
    assert.ok(out.includes('0x004359d0'), `got: ${out}`);
  });

  it('still resolves a string and a data global, unchanged', () => {
    assert.strictEqual(emitDataValue(pointer('0x006cc8b8'), 0, 'char *'), 's_Diablo_II_006cc8b8');
    assert.strictEqual(emitDataValue(pointer('0x006fb0a4'), 0, 'int *'), '(int *)&gnFrameCount');
  });

  it('keeps a null slot null', () => {
    assert.strictEqual(emitDataValue(pointer('0x00000000'), 0, 'void*'), 'nullptr');
  });

  it('resolves a dispatch TABLE of function addresses', () => {
    // Elements arriving as scalars go through the aggregate rule, which a table
    // of two satisfies on its own terms.
    const table: DataValue = {
      kind: 'array',
      elements: [scalar('0x004359d0'), scalar('0x00442150')],
    };
    const out = emitDataValue(table, 0, 'void*[2]');
    assert.ok(out.includes('&D2Launch::MainMenus::fAPPMODE_launcher_ReturnAppMode_Caller'), out);
    assert.ok(out.includes('&WinMain_Trampoline'), out);
    assert.ok(!out.includes('0x004359d0'), `no absolute address may survive: ${out}`);
  });

  it('leaves an INTEGER slot\'s lone scalar to the aggregate rule', () => {
    assert.strictEqual(emitDataValue(scalar('0x4359d0'), 0, 'uint'), '0x4359d0');
  });
});
