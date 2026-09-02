/**
 * A struct field must land where Ghidra says it does.
 *
 * The emitter writes the intended offset as a comment and, until this, enforced
 * nothing. Where Ghidra's layout is packed and C's is aligned, the compiler puts
 * the field elsewhere; the tree compiles, links, runs and reads wrong bytes.
 *
 * The fixture is the real one that cost a debug cycle: the 21-byte .tbl header,
 * whose unaligned dwords at 0x09/0x0D/0x11 a 32-bit compiler places at 12/16/20,
 * making the struct 24 bytes and sending STRTABLE_CalculateCRC off the end of the
 * buffer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { requiresPacking, fieldAlignment } from '../codegen/struct-packing.js';
import { generateStructDeclaration } from '../codegen/header.js';
import type { StructField, ExtractedStruct } from '../types.js';

const f = (name: string, dataType: string, offset: number, size: number): StructField =>
  ({ name, dataType, offset, size } as StructField);

/** 1.14d .tbl header, exactly as Ghidra models it after v854. */
const TBL_HEADER: StructField[] = [
  f('wCRC', 'ushort', 0x00, 2),
  f('wIndexCount', 'ushort', 0x02, 2),
  f('nNodeCount', 'int', 0x04, 4),
  f('bVersion', 'byte', 0x08, 1),
  f('dwDataStartOffset', 'uint32_t', 0x09, 4),
  f('nHashMaxTries', 'int', 0x0d, 4),
  f('dwFileSize', 'uint32_t', 0x11, 4),
];

describe('requiresPacking', () => {
  it('detects the .tbl header, whose dwords sit at 0x09/0x0D/0x11', () => {
    assert.strictEqual(requiresPacking(TBL_HEADER), true);
  });

  it('leaves a naturally-aligned struct alone', () => {
    assert.strictEqual(requiresPacking([
      f('a', 'int', 0, 4), f('b', 'int', 4, 4), f('c', 'ushort', 8, 2),
    ]), false);
  });

  it('treats a larger declared offset as explicit padding, not a conflict', () => {
    // Ghidra models real filler; a gap the compiler would also produce is not
    // evidence of packing.
    assert.strictEqual(requiresPacking([
      f('a', 'byte', 0, 1), f('b', 'int', 4, 4),
    ]), false);
  });

  it('an array aligns like its ELEMENT, so char[260] forces nothing', () => {
    // Sizing a char[260] as 260-aligned would invent a packing requirement.
    assert.strictEqual(fieldAlignment('char[260]'), 1);
    assert.strictEqual(requiresPacking([
      f('szName', 'char[260]', 0, 260), f('n', 'int', 260, 4),
    ]), false);
  });

  it('pointers are 4-aligned on this target', () => {
    assert.strictEqual(fieldAlignment('D2UnitStrc *'), 4);
    assert.strictEqual(requiresPacking([
      f('p', 'D2UnitStrc *', 0, 4), f('q', 'char *', 4, 4),
    ]), false);
  });

  // The safety rule: never add `packed` on a hunch. Changing a struct's ABI
  // because a field type could not be sized would be worse than the silence.
  it('an unsizeable field type makes the struct undecidable, not packed', () => {
    assert.strictEqual(fieldAlignment('D2SomeNestedStrc'), undefined);
    assert.strictEqual(requiresPacking([
      f('a', 'D2SomeNestedStrc', 0, 12), f('b', 'int', 13, 4),
    ]), false);
  });

  it('a struct with fewer than two positioned fields cannot disagree', () => {
    assert.strictEqual(requiresPacking([f('only', 'int', 0, 4)]), false);
  });
});

describe('generateStructDeclaration applies derived packing', () => {
  it('emits __attribute__((packed)) for the .tbl header', () => {
    const out = generateStructDeclaration({
      name: 'D2StringTableTblFileStrc', category: '/Diablo2/UI', size: 21,
      kind: 'STRUCTURE', fields: TBL_HEADER,
    } as ExtractedStruct);
    assert.match(out, /struct __attribute__\(\(packed\)\) D2StringTableTblFileStrc \{/);
    assert.match(out, /dwDataStartOffset/);
  });

  it('does not pack a naturally-aligned struct', () => {
    const out = generateStructDeclaration({
      name: 'D2PlainStrc', category: '/Diablo2', size: 8, kind: 'STRUCTURE',
      fields: [f('a', 'int', 0, 4), f('b', 'int', 4, 4)],
    } as ExtractedStruct);
    assert.doesNotMatch(out, /packed/);
  });
});
