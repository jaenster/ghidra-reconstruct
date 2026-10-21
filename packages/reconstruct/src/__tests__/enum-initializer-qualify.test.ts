/**
 * An enum datum in an initializer is printed by Ghidra as its member name. d2_enums.h
 * exports a member at global scope only where every enum declaring the name agrees on
 * its value; `Cast`, `Neutral`, `GetHit` ... are declared by both eD2MonsterAnimMode
 * and eD2PlayerAnimMode with different numbers, so the bare name names nothing:
 *
 *   globals.D2Client.cpp:2344: error: 'Cast' was not declared in this scope
 *
 * (gaMonMsgAnimModeTable, {eD2MonsterAnimMode eMode; int32_t bCheckMoveFlag}[]).
 * The slot's declared enum says which one is meant, so the initializer is spelled
 * `<Enum>_ns::Name`, the same spelling `enum-constant-qualify` gives a body.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import { emitDataValue, setGlobalInitializerTypes, setInitializerEnumConstants } from '../codegen/globals-header.js';
import type { DataValue, ExtractedDataType } from '../types.js';

const entry = (mode: string): DataValue => ({
  kind: 'struct',
  fields: [
    { name: 'eMode', value: { kind: 'enum', value: mode } },
    { name: 'bCheckMoveFlag', value: { kind: 'scalar', value: '0x1' } },
  ],
});

describe('enum member in an initializer', () => {
  beforeEach(() => {
    setGlobalInitializerTypes([
      {
        kind: 'STRUCTURE', name: 'D2MonMsgAnimModeStrc', size: 8,
        fields: [
          { name: 'eMode', dataType: 'eD2MonsterAnimMode', offset: 0, size: 4 },
          { name: 'bCheckMoveFlag', dataType: 'int32_t', offset: 4, size: 4 },
        ],
      },
    ] as unknown as ExtractedDataType[]);
    setInitializerEnumConstants(['Cast', 'Neutral'], {
      eD2MonsterAnimMode: ['Death', 'Neutral', 'Walk', 'Cast'],
      eD2PlayerAnimMode: ['Death', 'Neutral', 'Walk', 'Cast'],
    });
  });

  it('qualifies a member no enum exports with the slot enum', () => {
    const out = emitDataValue(entry('Cast'), 0, 'D2MonMsgAnimModeStrc');
    assert.match(out, /\/\* \.eMode = \*\/ eD2MonsterAnimMode_ns::Cast,/);
  });

  it('leaves an exported member bare', () => {
    const out = emitDataValue(entry('Walk'), 0, 'D2MonMsgAnimModeStrc');
    assert.match(out, /\/\* \.eMode = \*\/ Walk,/);
  });

  it('leaves a number that is no member alone', () => {
    const out = emitDataValue(entry('16'), 0, 'D2MonMsgAnimModeStrc');
    assert.match(out, /\/\* \.eMode = \*\/ 16,/);
  });

  it('does not guess when the slot type is unknown', () => {
    assert.strictEqual(emitDataValue({ kind: 'enum', value: 'Cast' }, 0, undefined), 'Cast');
  });
});
