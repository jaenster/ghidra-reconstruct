/**
 * Fixture test for undefined-filler member naming, built from two real
 * 1.14d structs.
 *
 * Neither struct was ever "too short": `D2WinScrollbar` is 0x60 and
 * `D2GfxUnknown_0xa8` is 0xa8 in the Ghidra database. What they carry between
 * their named members is unnamed `undefined` filler, and the decompiler names an
 * access into filler `field_0x<offset>` at the offset it touches
 * (`pScrollbar->field_0x48`, `pGfx->field_0x1c`). A single collapsed
 * `uint8_t _pad[N]` gives no member at any of those offsets, so every such access
 * failed to compile.
 *
 * The layout assertions are the point of this test: filler naming must never move
 * a member or change `sizeof`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateStructDeclaration } from '../codegen/header.js';
import type { ExtractedStruct, StructField } from '../types.js';

/** N consecutive unnamed 1-byte `undefined` fields starting at `start`. */
function filler(start: number, count: number): StructField[] {
  return Array.from({ length: count }, (_, k) => ({
    name: '', dataType: 'undefined1', offset: start + k, size: 1,
  }));
}

/**
 * Parse `/* 0xNN *​/ <type> <name>;` lines back into (offset, name) pairs so the
 * assertions below are about layout, not about text.
 */
function members(out: string): { offset: number; name: string }[] {
  const res: { offset: number; name: string }[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*\/\* 0x([0-9A-Fa-f]+) \*\/\s+\S+\s+([A-Za-z_]\w*)(\[(\d+)\])?;/);
    if (m) res.push({ offset: parseInt(m[1], 16), name: m[2] });
  }
  return res;
}

/** Total bytes covered, from the declared field list (the ABI contract). */
function coveredBytes(out: string): number {
  let total = 0;
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*\/\* 0x[0-9A-Fa-f]+ \*\/\s+uint8_t\s+\w+(?:\[(\d+)\])?;/);
    if (m) total += m[1] ? parseInt(m[1], 10) : 1;
  }
  return total;
}

describe('undefined filler gets a named member at every offset', () => {
  // D2WinScrollbar @ 0x60: D2ControlStrc at 0x00..0x3F, then 0x20 filler bytes.
  const scrollbar: ExtractedStruct = {
    kind: 'STRUCTURE',
    name: 'D2WinScrollbar',
    category: '/',
    size: 0x60,
    fields: [
      { name: 'sControl', dataType: 'D2ControlStrc', offset: 0x00, size: 0x40 },
      ...filler(0x40, 0x20),
    ],
  };

  // D2GfxUnknown_0xa8 @ 0xa8: two named members, then 0x9F filler bytes.
  const gfx: ExtractedStruct = {
    kind: 'STRUCTURE',
    name: 'D2GfxUnknown_0xa8',
    category: '/',
    size: 0xa8,
    fields: [
      { name: 'field0_0x0', dataType: 'uint', offset: 0x00, size: 4 },
      { name: 'neOverlayId', dataType: 'eOverlayId', offset: 0x04, size: 4 },
      ...filler(0x08, 0xa0),
    ],
  };

  it('D2WinScrollbar names the offsets its bodies actually read', () => {
    const out = generateStructDeclaration(scrollbar);
    const byName = new Map(members(out).map(m => [m.name, m.offset]));
    // The exact offsets that produced "has no member named field_0xNN".
    for (const off of [0x44, 0x48, 0x4c, 0x50, 0x54, 0x58, 0x5c]) {
      assert.strictEqual(
        byName.get(`field_0x${off.toString(16)}`), off,
        `field_0x${off.toString(16)} must exist at offset 0x${off.toString(16)}`);
    }
  });

  it('D2GfxUnknown_0xa8 names the offsets its bodies actually write', () => {
    const out = generateStructDeclaration(gfx);
    const byName = new Map(members(out).map(m => [m.name, m.offset]));
    for (const off of [0x0c, 0x10, 0x14, 0x18, 0x1c, 0x20, 0x24, 0x28, 0x34, 0x38, 0x40, 0xa4]) {
      assert.strictEqual(
        byName.get(`field_0x${off.toString(16)}`), off,
        `field_0x${off.toString(16)} must exist at offset 0x${off.toString(16)}`);
    }
    // Members that were already named keep their names and offsets.
    assert.strictEqual(byName.get('field0_0x0'), 0x00);
    assert.strictEqual(byName.get('neOverlayId'), 0x04);
  });

  it('preserves every offset and the total size', () => {
    for (const [struct, namedBytes] of [[scrollbar, 0x20], [gfx, 0xa0]] as const) {
      const out = generateStructDeclaration(struct);
      const ms = members(out);
      // Offsets are strictly increasing and contiguous over the filler region.
      for (let i = 1; i < ms.length; i++) {
        assert.ok(ms[i].offset > ms[i - 1].offset,
          `${struct.name}: offsets must stay strictly increasing`);
      }
      // Every filler byte is still accounted for — no byte added, none dropped.
      assert.strictEqual(coveredBytes(out), namedBytes,
        `${struct.name}: filler must cover exactly ${namedBytes} bytes`);
      // The last member sits at the last filler byte, so sizeof is unchanged.
      assert.strictEqual(ms[ms.length - 1].offset, struct.size - 1);
    }
  });

  it('leaves a multi-kilobyte run collapsed rather than emitting 60k members', () => {
    const huge: ExtractedStruct = {
      kind: 'STRUCTURE',
      name: 'HugeTailStrc',
      category: '/',
      size: 0x2000,
      fields: [
        { name: 'nReal', dataType: 'int', offset: 0, size: 4 },
        ...filler(4, 0x1ffc),
      ],
    };
    const out = generateStructDeclaration(huge);
    assert.match(out, /uint8_t _pad_0x0005\[8187\];/);
    // The run's first byte still carries the Ghidra name.
    assert.match(out, /uint8_t field_0x4;/);
    // And the collapsed form still covers the full 0x1ffc bytes.
    assert.strictEqual(coveredBytes(out), 0x1ffc);
  });

  it('does not disturb a named bitfield carrier', () => {
    // A byte whose per-bit meanings live in a comment is a NAMED undefined1, not
    // filler — it must keep its name and must not be expanded or renamed.
    const bits: ExtractedStruct = {
      kind: 'STRUCTURE',
      name: 'BitCarrierStrc',
      category: '/',
      size: 4,
      fields: [
        { name: 'bFlags', dataType: 'undefined1', offset: 0, size: 1,
          comment: 'bit0 = active, bit1 = hidden' },
        ...filler(1, 3),
      ],
    };
    const out = generateStructDeclaration(bits);
    const byName = new Map(members(out).map(m => [m.name, m.offset]));
    assert.strictEqual(byName.get('bFlags'), 0);
    assert.strictEqual(byName.get('field_0x1'), 1);
    assert.strictEqual(byName.get('field_0x3'), 3);
    assert.strictEqual(coveredBytes(out), 4);
  });
});
