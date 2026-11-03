import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { hasNativeGpp, compileAndRun } from '../../../testing/native-cpp.js';
import { paramLoadOrderPlugin, type ParamLoadOrderOptions } from '../builtins/param-load-order.js';

const PRELUDE = [
  'struct D2UnitStrc { int nId; };',
  'struct D2MonStatsTxt { int nLevel; };',
  'struct D2AiGeneralStrc { int dwArg0; };',
  'struct D2AiParamStrc { D2AiGeneralStrc *pMonsterAiGeneral; void *fpAiFunction; D2UnitStrc *pTarget;',
  '  int field_0xC; int nVelocity; int nDistanceToTarget; int bEngagedInCombat; D2MonStatsTxt *pMonStats; };',
  'typedef int BOOL;',
].join('\n');

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(code: string, opts: Partial<ParamLoadOrderOptions> = {}): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = paramLoadOrderPlugin.createTransformer({
    onSite: e => sites.push(e.function + ':' + e.fields.join(',')), ...opts,
  } as ParamLoadOrderOptions);
  return { out: emit(t(parse(code)) as AnyNode), sites };
}

/** The names a body declares, in order. */
function declOrder(out: string): string[] {
  return [...out.matchAll(/(\w+) = \(?[\w ]*\)?\s*pAiParam->(\w+)/g)].map(m => m[2]);
}

// AI_Fn1_AbyssKnight, 005fab80: the original loads +0x18 before +0x14; the printed order
// compiles to +0x14 first, the house order to what the original has.
const abyss = [
  'int f(D2UnitStrc *pUnit, D2AiParamStrc *pAiParam) {',
  '  int nSeen;',
  '  int bEngagedInCombat = pAiParam->bEngagedInCombat;',
  '  D2MonStatsTxt *pMonStats = pAiParam->pMonStats;',
  '  int nDistance = pAiParam->nDistanceToTarget;',
  '  D2UnitStrc *pAttacker = pAiParam->pTarget;',
  '  D2AiGeneralStrc *pAiGeneral = pAiParam->pMonsterAiGeneral;',
  '  nSeen = 0;',
  '  pAiParam->nDistanceToTarget = 7;',
  '  return bEngagedInCombat * 1000000 + pMonStats->nLevel * 10000 + nDistance * 100 + pAttacker->nId * 10 + pAiGeneral->dwArg0 + nSeen;',
  '}',
].join('\n');

