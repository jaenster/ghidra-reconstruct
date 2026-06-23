/**
 * Tests for buildBitfieldCatalog — the (byte offset, mask) → bitfield-name map
 * consumed by the bitfield-access transform.
 *
 * The catalog is global (keyed only by offset+mask) because the transform runs on
 * parsed function bodies with no resolved struct type on the base expression. These
 * tests pin the anti-contamination invariant: a key is emitted only when it is
 * unambiguously safe across EVERY struct in the program.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { buildBitfieldCatalog } from '../codegen/index.js';
import type { ExtractedDataType, ExtractedStruct } from '../types.js';

function struct(name: string, fields: ExtractedStruct['fields']): ExtractedStruct {
  return { kind: 'STRUCTURE', name, category: '/', size: 0, fields };
}

function bf(name: string, offset: number, width: number): ExtractedStruct['fields'][number] {
  // Bitfield fields are encoded as `<base>:<width>` in dataType.
  return { name, dataType: `byte:${width}`, offset, size: 1 };
}

function byte(name: string, offset: number, size = 1): ExtractedStruct['fields'][number] {
  return { name, dataType: 'undefined1', offset, size };
}

describe('buildBitfieldCatalog', () => {
  it('maps a single-bit named bitfield to (offset,mask)', () => {
    const dts: ExtractedDataType[] = [
      struct('D2MonStatsTxt', [bf('isSpawn', 0xc, 1), bf('isMelee', 0xc, 1)]),
    ];
    const catalog = buildBitfieldCatalog(dts);
    assert.strictEqual(catalog.get('field_0xc:1'), 'isSpawn');
    assert.strictEqual(catalog.get('field_0xc:2'), 'isMelee');
  });

  it('does NOT contaminate a struct that has a plain byte at the same offset', () => {
    // Struct A defines `soft` bitfield at offset 0x5 / mask 0x10.
    // Struct B (D2SkillsTxt) has a plain undefined byte at offset 0x5.
    // Applying field_0x5 & 0x10 → soft on B would be wrong, so the key must be dropped.
    const dts: ExtractedDataType[] = [
      struct('SomeFlags', [
        // pad bits up to bit 4 so `soft` lands on mask 0x10
        bf('_a', 0x5, 4),
        bf('soft', 0x5, 1),
      ]),
      struct('D2SkillsTxt', [
        byte('nameField', 0x0, 4),
        byte('field_0x5', 0x5, 1), // plain byte at the contended offset
      ]),
    ];
    const catalog = buildBitfieldCatalog(dts);
    assert.ok(
      !catalog.has('field_0x5:16'),
      `field_0x5:16 must be dropped (D2SkillsTxt has a plain byte at 0x5), got: ${catalog.get('field_0x5:16')}`
    );
  });

  it('keeps a same-struct rename when no other struct collides at that offset', () => {
    const dts: ExtractedDataType[] = [
      struct('D2MonStatsTxt', [bf('isSpawn', 0xc, 1)]),
      // unrelated struct, different offset — no collision at 0xc
      struct('D2SkillsTxt', [byte('field_0x5', 0x5, 1)]),
    ];
    const catalog = buildBitfieldCatalog(dts);
    assert.strictEqual(catalog.get('field_0xc:1'), 'isSpawn');
  });

  it('drops a key when two structs disagree on the bitfield name (collision)', () => {
    const dts: ExtractedDataType[] = [
      struct('A', [bf('alpha', 0x3, 1)]),
      struct('B', [bf('beta', 0x3, 1)]),
    ];
    const catalog = buildBitfieldCatalog(dts);
    assert.ok(!catalog.has('field_0x3:1'), 'conflicting names must drop the key');
  });

  it('drops when a multi-byte field overlaps the bitfield byte in another struct', () => {
    const dts: ExtractedDataType[] = [
      struct('Flags', [bf('flagBit', 0x8, 1)]),
      // 4-byte int spanning 0x6..0x9 covers 0x8
      struct('Other', [byte('someInt', 0x6, 4)]),
    ];
    const catalog = buildBitfieldCatalog(dts);
    assert.ok(!catalog.has('field_0x8:1'), 'overlapping multi-byte field must drop the key');
  });
});
