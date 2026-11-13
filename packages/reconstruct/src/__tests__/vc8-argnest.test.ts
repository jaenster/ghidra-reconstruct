/**
 * argnest.ts: the VC8 translation nests a run of argument temporaries back into the call,
 * in VC8's right-to-left evaluation order; anything else is left as written.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fileFacts, mergeFacts } from '../vc8/facts.js';
import { argNestPass, type ArgNestMode } from '../vc8/argnest.js';

/** The declarations the bodies below call: a call must name a function the tree declares. */
const DECLS = `struct D2UnitStrc;
struct D2RoomStrc;
struct D2MissilesTxt { int SubMissile1; int Param1; short sHitPar1; };
struct SGAMEDATA;
namespace D2Common { namespace Units {
  uint32_t GetXPosFromDynamicPathUnit(D2UnitStrc* pUnit);
  uint32_t GetYPosFromDynamicPathUnit(D2UnitStrc* pUnit);
  D2RoomStrc* UNITS_GetRoom(D2UnitStrc* pUnit);
  namespace Missile {
    int32_t GetLevel(D2UnitStrc* pUnit);
    eD2Skills GetSkillId(D2UnitStrc* pUnit);
    int32_t GetRemainingFrames(D2UnitStrc* pUnit);
  }
} }
namespace D2Common { namespace DUNGEON { namespace Dungeon { eD2LevelId DRLGROOM_GetLevelIdFromRoom(D2RoomStrc* pRoom); } } }
namespace D2Common { namespace Drlg { eAct GetActNoFromLevelNumber(eD2LevelId eLevel); } }
namespace D2Common { namespace PATH { namespace Path { uint32_t Get8FlagsFromDynamicPath(void* p); } } }
namespace UNIT { namespace SUnit { D2UnitStrc* GetOwnerUnit(SGAMEDATA* pGame, D2UnitStrc* pUnit); } }
namespace UNIT { namespace Player { D2UnitStrc* GetPlayerUnit_UI(); } }
namespace Engine { namespace Gfx { void GFX_LoadMonsterCofArchive(eAct eActNo); } }
namespace SKILLS { namespace SkillsServer {
  D2UnitStrc* SKILLS_CreateMissileAtTarget(SGAMEDATA* pGame, D2UnitStrc* pOwner, eD2Skills eSkill, int32_t nLevel,
    eMissilesId eMissile, uint32_t nX, uint32_t nY);
} }
int f(int a);
int g(int a, int b);
int h(int a, int b, int c);
int g3(int a, int b, int c);
int h3(int a, int b, int c, int d, int e, int f);
int gSeed;
`;

function nest(body: string, mode: ArgNestMode = 'values'): string {
  const state = mergeFacts([fileFacts(DECLS, true, 'decls.h'), fileFacts(body, false, 'a.cpp')]);
  return argNestPass(body, state, mode);
}

