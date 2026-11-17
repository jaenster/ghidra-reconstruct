/**
 * reused-param-slot: AITHINK_Fn1_NpcOutOfTown (005e7880) keeps a function pointer in
 * the dead slot of its `pAiParam` parameter; the pass gives it a funcdef-typed local.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { reusedParamSlotPlugin, type ReusedParamSlotOptions } from '../builtins/reused-param-slot.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const native = { skip: !hasNativeGpp() };

const SIG = 'void(D2GameStrc *,D2UnitStrc *)';
const OPTIONS: ReusedParamSlotOptions = {
  functionSignatures: {
    'Q::Q04_InitializeTristramObjects': SIG, Q04_InitializeTristramObjects: SIG,
    'Q::Q33_StartAnyaRescuePhase': SIG, Q33_StartAnyaRescuePhase: SIG,
    'Q::Other': 'int(D2GameStrc *)', Other: 'int(D2GameStrc *)',
  },
  functionConventions: {
    'Q::Q04_InitializeTristramObjects': '__fastcall', Q04_InitializeTristramObjects: '__fastcall',
    'Q::Q33_StartAnyaRescuePhase': '__fastcall', Q33_StartAnyaRescuePhase: '__fastcall',
    'Q::Other': '__fastcall', Other: '__fastcall',
  },
  // Four funcdefs share the contract in 1.14d; the program stores these two functions
  // as fpGameMechanicQuest in the sibling AI_QuestNpc_InitializeQuestPhase (005e77a0).
  funcdefSignatures: { fpGameMechanicQuest: SIG, fpTimerFunction: SIG, dt_1ae317ea: SIG, fpStdcallTwin: SIG },
  funcdefConventions: { fpGameMechanicQuest: '__fastcall', fpTimerFunction: '__fastcall', dt_1ae317ea: '__fastcall', fpStdcallTwin: '__stdcall' },
  functionStoredAs: {
    'Q::Q04_InitializeTristramObjects': ['fpGameMechanicQuest'], Q04_InitializeTristramObjects: ['fpGameMechanicQuest'],
    'Q::Q33_StartAnyaRescuePhase': ['fpGameMechanicQuest'], Q33_StartAnyaRescuePhase: ['fpGameMechanicQuest'],
  },
};

const run = (code: string, o: ReusedParamSlotOptions = OPTIONS) =>
  emit(reusedParamSlotPlugin.createTransformer(o)(parse(code)) as AnyNode).trim();

/** The else branch of 005e7880, trimmed to what the slot does. */
const SITE = `void f(D2GameStrc *pGame, D2UnitStrc *pUnit, D2AiParamStrc *pAiParam, int bIsAnya, int nArrived) {
  Use(pAiParam);
  if (nArrived == 0) {
    Use(pAiParam);
    return;
  }
  pAiParam = (D2AiParamStrc *)Q::Q04_InitializeTristramObjects;
  if (bIsAnya) {
    pAiParam = (D2AiParamStrc *)Q::Q33_StartAnyaRescuePhase;
  }
  if (nArrived == 1) {
    (*(code *)pAiParam)(pGame,pUnit);
    return;
  }
  return;
}`;

