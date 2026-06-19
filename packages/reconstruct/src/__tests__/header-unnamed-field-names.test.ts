/**
 * Regression test: unnamed struct/union members must be emitted with Ghidra's
 * DECOMPILER auto-name, because function bodies reference them by that name.
 *
 * Ghidra's default field name:
 *   - union member at ordinal i      → `field<i>`        (e.g. field0, field1)
 *   - struct member at ordinal i/off → `field<i>_0x<off>` (e.g. field2_0x1f44)
 *
 * The codegen previously emitted `_pad_0x<off>_<i>` for these, so bodies
 * accessing `Coords.field0` / `s.field2_0x1f44` failed with
 * "has no member named 'field0'".
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  generateStructDeclaration,
  generateUnionDeclaration,
} from '../codegen/header.js';
import type { ExtractedStruct, ExtractedUnion } from '../types.js';

describe('unnamed struct/union members use Ghidra decompiler auto-names', () => {
  it('emits field<i> for unnamed union members (not _pad_*)', () => {
    const union: ExtractedUnion = {
      kind: 'UNION',
      name: 'D2DynamicPathCoordsUnion',
      category: '/test',
      size: 8,
      fields: [
        { name: '', dataType: 'D2DynamicPathCoordsStrc', offset: 0, size: 8 },
        { name: '', dataType: 'POINT', offset: 0, size: 8 },
      ],
    };

    const out = generateUnionDeclaration(union);

    assert.match(out, /D2DynamicPathCoordsStrc field0;/);
    assert.match(out, /POINT field1;/);
    assert.doesNotMatch(out, /_pad_/);
  });

  it('emits field<i>_0x<offset> for unnamed struct members (not _pad_*)', () => {
    const struct: ExtractedStruct = {
      kind: 'STRUCTURE',
      name: 'SomeStrc',
      category: '/test',
      size: 0x1f48,
      fields: [
        { name: 'nReal', dataType: 'int', offset: 0, size: 4 },
        // unnamed typed member the decompiler refers to as field2_0x1f44
        { name: '', dataType: 'D2UnitStrc', offset: 0x1f44, size: 4 },
      ],
    };

    const out = generateStructDeclaration(struct);

    assert.match(out, /int nReal;/);
    assert.match(out, /D2UnitStrc field1_0x1f44;/);
    assert.doesNotMatch(out, /_pad_/);
  });

  it('still collapses genuine undefined1 filler into _pad_ arrays', () => {
    const struct: ExtractedStruct = {
      kind: 'STRUCTURE',
      name: 'FillerStrc',
      category: '/test',
      size: 8,
      fields: [
        { name: 'a', dataType: 'int', offset: 0, size: 4 },
        { name: '', dataType: 'undefined1', offset: 4, size: 1 },
        { name: '', dataType: 'undefined1', offset: 5, size: 1 },
        { name: '', dataType: 'undefined1', offset: 6, size: 1 },
        { name: '', dataType: 'undefined1', offset: 7, size: 1 },
      ],
    };

    const out = generateStructDeclaration(struct);

    // Consecutive unnamed undefined1 bytes are real filler the decompiler
    // never references — they must stay collapsed as a _pad_ array.
    assert.match(out, /uint8_t _pad_0x04\[4\];/);
  });
});
