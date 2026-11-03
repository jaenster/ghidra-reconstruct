/**
 * Incremental emission reuses a unit's previous text only while the include block
 * of that text still matches the current placement.
 *
 * v1852 -> v1855: a new struct embedding D2UnitFindArgStrc and D2UnitFindDataStrc
 * by value pulled both types out of D2Game/D2UnitFindDataStrc.h (which then
 * disappeared) and into D2Common/Unit.h and D2Game/SKILLS/SkillsServer.h. Neither
 * type's definition changed, so no hash moved, and eight reused units kept
 * `#include "D2Game/D2UnitFindDataStrc.h"` - seven of them then failed to compile.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { enumMemberFact, recordEnumLookups, zeroEnumMember } from '../codegen/enum-lookups.js';
import {
  includeBasisHolds,
  answerPlacementLookup,
  type IncludeBasis,
  type PlacementLookup,
} from '../codegen/index.js';

function placement(
  owners: Record<string, string>,
  functions: Record<string, Array<{ qualified: string; header: string }>> = {},
  fields: Record<string, Record<string, string>> = {},
  templateHeader?: string,
  constructors: Record<string, string> = {},
): PlacementLookup {
  return {
    typeOwner: t => owners[t],
    functionHeaders: n => functions[n],
    fieldType: (t, f) => fields[t]?.[f],
    templateHeader,
    constructorFact: t => constructors[t] ?? '-',
  };
}

const v1852 = placement(
  {
    D2UnitFindDataStrc: 'D2Game/D2UnitFindDataStrc.h',
    D2UnitFindArgStrc: 'D2Game/D2UnitFindDataStrc.h',
    D2UnitStrc: 'D2Common/Unit.h',
  },
  { SKILLS_FindUnitsInRange: [{ qualified: 'D2Game::SKILLS::SkillsServer::SKILLS_FindUnitsInRange', header: 'D2Game/SKILLS/SkillsServer.h' }] },
  { D2UnitFindDataStrc: { pRoom: 'D2RoomStrc' } },
);

const v1855 = placement(
  {
    D2UnitFindDataStrc: 'D2Common/Unit.h',
    D2UnitFindArgStrc: 'D2Game/SKILLS/SkillsServer.h',
    D2UnitStrc: 'D2Common/Unit.h',
  },
  { SKILLS_FindUnitsInRange: [{ qualified: 'D2Game::SKILLS::SkillsServer::SKILLS_FindUnitsInRange', header: 'D2Game/SKILLS/SkillsServer.h' }] },
  { D2UnitFindDataStrc: { pRoom: 'D2RoomStrc' } },
);

/** What the dependency scan records for a unit that names the type and calls the finder. */
function recorded(now: PlacementLookup, graph: string[], keys: string[]): IncludeBasis {
  return { graph, lookups: keys.map(k => [k, answerPlacementLookup(k, now)] as [string, string]).sort() };
}

const GRAPH = ['D2Game/globals.h', 'D2Common/Unit.h'];

test('a type that moved header invalidates text that named it', () => {
  const basis = recorded(v1852, GRAPH, ['t:D2UnitFindDataStrc', 'f:SKILLS_FindUnitsInRange']);
  assert.equal(includeBasisHolds(basis, GRAPH, v1852), true);
  assert.equal(includeBasisHolds(basis, GRAPH, v1855), false);
});

test('a unit that names neither moved type keeps its text', () => {
  const basis = recorded(v1852, GRAPH, ['t:D2UnitStrc', 'f:SKILLS_FindUnitsInRange']);
  assert.equal(includeBasisHolds(basis, GRAPH, v1855), true);
});

test('a type whose header disappears answers differently, even reached only on a deref chain', () => {
  const gone = placement({ D2UnitStrc: 'D2Common/Unit.h' }, {}, { D2UnitFindDataStrc: { pRoom: 'D2RoomStrc' } });
  const basis = recorded(v1852, GRAPH, ['t:D2UnitFindDataStrc', 'c:D2UnitFindDataStrc.pRoom']);
  assert.equal(includeBasisHolds(basis, GRAPH, gone), false);
});

test('a changed graph-resolved include list invalidates the text', () => {
  const basis = recorded(v1852, GRAPH, ['t:D2UnitStrc']);
  assert.equal(includeBasisHolds(basis, [...GRAPH, 'D2Game/SKILLS/SkillsServer.h'], v1852), false);
  assert.equal(includeBasisHolds(basis, GRAPH.slice(0, 1), v1852), false);
});