describe('reused-param-slot', () => {
  it('gives the reused slot a local of the funcdef the program stores those functions as', () => {
    const out = run(SITE);
    assert.match(out, /fpGameMechanicQuest\* pfnGameMechanicQuest;/, out);
    assert.match(out, /pfnGameMechanicQuest = Q::Q04_InitializeTristramObjects;/, out);
    assert.match(out, /pfnGameMechanicQuest = Q::Q33_StartAnyaRescuePhase;/, out);
    assert.match(out, /\(\*pfnGameMechanicQuest\)\(pGame, pUnit\);/, out);
    // The parameter keeps its own uses.
    assert.strictEqual(out.match(/Use\(pAiParam\)/g)?.length, 2, out);
    assert.doesNotMatch(out, /code|\(D2AiParamStrc\*\)/, out);
  });

  it('calls the same functions as the slot did', native, () => {
    const out = run(SITE);
    const prelude = [
      'struct D2GameStrc { int n; }; struct D2UnitStrc { int n; }; struct D2AiParamStrc { int n; };',
      'typedef void code(D2GameStrc *, D2UnitStrc *);',
      'typedef void fpGameMechanicQuest(D2GameStrc *, D2UnitStrc *);',
      'static int gLog = 0; static void Use(D2AiParamStrc *p) { gLog = gLog * 7 + (p ? p->n : 1); }',
      'namespace Q { void Q04_InitializeTristramObjects(D2GameStrc *g, D2UnitStrc *u) { gLog = gLog * 3 + g->n + 1; }',
      '  void Q33_StartAnyaRescuePhase(D2GameStrc *g, D2UnitStrc *u) { gLog = gLog * 5 + u->n + 2; } }',
      `namespace ref { ${SITE} }`,
      `namespace low { ${out} }`,
    ].join('\n');
    const body = [
      'D2GameStrc g{4}; D2UnitStrc u{9}; D2AiParamStrc a{6}; int bad = 0;',
      'for (int anya = 0; anya < 2; anya++) for (int arrived = 0; arrived < 3; arrived++) {',
      '  gLog = 0; ref::f(&g, &u, &a, anya, arrived); int x = gLog;',
      '  gLog = 0; low::f(&g, &u, &a, anya, arrived); if (x != gLog) bad++;',
      '}',
      'printf("%d\\n", bad);',
    ].join('\n');
    assert.strictEqual(compileAndRun(prelude, body).trim(), '0', out);
  });

  it('leaves the slot when a read of the parameter itself is reachable from a store', () => {
    const code = SITE.replace('  return;\n}', '  Use(pAiParam);\n  return;\n}');
    assert.match(run(code), /\(\*\(code\*\)pAiParam\)/);
  });

  it('leaves the slot when the stored functions differ in signature', () => {
    assert.match(run(SITE.replace('Q::Q33_StartAnyaRescuePhase', 'Q::Other')), /\(\*\(code\*\)pAiParam\)/);
  });

  it('leaves the slot when identical funcdefs cannot be told apart', () => {
    assert.match(run(SITE, { ...OPTIONS, functionStoredAs: {} }), /\(\*\(code\*\)pAiParam\)/);
  });

  it('leaves a slot written with something that is not a function', () => {
    assert.match(run(SITE.replace('pAiParam = (D2AiParamStrc *)Q::Q33_StartAnyaRescuePhase;', 'pAiParam = Next(pAiParam);')),
      /\(\*\(code\*\)pAiParam\)/);
  });
});

