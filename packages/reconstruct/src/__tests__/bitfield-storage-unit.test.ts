/**
 * A bitfield's storage unit is the one Ghidra models, not the one its value
 * type spells.
 *
 * Ghidra packs bitfields eight to a BYTE and gives every component `size: 1`,
 * even though the component's `dataType` reads `int:1`. The `int` is the value
 * type; the byte is the allocation unit. `D2SkillsTxt` is the worked example -
 * its 39 flags occupy 0x04..0x08, and `charclass` follows at 0x0C.
 *
 * Emitted as `int x : 1`, C++ allocates a FOUR-byte unit per group. The 7-bit
 * group at 0x08 then swallowed 0x08..0x0B, and every member after it moved by
 * three: `offsetof(D2SkillsTxt, charclass)` measured 0x0F where Ghidra says
 * 0x0C, and `sizeof` 575 where Ghidra says 572. Nothing reported it - the tree
 * compiled and read the wrong bytes.
 *
 * The width is only half of it. `int x : 1` is a SIGNED one-bit field: the two
 * values it can hold are 0 and -1, never +1. Every `if (pSkill->passive == 1)`
 * the decompiler emitted against such a field was dead code.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateStructDeclaration } from '../codegen/header.js';
import type { StructField, ExtractedStruct } from '../types.js';

const f = (name: string | null, dataType: string, offset: number, size: number): StructField =>
  ({ name, dataType, offset, size } as unknown as StructField);

const mk = (fields: StructField[], size: number, alignment = 1): ExtractedStruct => ({
  name: 'D2TestStrc', category: '/Diablo2', size, kind: 'STRUCTURE', fields, alignment,
} as ExtractedStruct);

/** The eight-bits-per-byte shape Ghidra actually emits, cut down from D2SkillsTxt. */
function byteOfFlags(offset: number, names: string[]): StructField[] {
  return names.map(n => f(n, 'int:1', offset, 1));
}

/** Width in bytes of each declared bitfield base spelling. */
const WIDTH: Record<string, number> = {
  uint8_t: 1, uint16_t: 2, uint32_t: 4, uint64_t: 8,
  char: 1, short: 2, int: 4, long: 4, longlong: 8,
};

/**
 * Bytes a C++ compiler gives the emitted anonymous bitfield groups.
 *
 * Reads the declared base type and bit width off each emitted line and lays
 * them out the way the language does: a new unit starts whenever the running
 * bit count would overflow the declared base. This is what makes the test an
 * assertion about LAYOUT and not about spelling.
 */
function bitfieldGroupBytes(emitted: string): number {
  let total = 0;
  let unitWidth = 0;
  let bitsUsed = 0;
  for (const line of emitted.split('\n')) {
    const m = /^\s*\/\* 0x[0-9A-F]+ \*\/ (\w+) \w+ : (\d+);/.exec(line);
    if (!m) continue;
    const width = WIDTH[m[1]];
    assert.ok(width, `unknown bitfield base type ${m[1]}`);
    const bits = Number(m[2]);
    if (width !== unitWidth || bitsUsed + bits > width * 8) {
      total += unitWidth;
      unitWidth = width;
      bitsUsed = 0;
    }
    bitsUsed += bits;
  }
  return total + unitWidth;
}

describe('bitfield storage unit follows Ghidra size, not the value type', () => {
  it("spells a size=1 bitfield uint8_t, not int", () => {
    const out = generateStructDeclaration(mk([
      ...byteOfFlags(0, ['decquant', 'lob', 'progressive', 'finishing',
        'passive', 'aura', 'periodic', 'prgstack']),
      f('charclass', 'char', 1, 1),
    ], 2));

    assert.match(out, /uint8_t decquant : 1;/);
    assert.match(out, /uint8_t prgstack : 1;/);
    assert.doesNotMatch(out, /\bint \w+ : 1;/);
  });

  it('a 7-bit group occupies ONE byte, so the next field keeps its offset', () => {
    // The exact D2SkillsTxt shape that moved charclass from 0x0C to 0x0F:
    // four full bytes of flags, then a 7-bit byte, then a named field.
    const fields: StructField[] = [
      ...byteOfFlags(0, ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']),
      ...byteOfFlags(1, ['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7']),
      ...byteOfFlags(2, ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']),
      ...byteOfFlags(3, ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']),
      ...byteOfFlags(4, ['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6']),
      f('charclass', 'char', 5, 1),
    ];
    const out = generateStructDeclaration(mk(fields, 6));

    // Five bytes of Ghidra bitfields must consume five bytes of C++ storage.
    // With `int` bases this came to 20 and charclass landed at 0x14.
    assert.strictEqual(bitfieldGroupBytes(out), 5);
    assert.match(out, /\/\* 0x05 \*\/ char charclass;/);
  });

  it('preserves the anonymous-struct grouping and the offset comments', () => {
    const out = generateStructDeclaration(mk([
      f('skill', 'short', 0, 2),
      ...byteOfFlags(4, ['decquant', 'lob']),
      ...byteOfFlags(5, ['InTown', 'Kick']),
    ], 6));

    assert.match(out, /\/\* 0x04 \*\/ struct \{/);
    assert.match(out, /\/\* 0x04 \*\/ uint8_t decquant : 1;/);
    assert.match(out, /\/\* 0x05 \*\/ uint8_t InTown : 1;/);
    assert.match(out, /\n {4}\};/);
  });

  it('a size=8 bitfield is uint64_t, not longlong', () => {
    // D2PlayerWaypointsStrc models its 64 waypoint bits as one `longlong:64`
    // component of size 8. A lone bitfield takes the non-grouped path.
    const out = generateStructDeclaration(mk([
      f('wSetOrDel', 'short', 0, 2),
      f('Waypoint', 'longlong:64', 2, 8),
    ], 16));

    assert.match(out, /uint64_t Waypoint : 64;/);
    assert.doesNotMatch(out, /longlong/);
  });

  it('widths 2 and 4 map to their unsigned integer, and nothing is signed', () => {
    const out = generateStructDeclaration(mk([
      f('w', 'short:3', 0, 2),
      f('d', 'int:5', 4, 4),
    ], 8));

    assert.match(out, /uint16_t w : 3;/);
    assert.match(out, /uint32_t d : 5;/);
    // A signed one-bit field holds 0 and -1; `== 1` is then always false.
    assert.doesNotMatch(out, /(?:^|\s)(?:int|short|long|char) \w+ : \d+;/m);
  });

  it('leaves a width C has no exact integer for spelled as Ghidra spelled it', () => {
    // Not a shape 1.14d carries, but the fallback must not invent a width.
    const out = generateStructDeclaration(mk([
      f('a', 'int:1', 0, 3),
      f('b', 'int', 4, 4),
    ], 8));
    assert.match(out, /int a : 1;/);
  });
});
