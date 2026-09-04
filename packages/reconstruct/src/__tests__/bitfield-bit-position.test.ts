/**
 * A bitfield occupies the BIT Ghidra assigns it, not the next free one.
 *
 * Ghidra models a bitfield as a component with `dataType: "int:1"`, a byte
 * `offset` and `size: 1`, and - since the exporter carries it - a `bitOffset`,
 * the position of the field's least-significant bit within the byte at that
 * offset. Packing a group consecutively from bit 0 is right only where the
 * original C used every bit.
 *
 * `D2MonStats2Txt` byte 0x104 is the case that is not. monstats2.txt has an
 * "mv" flag for A1, A2, SC and S1..S4 only, so the byte carries A1mv at bit 4,
 * A2mv at 5 and SCmv at 7, with bits 0..3 and 6 unused, and S1..S4 continue in
 * 0x105. Packed at bits 0, 1, 2 the group
 *
 *   - reads the WRONG BIT: `A1mv` compiles to a test of bit 0 where the binary
 *     means bit 4, and nothing reports it - it compiles, links and runs; and
 *   - collapses from two bytes to one, moving `field_0x106` to 0x105 and every
 *     one of the 22 members behind it by -1.
 *
 * `bitOffset` is the fix, and the comment text ("mask 0x10") is not: a comment
 * can be absent, reworded or wrong.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateStructDeclaration, planBitfieldGroup } from '../codegen/header.js';
import type { StructField, ExtractedStruct } from '../types.js';

const f = (
  name: string | null,
  dataType: string,
  offset: number,
  size: number,
  bitOffset?: number,
): StructField =>
  ({
    name, dataType, offset, size,
    ...(bitOffset === undefined ? {} : { bitOffset, bitSize: 1 }),
  } as unknown as StructField);

const mk = (fields: StructField[], size: number): ExtractedStruct => ({
  name: 'D2TestStrc', category: '/Diablo2', size, kind: 'STRUCTURE', fields, alignment: 1,
} as ExtractedStruct);

/** The real D2MonStats2Txt shape at 0x104, cut down to the group and its neighbour. */
const MONSTATS2_MV: StructField[] = [
  f('A1mv', 'int:1', 0x104, 1, 4),
  f('A2mv', 'int:1', 0x104, 1, 5),
  f('SCmv', 'int:1', 0x104, 1, 7),
  f('S1mv', 'int:1', 0x105, 1, 0),
  f('S2mv', 'int:1', 0x105, 1, 1),
  f('S3mv', 'int:1', 0x105, 1, 2),
  f('S4mv', 'int:1', 0x105, 1, 3),
];

/**
 * Bits the emitted anonymous bitfield group occupies - named members AND the
 * anonymous filler, which is the half a name-only scan misses. This is what
 * makes the assertions below about LAYOUT rather than about spelling.
 */
function groupBits(emitted: string): number {
  let bits = 0;
  for (const line of emitted.split('\n')) {
    const m = /:\s*(\d+);/.exec(line);
    if (m) bits += Number(m[1]);
  }
  return bits;
}

/** Bit position each named bitfield lands on, in declaration order. */
function bitPositions(emitted: string): Record<string, number> {
  const at: Record<string, number> = {};
  let cursor = 0;
  for (const line of emitted.split('\n')) {
    const anon = /^\s*\w+ : (\d+);/.exec(line);
    const named = /\w+\s+(\w+) : (\d+);/.exec(line);
    if (anon) {
      cursor += Number(anon[1]);
    } else if (named) {
      at[named[1]] = cursor;
      cursor += Number(named[2]);
    }
  }
  return at;
}