describe('reused-param-slot: a second value in a dead stack-argument slot', () => {
  const V: ReusedParamSlotOptions = {
    stackParameters: ['nVelocity', 'pUnit', 'pProperty'],
    functionReturnTypes: { 'D2Common::Units::Units::UNITS_GetRoom': 'D2RoomStrc *', UNITS_GetRoom: 'D2RoomStrc *' },
  };

  it('HirelingFollowOwnerAction @005e3930: the room kept in nVelocity\'s slot gets a local of its own', () => {
    const out = run(`int f(D2UnitStrc *pOwner, int nVelocity) {
      g(nVelocity);
      nVelocity = (int)D2Common::Units::Units::UNITS_GetRoom(pOwner);
      h((D2RoomStrc *)nVelocity, 1);
      return 0;
    }`, V);
    assert.ok(/D2RoomStrc\s*\*\s*pRoom;/.test(out), out);
    assert.ok(/pRoom = D2Common::Units::Units::UNITS_GetRoom\(pOwner\);/.test(out), out);
    assert.ok(/h\(pRoom, 1\);/.test(out), out);
    assert.ok(/g\(nVelocity\);/.test(out), out);
  });

  it('ITEM_RollSocketCount @0062bcb0: an integer in a pointer slot, typed by the reads', () => {
    const out = run(`void f(D2UnitStrc *pUnit, uint n) {
      if (pUnit != (D2UnitStrc *)0x0) {
        pUnit = (D2UnitStrc *)((uint)n << 0x18);
        n = ((uint)pUnit >> 0x18) * 2;
        k((uint)pUnit);
      }
    }`, V);
    assert.ok(/uint nUnit;/.test(out), out);
    assert.ok(/nUnit = \(uint\)\(\(uint\)n << 0x18\);/.test(out), out);
    assert.ok(/n = \(nUnit >> 0x18\) \* 2;/.test(out), out);
    assert.ok(/k\(nUnit\);/.test(out), out);
    assert.ok(/pUnit != \(D2UnitStrc\s*\*\)0x0/.test(out), out);
  });

  it('a bare read of the second value keeps its bits through the parameter type', () => {
    const out = run(`int f(D2UnitStrc *pOwner, int nVelocity) {
      int bWalked;
      g(nVelocity);
      nVelocity = (int)D2Common::Units::Units::UNITS_GetRoom(pOwner);
      bWalked = nVelocity;
      return h((D2RoomStrc *)nVelocity, bWalked);
    }`, V);
    assert.ok(/bWalked = \(int\)pRoom;/.test(out), out);
    assert.ok(/h\(pRoom, bWalked\)/.test(out), out);
  });

  it('leaves a slot one read sees with both values (a loop around the store)', () => {
    const src = `void f(D2UnitStrc *pOwner, int nVelocity) {
      while (g(nVelocity)) {
        nVelocity = (int)D2Common::Units::Units::UNITS_GetRoom(pOwner);
      }
    }`;
    assert.strictEqual(run(src, V).replace(/\s+/g, ' '), run(src, {}).replace(/\s+/g, ' '));
  });

  it('leaves a register parameter, an integer reused as an integer, and a type nothing says', () => {
    const reg = `int f(D2UnitStrc *pOwner, int nScratch) { nScratch = (int)D2Common::Units::Units::UNITS_GetRoom(pOwner); return h((D2RoomStrc *)nScratch); }`;
    assert.ok(!/pRoom/.test(run(reg, V)), 'not a stack parameter');
    const ints = `int f(int nVelocity) { g(nVelocity); nVelocity = q(); return (int)nVelocity; }`;
    assert.strictEqual(run(ints, V).replace(/\s+/g, ' '), run(ints, {}).replace(/\s+/g, ' '));
    const unknown = `int f(int nVelocity) { g(nVelocity); nVelocity = q(); return h(nVelocity); }`;
    assert.strictEqual(run(unknown, V).replace(/\s+/g, ' '), run(unknown, {}).replace(/\s+/g, ' '));
  });

  it('computes what the slot computed (a pointer slot carries an integer)', native, () => {
    const prelude = `
      struct D2UnitStrc { int nId; };
      static int g(D2UnitStrc *p) { return p ? p->nId : -1; }`;
    const fn = `int f(D2UnitStrc *pUnit, int n) {
        int a = g(pUnit);
        pUnit = (D2UnitStrc *)(intptr_t)(n << 4);
        return a + (int)(intptr_t)pUnit + 1;
      }`;
    const o: ReusedParamSlotOptions = { stackParameters: ['pUnit'] };
    const split = run(fn, o);
    assert.ok(/intptr_t nUnit;/.test(split), split);
    const call = 'D2UnitStrc u = { 7 }; printf("%d\\n", f(&u, 3));';
    assert.strictEqual(compileAndRun(prelude + split, call), compileAndRun(prelude + fn, call));
  });
});

describe('reused-param-slot: the second value typed by member reads, with constant stores voting for nothing (round 13)', () => {
  const V: ReusedParamSlotOptions = {
    stackParameters: ['pTarget', 'eSkill'],
    functionReturnTypes: { 'D2Common::PATH::DynamicPath::GetXPos': 'int32_t', GetXPos: 'int32_t' },
    structFields: { D2UnitStrc: { pPath: 'D2PathUnion' }, D2PathUnion: { pStaticPath: 'D2StaticPathStrc *', pDynamicPath: 'D2DynamicPathStrc *' }, D2StaticPathStrc: { nPosX: 'int' } },
    enumConstants: ['MISSILE_Arrow'],
    enumValues: { MISSILE_Arrow: 0 },
  };
  it("MoveAndCastSkill @005de4e0: pTarget's slot holds the caster's X once pTarget is dead", () => {
    const out = run(`int f(D2UnitStrc *pUnit, D2UnitStrc *pTarget, int nXOffset) {
      int nDist;
      nDist = GetDistance(pUnit, pTarget);
      if (pUnit->eUnitType == 2) {
        pTarget = (D2UnitStrc *)((pUnit->pPath).pStaticPath)->nPosX;
      }
      else if ((pUnit->pPath).pDynamicPath == (D2DynamicPathStrc *)0x0) {
        pTarget = (D2UnitStrc *)0x0;
      }
      else {
        pTarget = (D2UnitStrc *)D2Common::PATH::DynamicPath::GetXPos((pUnit->pPath).pDynamicPath);
      }
      return nXOffset - (int)pTarget + nDist;
    }`, V);
    assert.match(out, /int nTarget;/);
    assert.match(out, /nTarget = pUnit->pPath\.pStaticPath->nPosX;/);
    assert.match(out, /nTarget = 0x0;|nTarget = 0;/);
    assert.match(out, /return nXOffset - nTarget \+ nDist;/);
    assert.match(out, /GetDistance\(pUnit, pTarget\)/);
  });
  it('without the member tables the second type is still not evident', () => {
    const out = run(`int f(D2UnitStrc *pUnit, D2UnitStrc *pTarget) {
      g(pTarget);
      if (pUnit) pTarget = (D2UnitStrc *)((pUnit->pPath).pStaticPath)->nPosX; else pTarget = (D2UnitStrc *)0x0;
      return h(pTarget);
    }`, { stackParameters: ['pTarget'] });
    assert.doesNotMatch(out, /nTarget/);
  });
});

