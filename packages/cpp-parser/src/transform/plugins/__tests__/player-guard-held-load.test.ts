import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { hasNativeGpp, compileAndRun } from '../../../testing/native-cpp.js';
import { playerGuardHeldLoadPlugin, HELD_LOAD_SUPPORT_LINES } from '../builtins/player-guard-held-load.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(code: string): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = playerGuardHeldLoadPlugin.createTransformer({ onSite: (e: { name: string }) => sites.push(e.name) } as never);
  return { out: emit(t(parse(code)) as AnyNode), sites };
}

const HALT = '{ Halt(0x13f6); exit(-1); }';

// InitRightSkill 00622ea0, as printed.
const negReturn = [
  'void f(D2UnitStrc * pUnit) {',
  '  if (!(pUnit && pUnit->eUnitType == UNIT_PLAYER)) {',
  '    return;',
  '  }',
  '',
  '  D2UnitDataPlayerStrc* pPlayerData = pUnit->pUnitData.pUnitDataPlayer;',
  `  if (!pPlayerData) ${HALT}`,
  '  pPlayerData->eRightSkillId = 1;',
  '}',
].join('\n');

// SetWeaponGUID 006233a0.
const orReturn = negReturn.replace('!(pUnit && pUnit->eUnitType == UNIT_PLAYER)', '!pUnit || pUnit->eUnitType != UNIT_PLAYER');

// GetRightSkillData 00623060.
const positive = [
  'void f(D2UnitStrc * pUnit, int * pOut) {',
  '  D2UnitDataPlayerStrc* pPlayerData;',
  '  if (pUnit && pUnit->eUnitType == UNIT_PLAYER) {',
  '    pPlayerData = pUnit->pUnitData.pUnitDataPlayer;',
  `    if (!pPlayerData) ${HALT}`,
  '    *pOut = pPlayerData->eRightSkillId;',
  '    return;',
  '  }',
  '  *pOut = 0;',
  '}',
].join('\n');

describe('player-guard-held-load', () => {
  it('holds the type read of a returning negated guard', () => {
    const { out, sites } = run(negReturn);
    assert.deepStrictEqual(sites, ['pUnit']);
    assert.ok(flat(out).includes('if (!(pUnit && D2_HELD_LOAD(eD2UnitType, pUnit->eUnitType) == UNIT_PLAYER))'), out);
  });

  it('holds the type read of an || guard', () => {
    const { out, sites } = run(orReturn);
    assert.deepStrictEqual(sites, ['pUnit']);
    assert.ok(flat(out).includes('if (!pUnit || D2_HELD_LOAD(eD2UnitType, pUnit->eUnitType) != UNIT_PLAYER)'), out);
  });

  it('holds the type read of a positive guard whose arm loads and checks', () => {
    const { out, sites } = run(positive);
    assert.deepStrictEqual(sites, ['pUnit']);
    assert.ok(flat(out).includes('if (pUnit && D2_HELD_LOAD(eD2UnitType, pUnit->eUnitType) == UNIT_PLAYER) {'), out);
  });

  it('accepts a halting check with an else (SetWeaponGUID 006233a0)', () => {
    const code = orReturn.replace(`if (!pPlayerData) ${HALT}`, `if (!pPlayerData) ${HALT} else { pPlayerData->eRightSkillId = 2; }`);
    assert.deepStrictEqual(run(code).sites, ['pUnit']);
  });

  it('leaves a guard without the halting check (PLRMODES_StartModeID 00580a70)', () => {
    const code = [
      'void f(D2UnitStrc * pUnit) {',
      '  if (pUnit && pUnit->eUnitType == UNIT_PLAYER) {',
      '    if (pUnit->pUnitData.pUnitDataPlayer) {',
      '      pUnit->pUnitData.pUnitDataPlayer->eQueuedSkillId = 0;',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const { out, sites } = run(code);
    assert.deepStrictEqual(sites, []);
    assert.ok(!out.includes('D2_HELD_LOAD'), out);
  });

  it('leaves a check that does not halt, another unit, or another type', () => {
    const noHalt = negReturn.replace(HALT, '{ return; }');
    const other = negReturn.replace('pUnit->pUnitData.pUnitDataPlayer', 'pOther->pUnitData.pUnitDataPlayer').replace('(D2UnitStrc * pUnit)', '(D2UnitStrc * pUnit, D2UnitStrc * pOther)');
    const item = negReturn.replace('UNIT_PLAYER', 'UNIT_ITEM');
    for (const c of [noHalt, other, item]) assert.deepStrictEqual(run(c).sites, [], c);
  });

  it('keeps the value: the held read is the plain read outside VC8', (t) => {
    if (!hasNativeGpp()) { t.skip('no native g++'); return; }
    const prelude = [
      ...HELD_LOAD_SUPPORT_LINES,
      '#include <cstdlib>',
      'enum eD2UnitType { UNIT_PLAYER = 0, UNIT_MONSTER = 1, UNIT_ITEM = 4 };',
      'struct D2UnitDataPlayerStrc { int eRightSkillId; };',
      'union D2UnitData { D2UnitDataPlayerStrc * pUnitDataPlayer; };',
      'struct D2UnitStrc { eD2UnitType eUnitType; int pad[4]; D2UnitData pUnitData; };',
      'static void Halt(int) {}',
    ].join('\n');
    const fn = run(negReturn).out;
    const body = [
      'D2UnitDataPlayerStrc pd = { 7 }; D2UnitStrc u = { UNIT_PLAYER, {0}, { &pd } };',
      'f(&u); printf("%d ", pd.eRightSkillId);',
      'D2UnitStrc m = { UNIT_MONSTER, {0}, { &pd } }; pd.eRightSkillId = 5; f(&m); f(0);',
      'printf("%d\\n", pd.eRightSkillId);',
    ].join('\n');
    assert.strictEqual(compileAndRun(`${prelude}\n${fn}`, body).trim(), '1 5');
  });
});
