/** Ghidra's `+Infinity` data value (DOUBLE_0074af20) is emitted as a C++ expression. */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { normalizeDataValue } from '../codegen/platform-types.js';

describe('normalizeDataValue: IEEE infinities', () => {
  it('spells +Infinity and -Infinity through <cmath>', () => {
    assert.strictEqual(normalizeDataValue('+Infinity'), 'HUGE_VAL');
    assert.strictEqual(normalizeDataValue('-Infinity'), '-HUGE_VAL');
    assert.strictEqual(normalizeDataValue('-5'), '-5');
  });
});