describe('vc8 argnest: nested call arguments', () => {
  it('MISSILESMODE_SrvDoFn21_Distraction 005af590: the run nests right to left up to nPosY, which the if reads too', () => {
    const body = `// 1.14d: 005af590
int __fastcall MISSILESMODE_SrvDoFn21_Distraction(::SGAMEDATA * pGame, D2UnitStrc * pUnit) {
    uint32_t nPosX;
    int32_t nSkillLevel;
    eD2Skills eSkill;
    D2UnitStrc* pUnit_00;
    eMissilesId pSubMissileId;
    D2MissilesTxt* pMissilesTxt = pUnit ? D2Common::ITEMS::Items::sgptDataTable->pTxtMissiles : nullptr;
    if (pMissilesTxt->SubMissile1) {
      uint32_t nPosY;
      nPosY = D2Common::PATH::Path::Get8FlagsFromDynamicPath(pUnit->pPath.pDynamicPath);
      if (nPosY) {
        nPosY = D2Common::Units::GetYPosFromDynamicPathUnit(pUnit);
        nPosX = D2Common::Units::GetXPosFromDynamicPathUnit(pUnit);
        pSubMissileId = (eMissilesId)pMissilesTxt->SubMissile1;
        nSkillLevel = D2Common::Units::Missile::GetLevel(pUnit);
        eSkill = D2Common::Units::Missile::GetSkillId(pUnit);
        pUnit_00 = UNIT::SUnit::GetOwnerUnit(pGame, pUnit);
        SKILLS::SkillsServer::SKILLS_CreateMissileAtTarget(pGame, pUnit_00, eSkill, nSkillLevel, pSubMissileId, nPosX, nPosY);
      }
    }
    return 0;
}
`;
    const out = nest(body, 'calls');
    assert.equal(out.split('\n').length, body.split('\n').length);
    assert.equal(out, body
      .replace('    int32_t nSkillLevel;\n', '    \n')
      .replace('    eD2Skills eSkill;\n', '    \n')
      .replace('    D2UnitStrc* pUnit_00;\n', '    \n')
      .replace('        nSkillLevel = D2Common::Units::Missile::GetLevel(pUnit);\n', '        \n')
      .replace('        eSkill = D2Common::Units::Missile::GetSkillId(pUnit);\n', '        \n')
      .replace('        pUnit_00 = UNIT::SUnit::GetOwnerUnit(pGame, pUnit);\n', '        \n')
      .replace('(pGame, pUnit_00, eSkill, nSkillLevel, pSubMissileId,',
        '(pGame, (D2UnitStrc*)(UNIT::SUnit::GetOwnerUnit(pGame, pUnit)), (eD2Skills)(D2Common::Units::Missile::GetSkillId(pUnit)), ' +
        '(int32_t)(D2Common::Units::Missile::GetLevel(pUnit)), pSubMissileId,'));
    // Calls only: the load stops the run. With values (the default) the load and the X call
    // join; nPosY stays, read by the if as well.
    const values = nest(body);
    assert.match(values, /\(eMissilesId\)\(\(eMissilesId\)pMissilesTxt->SubMissile1\), \(uint32_t\)\(D2Common::Units::GetXPosFromDynamicPathUnit\(pUnit\)\), nPosY\);/);
    assert.match(values, /nPosY = D2Common::Units::GetYPosFromDynamicPathUnit\(pUnit\);/);
  });

  it('MISSILESMODE_SrvDoFn37_Unused 005b0aa0: a temporary reused by three calls nests in each', () => {
    const block = (n: number) => `    if (pMissileTxt->SubMissile${n} > 0) {
      nRemainingFrames = D2Common::Units::Missile::GetRemainingFrames(pUnit);
      if (nRemainingFrames == pMissileTxt->Param${n}) {
        nY = D2Common::Units::GetYPosFromDynamicPathUnit(pUnit);
        nX = D2Common::Units::GetXPosFromDynamicPathUnit(pUnit);
        pSubMissileId = (eMissilesId)pMissileTxt->SubMissile${n};
        nRemainingFrames = D2Common::Units::Missile::GetLevel(pUnit);
        eSkill = D2Common::Units::Missile::GetSkillId(pUnit);
        pOwner = UNIT::SUnit::GetOwnerUnit(pGame, pUnit);
        SKILLS::SkillsServer::SKILLS_CreateMissileAtTarget(pGame, pOwner, eSkill, nRemainingFrames, pSubMissileId, nX, nY);
      }
    }
`;
    const body = `// 1.14d: 005b0aa0
int __fastcall MISSILESMODE_SrvDoFn37_Unused(::SGAMEDATA * pGame, D2UnitStrc * pUnit) {
    int32_t nRemainingFrames;
    uint32_t nY;
    uint32_t nX;
    eD2Skills eSkill;
    D2UnitStrc* pOwner;
    eMissilesId pSubMissileId;
    D2MissilesTxt* pMissileTxt = D2Common::ITEMS::Items::sgptDataTable->pTxtMissiles;
${block(1)}${block(2)}${block(3)}    return 0;
}
`;
    const out = nest(body);
    assert.equal(out.split('\n').length, body.split('\n').length);
    const nested = 'SKILLS::SkillsServer::SKILLS_CreateMissileAtTarget(pGame, (D2UnitStrc*)(UNIT::SUnit::GetOwnerUnit(pGame, pUnit)), ' +
      '(eD2Skills)(D2Common::Units::Missile::GetSkillId(pUnit)), nRemainingFrames, pSubMissileId, nX, nY);';
    assert.equal(out.split(nested).length - 1, 3);
    assert.doesNotMatch(out, /eSkill|pOwner/);
    // nRemainingFrames is also read by the if: it stays, and with it every store before it.
    assert.equal(out.split('nRemainingFrames = D2Common::Units::Missile::GetLevel(pUnit);').length - 1, 3);
  });

  it('Missiles_SrvHitFunc_SpawnRadialSubMissiles 005a9d80: a call and a load nest, the gap at pTarget stops the run', () => {
    const body = `// 1.14d: 005a9d80
BOOL __fastcall Missiles_SrvHitFunc_SpawnRadialSubMissiles(::SGAMEDATA * pGame, D2UnitStrc * pUnit, D2UnitStrc * pTarget) {
    int nMissileClassIdLocal = pUnit->nClassId;
    D2MissilesTxt* pMissileTxt = nMissileClassIdLocal >= 0 ? D2Common::ITEMS::Items::sgptDataTable->pTxtMissiles + nMissileClassIdLocal : nullptr;
    nMissileClassIdLocal = pMissileTxt->sHitPar3;
    int nAngleOffset = pMissileTxt->sHitPar2;
    int nMissileCount = pMissileTxt->sHitPar1;
    int32_t nLevel = D2Common::Units::Missile::GetLevel(pUnit);
    eD2Skills eSkill = D2Common::Units::Missile::GetSkillId(pUnit);
    eMissilesId eMissileId = (eMissilesId)pMissileTxt->HitSubMissile1;
    D2UnitStrc* pOwnerUnit = UNIT::SUnit::GetOwnerUnit(pGame, pUnit);
    MISSILES_SpawnRadialPattern(pGame, pOwnerUnit, pTarget, eMissileId, eSkill, nLevel, nMissileCount, nAngleOffset, nMissileClassIdLocal);
    return 3;
}
`;
    const decl = 'void MISSILES_SpawnRadialPattern(SGAMEDATA*, D2UnitStrc*, D2UnitStrc*, eMissilesId, eD2Skills, int, int, int, int);\n';
    // The owner call and the load nest; the skill call would leave pTarget in a gap after the
    // owner call, so the run stops there and the stores before it stay.
    assert.equal(nest(decl + body), decl + body
      .replace('    eMissilesId eMissileId = (eMissilesId)pMissileTxt->HitSubMissile1;\n', '    \n')
      .replace('    D2UnitStrc* pOwnerUnit = UNIT::SUnit::GetOwnerUnit(pGame, pUnit);\n', '    \n')
      .replace('(pGame, pOwnerUnit, pTarget, eMissileId,',
        '(pGame, (D2UnitStrc*)(UNIT::SUnit::GetOwnerUnit(pGame, pUnit)), pTarget, (eMissilesId)((eMissilesId)pMissileTxt->HitSubMissile1),'));
  });
});

