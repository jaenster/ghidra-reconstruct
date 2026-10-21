/**
 * Shifted pointers: the offset read from Ghidra (extract/shifted-pointers.ts) and the
 * typedef declared as a pointer to the member at it (codegen/shifted-pointers.ts).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseShiftedPointers, applyShiftedPointers, SHIFTED_POINTER_SCRIPT } from '../extract/shifted-pointers.js';
import { shiftedPointerSpecs, lowerShiftedPointerTypedefs } from '../codegen/shifted-pointers.js';
import type { ExtractedDataType } from '../types.js';

const model = (): ExtractedDataType[] => [
  { name: 'D2TaskQueueSlotStrc', category: '/Diablo2', size: 0x18, kind: 'STRUCTURE', fields: [
    { name: 'nSlotIndex', dataType: 'int', offset: 0, size: 4 },
    { name: 'nTaskCount', dataType: 'int', offset: 4, size: 4 },
    { name: 'sTaskList', dataType: 'D2LinkNodeStrc', offset: 8, size: 8 },
    { name: 'sSlotLink', dataType: 'D2LinkNodeStrc', offset: 0x10, size: 8 },
  ] } as ExtractedDataType,
  { name: 'PD2TaskQueueSlotLink', category: '/Diablo2', size: 4, kind: 'TYPEDEF', underlyingType: 'D2TaskQueueSlotStrc *' } as ExtractedDataType,
  { name: 'PD2TaskQueueSlotOdd', category: '/Diablo2', size: 4, kind: 'TYPEDEF', underlyingType: 'D2TaskQueueSlotStrc *' } as ExtractedDataType,
];

describe('shifted pointers', () => {
  it('the script reads the component offset of every pointer-typedef', () => {
    assert.ok(SHIFTED_POINTER_SCRIPT.includes('ComponentOffsetSettingsDefinition.DEF.getValue(td.getDefaultSettings())'));
  });
  it('parses the rows and attaches them by name and category', () => {
    const facts = parseShiftedPointers([
      'S\tPD2TaskQueueSlotLink\t/Diablo2\tD2TaskQueueSlotStrc\t/Diablo2\t16',
      'S\tPD2TaskQueueSlotOdd\t/Diablo2\tD2TaskQueueSlotStrc\t/Diablo2\t6',
      'S\tOther\t/x\tY\t/x\t0',
      'noise',
    ].join('\n'));
    assert.equal(facts.size, 2);
    const dts = model();
    assert.equal(applyShiftedPointers(facts, dts), 2);
    assert.deepEqual((dts[1] as unknown as { shifted?: unknown }).shifted, { base: 'D2TaskQueueSlotStrc', baseCategory: '/Diablo2', offset: 16 });
  });
  it('declares the typedef as a pointer to the member at the offset, or to a byte between members', () => {
    const dts = model();
    applyShiftedPointers(parseShiftedPointers('S\tPD2TaskQueueSlotLink\t/Diablo2\tD2TaskQueueSlotStrc\t/Diablo2\t16\nS\tPD2TaskQueueSlotOdd\t/Diablo2\tD2TaskQueueSlotStrc\t/Diablo2\t6'), dts);
    assert.deepEqual(shiftedPointerSpecs(dts), {
      PD2TaskQueueSlotLink: { container: 'D2TaskQueueSlotStrc', offset: 16, member: 'sSlotLink', memberType: 'D2LinkNodeStrc' },
      PD2TaskQueueSlotOdd: { container: 'D2TaskQueueSlotStrc', offset: 6 },
    });
    assert.equal(lowerShiftedPointerTypedefs(dts), 2);
    assert.equal((dts[1] as unknown as { underlyingType: string }).underlyingType, 'D2LinkNodeStrc *');
    assert.equal((dts[2] as unknown as { underlyingType: string }).underlyingType, 'uint8_t *');
  });
  it('a typedef without a component offset is untouched', () => {
    const dts = model();
    assert.equal(lowerShiftedPointerTypedefs(dts), 0);
    assert.equal((dts[1] as unknown as { underlyingType: string }).underlyingType, 'D2TaskQueueSlotStrc *');
  });
});
