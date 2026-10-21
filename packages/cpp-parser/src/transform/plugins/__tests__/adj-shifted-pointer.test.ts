/**
 * adj-shifted-pointer: ADJ(p) on a shifted pointer is the member's containing record.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { adjShiftedPointerPlugin } from '../builtins/adj-shifted-pointer.js';

// D2TaskQueueSlotStrc {+0 nSlotIndex, +4 nTaskCount, +8 sTaskList, +0x10 sSlotLink}; the
// typedef name is the one a Ghidra writer would give it (illustrative).
const SPECS = { PD2TaskQueueSlotLink: { container: 'D2TaskQueueSlotStrc', offset: 0x10, member: 'sSlotLink' } };
const run = (src: string, extra: Record<string, unknown> = {}) =>
  emit(adjShiftedPointerPlugin.createTransformer({ shiftedPointers: SPECS, ...extra })(parse(src)) as AnyNode).replace(/\s+/g, ' ').trim();

describe('adj-shifted-pointer', () => {
  it('ADJ(local)->field is the field of the container, 0x10 bytes back', () => {
    const out = run(`void f(void) { PD2TaskQueueSlotLink pSlotLink; pSlotLink = head(); ADJ(pSlotLink)->nTaskCount = ADJ(pSlotLink)->nTaskCount + 1; }`);
    assert.match(out, /\(\(D2TaskQueueSlotStrc\*\)\(\(char\*\)pSlotLink - 0x10\)\)->nTaskCount = \(\(D2TaskQueueSlotStrc\*\)\(\(char\*\)pSlotLink - 0x10\)\)->nTaskCount \+ 1;/);
    assert.doesNotMatch(out, /ADJ/);
  });
  it('a parameter and a global typed with it', () => {
    assert.doesNotMatch(run(`int f(PD2TaskQueueSlotLink p) { return ADJ(p)->nSlotIndex; }`), /ADJ/);
    assert.doesNotMatch(run(`int f(void) { return ADJ(gpLink)->nSlotIndex; }`, { globalTypes: { gpLink: 'PD2TaskQueueSlotLink' } }), /ADJ/);
  });
  it('an ADJ whose argument is not a known shifted pointer stays as printed', () => {
    assert.match(run(`int f(D2LinkNodeStrc *p) { return ADJ(p)->nSlotIndex; }`), /ADJ\(p\)/);
  });
});
