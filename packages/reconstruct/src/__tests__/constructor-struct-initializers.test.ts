/**
 * Data of a struct the header gives constructors, and a struct a union holds.
 *
 * The header gives small integer-only structs a conversion constructor and a
 * field-wise one. That makes them non-aggregates: in C++11 a brace list `{a, b}`
 * is a call of the field-wise constructor, in C++03 it is ill-formed (MSVC C2552),
 * at any depth of an initializer - `globals/Storm.cpp`'s ct_data tables were 30 of
 * those. The data initializer spells the call itself, which selects the same
 * constructor with the same arguments in both languages.
 *
 * C++03 also forbids a union member with a constructor (MSVC C2620), so a struct a
 * union holds by value keeps only the conversion operator, and a cast to it is no
 * converting construction but a bit move.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateStructDeclaration, hasConvertingConstructor, setConstructorBearingStructs } from '../codegen/header.js';
import { emitDataValue } from '../codegen/globals-header.js';
import type { ExtractedStruct, StructField } from '../types.js';

const fields = (...specs: Array<[string, string, number, number]>): StructField[] =>
  specs.map(([name, dataType, offset, size]) => ({ name, dataType, offset, size }) as StructField);

const CT_DATA = { kind: 'STRUCTURE', name: 'ct_data', size: 4, fields: fields(['fc', 'uint16_t', 0, 2], ['dl', 'uint16_t', 2, 2]) };
const PACKET = { kind: 'STRUCTURE', name: 'D2GSPacketClt0x89', size: 2, fields: fields(['nPacketId', 'uint8_t', 0, 1], ['nEventType', 'uint8_t', 1, 1]) };
const SLOT = { kind: 'UNION', name: 'D2QuestJoinFrameSlotUnion', size: 4, fields: fields(['pGameSaved', 'SGAMEDATA *', 0, 4], ['sPacket0x89', 'D2GSPacketClt0x89', 0, 2]) };

const scalar = (value: string) => ({ kind: 'scalar', value }) as const;

describe('constructor-bearing struct data', () => {
  setConstructorBearingStructs([CT_DATA, PACKET, SLOT]);

  it('calls the field-wise constructor, keeping each field name', () => {
    const out = emitDataValue({ kind: 'struct', fields: [{ name: 'fc', value: scalar('0x10') }, { name: 'dl', value: scalar('0x5') }] } as never, 0, 'ct_data');
    assert.match(out, /^ct_data\(\n {4}\/\* \.fc = \*\/ 0x10,\n {4}\/\* \.dl = \*\/ 0x5\n\)$/, out);
  });

  it('value-initializes an all-zero one with the default constructor', () => {
    const out = emitDataValue({ kind: 'struct', fields: [{ name: 'fc', value: scalar('0') }, { name: 'dl', value: scalar('0') }] } as never, 0, 'ct_data');
    assert.strictEqual(out, 'ct_data()');
  });

  it('spells the call for every element of an array', () => {
    const out = emitDataValue({ kind: 'array', elements: [
      { kind: 'struct', fields: [{ name: 'fc', value: scalar('0x1') }, { name: 'dl', value: scalar('0x2') }] },
      { kind: 'struct', fields: [{ name: 'fc', value: scalar('0x3') }, { name: 'dl', value: scalar('0x4') }] },
    ] } as never, 0, 'ct_data[2]');
    assert.ok(!/\{\s*\/\*/.test(out), out);
    assert.strictEqual(out.match(/ct_data\(/g)?.length, 2, out);
  });

  it('gives a struct a union holds the conversion operator only', () => {
    assert.ok(hasConvertingConstructor('ct_data', CT_DATA.fields));
    assert.ok(!hasConvertingConstructor('D2GSPacketClt0x89', PACKET.fields));
    const decl = generateStructDeclaration(PACKET as unknown as ExtractedStruct);
    assert.match(decl, /operator uint16_t\(\) const/, decl);
    assert.ok(!/D2GSPacketClt0x89\(/.test(decl), decl);
  });

  it('brace-initializes a struct a union holds, as the aggregate it is', () => {
    const out = emitDataValue({ kind: 'struct', fields: [{ name: 'nPacketId', value: scalar('0x89') }, { name: 'nEventType', value: scalar('0x1') }] } as never, 0, 'D2GSPacketClt0x89');
    assert.match(out, /^\{/, out);
  });
});
