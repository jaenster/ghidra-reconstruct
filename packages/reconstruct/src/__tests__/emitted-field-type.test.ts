/**
 * `emittedFieldType` — the type spelling a struct field is actually emitted
 * with, which is what a cast into that field has to name.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { emittedFieldType, sigType } from '../codegen/header.js';

describe('emittedFieldType', () => {
  it("spells Ghidra's `string *` the way the struct declares it", () => {
    // CHANGED: the cast tables used to read `sigType`, which leaves this
    // `string*` — a type no header declares, so the cast failed to parse and
    // took the rest of the file with it (MonsterTbls.cpp: 6 -> 251 errors).
    assert.strictEqual(emittedFieldType('string *', 4), 'char *');
    assert.notStrictEqual(sigType('string *'), 'char *');
  });

  it('drops an array field — it is not a cast target', () => {
    assert.strictEqual(emittedFieldType('char[16]', 16), null);
    assert.strictEqual(emittedFieldType('string {60}', 60), null);
  });

  it('drops a bitfield', () => {
    assert.strictEqual(emittedFieldType('int:3', 4), null);
  });

  it('strips a Ghidra pointer-size annotation', () => {
    assert.strictEqual(emittedFieldType('D2UnitStrc *32', 4), 'D2UnitStrc *');
  });

  it('keeps a plain pointer field as declared', () => {
    assert.strictEqual(emittedFieldType('D2UnitStrc *', 4), 'D2UnitStrc *');
  });
});
