/**
 * A retyped global must re-emit the unit that DEFINES it, not only the units that
 * use it.
 *
 * v1852 -> v1855: gnSoundFrequency_22kHz and gnSoundQuality_Low (file-local statics
 * of D2Sound::Src::D2SoundSmp) went int/long long -> float. Their users carry a
 * dependency edge to the name; the defining unit carries none - it lists the
 * address in `globalAddresses` - so the selection skipped it and the tree kept
 * `static int gnSoundFrequency_22kHz = 0x40000000;`.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { selectDirtyUnits, computeHashCache } from '../dirty-units.js';
import type { AnalyzedDataSymbol, ExtractedDataType, ExtractedFunction } from '@ghidra-mcp/reconstruct';

const fn = (address: string, name: string): ExtractedFunction =>
  ({ address, name, signature: `void ${name}(void)`, returnType: 'void', parameters: [], decompiled: `void ${name}(void) {}` } as unknown as ExtractedFunction);

const global = (dataType: string, value: string): AnalyzedDataSymbol => ({
  name: 'gnSoundFrequency_22kHz', address: '006deb0c', dataType, size: 4, value,
  isInitialized: true, scope: 'file-local', suggestedType: dataType,
  referencingFunctions: ['D2Sound::Src::D2SoundSmp::SOUNDSMP_Reset'],
} as unknown as AnalyzedDataSymbol);

const buildInfo = {
  symbolIndex: {},
  symbolHashes: { x: 'x' },
  modules: [
    {
      id: 'D2Sound/Src/D2SoundSmp.h', implPath: 'D2Sound/Src/D2SoundSmp.cpp', unitName: 'D2Sound::Src::D2SoundSmp',
      functionNames: ['SOUNDSMP_Reset'], ownedTypeNames: [], globalAddresses: ['006deb0c'], deps: [],
    },
    {
      id: 'D2Sound/Src/Other.h', implPath: 'D2Sound/Src/Other.cpp', unitName: 'D2Sound::Src::Other',
      functionNames: ['OTHER_Run'], ownedTypeNames: [], globalAddresses: [], deps: [],
    },
    {
      id: 'D2Sound/Src/User.h', implPath: 'D2Sound/Src/User.cpp', unitName: 'D2Sound::Src::User',
      functionNames: ['USER_Run'], ownedTypeNames: [], globalAddresses: [],
      deps: [{ symbol: 'gnSoundFrequency_22kHz', strength: 'type-ref' }],
    },
  ],
};

const functions = [fn('00500000', 'SOUNDSMP_Reset'), fn('00500100', 'OTHER_Run'), fn('00500200', 'USER_Run')];
const dataTypes: ExtractedDataType[] = [];

test('a retyped global re-emits the unit that defines it, and its users', () => {
  const previous = computeHashCache({ functions, dataTypes, globals: [global('int', '0x40000000')] });
  const r = selectDirtyUnits({
    buildInfo, previous, identCacheEmpty: false, functions, dataTypes, globals: [global('float', '2')],
  });
  assert.deepStrictEqual(r.units, ['D2Sound::Src::D2SoundSmp', 'D2Sound::Src::User']);
});

test('a global that disappears re-emits the unit that defined it', () => {
  const previous = computeHashCache({ functions, dataTypes, globals: [global('int', '0x40000000')] });
  const r = selectDirtyUnits({ buildInfo, previous, identCacheEmpty: false, functions, dataTypes, globals: [] });
  assert.ok(r.units?.includes('D2Sound::Src::D2SoundSmp'), `got ${JSON.stringify(r.units)}`);
});

test('an unchanged global dirties nothing', () => {
  const globals = [global('float', '2')];
  const previous = computeHashCache({ functions, dataTypes, globals });
  const r = selectDirtyUnits({ buildInfo, previous, identCacheEmpty: false, functions, dataTypes, globals });
  assert.deepStrictEqual(r.units, []);
});