describe('vc8 argnest: left as written', () => {
  const wrap = (stmts: string) => `int __fastcall Caller(int a, int* p) {\n${stmts}    return 0;\n}\n`;

  it('stores in the wrong order: VC8 would evaluate the second argument first', () => {
    const body = wrap('    int t1 = f(1);\n    int t2 = f(2);\n    g(t1, t2);\n');
    assert.equal(nest(body), body);
    const swapped = wrap('    int t1 = f(1);\n    int t2 = f(2);\n    g(t2, t1);\n');
    assert.equal(nest(swapped), wrap('    \n    \n    g((int)(f(2)), (int)(f(1)));\n'));
  });

  it('a temporary read anywhere else stays, and with it the stores before it', () => {
    const body = wrap('    int t2 = f(2);\n    int t1 = f(1);\n    h(a, t1, t2);\n    a = t1;\n');
    assert.equal(nest(body), body);
    const twice = wrap('    int t2 = f(2);\n    int t1 = f(1);\n    h(t1, t1, t2);\n');
    assert.equal(nest(twice), twice);
  });

  it('a temporary whose address is taken stays', () => {
    const body = wrap('    int t2 = f(2);\n    int t1;\n    t1 = f(1);\n    h((int)&t1, t1, t2);\n');
    assert.equal(nest(body), body);
  });

  it('another argument with a side effect leaves the call alone', () => {
    for (const other of ['f(a)', 'a++', '(a = 3)', '--a']) {
      const body = wrap(`    int t2 = f(2);\n    int t1 = f(1);\n    h(${other}, t1, t2);\n`);
      assert.equal(nest(body), body, other);
    }
    assert.equal(nest(wrap('    int t2 = f(2);\n    int t1 = f(1);\n    h(a, t1, t2);\n')),
      wrap('    \n    \n    h(a, (int)(f(1)), (int)(f(2)));\n'));
  });

  it('an argument right of a nested call that reads memory or a global leaves the call alone', () => {
    for (const other of ['*p', 'p[1]', 'gSeed']) {
      const body = wrap(`    int t2 = f(2);\n    int t1 = f(1);\n    h(t1, t2, ${other});\n`);
      assert.equal(nest(body), body, other);
    }
    // Left of every nested argument it is still read after the calls, as before.
    assert.equal(nest(wrap('    int t2 = f(2);\n    int t1 = f(1);\n    h(*p, t1, t2);\n')),
      wrap('    \n    \n    h(*p, (int)(f(1)), (int)(f(2)));\n'));
  });

  it('an argument left in a gap between two nested calls cuts the run (TestCollisionWithUnit 00622aa0)', () => {
    const body = wrap('    int t5 = f(5);\n    int t4 = f(4);\n    int t1 = f(1);\n    int t0 = f(0);\n' +
      '    h3(t0, t1, a, a, t4, t5);\n');
    // t4 would be called after `a` is pushed, where the temporaries made every call first.
    assert.equal(nest(body), body.replace('    int t1 = f(1);\n    int t0 = f(0);\n', '    \n    \n')
      .replace('h3(t0, t1,', 'h3((int)(f(0)), (int)(f(1)),'));
    // A load in the gap nests, and so closes it.
    const load = wrap('    int t2 = f(2);\n    int t1 = p[0];\n    int t0 = f(0);\n    g3(t0, t1, t2);\n');
    assert.equal(nest(load), wrap('    \n    \n    \n    g3((int)(f(0)), (int)(p[0]), (int)(f(2)));\n'));
  });

  it('a statement between the stores stops the run', () => {
    const body = wrap('    int t2 = f(2);\n    a = 2;\n    int t1 = f(1);\n    h(a, t1, t2);\n');
    assert.equal(nest(body), body);
  });

  it('a single temporary stays: NET_D2GS_CLIENT_Incoming0x7E 0045e970 keeps its chain', () => {
    const body = `void __fastcall NET_D2GS_CLIENT_Incoming0x7E(D2GSPacketSrv0x7E * pBytes) {
    D2UnitStrc* pUnit = UNIT::Player::GetPlayerUnit_UI();
    D2RoomStrc* pRoom = D2Common::Units::UNITS_GetRoom(pUnit);
    eD2LevelId eLevel = D2Common::DUNGEON::Dungeon::DRLGROOM_GetLevelIdFromRoom(pRoom);
    eAct neAct = D2Common::Drlg::GetActNoFromLevelNumber(eLevel);
    Engine::Gfx::GFX_LoadMonsterCofArchive(neAct);
}
`;
    assert.equal(nest(body), body);
  });

  it('a load joins a run only in values mode, and a run needs a call', () => {
    const body = wrap('    int t2 = p[0];\n    int t1 = f(1);\n    g(t1, t2);\n');
    assert.equal(nest(body, 'calls'), body);
    assert.equal(nest(body), wrap('    \n    \n    g((int)(f(1)), (int)(p[0]));\n'));
    const noCall = wrap('    int t2 = p[1];\n    int t1 = p[0];\n    g(t1, t2);\n');
    assert.equal(nest(noCall), noCall);
  });

  it('a function naming anything volatile is left alone', () => {
    const body = wrap('    volatile int v = 0;\n    int t2 = f(2);\n    int t1 = f(1);\n    h(v, t1, t2);\n');
    assert.equal(nest(body), body);
  });
});
