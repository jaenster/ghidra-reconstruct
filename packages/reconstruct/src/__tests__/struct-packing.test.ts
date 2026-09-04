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
import { requiresPacking, fieldAlignment, adoptGhidraLayout } from '../codegen/struct-packing.js';
import { generateStructDeclaration, generateClassDeclaration } from '../codegen/header.js';
import type { StructField, ExtractedStruct, DetectedClass, ReconstructOptions } from '../types.js';

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
  it('an unsizeable field type with no recorded alignment stays undecidable', () => {
    assert.strictEqual(fieldAlignment('D2SomeNestedStrc'), undefined);
    assert.strictEqual(requiresPacking([
      f('a', 'D2SomeNestedStrc', 0, 12), f('b', 'int', 13, 4),
    ]), false);
  });

  it('a struct with fewer than two positioned fields cannot disagree', () => {
    assert.strictEqual(requiresPacking([f('only', 'int', 0, 4)]), false);
  });
});

/**
 * Undecidable is not "no". Ghidra records an `alignment` per structure and 914
 * of the 1063 non-mac structures carry `alignment: 1` - Ghidra saying, in its
 * own words, that it laid the struct out packed. Deriving nothing and then
 * emitting nothing threw that answer away: the emitter packed 124 structs where
 * the database named 914, and every struct the cross compiler proved mislaid
 * was in the gap.
 */
describe('requiresPacking defers to Ghidra when the derivation is undecidable', () => {
  const NESTED = [f('a', 'D2SomeNestedStrc', 0, 12), f('b', 'int', 13, 4)];

  it('packs an undecidable struct that Ghidra records as alignment 1', () => {
    assert.strictEqual(requiresPacking(NESTED, 1), true);
  });

  it('does NOT pack an undecidable struct Ghidra aligns naturally', () => {
    assert.strictEqual(requiresPacking(NESTED, 4), false);
  });

  it('a bitfield is unsizeable, so a bitfield struct rides on the alignment', () => {
    // `fieldAlignment` has no entry for `int:1` and cannot invent one - the
    // storage unit is not in the spelling. D2SkillsTxt reaches the fallback
    // through exactly this branch.
    assert.strictEqual(fieldAlignment('int:1'), undefined);
    const fields = [
      f('skill', 'short', 0, 2),
      f('decquant', 'int:1', 4, 1),
      f('charclass', 'char', 5, 1),
    ];
    assert.strictEqual(requiresPacking(fields, 1), true);
    assert.strictEqual(requiresPacking(fields), false);
  });

  it('a missing or non-positive size is undecidable the same way', () => {
    const fields = [f('a', 'int', 0, 0), f('b', 'int', 4, 4)];
    assert.strictEqual(requiresPacking(fields, 1), true);
    assert.strictEqual(requiresPacking(fields, 4), false);
  });

  it('alignment 1 never OVERRIDES a derivation that already said no', () => {
    // The positive derivation is unchanged: a struct whose declared offsets
    // natural C layout reproduces exactly stays unpacked, whatever Ghidra's
    // alignment says. Packing it would be a change with no evidence behind it.
    assert.strictEqual(requiresPacking([
      f('a', 'int', 0, 4), f('b', 'int', 4, 4), f('c', 'ushort', 8, 2),
    ], 1), false);
  });
});

