/**
 * A class's vtable data and its member functions hang under a namespace named
 * after the class, so `namespace D2Client::ButtonWrapper` and the root-scope
 * `struct ButtonWrapper` coexist. Inside `namespace D2Client` the NAMESPACE wins
 * unqualified lookup and the type name stops naming a type, which is a syntax
 * error at every use. The type has to be spelled `::ButtonWrapper`.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { setShadowedTypeNames, rootQualifyShadowedType, isVoidPointerSpelling } from '../codegen/platform-types.js';

describe('rootQualifyShadowedType', () => {
  afterEach(() => setShadowedTypeNames(undefined));

  it('root-qualifies only the names a namespace shadows', () => {
    setShadowedTypeNames(new Set(['ButtonWrapper', 'Draw']));
    assert.equal(rootQualifyShadowedType('ButtonWrapper *'), '::ButtonWrapper *');
    assert.equal(rootQualifyShadowedType('Draw'), '::Draw');
    assert.equal(rootQualifyShadowedType('D2UnitStrc *'), 'D2UnitStrc *');
  });

  it('keeps an elaborated specifier in front of the qualifier', () => {
    setShadowedTypeNames(new Set(['Item']));
    assert.equal(rootQualifyShadowedType('struct Item *'), 'struct ::Item *');
    assert.equal(rootQualifyShadowedType('const struct Item *'), 'const struct ::Item *');
  });

  it('leaves an already-qualified name alone (idempotent)', () => {
    setShadowedTypeNames(new Set(['Item']));
    assert.equal(rootQualifyShadowedType('::Item *'), '::Item *');
  });

  it('is inert until a table is registered', () => {
    assert.equal(rootQualifyShadowedType('ButtonWrapper *'), 'ButtonWrapper *');
  });
});

describe('isVoidPointerSpelling', () => {
  it('recognises every spelling Ghidra uses for a void-pointer slot', () => {
    for (const t of ['void*', 'void *', 'pointer', 'LPVOID', 'PVOID']) {
      assert.ok(isVoidPointerSpelling(t), t);
    }
  });

  it('does not treat a typed pointer or a funcdef as a void slot', () => {
    for (const t of ['D2UnitStrc *', 'Mouse', 'void**', undefined]) {
      assert.ok(!isVoidPointerSpelling(t), String(t));
    }
  });
});
