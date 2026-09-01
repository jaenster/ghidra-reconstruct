/**
 * Regression test: the DECLARATION and the REFERENCE of a symbol whose Ghidra
 * namespace repeats a segment must be spelled the same way.
 *
 * Ghidra names a symbol `Module::Dir::File::Sym`, and when a directory and the
 * file inside it share a name the segment repeats: `D2Game::Quests::Quests::A1Q6`.
 * Every declaration path collapses that (organizeByNamespace via normalizeUnitName,
 * impl.ts and header.ts via collapseConsecutiveDuplicates), so the definition lands
 * in `namespace D2Game::Quests::A1Q6`. Data initializers, however, were emitted
 * straight from Ghidra's raw symbol path, so the reference named a scope that does
 * not exist:
 *
 *   D2Game/Objects/Objects.cpp:382  &Quests::Quests::A1Q6::Objects_InitFn04
 *
 * 88 of those in 1.14d, all reported as
 * "'D2Game::Quests::Quests' has not been declared".
 *
 * The three-deep form (`D2Common::Skills::Skills::MakeMissile`) is the SAME rule,
 * not a special case — it only survived because it was already collapsed on both
 * sides. What must NOT be collapsed is a symbol whose own name repeats its
 * namespace's last segment, which is why only the QUALIFIER is normalized.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  normalizeQualifiedReference,
  collapseConsecutiveDuplicates,
  normalizeUnitName,
  setNamespaceCollisionTypes,
} from '../codegen/namespace.js';
import { emitDataValue } from '../codegen/globals-header.js';
import type { DataValue } from '../types.js';

describe('doubled namespace segments agree between declaration and reference', () => {
  it('collapses the qualifier the same way the declaration side does', () => {
    const raw = 'D2Game::Quests::Quests::A1Q6::Objects_InitFn04';
    // The declaration side: this symbol's functions are organized into this unit.
    assert.strictEqual(normalizeUnitName('D2Game::Quests::Quests::A1Q6'), 'D2Game::Quests::A1Q6');
    // The reference side must land on the same scope.
    assert.strictEqual(
      normalizeQualifiedReference(raw),
      'D2Game::Quests::A1Q6::Objects_InitFn04'
    );
  });

  it('applies to the three-deep Module::Dir::File form too', () => {
    assert.strictEqual(
      normalizeQualifiedReference('D2Common::Skills::Skills::MakeMissile'),
      collapseConsecutiveDuplicates('D2Common::Skills::Skills') + '::MakeMissile'
    );
  });

  it('leaves a symbol named after its own namespace alone', () => {
    // Only the qualifier is collapsed — `Foo::Foo` here is namespace Foo, symbol Foo.
    assert.strictEqual(normalizeQualifiedReference('Foo::Foo'), 'Foo::Foo');
    assert.strictEqual(normalizeQualifiedReference('A::B::B'), 'A::B::B');
  });

  it('strips a last qualifier that collides with a type, exactly as the declaration does', () => {
    // `D2Client::Chat::IgnoreList::Fn` is DECLARED in `namespace D2Client::Chat`
    // because IgnoreList is also a struct name; the reference has to follow.
    setNamespaceCollisionTypes(new Set(['IgnoreList', 'WardenClient']));
    try {
      assert.strictEqual(
        normalizeQualifiedReference('D2Client::Chat::IgnoreList::ChatIgnoreList_Destructor'),
        'D2Client::Chat::ChatIgnoreList_Destructor'
      );
      // A single leading qualifier that is a type name is a class qualifier, not a
      // namespace — it must survive.
      assert.strictEqual(
        normalizeQualifiedReference('IgnoreList::Method'),
        'IgnoreList::Method'
      );
    } finally {
      setNamespaceCollisionTypes(new Set());
    }
  });

  it('leaves an unqualified name alone', () => {
    assert.strictEqual(normalizeQualifiedReference('OBJOP_ToggleDoor'), 'OBJOP_ToggleDoor');
  });

  it('normalizes address-taken references inside a data initializer', () => {
    const table: DataValue = {
      kind: 'array',
      elements: [
        { kind: 'pointer', value: 'D2Game::Quests::Quests::A1Q6::Objects_InitFn04' },
        { kind: 'pointer', value: 'D2Game::Quests::Quests::A1Q4::Objects_InitFn06' },
      ],
    };
    const emitted = emitDataValue(table, 0, 'D2ObjectInitFnFunc[2]');
    assert.ok(
      !emitted.includes('Quests::Quests'),
      `reference kept the doubled segment: ${emitted}`
    );
    assert.match(emitted, /&D2Game::Quests::A1Q6::Objects_InitFn04/);
    assert.match(emitted, /&D2Game::Quests::A1Q4::Objects_InitFn06/);
  });
});
