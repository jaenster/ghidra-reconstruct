/**
 * A multi-dimensional struct field keeps Ghidra's dimension order.
 *
 * Ghidra spells an array outermost-first, exactly as C does: `D2TimerListStrc
 * *[5][64]` is 5 rows of 64 pointers, row stride 0x100. The pointer-to-array
 * repair in `normalizeFieldDeclaration` used to peel only the FIRST `[N]` and
 * glue the remainder back onto the type; the generic array split then found
 * that remainder and PREPENDED it to the suffix already collected, so the two
 * dimensions came out transposed - `[64][5]`.
 *
 * Nothing catches that downstream. The total is 1280 bytes either way, so the
 * layout static_asserts pass, and every index still lands inside the object;
 * only the stride is wrong, and all five unit types alias into one 5-pointer
 * window. `D2TimerQueueStrc::pActiveTimersByType` is the live case - it
 * crashed the game.
 *
 * A non-pointer element type never went through that path (its dimensions were
 * always taken in one bite), and neither did a global. Both stay covered here
 * so the fix cannot be a relocation of the same transposition.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateStructDeclaration, fieldDeclSpelling, emittedFieldType } from '../codegen/header.js';
import type { ExtractedStruct } from '../types.js';

function struct(name: string, fields: ExtractedStruct['fields'], size = 0): ExtractedStruct {
  return { kind: 'STRUCTURE', name, category: '/', size, fields };
}

describe('multi-dimensional struct field dimension order', () => {
  it('keeps [5][64] for a pointer element type, as Ghidra spells it', () => {
    const out = generateStructDeclaration(
      struct('D2TimerQueueStrc', [
        { name: 'nIndex', dataType: 'int', offset: 0, size: 4 },
        { name: 'pActiveTimersByType', dataType: 'D2TimerListStrc *[5][64]', offset: 4, size: 1280 },
        { name: 'pDispatchedTimersByType', dataType: 'D2TimerListStrc *[5][64]', offset: 1284, size: 1280 },
        { name: 'pTimerListByType', dataType: 'D2TimerListStrc *[5]', offset: 2564, size: 20 },
      ], 2584),
    );

    assert.match(out, /pActiveTimersByType\[5\]\[64\];/);
    assert.match(out, /pDispatchedTimersByType\[5\]\[64\];/);
    assert.doesNotMatch(out, /\[64\]\[5\]/);
    // The single-dimension pointer array is untouched.
    assert.match(out, /pTimerListByType\[5\];/);
  });

  it('keeps the order for a three-dimensional pointer array', () => {
    const out = generateStructDeclaration(
      struct('D2ThreeDeeStrc', [
        { name: 'pCells', dataType: 'D2CellStrc *[2][3][4]', offset: 0, size: 96 },
      ], 96),
    );

    assert.match(out, /pCells\[2\]\[3\]\[4\];/);
  });

  it('keeps the order for a non-pointer element type', () => {
    const out = generateStructDeclaration(
      struct('D2GridStrc', [
        { name: 'aCounts', dataType: 'uint32_t[4][27]', offset: 0, size: 432 },
        { name: 'aCells', dataType: 'D2CellStrc[8][8]', offset: 432, size: 64 },
      ], 496),
    );

    assert.match(out, /aCounts\[4\]\[27\];/);
    assert.match(out, /aCells\[8\]\[8\];/);
    assert.doesNotMatch(out, /\[27\]\[4\]/);
  });

  it('reports the same order through the type tables', () => {
    assert.strictEqual(
      fieldDeclSpelling('D2TimerListStrc *[5][64]', 1280),
      'D2TimerListStrc *[5][64]',
    );
    assert.strictEqual(fieldDeclSpelling('uint32_t[4][27]', 432), 'uint32_t[4][27]');
    // An array is still not a cast target.
    assert.strictEqual(emittedFieldType('D2TimerListStrc *[5][64]', 1280), null);
  });

  it('still moves a Ghidra string array to char[outer][inner]', () => {
    // `string {60} [32]` is 32 elements of 60 chars — char x[32][60].
    const out = generateStructDeclaration(
      struct('D2NamesStrc', [
        { name: 'szNames', dataType: 'string {60} [32]', offset: 0, size: 1920 },
      ], 1920),
    );

    assert.match(out, /szNames\[32\]\[60\];/);
  });
});
