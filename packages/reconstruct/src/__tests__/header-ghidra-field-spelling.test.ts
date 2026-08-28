/**
 * A declared member name has to be the name Ghidra's DECOMPILER puts in the
 * bodies — the declaration side and the use side are not free to disagree.
 *
 * Two spellings were out of step:
 *
 *   1. A field name that is not a legal C identifier. Ghidra repairs it by
 *      REPLACING each illegal character with `_`, so `Day Event` is written
 *      `Day_Event` and `0x1D` is written `_x1D`. The generator instead PREFIXED
 *      a digit-leading name (`field_0x1D`), which no body ever spells.
 *      `D2UIFlagStrc` really does carry members named `0x1D`/`0x1E`/`0x20`.
 *
 *   2. A LONE unnamed `undefined` byte. Inside a run of them the generator
 *      already emits the decompiler's undefined-space name `field_0x<off>`; a
 *      run of one fell through to the ordinal-bearing `field<i>_0x<off>` that
 *      the decompiler only uses for a *typed* unnamed member.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateStructDeclaration } from '../codegen/header.js';
import type { ExtractedStruct } from '../types.js';

function struct(name: string, fields: ExtractedStruct['fields'], size = 0): ExtractedStruct {
  return { kind: 'STRUCTURE', name, category: '/', size, fields };
}

describe('declared field names match Ghidra decompiler spelling', () => {
  it('repairs a digit-leading field name by replacing the digit, not prefixing', () => {
    const out = generateStructDeclaration(
      struct('D2UIFlagStrc', [
        { name: 'GuildVault', dataType: 'BOOL', offset: 0, size: 4 },
        { name: '0x1D', dataType: 'BOOL', offset: 4, size: 4 },
        { name: '0x1E', dataType: 'BOOL', offset: 8, size: 4 },
        { name: 'FullBelt', dataType: 'BOOL', offset: 12, size: 4 },
        { name: '0x20', dataType: 'BOOL', offset: 16, size: 4 },
      ], 20),
    );

    assert.match(out, /\b_x1D;/);
    assert.match(out, /\b_x1E;/);
    assert.match(out, /\b_x20;/);
    assert.doesNotMatch(out, /field_0x1D/);
    assert.doesNotMatch(out, /field_0x1E/);
    assert.doesNotMatch(out, /field_0x20/);
  });

  it('still replaces every other illegal character with an underscore', () => {
    const out = generateStructDeclaration(
      struct('D2SoundEnvironTxt', [
        { name: 'Day Event', dataType: 'int', offset: 0, size: 4 },
        { name: 'EAX Room HF', dataType: 'int', offset: 4, size: 4 },
      ], 8),
    );

    assert.match(out, /\bDay_Event;/);
    assert.match(out, /\bEAX_Room_HF;/);
  });

  it('names a lone unnamed undefined byte field_0x<off>, with no ordinal', () => {
    const out = generateStructDeclaration(
      struct('mcp0x03data', [
        { name: 'nGameFlags', dataType: 'int', offset: 0x40, size: 4 },
        { name: '', dataType: 'undefined', offset: 0x44, size: 1 },
        { name: 'nDifference', dataType: 'char', offset: 0x45, size: 1 },
      ], 0x46),
    );

    assert.match(out, /\bfield_0x44;/);
    assert.doesNotMatch(out, /field\d+_0x44/);
    assert.match(out, /\bnDifference;/);
  });

  it('keeps the ordinal for an unnamed member that has a real type', () => {
    const out = generateStructDeclaration(
      struct('SomeStrc', [
        { name: 'nReal', dataType: 'int', offset: 0, size: 4 },
        { name: '', dataType: 'D2UnitStrc', offset: 0x1f44, size: 4 },
      ], 0x1f48),
    );

    assert.match(out, /D2UnitStrc field1_0x1f44;/);
  });
});
