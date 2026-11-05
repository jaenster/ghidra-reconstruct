/**
 * A class's vtable data and its member functions hang under a namespace named
 * after the class, so `namespace D2Client::ButtonWrapper` and the root-scope
 * `struct ButtonWrapper` coexist. Inside `namespace D2Client` the NAMESPACE wins
 * unqualified lookup and the type name stops naming a type, which is a syntax
 * error at every use. The type has to be spelled `::ButtonWrapper`.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { setShadowedTypeNames, rootQualifyShadowedType, isVoidPointerSpelling, emittedParameterName } from '../codegen/platform-types.js';

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

/**
 * A FUNCTION shadows a same-named type exactly the way a namespace does, and
 * Ghidra makes the collision wholesale: 53 functions carry the name of the
 * funcdef that describes them (`Push`, `Draw`, `Key`, `Release`,
 * `fpDrawGroundTile`). The typedef is emitted at ROOT scope, the function inside
 * its own namespace, so inside that namespace the FUNCTION wins unqualified
 * lookup and `Push pPush;` stops parsing.
 */
describe('a function shadowing its own funcdef', () => {
  afterEach(() => setShadowedTypeNames(undefined));

  it('is respelled root-qualified like any other shadowed type', () => {
    setShadowedTypeNames(new Set(['Push', 'fpDrawGroundTile']));
    assert.equal(rootQualifyShadowedType('Push'), '::Push');
    assert.equal(rootQualifyShadowedType('Push *'), '::Push *');
    assert.equal(rootQualifyShadowedType('fpDrawGroundTile'), '::fpDrawGroundTile');
  });
});

/**
 * The parameter-name rule and its one implementation.
 *
 * `eD2ItemFlag eD2ItemFlag` hides its own type, so such a parameter is emitted
 * as `n<name>`. The rule lived in three places and only the BODY-rename copy
 * stripped a leading `::`. The moment a parameter's type became root-qualified
 * — which is exactly what the shadowing above does — the body renamed the
 * parameter and the two signature emitters did not: the declaration read
 * `::fpRequiredUserAction fpRequiredUserAction` while the body still said
 * `nfpRequiredUserAction`, undeclared. Measured at +6 errors across three files.
 */
describe('emittedParameterName', () => {
  it('renames a parameter that hides its own type', () => {
    assert.equal(emittedParameterName('eD2ItemFlag', 'eD2ItemFlag'), 'neD2ItemFlag');
    assert.equal(emittedParameterName('Item', 'struct Item *'), 'nItem');
  });

  it('sees through a root qualifier, so all three emitters agree', () => {
    assert.equal(
      emittedParameterName('fpRequiredUserAction', '::fpRequiredUserAction'),
      'nfpRequiredUserAction'
    );
    assert.equal(emittedParameterName('Item', 'struct ::Item *'), 'nItem');
  });

  it('leaves a parameter whose name differs from its type alone', () => {
    assert.equal(emittedParameterName('pUnit', 'D2UnitStrc *'), 'pUnit');
    assert.equal(emittedParameterName('nCount', '::Push'), 'nCount');
  });
});

/**
 * A global's declarator is a use site like any other. `pFormTextAndEditBox` lives
 * in `namespace D2Win::Src::D2WinMain`, where the sibling unit namespace
 * `D2Win::Src::D2WinEditBox` hides the root-scope `struct D2WinEditBox`: the
 * extern in globals.h and the definition in globals/D2Win.cpp must spell
 * `::D2WinEditBox`, or neither parses (Game.exe v1937).
 */
describe('a global declared with a shadowed type', () => {
  afterEach(() => setShadowedTypeNames(undefined));

  it('root-qualifies the type of a scalar, an array and a pointer-to-array declarator', async () => {
    const { normalizeArrayDeclaration } = await import('../codegen/globals-header.js');
    setShadowedTypeNames(new Set(['D2WinEditBox']));
    assert.equal(normalizeArrayDeclaration('D2WinEditBox *', 'pFormTextAndEditBox'), '::D2WinEditBox * pFormTextAndEditBox');
    assert.equal(normalizeArrayDeclaration('D2WinEditBox *[4]', 'apBoxes'), '::D2WinEditBox * apBoxes[4]');
    assert.equal(normalizeArrayDeclaration('D2WinEditBox[2] *', 'pPair'), '::D2WinEditBox (*pPair)[2]');
    assert.equal(normalizeArrayDeclaration('D2ControlStrc *', 'pFormsList'), 'D2ControlStrc * pFormsList');
  });
});
