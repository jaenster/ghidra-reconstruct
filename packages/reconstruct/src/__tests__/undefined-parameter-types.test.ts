/**
 * An uncurated (`undefinedN`) parameter takes the type the decompiler resolved for it,
 * because the body was decompiled against that type.
 *
 * v1410: `DRLGROOMTILE_SetupWarpTile` @0066e260 stores `undefined4 dwParam2` and
 * decompiles `D2DrlgTileDataStrc *dwParam2` (5 "base operand of -> is not a pointer"
 * errors in RoomTile.cpp); `SOUNDSMP_LogVolumeToLinear` @00516570 stores
 * `undefined4 dwVolume` and decompiles `float dwVolume` - declared `uint32_t`, its
 * `(long double)dwVolume` reads the float's bits as an integer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateProject } from '../codegen/index.js';
import { withResolvedType } from '../extract/functions.js';
import type { ExtractedFunction, ReconstructOptions } from '../types.js';

const options: ReconstructOptions = {
  outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false,
  generateSourceMaps: false, transformPreset: 'quick', includeAddressComments: false,
  promoteStaticGlobals: false,
};

const LOGVOL = `
/* @function SOUNDSMP_LogVolumeToLinear */

float __stdcall D2Sound::Src::D2SoundSmp::SOUNDSMP_LogVolumeToLinear(float dwVolume,int nScale)

{
  return dwVolume * 2.0;
}
`;

function fn(params: ExtractedFunction['parameters'], decompiled = LOGVOL): ExtractedFunction {
  return {
    name: 'SOUNDSMP_LogVolumeToLinear', address: '00516570',
    signature: 'float SOUNDSMP_LogVolumeToLinear(undefined4 dwVolume, undefined4 nScale)',
    returnType: 'float', parameters: params,
    localVariables: [], callingConvention: '__stdcall', size: 23, isThunk: false,
    isExternal: false, hasVarArgs: false, namespace: 'D2Sound::Src::D2SoundSmp',
    decompiled, calledFunctions: [],
  } as ExtractedFunction;
}

function definition(f: ExtractedFunction): string {
  const project = generateProject('T', [f], [], [], [], [], options);
  const cpp = [...project.files.values()].find(x => x.path.endsWith('.cpp') && x.content.includes('SOUNDSMP_LogVolumeToLinear('));
  assert.ok(cpp, 'no file defines SOUNDSMP_LogVolumeToLinear');
  return cpp!.content.split('\n').find(l => /SOUNDSMP_LogVolumeToLinear\(.*\)\s*\{/.test(l)) ?? '';
}

describe('uncurated parameter types', () => {
  it('an undefined4 slot takes the decompiler type; an undefined4 the decompiler also typed int stays int', () => {
    const line = definition(fn([
      { name: 'dwVolume', dataType: 'undefined4', size: 4, ordinal: 0, storage: 'Stack[0x4]:4' },
      { name: 'nScale', dataType: 'undefined4', size: 4, ordinal: 1, storage: 'Stack[0x8]:4' },
    ]));
    assert.match(line, /SOUNDSMP_LogVolumeToLinear\(float dwVolume, int nScale\)/, line);
  });

  it('a curated field is left alone even when the decompiler disagrees', () => {
    const line = definition(fn([
      { name: 'dwVolume', dataType: 'uint', size: 4, ordinal: 0, storage: 'Stack[0x4]:4' },
      { name: 'nScale', dataType: 'undefined4', size: 4, ordinal: 1, storage: 'Stack[0x8]:4' },
    ]));
    assert.match(line, /SOUNDSMP_LogVolumeToLinear\(uint32_t dwVolume, int nScale\)/, line);
  });

  it('a resolved type of another size, or a prototype with another arity, changes nothing', () => {
    const wide = LOGVOL.replace('(float dwVolume,int nScale)', '(double dwVolume,int nScale)');
    assert.match(definition(fn([
      { name: 'dwVolume', dataType: 'undefined4', size: 4, ordinal: 0, storage: 'Stack[0x4]:4' },
      { name: 'nScale', dataType: 'undefined4', size: 4, ordinal: 1, storage: 'Stack[0x8]:4' },
    ], wide)), /SOUNDSMP_LogVolumeToLinear\(uint32_t dwVolume, int nScale\)/);
    const one = LOGVOL.replace('(float dwVolume,int nScale)', '(float dwVolume)');
    assert.match(definition(fn([
      { name: 'dwVolume', dataType: 'undefined4', size: 4, ordinal: 0, storage: 'Stack[0x4]:4' },
      { name: 'nScale', dataType: 'undefined4', size: 4, ordinal: 1, storage: 'Stack[0x8]:4' },
    ], one)), /SOUNDSMP_LogVolumeToLinear\(uint32_t dwVolume, uint32_t nScale\)/);
  });
});

describe('uncurated parameter types: an aggregate by value is not taken', () => {
  it('SMsgDispatchMessage @00420b00: the LPARAM the decompiler typed as the union it is stored into stays a word', () => {
    const body = LOGVOL.replace('(float dwVolume,int nScale)', '(D2UIMsgLParamUnion dwVolume,int nScale)');
    const union = { name: 'D2UIMsgLParamUnion', category: '/D2', size: 4, kind: 'UNION', fields: [
      { name: 'nLParam', dataType: 'int32_t', offset: 0, size: 4 },
    ] } as never;
    const f = fn([
      { name: 'dwVolume', dataType: 'undefined4', size: 4, ordinal: 0, storage: 'Stack[0x4]:4' },
      { name: 'nScale', dataType: 'undefined4', size: 4, ordinal: 1, storage: 'Stack[0x8]:4' },
    ], body);
    const project = generateProject('T', [f], [], [union], [], [], options);
    const cpp = [...project.files.values()].find(x => x.path.endsWith('.cpp') && x.content.includes('SOUNDSMP_LogVolumeToLinear('));
    const line = cpp!.content.split('\n').find(l => /SOUNDSMP_LogVolumeToLinear\(.*\)\s*\{/.test(l)) ?? '';
    assert.match(line, /SOUNDSMP_LogVolumeToLinear\(uint32_t dwVolume, int nScale\)/, line);
  });
});

describe('extraction: the daemon resolvedType key', () => {
  it('replaces an undefined placeholder and nothing else', () => {
    assert.strictEqual(withResolvedType('undefined4', 'D2DrlgTileDataStrc *'), 'D2DrlgTileDataStrc *');
    assert.strictEqual(withResolvedType('undefined1', 'char'), 'char');
    assert.strictEqual(withResolvedType('D2RoomExStrc *', 'int'), 'D2RoomExStrc *');
    assert.strictEqual(withResolvedType('undefined4', null), 'undefined4');
    assert.strictEqual(withResolvedType('undefined4 *', 'int *'), 'undefined4 *');
  });
});