// MONSTERAI_WalkPartialTowardTarget @005de6f0 and SKILLDESC_DrawSkillDmgElemental @004e9d20,
// as Ghidra prints them (1.14d, redivivus#494 and #501).
const WALK_005DE6F0 = `int32_t __fastcall
D2Game::Monster::AI::MONSTERAI_WalkPartialTowardTarget
          (SGAMEDATA *pGame,D2UnitStrc *pUnit,D2AiGeneralStrc *pAiGeneral,D2UnitStrc *pTarget,
          int32_t nDistanceFromTarget)

{
  int32_t nResult;
  int nUnitX;
  int nUnitY;
  D2ModeChangeStrc sKillInfo;
  SGAMEDATA *pGameSaved;
  int32_t nTotalDist;
  int32_t nTargetY;
  eD2UnitType eUnitType;
  D2UnitStrc *pTargetOrig;
  
  pTargetOrig = pTarget;
  pGameSaved = pGame;
  nResult = D2Common::Collision::Collision::GetCollisionDistance(pUnit,pTarget);
  eUnitType = pTarget->eUnitType;
  nTotalDist = nResult;
  if ((eUnitType == UNIT_OBJECT) || ((3 < (int)eUnitType && ((int)eUnitType < 6)))) {
    pTarget = (D2UnitStrc *)((pTarget->pPath).pStaticPath)->nPosX;
  }
  else if ((pTarget->pPath).pDynamicPath == (D2DynamicPathStrc *)0x0) {
    pTarget = (D2UnitStrc *)0x0;
  }
  else {
    pTarget = (D2UnitStrc *)D2Common::PATH::DynamicPath::GetXPos((pTarget->pPath).pDynamicPath);
  }
  eUnitType = pTargetOrig->eUnitType;
  if ((eUnitType == UNIT_OBJECT) || ((3 < (int)eUnitType && ((int)eUnitType < 6)))) {
    nTargetY = ((pTargetOrig->pPath).pStaticPath)->nPosY;
  }
  else if ((pTargetOrig->pPath).pDynamicPath == (D2DynamicPathStrc *)0x0) {
    nTargetY = 0;
  }
  else {
    nTargetY = D2Common::PATH::DynamicPath::GetYPos((pTargetOrig->pPath).pDynamicPath);
  }
  if (nResult == 0) {
    return 0;
  }
  eUnitType = pUnit->eUnitType;
  if ((eUnitType == UNIT_OBJECT) || ((3 < (int)eUnitType && ((int)eUnitType < 6)))) {
    nUnitX = ((pUnit->pPath).pStaticPath)->nPosX;
  }
  else if ((pUnit->pPath).pDynamicPath == (D2DynamicPathStrc *)0x0) {
    nUnitX = 0;
  }
  else {
    nUnitX = D2Common::PATH::DynamicPath::GetXPos((pUnit->pPath).pDynamicPath);
  }
  nUnitX = ((nUnitX - (int)pTarget) * nDistanceFromTarget) / nTotalDist;
  eUnitType = pUnit->eUnitType;
  if ((eUnitType == UNIT_OBJECT) || ((3 < (int)eUnitType && ((int)eUnitType < 6)))) {
    nUnitY = ((pUnit->pPath).pStaticPath)->nPosY;
  }
  else if ((pUnit->pPath).pDynamicPath == (D2DynamicPathStrc *)0x0) {
    nUnitY = 0;
  }
  else {
    nUnitY = D2Common::PATH::DynamicPath::GetYPos((pUnit->pPath).pDynamicPath);
  }
  D2Game::Monster::MonsterMode::MONMODE_InitModeChange(pUnit,Walk,&sKillInfo);
  sKillInfo.nTargetX = (int)(pTarget->unk0x19 + nUnitX + -0x19);
  sKillInfo.nTargetY = ((nUnitY - nTargetY) * nDistanceFromTarget) / nTotalDist + nTargetY;
  nResult = D2Game::Monster::MonsterMode::MONSTERAI_ExecuteLifecycleTransition
                      (pGameSaved,&sKillInfo,1);
  return nResult;
}`;

