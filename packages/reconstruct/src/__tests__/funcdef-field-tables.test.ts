/**
 * `funcdefBaseName` — the step that turns a struct field's raw Ghidra type into
 * the funcdef that declares the call made through it.
 *
 * This is the only place the funcdef survives. A funcdef field is EMITTED as an
 * inline declarator (`int (*fpFind)(int, pointer)`), and `emittedFieldType`
 * rejects any spelling whose name sits in the middle — so the field is absent
 * from `structFields` and a call through it has no signature at all unless it is
 * read off the raw spelling here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { funcdefBaseName } from '../codegen/index.js';

describe('funcdefBaseName', () => {
  const decls = { fnFindPlayerToken: {}, fnLoad: {} };

  it('reads a funcdef behind a plain star', () => {
    assert.strictEqual(funcdefBaseName('fnLoad *', decls), 'fnLoad');
  });

  // Ghidra spells a pointer's WIDTH into the star, and `*32` is the spelling
  // most of these fields actually carry. Matching only a bare star finds the
  // minority of them and looks exactly like the mechanism working.
  it('reads a funcdef behind a width-annotated star', () => {
    assert.strictEqual(funcdefBaseName('fnFindPlayerToken *32', decls), 'fnFindPlayerToken');
  });

  it('reads a funcdef used with no indirection at all', () => {
    assert.strictEqual(funcdefBaseName('fnLoad', decls), 'fnLoad');
  });

  it('drops a pointer TO a function pointer, whose call shape is different', () => {
    assert.strictEqual(funcdefBaseName('fnLoad * *', decls), undefined);
    assert.strictEqual(funcdefBaseName('fnLoad *32 *32', decls), undefined);
  });

  it('ignores a name that is not a funcdef', () => {
    assert.strictEqual(funcdefBaseName('D2UnitStrc *32', decls), undefined);
    assert.strictEqual(funcdefBaseName('undefined *', decls), undefined);
  });

  it('ignores a spelling that is not a single name', () => {
    assert.strictEqual(funcdefBaseName('char[16]', decls), undefined);
    assert.strictEqual(funcdefBaseName('int:3', decls), undefined);
    assert.strictEqual(funcdefBaseName('', decls), undefined);
  });

  it('sees through const', () => {
    assert.strictEqual(funcdefBaseName('const fnLoad *', decls), 'fnLoad');
  });
});
