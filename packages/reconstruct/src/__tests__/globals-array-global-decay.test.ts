/**
 * Regression test: `&<name>` on a global that is a 1-D array is one indirection
 * off — `T(*)[N]`, where every consumer wants `T*`. The array name alone decays
 * to exactly `T*`, so the `&` must not be emitted at all.
 *
 * `recon/diablo-2/globals.cpp` carries 624 of these, e.g.
 *
 *   globals.h:1504    extern eD2Sounds eD2Sounds_ARRAY_00727f48[7];
 *   globals.cpp       /* .pSounds = *\/ &eD2Sounds_ARRAY_00728cc8,   (55 sites on that one name)
 *
 * `impl.ts` currently patches the same defect on the static-locals block with a
 * regex over emitted C++ (`block.replace(/&\s*(\w+_ARRAY_[0-9a-f]+)\b.../)`),
 * because its input comes from `generateStaticLocalsBlock` in globals-header.ts.
 * Fixing it at the source retires that regex: the emitter never produces the `&`.
 *
 * 2-D+ arrays are NOT the same case — decay there still leaves `T(*)[M]`, so the
 * existing element-pointer cast stays.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  emitDataValue,
  generateStaticLocalsBlock,
  setMultidimArrayGlobals,
  setGlobalInitializerTypes,
} from '../codegen/globals-header.js';
import type { AnalyzedDataSymbol, DataValue } from '../types.js';

/** globals.h:1504-1508 and the D2Client 2-D screen-coordinate tables. */
const GLOBALS = [
  { name: 'eD2Sounds_ARRAY_00728cc8', dataType: 'eD2Sounds[7]', suggestedType: 'eD2Sounds[7]' },
  { name: 'eD2Sounds_ARRAY_007291d8', dataType: 'eD2Sounds[7]', suggestedType: 'eD2Sounds[7]' },
  { name: 'gaGridCoords_ARRAY_006fc140', dataType: 'int[4][10]', suggestedType: 'int[4][10]' },
];

const table: DataValue = {
  kind: 'array',
  elements: [
    { kind: 'pointer', value: 'eD2Sounds_ARRAY_00728cc8' },
    { kind: 'pointer', value: 'eD2Sounds_ARRAY_007291d8' },
  ],
};

describe('a 1-D array global decays instead of being address-of-d', () => {
  beforeEach(() => {
    setMultidimArrayGlobals(GLOBALS);
    setGlobalInitializerTypes(undefined);
  });

  it('emits the bare name for a 1-D array global', () => {
    const out = emitDataValue(table, 0, 'eD2Sounds*[2]');
    assert.doesNotMatch(out, /&eD2Sounds_ARRAY_/);
    assert.match(out, /\beD2Sounds_ARRAY_00728cc8\b/);
    assert.match(out, /\beD2Sounds_ARRAY_007291d8\b/);
  });

  it('still casts a MULTIDIMENSIONAL array global — decay is not enough there', () => {
    const out = emitDataValue({ kind: 'pointer', value: 'gaGridCoords_ARRAY_006fc140' }, 0, 'int*');
    assert.match(out, /^\(int\*\)&gaGridCoords_ARRAY_006fc140$/);
  });

  it('the static-locals block no longer needs the `&`-stripping regex', () => {
    // recon/diablo-2 static vtable/table locals go through this path; impl.ts
    // post-processes its output with a regex that this test makes redundant.
    const sym: AnalyzedDataSymbol = {
      name: 'gpSoundTable',
      address: '006fd2a0',
      dataType: 'eD2Sounds*[2]',
      suggestedType: 'eD2Sounds*[2]',
      size: 8,
      isInitialized: true,
      xrefCount: 1,
      scope: 'static-local',
      ownerFunction: 'SOUND_InitTables',
      initializedData: table,
    } as AnalyzedDataSymbol;

    const block = generateStaticLocalsBlock([sym], 'SOUND_InitTables', false);
    assert.ok(block, 'block should be emitted');
    assert.doesNotMatch(block!, /&\s*\w+_ARRAY_[0-9a-fA-F]+/);
  });
});