const SKILLDMG_004E9D20 = `void __fastcall
D2Client::UI::SkillDesc::SKILLDESC_DrawSkillDmgElemental
          (D2UnitStrc *pUnit,D2SkillStrc *pSkill,D2SkillsTxt *pSkillsTxt,int32_t nSkillLevel,
          int32_t nXLeft,int32_t nY,int32_t nXRight)

{
  int32_t nCalcResult;
  int32_t nSkillLvlSaved;
  WCHAR wszElemDmgW [32];
  WCHAR wszSkillDmgW [32];
  CHAR szDmgTextA [32];
  D2UnitStrc *pUnitSaved;
  int nElemMinDmg;
  uint32_t nElemColorIdx;
  int32_t nElemDmgType;
  int nElemMaxDmg;
  int nElemMaxCopy;
  int nElemMinCopy;
  int nPhysMinDmg;
  D2SkillsTxt *pSkillsTxtSaved;
  D2UnitStrc *pUnitCopy;
  char *szFmt;
  
  if (pSkill == (D2SkillStrc *)0x0) {
    return;
  }
  if (pSkillsTxt == (D2SkillsTxt *)0x0) {
    return;
  }
  nElemMinDmg = 0;
  nElemMaxDmg = 0;
  nElemDmgType = 0;
  pUnitSaved = pUnit;
  D2Client::UI::SkillDesc::SKILLDESC_DrawElemDamageWithRange
            (pUnit,&nElemMinDmg,&nElemMaxDmg,&nElemDmgType,(D2UnitStrc *)0x0,pSkill,
             (uint)pSkillsTxt->SrcDam);
  pSkillsTxtSaved = pSkillsTxt;
  nElemColorIdx = D2Client::UI::SkillDesc::SKILLDESC_ElemTypeToColorIndex((uint)pSkillsTxt->EType);
  pUnitCopy = pUnitSaved;
  nSkillLvlSaved = nSkillLevel;
  nCalcResult = D2Common::Skills::Skills::SKILL_CalcMinDamage
                          (pUnitSaved,(int)pSkillsTxtSaved->skill,nSkillLevel,0);
  nSkillLevel = nCalcResult >> 8;
  nCalcResult = D2Common::Skills::Skills::SKILL_CalcMaxDamage
                          (pUnitCopy,(int)pSkillsTxtSaved->skill,nSkillLvlSaved,0);
  pSkillsTxt = (D2SkillsTxt *)(nCalcResult >> 8);
  nCalcResult = D2Common::Skills::Skills::SERVER_MinDamage
                          (pUnitCopy,(int)pSkillsTxtSaved->skill,nSkillLvlSaved,1);
  nSkillLevel = nSkillLevel + (nCalcResult >> 8);
  nSkillLvlSaved =
       D2Common::Skills::Skills::SERVER_MaxDamage
                 (pUnitCopy,(int)pSkillsTxtSaved->skill,nSkillLvlSaved,1);
  pSkillsTxt = (D2SkillsTxt *)((int)pSkillsTxt->srvprgfunc + (nSkillLvlSaved >> 8) + -0x30);
  D2Client::UI::SkillDesc::AdjustDamageByType
            (pUnitCopy,&nSkillLevel,(int *)&pSkillsTxt,pSkillsTxtSaved->EType);
  nElemMaxCopy = nElemMaxDmg;
  nElemMinCopy = nElemMinDmg;
  nPhysMinDmg = nSkillLevel;
  if ((nElemMinDmg == 0) && (nElemMaxDmg == 0)) {
    D2Client::UI::SkillDesc::SKILLDESC_DrawDamageNumbers
              (nSkillLevel,(int32_t)pSkillsTxt,nElemColorIdx,nXLeft,nY,nXRight);
    return;
  }
  if ((nSkillLevel == 0) && (pSkillsTxt == (D2SkillsTxt *)0x0)) {
    D2Client::UI::SkillDesc::SKILLDESC_DrawDamageNumbers
              (nElemMinDmg,nElemMaxDmg,nElemDmgType,nXLeft,nY,nXRight);
    return;
  }
  Fog::File::CONTAINER_InitializeBuffer
            (wszElemDmgW,2,0x20,D2Lang::Unicode::UNISYS::STRING_ZeroOneWCHAR);
  if (nElemMinCopy == nElemMaxCopy) {
                    /* LPCSTR param_2 for wsprintfA */
                    /* LPSTR param_1 for wsprintfA */
    wsprintfA(szDmgTextA,"%d",nElemMinCopy);
  }
  else {
    if (nElemMinCopy < 10000) {
      if (nElemMaxCopy < 10000) {
                    /* LPCSTR param_2 for wsprintfA */
                    /* LPSTR param_1 for wsprintfA */
        wsprintfA(szDmgTextA,"%d-%d",nElemMinCopy,nElemMaxCopy);
        goto format_second_range;
      }
      szFmt = "%s%d-%dK";
    }
    else {
      nElemMinCopy = (nElemMinCopy + 500) / 1000;
      szFmt = "%s%dK-%dK";
    }
    wsprintfA(szDmgTextA,szFmt,"",nElemMinCopy,(nElemMaxCopy + 500) / 1000);
  }
format_second_range:
  D2Lang::UTF8_ConvertToWideChar(wszElemDmgW,szDmgTextA,0x20);
  Fog::File::CONTAINER_InitializeBuffer
            (wszSkillDmgW,2,0x20,D2Lang::Unicode::UNISYS::STRING_ZeroOneWCHAR);
  if ((D2SkillsTxt *)nPhysMinDmg == pSkillsTxt) {
                    /* LPCSTR param_2 for wsprintfA */
                    /* LPSTR param_1 for wsprintfA */
    wsprintfA(szDmgTextA,"%d",nPhysMinDmg);
  }
  else {
    if (nPhysMinDmg < 10000) {
      if ((int)pSkillsTxt < 10000) {
                    /* LPCSTR param_2 for wsprintfA */
                    /* LPSTR param_1 for wsprintfA */
        wsprintfA(szDmgTextA,"%d-%d",nPhysMinDmg,pSkillsTxt);
        goto draw_both_ranges;
      }
                    /* LPCSTR param_2 for wsprintfA */
      szFmt = "%s%d-%dK";
    }
    else {
      nPhysMinDmg = (nPhysMinDmg + 500) / 1000;
      szFmt = "%s%dK-%dK";
    }
    wsprintfA(szDmgTextA,szFmt,"",nPhysMinDmg,(int)(pSkillsTxt->EMinLev + 3) / 1000);
  }
draw_both_ranges:
  D2Lang::UTF8_ConvertToWideChar(wszSkillDmgW,szDmgTextA,0x20);
  D2Client::UI::SkillDesc::SKILLDESC_DrawTwoLineText
            (wszElemDmgW,wszSkillDmgW,nXLeft,nY,nXRight,nElemDmgType,nElemColorIdx);
  return;
}`;