describe('param-load-order', () => {
  it('writes the run in the house order', () => {
    const { out, sites } = run(abyss);
    assert.deepStrictEqual(declOrder(out),
      ['nDistanceToTarget', 'bEngagedInCombat', 'pTarget', 'pMonStats', 'pMonsterAiGeneral']);
    assert.deepStrictEqual(sites, ['f:nDistanceToTarget,bEngagedInCombat,pTarget,pMonStats,pMonsterAiGeneral']);
    // the statements after the run stay where they are
    assert.ok(flat(out).includes('pAiGeneral = pAiParam->pMonsterAiGeneral; nSeen = 0; pAiParam->nDistanceToTarget = 7;'), out);
  });

  it('keeps pMonStats and pMonsterAiGeneral in their printed order', () => {
    // SandMaggotAi_CastDelayedSkill, 005f1750, matches only with pMonsterAiGeneral first.
    const code = [
      'int f(D2AiParamStrc *pAiParam) {',
      '  D2AiGeneralStrc *pAiGeneral = pAiParam->pMonsterAiGeneral;',
      '  D2MonStatsTxt *pMonStats = pAiParam->pMonStats;',
      '  return pAiGeneral->dwArg0 + pMonStats->nLevel;',
      '}',
    ].join('\n');
    const { out, sites } = run(code);
    assert.deepStrictEqual(declOrder(out), ['pMonsterAiGeneral', 'pMonStats']);
    assert.deepStrictEqual(sites, []);
  });

  it('reads through a cast and a typedef scalar', () => {
    const code = [
      'int f(D2AiParamStrc *pAiParam) {',
      '  D2UnitStrc *pTarget = pAiParam->pTarget;',
      '  BOOL bCombat = (BOOL)pAiParam->bEngagedInCombat;',
      '  return pTarget->nId + bCombat;',
      '}',
    ].join('\n');
    assert.deepStrictEqual(declOrder(run(code).out), ['bEngagedInCombat', 'pTarget']);
  });

  it('leaves a run with a field outside the table', () => {
    const code = [
      'int f(D2AiParamStrc *pAiParam) {',
      '  D2UnitStrc *pTarget = pAiParam->pTarget;',
      '  int nVelocity = pAiParam->nVelocity;',
      '  int nDistance = pAiParam->nDistanceToTarget;',
      '  return pTarget->nId + nVelocity + nDistance;',
      '}',
    ].join('\n');
    const { out, sites } = run(code);
    assert.deepStrictEqual(declOrder(out), ['pTarget', 'nVelocity', 'nDistanceToTarget']);
    assert.deepStrictEqual(sites, []);
  });

  it('stops the run at a statement that is not a copy', () => {
    const code = [
      'int f(D2AiParamStrc *pAiParam) {',
      '  D2UnitStrc *pTarget = pAiParam->pTarget;',
      '  pAiParam->nDistanceToTarget = 3;',
      '  int nDistance = pAiParam->nDistanceToTarget;',
      '  return pTarget->nId + nDistance;',
      '}',
    ].join('\n');
    const { out, sites } = run(code);
    assert.deepStrictEqual(declOrder(out), ['pTarget', 'nDistanceToTarget']);
    assert.deepStrictEqual(sites, []);
  });

  it('leaves copies out of another struct or a non-parameter pointer alone', () => {
    const code = [
      'int f(D2AiParamStrc *pAiParam, D2UnitStrc *pUnit) {',
      '  D2AiParamStrc *pOther = pAiParam;',
      '  D2UnitStrc *pTarget = pOther->pTarget;',
      '  int nDistance = pOther->nDistanceToTarget;',
      '  return pTarget->nId + nDistance + pUnit->nId;',
      '}',
    ].join('\n');
    assert.deepStrictEqual(run(code).sites, []);
  });

  it('takes another table from the options', () => {
    const code = [
      'int f(D2AiParamStrc *pAiParam) {',
      '  D2MonStatsTxt *pMonStats = pAiParam->pMonStats;',
      '  D2UnitStrc *pTarget = pAiParam->pTarget;',
      '  D2AiGeneralStrc *pAiGeneral = pAiParam->pMonsterAiGeneral;',
      '  return pMonStats->nLevel + pTarget->nId + pAiGeneral->dwArg0;',
      '}',
    ].join('\n');
    const table = { D2AiParamStrc: [['pMonsterAiGeneral', 'pTarget'], ['pMonStats']] };
    assert.deepStrictEqual(declOrder(run(code, { table }).out), ['pTarget', 'pMonsterAiGeneral', 'pMonStats']);
    // the house table does not know this struct's fields under another struct name
    assert.deepStrictEqual(run(code, { table: { OtherStrc: [['pTarget']] } }).sites, []);
  });

  it('computes what the printed order computes (compiled)', { skip: !hasNativeGpp() }, () => {
    const { out } = run(abyss);
    const prelude = [
      PRELUDE, '#include <stdio.h>',
      abyss.replace('int f(', 'int before('),
      out.replace('int f(', 'int after('),
    ].join('\n');
    const r = compileAndRun(prelude, [
      'for (int k = 0; k < 4; k++) {',
      '  D2UnitStrc u = {k}, t = {k + 3}; D2MonStatsTxt m = {k * 2}; D2AiGeneralStrc g = {k + 1};',
      '  D2AiParamStrc a = {&g, 0, &t, 0, 0, 10 + k, k & 1, &m}, b = a;',
      '  int x = before(&u, &a), y = after(&u, &b);',
      '  printf("%d/%d %d/%d\\n", x, a.nDistanceToTarget, y, b.nDistanceToTarget);',
      '}',
    ].join('\n'));
    for (const row of r.trim().split('\n')) {
      const [a, b] = row.split(' ');
      assert.strictEqual(a, b, r);
    }
  });
});
