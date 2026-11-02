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

/**
 * The value alone. `hashGlobal` covered name, type, address and scope, so bytes
 * that changed in Ghidra under the same type changed no hash and re-emitted
 * nothing: the definition kept its old initializer.
 */
const withValue = (value: string): AnalyzedDataSymbol => ({
  ...global('int', value),
  initializedData: { kind: 'scalar', value },
} as unknown as AnalyzedDataSymbol);

test('a global whose value changed under the same type re-emits its definition and its users', () => {
  const previous = computeHashCache({ functions, dataTypes, globals: [withValue('0x40000000')] });
  const r = selectDirtyUnits({
    buildInfo, previous, identCacheEmpty: false, functions, dataTypes, globals: [withValue('0x3f800000')],
  });
  assert.deepStrictEqual(r.units, ['D2Sound::Src::D2SoundSmp', 'D2Sound::Src::User']);
});

test('the same value spelled with keys in another order changes nothing', () => {
  const a = { ...global('D2RenderStrc', ''), initializedData: { kind: 'struct', fields: [], value: 'x' } } as unknown as AnalyzedDataSymbol;
  const b = { ...global('D2RenderStrc', ''), initializedData: { value: 'x', fields: [], kind: 'struct' } } as unknown as AnalyzedDataSymbol;
  const previous = computeHashCache({ functions, dataTypes, globals: [a] });
  const r = selectDirtyUnits({ buildInfo, previous, identCacheEmpty: false, functions, dataTypes, globals: [b] });
  assert.deepStrictEqual(r.units, []);
});

/**
 * A call through `p->pfnDraw` is resolved from the initial values of every
 * initialised instance of p's struct type. That body names the type, never the
 * global, so a changed instance must reach the units that name the type.
 */
test('a changed initialised struct instance re-emits the units that name its type', () => {
  const table = (target: string): AnalyzedDataSymbol => ({
    name: 'gsRendererGlide', address: '007a0000', dataType: 'D2RenderStrc', size: 8, isInitialized: true,
    scope: 'global', suggestedType: 'D2RenderStrc', referencingFunctions: [],
    initializedData: { kind: 'struct', fields: [{ name: 'pfnDraw', value: { kind: 'pointer', value: target } }] },
  } as unknown as AnalyzedDataSymbol);
  const withTypeUser = {
    ...buildInfo,
    modules: [
      ...buildInfo.modules,
      {
        id: 'D2Gfx/Draw.h', implPath: 'D2Gfx/Draw.cpp', unitName: 'D2Gfx::Draw',
        functionNames: ['DRAW_Frame'], ownedTypeNames: [], globalAddresses: [],
        deps: [{ symbol: 'D2RenderStrc', strength: 'by-pointer' }],
      },
    ],
  };
  const fns = [...functions, fn('00500300', 'DRAW_Frame')];
  const previous = computeHashCache({ functions: fns, dataTypes, globals: [table('GLIDE_Draw')] });
  const r = selectDirtyUnits({
    buildInfo: withTypeUser, previous, identCacheEmpty: false, functions: fns, dataTypes, globals: [table('GLIDE_DrawFast')],
  });
  assert.ok(r.units?.includes('D2Gfx::Draw'), `got ${JSON.stringify(r.units)}`);
});