describe('generateStructDeclaration reads the alignment off the structure', () => {
  const undecidable = (alignment?: number): ExtractedStruct => ({
    name: 'D2UndecidableStrc', category: '/Diablo2', size: 17, kind: 'STRUCTURE',
    alignment,
    fields: [f('a', 'D2SomeNestedStrc', 0, 12), f('b', 'int', 13, 4)],
  } as ExtractedStruct);

  it('packs when Ghidra records alignment 1', () => {
    assert.match(generateStructDeclaration(undecidable(1)),
      /struct __attribute__\(\(packed\)\) D2UndecidableStrc \{/);
  });

  it('leaves it alone when Ghidra records a natural alignment', () => {
    assert.doesNotMatch(generateStructDeclaration(undecidable(4)), /packed/);
  });

  it('leaves it alone when the structure carries no alignment at all', () => {
    assert.doesNotMatch(generateStructDeclaration(undecidable()), /packed/);
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


/**
 * A struct can place every field correctly and still be the wrong SIZE.
 *
 * C rounds a struct's total up to the struct's own alignment; Ghidra does not.
 * `D2ConfigControlDescStrc` is 10 bytes in the database and 12 in C. Every
 * `offsetof` agrees, so the offset derivation sees nothing - but `sizeof` is
 * the array stride, so an array of one reads the wrong row from element 1 on,
 * and every allocation sized by `sizeof` is over-large. `layout_check.py`
 * caught three of these against the emitted tree before the generator could.
 */
describe('requiresPacking catches trailing padding the offsets cannot show', () => {
  // 10 declared bytes; a 4-aligned struct, so C rounds the total to 12.
  const TAIL_PAD: StructField[] = [
    f('a', 'int', 0, 4), f('b', 'int', 4, 4), f('c', 'ushort', 8, 2),
  ];

  it('packs when C\'s natural total exceeds the size Ghidra records', () => {
    assert.strictEqual(requiresPacking(TAIL_PAD, 1, 10), true);
  });

  it('does not pack when the natural total already matches', () => {
    assert.strictEqual(requiresPacking(TAIL_PAD, 1, 12), false);
  });

  it('does not pack when Ghidra declares MORE than the fields need', () => {
    // A bigger declared size is trailing filler the database models on
    // purpose, and packing removes bytes - it can never add them.
    assert.strictEqual(requiresPacking(TAIL_PAD, 1, 16), false);
  });

  it('does not pack when the fields overrun the declared size', () => {
    // A degenerate record packing cannot rescue; do not touch the ABI for it.
    assert.strictEqual(requiresPacking(TAIL_PAD, 1, 8), false);
  });

  it('needs the size: without it the struct still reads as naturally laid out', () => {
    assert.strictEqual(requiresPacking(TAIL_PAD, 1), false);
    assert.strictEqual(requiresPacking(TAIL_PAD), false);
  });

  it('the trigger does not depend on Ghidra alignment', () => {
    // Trigger 3 is derived, not deferred: the size disagreement is proof on
    // its own, whatever alignment the database happens to record.
    assert.strictEqual(requiresPacking(TAIL_PAD, undefined, 10), true);
  });

  it('generateStructDeclaration reads the size off the structure', () => {
    const mk = (size: number): ExtractedStruct => ({
      name: 'D2ConfigControlDescStrc', category: '/Diablo2', size,
      kind: 'STRUCTURE', alignment: 1, fields: TAIL_PAD,
    } as ExtractedStruct);
    assert.match(generateStructDeclaration(mk(10)),
      /struct __attribute__\(\(packed\)\) D2ConfigControlDescStrc \{/);
    assert.doesNotMatch(generateStructDeclaration(mk(12)), /packed/);
  });
});

/**
 * A class here is a Ghidra structure that acquired methods, so it carries the
 * same layout obligation - and got no check at all until its `alignment` and
 * `size` travelled with its fields. `applyMethodConversions` synthesises the
 * class with `fields: []`, and the header emitter fills those in from the
 * matching `ExtractedStruct`; the numbers now come along for the ride.
 */
describe('adoptGhidraLayout carries layout, not just fields', () => {
  it('takes fields, alignment and size from the source structure', () => {
    const cls = { fields: [] as StructField[] } as DetectedClass;
    adoptGhidraLayout(cls, {
      fields: [f('a', 'int', 0, 4)], alignment: 1, size: 5,
    });
    assert.strictEqual(cls.fields.length, 1);
    assert.strictEqual(cls.alignment, 1);
    assert.strictEqual(cls.size, 5);
  });

  it('keeps fields that arrived first, but still adopts the numbers', () => {
    // The order the pipeline actually runs in: class detection sets the fields,
    // the header emitter later sees the same structure. Overwriting the fields
    // would undo work; leaving the numbers unset was the bug.
    const own = [f('kept', 'int', 0, 4)];
    const cls = { fields: own } as DetectedClass;
    adoptGhidraLayout(cls, { fields: [f('other', 'char', 0, 1)], alignment: 1, size: 5 });
    assert.strictEqual(cls.fields, own);
    assert.strictEqual(cls.alignment, 1);
  });

  it('never overwrites numbers the target already has', () => {
    const cls = { fields: [], alignment: 4, size: 8 } as unknown as DetectedClass;
    adoptGhidraLayout(cls, { fields: [], alignment: 1, size: 5 });
    assert.strictEqual(cls.alignment, 4);
    assert.strictEqual(cls.size, 8);
  });

  it('leaves a class with no matching structure untouched', () => {
    // Nothing to take an alignment from, so nothing is invented - and an
    // undefined alignment never packs.
    const cls = { fields: [] as StructField[] } as DetectedClass;
    adoptGhidraLayout(cls, {});
    assert.strictEqual(cls.alignment, undefined);
    assert.strictEqual(cls.size, undefined);
  });
});

describe('generateClassDeclaration packs a class-shaped aggregate', () => {
  const OPTS = { outputDir: '/tmp', format: 'cpp', organization: 'namespace' } as ReconstructOptions;

  const cls = (extra: Partial<DetectedClass>): DetectedClass => ({
    name: 'D2BitBufferStrc', namespace: 'Fog', methods: [], baseClasses: [],
    fields: [f('a', 'D2SomeNestedStrc', 0, 12), f('b', 'int', 13, 4)],
    ...extra,
  } as DetectedClass);

  it('packs when the class carries Ghidra alignment 1', () => {
    const out = generateClassDeclaration(cls({ alignment: 1 }), [], OPTS, null, true);
    assert.match(out, /struct __attribute__\(\(packed\)\) D2BitBufferStrc \{/);
  });

  it('packs on the trailing-padding trigger too', () => {
    const out = generateClassDeclaration(
      cls({ alignment: 1, size: 10, fields: [f('a', 'int', 0, 4), f('b', 'ushort', 4, 2), f('c', 'int', 6, 4)] }),
      [], OPTS, null, true);
    assert.match(out, /__attribute__\(\(packed\)\)/);
  });

  it('leaves a class with no recorded alignment alone', () => {
    const out = generateClassDeclaration(cls({}), [], OPTS, null, true);
    assert.doesNotMatch(out, /packed/);
    assert.match(out, /struct D2BitBufferStrc \{/);
  });

  it('keeps the base clause when it packs', () => {
    const out = generateClassDeclaration(
      cls({ alignment: 1, baseClasses: ['D2BaseStrc'] }), [], OPTS, null, false);
    assert.match(out, /class __attribute__\(\(packed\)\) D2BitBufferStrc : public D2BaseStrc \{/);
  });
});