describe('reused-param-slot: an integer second value under array-member arithmetic (#494, #501)', () => {
  const LAYOUTS: ReusedParamSlotOptions['structLayouts'] = {
    D2UnitStrc: [
      { name: 'eUnitType', offset: 0, size: 4, type: 'eD2UnitType' },
      { name: 'nAct', offset: 24, size: 1, type: 'eAct' },
      { name: 'unk0x19', offset: 25, size: 3, type: 'byte[3]' },
      { name: 'nInitSeed', offset: 40, size: 4, type: 'int' },
      { name: 'pPath', offset: 44, size: 4, type: 'D2PathUnion' },
    ],
    D2SkillsTxt: [
      { name: 'skill', offset: 0, size: 2, type: 'short' },
      { name: 'srvprgfunc', offset: 48, size: 6, type: 'short[3]' },
      { name: 'SrcDam', offset: 421, size: 1, type: 'byte' },
      { name: 'EType', offset: 476, size: 1, type: 'byte' },
      { name: 'EMinLev', offset: 488, size: 20, type: 'int[5]' },
    ],
  };
  const V: ReusedParamSlotOptions = {
    stackParameters: ['pUnit', 'pTarget', 'nDistanceFromTarget', 'pSkillsTxt', 'nSkillLevel', 'nXLeft', 'nY', 'nXRight'],
    functionReturnTypes: {
      'D2Common::PATH::DynamicPath::GetXPos': 'int32_t', GetXPos: 'int32_t',
      'D2Common::Skills::Skills::SKILL_CalcMaxDamage': 'int32_t', SKILL_CalcMaxDamage: 'int32_t',
      'D2Common::Skills::Skills::SERVER_MaxDamage': 'int32_t', SERVER_MaxDamage: 'int32_t',
    },
    structFields: { D2UnitStrc: { pPath: 'D2PathUnion' }, D2PathUnion: { pStaticPath: 'D2StaticPathStrc *', pDynamicPath: 'D2DynamicPathStrc *' }, D2StaticPathStrc: { nPosX: 'int', nPosY: 'int' } },
    structLayouts: LAYOUTS,
  };
  const flat = (s: string) => s.replace(/\s+/g, ' ');

  it('005de6f0: the target X in pTarget\'s slot plus nUnitX is `nTarget + nUnitX`', () => {
    const out = flat(run(WALK_005DE6F0, V));
    assert.match(out, /int nTarget;/, out);
    assert.match(out, /sKillInfo\.nTargetX = nTarget \+ nUnitX;/, out);
    assert.match(out, /nUnitX = \(nUnitX - nTarget\) \* nDistanceFromTarget \/ nTotalDist;/, out);
    assert.doesNotMatch(out, /unk0x19/, out);
    // The first life keeps the parameter.
    assert.match(out, /GetCollisionDistance\(pUnit, pTarget\)/, out);
  });

  it('004e9d20: the max damage in pSkillsTxt\'s slot is an int local, its address passed as one', () => {
    const out = flat(run(SKILLDMG_004E9D20, V));
    assert.match(out, /int nSkillsTxt;/, out);
    assert.match(out, /nSkillsTxt = \(int\)\(nCalcResult >> 8\);/, out);
    assert.match(out, /nSkillsTxt = nSkillsTxt \+ \(nSkillLvlSaved >> 8\);/, out);
    assert.match(out, /AdjustDamageByType\(pUnitCopy, &nSkillLevel, &nSkillsTxt, pSkillsTxtSaved->EType\);/, out);
    assert.match(out, /\(nSkillsTxt \+ 500\) \/ 1000/, out);
    assert.match(out, /\(int32_t\)nSkillsTxt|SKILLDESC_DrawDamageNumbers\(nSkillLevel, nSkillsTxt,/, out);
    assert.doesNotMatch(out, /srvprgfunc|EMinLev|&pSkillsTxt/, out);
    // The first life: a D2SkillsTxt * still.
    assert.match(out, /pSkillsTxt->SrcDam/, out);
    assert.match(out, /pSkillsTxtSaved = pSkillsTxt;/, out);
  });

  it('a scalar member read on the second value is a load: left as a read through the pointer', () => {
    const out = flat(run(`int f(D2UnitStrc *pUnit, int n) {
      g(pUnit);
      pUnit = (D2UnitStrc *)k();
      return pUnit->nInitSeed + 1 + (int)pUnit;
    }`, { ...V, functionReturnTypes: { k: 'int' } }));
    assert.match(out, /\(\(D2UnitStrc\*\)nUnit\)->nInitSeed \+ 1/, out);
  });

  it('refuses the fold with no layout, a volatile or bit-field member, or a pointer result', () => {
    const src = `int f(D2UnitStrc *pUnit, int n) {
      g(pUnit);
      pUnit = (D2UnitStrc *)k();
      return (int)(pUnit->unk0x19 + n + -0x19) + (int)pUnit;
    }`;
    const o = { ...V, functionReturnTypes: { k: 'int' } };
    assert.match(flat(run(src, o)), /return nUnit \+ n \+ nUnit;/);
    for (const field of [
      { name: 'unk0x19', offset: 25, size: 3, type: 'volatile byte[3]' },
      { name: 'unk0x19', offset: 25, size: 3, type: 'byte[3]', bitSize: 0 },
    ]) {
      const out = flat(run(src, { ...o, structLayouts: { D2UnitStrc: [field] } }));
      assert.match(out, /\(\(D2UnitStrc\*\)nUnit\)->unk0x19/, out);
    }
    assert.match(flat(run(src, { ...o, structLayouts: {} })), /\(\(D2UnitStrc\*\)nUnit\)->unk0x19/);
    // An element load, and an address that stays a pointer, are not integers.
    const load = flat(run(src.replace('(int)(pUnit->unk0x19 + n + -0x19)', '(int)pUnit->unk0x19[n]'), o));
    assert.match(load, /\(\(D2UnitStrc\*\)nUnit\)->unk0x19\[n\]/, load);
    const ptr = flat(run(src.replace('(int)(pUnit->unk0x19 + n + -0x19)', 'h(pUnit->unk0x19 + n)'), o));
    assert.match(ptr, /h\(\(\(D2UnitStrc\*\)nUnit\)->unk0x19 \+ n\)/, ptr);
  });

  it('keeps an unsigned cast the arithmetic would otherwise lose', () => {
    const out = flat(run(`uint f(D2SkillsTxt *pSkillsTxt) {
      g(pSkillsTxt);
      pSkillsTxt = (D2SkillsTxt *)k();
      return (uint)(pSkillsTxt->EMinLev + 3) / 1000 + (int)pSkillsTxt;
    }`, { ...V, functionReturnTypes: { k: 'int' } }));
    assert.match(out, /\(uint\)\(nSkillsTxt \+ 500\) \/ 1000/, out);
  });

  it('refuses the split when the address is taken where the parameter is still live', () => {
    // One path reaches the call with the parameter's own value.
    const src = `void f(D2SkillsTxt *pSkillsTxt, int n) {
      g(pSkillsTxt->EType);
      if (n) pSkillsTxt = (D2SkillsTxt *)k();
      Adjust((int *)&pSkillsTxt);
      h((int)pSkillsTxt);
    }`;
    const out = flat(run(src, { ...V, functionReturnTypes: { k: 'int' } }));
    assert.match(out, /\(int\*\)&pSkillsTxt/, out);
    assert.doesNotMatch(out, /nSkillsTxt/, out);
    // ...and when the address is stored rather than passed.
    const kept = flat(run(SKILLDMG_004E9D20.replace('(int *)&pSkillsTxt', 'pSaved = (int *)&pSkillsTxt'), V));
    assert.doesNotMatch(kept, /nSkillsTxt/, kept);
  });

  it('computes what the slot computed (32-bit modular address arithmetic)', native, () => {
    const prelude = `
      #include <stdint.h>
      typedef unsigned char byte;
      struct D2UnitStrc { int eUnitType; int a; int b; int c; int d; int e; char nAct; byte unk0x19[3]; int nInitSeed; };
      static int g(D2UnitStrc *p) { return p ? p->nInitSeed : -1; }`;
    const fn = `int f(D2UnitStrc *pUnit, int n) {
        int a = g(pUnit);
        pUnit = (D2UnitStrc *)(intptr_t)(n << 4);
        return a + (int)(intptr_t)(pUnit->unk0x19 + n + -0x19);
      }`;
    const o: ReusedParamSlotOptions = { stackParameters: ['pUnit'], structLayouts: { D2UnitStrc: [{ name: 'unk0x19', offset: 25, size: 3, type: 'byte[3]' }] } };
    const split = run(fn, o);
    assert.match(flat(split), /return a \+ nUnit \+ n;/, split);
    const call = 'D2UnitStrc u = { 7 }; u.nInitSeed = 11; printf("%d\\n", f(&u, 3));';
    assert.strictEqual(compileAndRun(prelude + split, call), compileAndRun(prelude + fn, call));
  });
});
