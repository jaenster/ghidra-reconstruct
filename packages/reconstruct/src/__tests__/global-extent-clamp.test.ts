/**
 * An extent may not cross a later symbol's base.
 *
 * Two distinct objects do not overlap in an image, so a size that reaches past
 * the next symbol is a size Ghidra got wrong. 1.14d's table is full of them and
 * the cost was not a WRONG answer but NO answer: `ownerOfAddress` requires a
 * unique owner, so every address covered by two extents resolved to nothing and
 * stayed an absolute image address the linker does not move.
 *
 * Real cases this reproduces, by address:
 *  - `gaGlideEmblemPrimaryColorTableEntries_Minus1` starts one byte before the
 *    array it names, carries that array's full 241,920 bytes and therefore
 *    swallows `DATA_LastGameToken` whole — the seven `0x883d37` bounds in
 *    `Server.cpp`.
 *  - `gnColorLookupTableData` runs 0x20 bytes past its end into
 *    `gaPaletteBlendEntries` — `PALETTE_InitColorLookupTables`' `0x7d5528`.
 *
 * Clamping is the only correction that is safe without knowing which of the two
 * sizes is right, because it can ONLY SHRINK. The pass's standing rule — never
 * infer an extent from the gap to the next symbol — forbids the opposite.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { buildGlobalAddressExtentTables } from '../codegen/index.js';
import type { AnalyzedDataSymbol } from '../types.js';

function sym(
  name: string, address: string, size: number, dataType = 'undefined'
): AnalyzedDataSymbol {
  return {
    name, address, size, dataType, suggestedType: dataType,
    isInitialized: true, value: null, xrefCount: 1, scope: 'global',
  } as unknown as AnalyzedDataSymbol;
}

describe('buildGlobalAddressExtentTables extent clamping', () => {
  it('shortens an extent that swallows a later symbol base', () => {
    const { globalSizes } = buildGlobalAddressExtentTables([
      sym('gBogusBlob', '0087d80f', 241920, 'byte[241920]'),
      sym('DATA_LastGameToken', '00882d38', 4096, 'int[1024]'),
    ]);
    assert.strictEqual(globalSizes.gBogusBlob, 0x882d38 - 0x87d80f);
    assert.strictEqual(globalSizes.DATA_LastGameToken, 4096);
  });

  it('leaves an extent that stops exactly at the next base', () => {
    // The Storm anchors: four 12-byte list heads, back to back. Nothing here
    // may move, and the one-past-the-end rule depends on the exact size.
    const { globalSizes } = buildGlobalAddressExtentTables([
      sym('gSFileAsyncReqFreeList', '00708354', 12),
      sym('gSFileAsyncReqQueue', '00708360', 12),
      sym('gSFileAsyncReqActive', '0070836c', 12),
      sym('gSFileAsyncReqDone', '00708378', 12),
    ]);
    assert.deepStrictEqual(globalSizes, {
      gSFileAsyncReqFreeList: 12,
      gSFileAsyncReqQueue: 12,
      gSFileAsyncReqActive: 12,
      gSFileAsyncReqDone: 12,
    });
  });

  it('leaves the last symbol alone — there is no next base to clamp against', () => {
    const { globalSizes } = buildGlobalAddressExtentTables([
      sym('gFirst', '00500100', 4),
      sym('gLast', '00500200', 4096, 'int[1024]'),
    ]);
    assert.strictEqual(globalSizes.gLast, 4096);
  });

  it('never grows an extent', () => {
    const { globalSizes } = buildGlobalAddressExtentTables([
      sym('gSmall', '00500100', 4),
      sym('gNext', '00501000', 4),
    ]);
    assert.strictEqual(globalSizes.gSmall, 4);
  });

  it('clamps a shorter overlap to the tighter of two later bases', () => {
    const { globalSizes } = buildGlobalAddressExtentTables([
      sym('gOuter', '00500100', 64),
      sym('gMiddle', '00500110', 8),
      sym('gLater', '00500120', 8),
    ]);
    assert.strictEqual(globalSizes.gOuter, 0x10);
    assert.strictEqual(globalSizes.gMiddle, 8);
  });
});