describe('bitfield bit positions come from Ghidra, not from declaration order', () => {
  it('emits leading filler so the first field lands on its own bit', () => {
    const out = generateStructDeclaration(mk([...MONSTATS2_MV, f('after', 'char', 0x106, 1)], 0x107));

    // Bits 0..3 are unused in monstats2.txt, so A1mv must be preceded by 4 bits.
    assert.match(out, /uint8_t : 4;.*\n\s*\/\* 0x104 \*\/ uint8_t A1mv : 1;/);
    assert.deepStrictEqual(bitPositions(out), {
      A1mv: 4, A2mv: 5, SCmv: 7, S1mv: 8, S2mv: 9, S3mv: 10, S4mv: 11,
    });
  });

  it('skips the unused bit BETWEEN two fields (bit 6, between A2mv and SCmv)', () => {
    const out = generateStructDeclaration(mk(MONSTATS2_MV, 0x106));
    assert.match(out, /A2mv : 1;\n\s*uint8_t : 1;.*\n\s*\/\* 0x104 \*\/ uint8_t SCmv : 1;/);
  });

  it('spans the two bytes Ghidra assigns, so the next member keeps its offset', () => {
    const out = generateStructDeclaration(mk([...MONSTATS2_MV, f('after', 'char', 0x106, 1)], 0x107));

    // 0x104 and 0x105 => 16 bits, not the 7 a consecutive packing would give.
    assert.strictEqual(groupBits(out), 16);
    assert.match(out, /\/\* 0x106 \*\/ char after;/);
  });

  it('places a LONE bitfield at its bit too', () => {
    const out = generateStructDeclaration(mk([
      f('before', 'char', 0x00, 1),
      f('flag', 'int:1', 0x01, 1, 3),
      f('after', 'char', 0x02, 1),
    ], 3));

    assert.match(out, /uint8_t : 3;.*\n\s*\/\* 0x01 \*\/ uint8_t flag : 1;/);
    assert.strictEqual(groupBits(out), 8);
  });

  it('emits exactly the old shape when the snapshot carries no bitOffset', () => {
    // An older snapshot, or any non-bitfield: unknown is not zero, but the only
    // safe fallback is what the emitter did before bitOffset existed.
    const out = generateStructDeclaration(mk([
      f('A1mv', 'int:1', 0x104, 1),
      f('A2mv', 'int:1', 0x104, 1),
      f('SCmv', 'int:1', 0x104, 1),
      f('after', 'char', 0x105, 1),
    ], 0x106));

    assert.doesNotMatch(out, /^\s*uint8_t : \d+;/m);
    assert.strictEqual(groupBits(out), 3);
    assert.deepStrictEqual(bitPositions(out), { A1mv: 0, A2mv: 1, SCmv: 2 });
  });
});

describe('planBitfieldGroup declines rather than guessing', () => {
  it('returns null when no member carries a bit offset', () => {
    assert.strictEqual(planBitfieldGroup([
      f('a', 'int:1', 4, 1), f('b', 'int:1', 4, 1),
    ]), null);
  });

  it('returns null when the storage unit is not one byte', () => {
    // Ghidra's bitfield storage is minimal; a multi-byte unit means the unit
    // arithmetic here and C's own unit-change rules stop agreeing.
    assert.strictEqual(planBitfieldGroup([
      f('a', 'int:6', 4, 2, 5), f('b', 'int:4', 4, 2, 11),
    ]), null);
  });

  it('never emits a backwards pad if two components claim one bit', () => {
    const plan = planBitfieldGroup([
      f('a', 'int:4', 4, 1, 4),
      f('b', 'int:1', 4, 1, 2),
    ]);
    assert.ok(plan);
    assert.deepStrictEqual(plan.get(0)?.before, [4]);
    assert.strictEqual(plan.get(1)?.before, undefined);
  });

  it('splits a gap wider than a byte at the byte grid', () => {
    // `uint8_t : 12;` is not a legal declaration.
    const plan = planBitfieldGroup([
      f('a', 'int:1', 0x10, 1, 0),
      f('b', 'int:1', 0x12, 1, 4),
    ]);
    assert.ok(plan);
    assert.deepStrictEqual(plan.get(1)?.before, [7, 8, 4]);
  });
});