test('a function that gained a second declaring header invalidates the text', () => {
  const basis = recorded(v1852, GRAPH, ['f:SKILLS_FindUnitsInRange']);
  const twice = placement({}, {
    SKILLS_FindUnitsInRange: [
      { qualified: 'D2Game::SKILLS::SkillsServer::SKILLS_FindUnitsInRange', header: 'D2Game/SKILLS/SkillsServer.h' },
      { qualified: 'D2Game::Monster::AI::SKILLS_FindUnitsInRange', header: 'D2Game/Monster/AI/AI.h' },
    ],
  });
  assert.equal(includeBasisHolds(basis, GRAPH, twice), false);
});

test('a field retyped on a deref chain invalidates the text', () => {
  const basis = recorded(v1852, GRAPH, ['c:D2UnitFindDataStrc.pRoom']);
  const retyped = placement({}, {}, { D2UnitFindDataStrc: { pRoom: 'D2ActiveRoomStrc' } });
  assert.equal(includeBasisHolds(basis, GRAPH, retyped), false);
});

test('a record without a basis is never reused', () => {
  assert.equal(includeBasisHolds(undefined, GRAPH, v1852), false);
});

/**
 * gen-1103: a struct no code holds by value gets no constructors, so its data is a
 * brace list. One function starting to hold it by value gives it constructors
 * again, and every unit whose data or body spells it must be written again.
 */
test('a struct gaining constructors invalidates text spelled without them', () => {
  const aggregate = placement({}, {}, {}, undefined, { D2MercWeaponAnimStrc: '-' });
  const converting = placement({}, {}, {}, undefined, { D2MercWeaponAnimStrc: 'ctor(nWeaponClass,nAnim)' });
  const basis = recorded(aggregate, GRAPH, ['k:D2MercWeaponAnimStrc']);
  assert.equal(includeBasisHolds(basis, GRAPH, aggregate), true);
  assert.equal(includeBasisHolds(basis, GRAPH, converting), false);
  assert.equal(includeBasisHolds(recorded(converting, GRAPH, ['k:D2MercWeaponAnimStrc']), GRAPH, aggregate), false);
});

/**
 * width-1104: compare-form keeps `X != ELEMENTAL_NONE` when every enum declaring the name
 * gives it 0. The function names neither enum, so no dependency edge reaches it; a
 * second enum gaining the name, or a value change, must still re-emit the unit.
 */
test('an enum member whose values across all enums change invalidates the text', () => {
  const v6 = { eElem: { ELEMENTAL_NONE: 0 }, eElemDWORD: { ELEMENTAL_NONE: 0 } };
  const at = (values: Record<string, Record<string, number>>): PlacementLookup =>
    ({ ...placement({}), enumMemberFact: n => enumMemberFact(values, n) });
  const basis = recorded(at(v6), GRAPH, ['e:ELEMENTAL_NONE']);
  assert.deepStrictEqual(basis.lookups, [['e:ELEMENTAL_NONE', '0']]);
  assert.equal(includeBasisHolds(basis, GRAPH, at({ ...v6, eOther: { ELEMENTAL_FIRE: 1 } })), true);
  assert.equal(includeBasisHolds(basis, GRAPH, at({ ...v6, eOther: { ELEMENTAL_NONE: 4 } })), false);
  assert.equal(includeBasisHolds(basis, GRAPH, at({ eElem: { ELEMENTAL_NONE: 1 }, eElemDWORD: { ELEMENTAL_NONE: 0 } })), false);
  assert.equal(includeBasisHolds(basis, GRAPH, at({})), false);
});

test('the zero-enum answer reports each member name it was asked about', () => {
  const asked: string[] = [];
  const values = { eElem: { ELEMENTAL_NONE: 0, ELEMENTAL_FIRE: 1 }, eOther: { MODE_NONE: 0, MODE_ALT: 0 } };
  recordEnumLookups(n => asked.push(n));
  try {
    const isZero = zeroEnumMember(values);
    assert.equal(isZero('ELEMENTAL_NONE'), true);
    assert.equal(isZero('ELEMENTAL_FIRE'), false);
    assert.equal(isZero('NOT_DECLARED'), false);
  } finally {
    recordEnumLookups(null);
  }
  assert.deepStrictEqual(asked, ['ELEMENTAL_NONE', 'ELEMENTAL_FIRE', 'NOT_DECLARED']);
  assert.equal(zeroEnumMember(values)('MODE_NONE'), true);
  assert.equal(enumMemberFact({ a: { X: 2 }, b: { X: 0 }, c: { X: 2 } }, 'X'), '0,2');
});
