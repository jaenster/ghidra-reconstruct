/**
 * Tests for the Enum-Constant-Qualify plugin.
 *
 * The case that made this exist: `eD2PlayerAnimMode` and `eD2MonsterAnimMode`
 * share fourteen constant names and number them differently. A case label must
 * resolve against the enum of ITS OWN switch and never borrow the other's
 * number.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { enumConstantQualifyPlugin } from '../builtins/enum-constant-qualify.js';

const PLAYER = [
  'Death', 'Neutral', 'Walk', 'Run', 'GetHit', 'TownNeutral', 'TownWalk', 'Attack1', 'Attack2',
  'Block', 'Cast', 'Throw', 'Kick', 'Skill1', 'Skill2', 'Skill3', 'Skill4', 'Dead', 'Sequence',
  'KnockBack',
];
const MONSTER = [
  'Death', 'Neutral', 'Walk', 'GetHit', 'Attack1', 'Attack2', 'Block', 'Cast', 'Skill1', 'Skill2',
  'Skill3', 'Skill4', 'Dead', 'Knockback', 'Sequence', 'Run',
];

/** Names both enums declare with a different number. */
const AMBIGUOUS = [
  'Run', 'GetHit', 'Attack1', 'Attack2', 'Block', 'Cast', 'Skill1', 'Skill2', 'Skill3', 'Skill4',
  'Dead', 'Sequence',
];

const OPTIONS = {
  ambiguousConstants: AMBIGUOUS,
  enumMembers: {
    eD2PlayerAnimMode: PLAYER,
    eD2MonsterAnimMode: MONSTER,
  },
  structFields: {
    D2UnitStrc: { eAnimMode: 'D2AnimModeUnion', eUnitType: 'eD2UnitType' },
    D2AnimModeUnion: {
      ePlayerMode: 'eD2PlayerAnimMode',
      eMonsterMode: 'eD2MonsterAnimMode',
    },
  },
  globalTypes: { gPlayerMode: 'eD2PlayerAnimMode' },
};

function transformCode(code: string): string {
  const ast = parse(code);
  const transformer = enumConstantQualifyPlugin.createTransformer(OPTIONS);
  return emit(transformer(ast) as AnyNode).trim();
}

describe('enumConstantQualifyPlugin', () => {
  it('qualifies a case label to the enum of the switch it is under', () => {
    const output = transformCode(`
void f(D2UnitStrc *pUnit) {
  switch (pUnit->eAnimMode.ePlayerMode) {
    case Run:
      a();
      break;
    case TownNeutral:
      b();
      break;
  }
}
`);
    assert.ok(
      output.includes('case eD2PlayerAnimMode_ns::Run:'),
      `Run must resolve against the player enum in: ${output}`
    );
    // TownNeutral is declared by one enum only, so it keeps its global spelling.
    assert.ok(output.includes('case TownNeutral:'), `Expected bare TownNeutral in: ${output}`);
    assert.ok(
      !output.includes('eD2MonsterAnimMode_ns::'),
      `No label may borrow the monster enum in: ${output}`
    );
  });

  it('qualifies the same name to a different enum in a monster-mode switch', () => {
    const output = transformCode(`
void f(D2UnitStrc *pUnit) {
  switch (pUnit->eAnimMode.eMonsterMode) {
    case Run:
      a();
      break;
  }
}
`);
    assert.ok(
      output.includes('case eD2MonsterAnimMode_ns::Run:'),
      `Run must resolve against the monster enum in: ${output}`
    );
  });

  it('never borrows a name the controlling enum does not declare', () => {
    // `Kick` is a player mode. A monster-mode switch must NOT be handed the
    // player's number for it - it is left bare, which no longer resolves, so
    // the failure is a compile error rather than a wrong branch.
    const output = transformCode(`
void f(D2UnitStrc *pUnit) {
  switch (pUnit->eAnimMode.eMonsterMode) {
    case Kick:
      a();
      break;
  }
}
`);
    assert.ok(output.includes('case Kick:'), `Expected an unqualified Kick in: ${output}`);
    assert.ok(!output.includes('_ns::Kick'), `Kick must not be qualified in: ${output}`);
  });

  it('leaves a label alone when the controlling type is unknown', () => {
    const output = transformCode(`
void f(int nMode) {
  switch (nMode) {
    case Run:
      a();
      break;
  }
}
`);
    assert.ok(output.includes('case Run:'), `Expected an unqualified Run in: ${output}`);
    assert.ok(!output.includes('_ns::'), `Nothing may be qualified in: ${output}`);
  });

  it('gives a nested switch its own enum, not the enclosing one', () => {
    const output = transformCode(`
void f(D2UnitStrc *pUnit) {
  switch (pUnit->eAnimMode.ePlayerMode) {
    case Run:
      switch (pUnit->eAnimMode.eMonsterMode) {
        case Dead:
          a();
          break;
      }
      break;
  }
}
`);
    assert.ok(
      output.includes('case eD2PlayerAnimMode_ns::Run:'),
      `Outer label takes the outer enum in: ${output}`
    );
    assert.ok(
      output.includes('case eD2MonsterAnimMode_ns::Dead:'),
      `Inner label takes the inner enum in: ${output}`
    );
  });

  it('qualifies an equality comparison from the other operand', () => {
    const output = transformCode(`
void f(D2UnitStrc *pUnit) {
  if (pUnit->eAnimMode.ePlayerMode == Dead) {
    a();
  }
}
`);
    assert.ok(
      output.includes('eD2PlayerAnimMode_ns::Dead'),
      `Expected the player enum's Dead in: ${output}`
    );
  });

  it('qualifies an assignment from the target', () => {
    const output = transformCode(`
void f(void) {
  gPlayerMode = Attack1;
}
`);
    assert.ok(
      output.includes('gPlayerMode = eD2PlayerAnimMode_ns::Attack1'),
      `Expected the player enum's Attack1 in: ${output}`
    );
  });

  it('leaves every unambiguous constant unqualified', () => {
    const output = transformCode(`
void f(D2UnitStrc *pUnit) {
  switch (pUnit->eAnimMode.ePlayerMode) {
    case Death:
    case Neutral:
    case Walk:
    case Throw:
      a();
      break;
  }
}
`);
    assert.ok(!output.includes('_ns::'), `Nothing may be qualified in: ${output}`);
  });
});
