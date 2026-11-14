/**
 * Tests for the limited seed roll: a draw below a limit that the decompiler prints as an
 * if/else on a power of two becomes `r = D2_SeedRollLimited(&seed, n)`. The golden cases are
 * Game.exe 1.14d functions as the generator emitted them at program v2091 (deploy 1157).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { seedRollLimitedPlugin } from '../builtins/seed-roll-limited.js';

const TABLES = {
  structFields: {
    D2SeedStrc: { nSeedLow: 'uint32_t', nSeedHigh: 'uint32_t' },
    D2UnitStrc: { sSeed: 'D2SeedStrc', nClassId: 'int', dwFlags: 'uint32_t' },
    D2DrlgRoomCoordsStrc: { dwXStart: 'int', dwYStart: 'int', dwXSize: 'int', dwYSize: 'int' },
    D2RoomStrc: { sSeed: 'D2SeedStrc' },
    D2NPCSpeechStrc: { nCount: 'uint32_t', nGossip: 'uint32_t' },
  },
};

function run(code: string): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = seedRollLimitedPlugin.createTransformer({
    ...TABLES, strict: true, onReject: (e: { line: number; why: string }) => { if (process.env.SRL_DEBUG) console.log("reject", e.line, e.why); }, onSite: (e: { result: string; seed: string; limit: string }) => { sites.push(`${e.result}=${e.seed},${e.limit}`); },
  });
  return { out: emit(t(parse(code)) as AnyNode).replace(/\s+/g, ' ').trim(), sites };
}

describe('seedRollLimitedPlugin', () => {
  it('DAMAGE_RollMinMaxDamageRange 0057d760: hoisted words and a struct temporary per arm', () => {
    const { out, sites } = run(`uint32_t __stdcall DAMAGE_RollMinMaxDamageRange(D2UnitStrc * pUnit, uint32_t * pnMinDamage, uint32_t * pnMaxDamage) {
    uint32_t uVar1;
    uint64_t uVar2;
    D2SeedStrc nSeedStateGeneral;
    uint32_t nRangeRoll = *pnMinDamage;
    if ((int)nRangeRoll <= 0) {
      nRangeRoll = 0;
    } else {
      uVar1 = pUnit->sSeed.nSeedLow;
      uVar2 = (uint64_t)pUnit->sSeed.nSeedHigh;
      if (nRangeRoll & nRangeRoll - 1) {
        nSeedStateGeneral = (D2SeedStrc)((uint64_t)uVar1 * 0x6ac690c5 + uVar2);
        pUnit->sSeed.nSeedHigh = nSeedStateGeneral.nSeedHigh;
        pUnit->sSeed.nSeedLow = nSeedStateGeneral.nSeedLow;
        nRangeRoll = (uint32_t)(nSeedStateGeneral.nSeedLow % nRangeRoll);
      } else {
        nSeedStateGeneral = (D2SeedStrc)((uint64_t)uVar1 * 0x6ac690c5 + uVar2);
        pUnit->sSeed.nSeedHigh = nSeedStateGeneral.nSeedHigh;
        pUnit->sSeed.nSeedLow = nSeedStateGeneral.nSeedLow;
        nRangeRoll = nRangeRoll - 1 & nSeedStateGeneral.nSeedLow;
      }
    }

    *pnMinDamage = nRangeRoll;
    nRangeRoll = *pnMaxDamage;
    if ((int)nRangeRoll <= 0) {
      nRangeRoll = 0;
    } else {
      uVar2 = (uint64_t)pUnit->sSeed.nSeedHigh;
      uVar1 = pUnit->sSeed.nSeedLow;
      if (nRangeRoll & nRangeRoll - 1) {
        nSeedStateGeneral = (D2SeedStrc)((uint64_t)uVar1 * 0x6ac690c5 + uVar2);
        pUnit->sSeed.nSeedHigh = nSeedStateGeneral.nSeedHigh;
        pUnit->sSeed.nSeedLow = nSeedStateGeneral.nSeedLow;
        nRangeRoll = (uint32_t)(nSeedStateGeneral.nSeedLow % nRangeRoll);
      } else {
        nSeedStateGeneral = (D2SeedStrc)((uint64_t)uVar1 * 0x6ac690c5 + uVar2);
        pUnit->sSeed.nSeedHigh = nSeedStateGeneral.nSeedHigh;
        pUnit->sSeed.nSeedLow = nSeedStateGeneral.nSeedLow;
        nRangeRoll = nRangeRoll - 1 & nSeedStateGeneral.nSeedLow;
      }
    }

    *pnMaxDamage = nRangeRoll;
    return (uint32_t)((int)*pnMinDamage >= (int)nRangeRoll);
}`);
    assert.deepStrictEqual(sites, ['nRangeRoll=&pUnit->sSeed,nRangeRoll', 'nRangeRoll=&pUnit->sSeed,nRangeRoll']);
    assert.strictEqual(out, 'uint32_t __stdcall DAMAGE_RollMinMaxDamageRange(D2UnitStrc* pUnit, uint32_t* pnMinDamage, uint32_t* pnMaxDamage) { ' +
      'uint32_t nRangeRoll = *pnMinDamage; nRangeRoll = D2_SeedRollLimited(&pUnit->sSeed, nRangeRoll); *pnMinDamage = nRangeRoll; ' +
      'nRangeRoll = *pnMaxDamage; nRangeRoll = D2_SeedRollLimited(&pUnit->sSeed, nRangeRoll); *pnMaxDamage = nRangeRoll; ' +
      'return (uint32_t)((int)*pnMinDamage >= (int)nRangeRoll); }');
  });

  it('DenOfEvilSpecific 0046af70: an int limit in a local struct, the guard without a cast', () => {
    const { out, sites } = run(`void __stdcall DenOfEvilSpecific(D2RoomStrc * pRoom, D2UnitStrc* pPlayer) {
    uint32_t nRandCoord;
    D2DrlgRoomCoordsStrc sRoomCoords;
    uint64_t nSeedHigh;
    D2SeedStrc sNewSeed;
    GetRoomCoordinates(pRoom, &sRoomCoords);
    if (sRoomCoords.dwXSize <= 0) {
      nRandCoord = 0;
    } else {
      nSeedHigh = (uint64_t)pPlayer->sSeed.nSeedHigh;
      nRandCoord = pPlayer->sSeed.nSeedLow;
      if (sRoomCoords.dwXSize & sRoomCoords.dwXSize - 1U) {
        sNewSeed = (D2SeedStrc)((uint64_t)nRandCoord * 0x6ac690c5 + nSeedHigh);
        pPlayer->sSeed.nSeedHigh = sNewSeed.nSeedHigh;
        pPlayer->sSeed.nSeedLow = sNewSeed.nSeedLow;
        nRandCoord = (uint32_t)(sNewSeed.nSeedLow % (uint32_t)sRoomCoords.dwXSize);
      } else {
        sNewSeed = (D2SeedStrc)((uint64_t)nRandCoord * 0x6ac690c5 + nSeedHigh);
        pPlayer->sSeed.nSeedHigh = sNewSeed.nSeedHigh;
        pPlayer->sSeed.nSeedLow = sNewSeed.nSeedLow;
        nRandCoord = sRoomCoords.dwXSize - 1U & sNewSeed.nSeedLow;
      }
    }
    g(nRandCoord + sRoomCoords.dwXStart);
}`);
    assert.deepStrictEqual(sites, ['nRandCoord=&pPlayer->sSeed,sRoomCoords.dwXSize']);
    assert.match(out, /GetRoomCoordinates\(pRoom, &sRoomCoords\); nRandCoord = D2_SeedRollLimited\(&pPlayer->sSeed, sRoomCoords\.dwXSize\); g\(/);
    assert.doesNotMatch(out, /nSeedHigh;|sNewSeed/);
  });

  it('SPAWN_SpawnMonsterGroupAtRandom 0054ddc0: the product hoisted above the test, the high word added implicitly', () => {
    const { out, sites } = run(`void f(D2RoomStrc* pRoom, int nRoomHeight) {
    uint64_t ullSeedProduct;
    D2SeedStrc seedNext;
    D2SeedStrc* pRoomSeed = &pRoom->sSeed;
    uint32_t nRand;
    if (nRoomHeight <= 0) {
      nRand = 0;
    } else {
      ullSeedProduct = (uint64_t)pRoomSeed->nSeedLow * 0x6ac690c5;
      if (nRoomHeight & nRoomHeight - 1U) {
        seedNext = (D2SeedStrc)(ullSeedProduct + pRoomSeed->nSeedHigh);
        pRoomSeed->nSeedHigh = seedNext.nSeedHigh;
        pRoomSeed->nSeedLow = seedNext.nSeedLow;
        nRand = (uint32_t)(seedNext.nSeedLow % (uint32_t)nRoomHeight);
      } else {
        seedNext = (D2SeedStrc)(ullSeedProduct + pRoomSeed->nSeedHigh);
        pRoomSeed->nSeedHigh = seedNext.nSeedHigh;
        pRoomSeed->nSeedLow = seedNext.nSeedLow;
        nRand = nRoomHeight - 1U & seedNext.nSeedLow;
      }
    }
    g(nRand);
}`);
    assert.deepStrictEqual(sites, ['nRand=pRoomSeed,nRoomHeight']);
    assert.match(out, /nRand = D2_SeedRollLimited\(pRoomSeed, nRoomHeight\); g\(nRand\);/);
  });

  it('a 64-bit temporary per arm with the high store sunk below the join (004af890)', () => {
    const { out, sites } = run(`void f(D2UnitStrc* pUnit, uint32_t nBloodCount) {
    uint32_t nSeedLowTmp;
    uint64_t lSeedProduct;
    uint32_t nSeedHigh;
    if ((int)nBloodCount <= 0) {
      nSeedLowTmp = 0;
    } else {
      nSeedLowTmp = pUnit->sSeed.nSeedLow;
      if (nBloodCount & nBloodCount - 1) {
        lSeedProduct = (uint64_t)nSeedLowTmp * 0x6ac690c5 + (uint64_t)pUnit->sSeed.nSeedHigh;
        nSeedLowTmp = (uint32_t)lSeedProduct;
        nSeedHigh = (uint32_t)((uint64_t)lSeedProduct >> 0x20);
        pUnit->sSeed.nSeedLow = nSeedLowTmp;
        nSeedLowTmp %= nBloodCount;
      } else {
        lSeedProduct = (uint64_t)nSeedLowTmp * 0x6ac690c5 + (uint64_t)pUnit->sSeed.nSeedHigh;
        nSeedLowTmp = (uint32_t)lSeedProduct;
        nSeedHigh = (uint32_t)((uint64_t)lSeedProduct >> 0x20);
        pUnit->sSeed.nSeedLow = nSeedLowTmp;
        nSeedLowTmp = nBloodCount - 1 & nSeedLowTmp;
      }

      pUnit->sSeed.nSeedHigh = nSeedHigh;
    }
    g(nSeedLowTmp);
}`);
    assert.deepStrictEqual(sites, ['nSeedLowTmp=&pUnit->sSeed,nBloodCount']);
    assert.strictEqual(out, 'void f(D2UnitStrc* pUnit, uint32_t nBloodCount) { uint32_t nSeedLowTmp; ' +
      'nSeedLowTmp = D2_SeedRollLimited(&pUnit->sSeed, nBloodCount); g(nSeedLowTmp); }');
  });

  it('the roll calls seed-roll-step left, as an else-if chain (00476190)', () => {
    const { out, sites } = run(`void f(D2SeedStrc* pStarSeed, int nWindowHeight) {
    uint32_t seed;
    uint32_t nYPos;
    if (nWindowHeight <= 0) {
      nYPos = 0;
    } else if (nWindowHeight & nWindowHeight - 1U) {
      seed = D2_SeedRoll(pStarSeed);
      nYPos = (uint32_t)(seed % (uint32_t)nWindowHeight);
    } else {
      seed = D2_SeedRoll(pStarSeed);
      nYPos = nWindowHeight - 1U & seed;
    }
    g(nYPos);
    seed = D2_SeedRoll(pStarSeed);
    g(seed);
}`);
    assert.deepStrictEqual(sites, ['nYPos=pStarSeed,nWindowHeight']);
    assert.match(out, /uint32_t seed; uint32_t nYPos; nYPos = D2_SeedRollLimited\(pStarSeed, nWindowHeight\); g\(nYPos\); seed = D2_SeedRoll\(pStarSeed\);/);
  });

  it('the test negated, as the pass sees it before the arms are swapped back (AI 005df850)', () => {
    const { out, sites } = run(`void f(D2UnitStrc* pUnit, uint32_t nDiameter) {
    uint32_t nRandom;
    D2SeedStrc sSeedNext;
    if ((int)nDiameter <= 0) {
      nRandom = 0;
    } else {
      nRandom = pUnit->sSeed.nSeedLow;
      if (!(nDiameter & nDiameter - 1)) {
        sSeedNext = D2_SEED_NEXT(pUnit->sSeed);
        pUnit->sSeed.nSeedHigh = sSeedNext.nSeedHigh;
        pUnit->sSeed.nSeedLow = sSeedNext.nSeedLow;
        nRandom = nDiameter - 1 & sSeedNext.nSeedLow;
      } else {
        sSeedNext = D2_SEED_NEXT(pUnit->sSeed);
        pUnit->sSeed.nSeedHigh = sSeedNext.nSeedHigh;
        pUnit->sSeed.nSeedLow = sSeedNext.nSeedLow;
        nRandom = (uint32_t)(sSeedNext.nSeedLow % nDiameter);
      }
    }
    g(nRandom);
}`);
    assert.deepStrictEqual(sites, ['nRandom=&pUnit->sSeed,nDiameter']);
    assert.strictEqual(out, 'void f(D2UnitStrc* pUnit, uint32_t nDiameter) { uint32_t nRandom; nRandom = D2_SeedRollLimited(&pUnit->sSeed, nDiameter); g(nRandom); }');
    // Negated with the arms as printed above it would be the wrong way round.
    const swapped = run(`void f(D2SeedStrc* pSeed, int n) { uint32_t r; uint32_t x;
      if (n <= 0) { r = 0; } else if (!(n & n - 1)) { x = D2_SeedRoll(pSeed); r = x % (uint32_t)n; } else { x = D2_SeedRoll(pSeed); r = n - 1U & x; }
      g(r); }`);
    assert.strictEqual(swapped.sites.length, 0);
  });

  it('the guard inverted: `> 0` with the zero store in the else arm', () => {
    const { sites } = run(`void f(D2SeedStrc* pSeed, int n) {
    uint32_t r;
    uint32_t x;
    if (n > 0) {
      if (n & n - 1) { x = D2_SeedRoll(pSeed); r = x % (uint32_t)n; } else { x = D2_SeedRoll(pSeed); r = n - 1U & x; }
    } else {
      r = 0;
    }
    g(r);
}`);
    assert.deepStrictEqual(sites, ['r=pSeed,n']);
  });

  describe('a limit defined above the guard', () => {
    it('Objects_InitFn01_Shrine 0054f9d0: `n = k - 1` in the loop, the test `n & k - 2U`', () => {
      const { out, sites } = run(`void __fastcall Objects_InitFn01_Shrine(D2ObjInitFnStrc * pInitArg) {
    uint32_t nRandIdx;
    uint32_t seedRolled;
    D2SeedStrc* pRandSeed;
    int32_t nShrinesCount;
    int nShrineTypeArg = 8;
    do {
      nShrinesCount = GetShrinesSize();
      pRandSeed = pInitArg->pSeed;
      nRandIdx = nShrinesCount - 1;
      if ((int)nRandIdx <= 0) {
        nRandIdx = 0;
      } else if (nRandIdx & nShrinesCount - 2U) {
        seedRolled = D2_SeedRoll(pRandSeed);
        nRandIdx = (uint32_t)(seedRolled % nRandIdx);
      } else {
        seedRolled = D2_SeedRoll(pRandSeed);
        nRandIdx = nShrinesCount - 2U & seedRolled;
      }

      nShrineId = nRandIdx + 1;
    } while (Test(nShrineId) && (nShrineTypeArg-- , nShrineTypeArg > 0));
}`);
      assert.deepStrictEqual(sites, ['nRandIdx=pRandSeed,nRandIdx']);
      assert.match(out, /nRandIdx = nShrinesCount - 1; nRandIdx = D2_SeedRollLimited\(pRandSeed, nRandIdx\); nShrineId = nRandIdx \+ 1;/);
      assert.doesNotMatch(out, /seedRolled/);
    });

    it('MISSILE_CreateRandomSubInRadius 004cea00: a chain of definitions, the test against the limit less one by name', () => {
      const { sites } = run(`void __fastcall MISSILE_CreateRandomSubInRadius(D2UnitStrc * pUnit, D2UnitStrc * pUnit2, int32_t nRadius) {
    uint32_t nRandX;
    uint32_t nRandY;
    uint32_t sSeedTmp;
    uint32_t nDiameter;
    int iOffsetX;
    int nRetryCount = 0;
    do {
      nRetryCount++;
      nDiameter = nRadius * 2;
      nRandY = nDiameter + 1;
      if ((int)nRandY <= 0) {
        nRandX = 0;
      } else {
        nRandX = pUnit2->sSeed.nSeedLow;
        if (nRandY & nDiameter) {
          sSeedTmp = D2_SeedRoll(&pUnit2->sSeed);
          nRandX = (uint32_t)(sSeedTmp % nRandY);
        } else {
          sSeedTmp = D2_SeedRoll(&pUnit2->sSeed);
          nRandX = nDiameter & sSeedTmp;
        }
      }

      iOffsetX = nRandX - nRadius;
      if ((int)nRandY <= 0) {
        nRandY = 0;
      } else {
        nRandX = pUnit2->sSeed.nSeedLow;
        if (nRandY & nDiameter) {
          sSeedTmp = D2_SeedRoll(&pUnit2->sSeed);
          nRandY = (uint32_t)(sSeedTmp % (uint32_t)(nRadius * 2 + 1));
        } else {
          sSeedTmp = D2_SeedRoll(&pUnit2->sSeed);
          nRandY = nRadius * 2 & sSeedTmp;
        }
      }

      g(iOffsetX, nRandY - nRadius);
    } while (nRetryCount < 10);
}`);
      assert.deepStrictEqual(sites, ['nRandX=&pUnit2->sSeed,nRandY', 'nRandY=&pUnit2->sSeed,nRandY']);
    });

    it('MISSILE_CreateFlyingRockDebris 004d0b90: the limit defined before the loop the draws are in', () => {
      const { sites } = run(`void __fastcall MISSILE_CreateFlyingRockDebris(D2UnitStrc * pMissileUnit, int32_t nSplashCount) {
    uint32_t nSplashX4;
    uint32_t nRangeP1;
    uint32_t nRandVal;
    int64_t lSeedCalc;
    D2SeedStrc sNewSeed;
    int nTargetX;
    if (nSplashCount > 0) {
      nSplashX4 = nSplashCount * 4;
      nRangeP1 = nSplashX4 + 1;
      do {
        if ((int)nRangeP1 <= 0) {
          nRandVal = 0;
        } else {
          lSeedCalc = (uint64_t)pMissileUnit->sSeed.nSeedLow * 0x6ac690c5;
          nRandVal = pMissileUnit->sSeed.nSeedHigh;
          if (nRangeP1 & nSplashX4) {
            sNewSeed = (D2SeedStrc)(lSeedCalc + (uint64_t)nRandVal);
            pMissileUnit->sSeed.nSeedHigh = sNewSeed.nSeedHigh;
            pMissileUnit->sSeed.nSeedLow = sNewSeed.nSeedLow;
            nRandVal = (uint32_t)(sNewSeed.nSeedLow % nRangeP1);
          } else {
            sNewSeed = (D2SeedStrc)(lSeedCalc + (uint64_t)nRandVal);
            pMissileUnit->sSeed.nSeedHigh = sNewSeed.nSeedHigh;
            pMissileUnit->sSeed.nSeedLow = sNewSeed.nSeedLow;
            nRandVal = nSplashX4 & sNewSeed.nSeedLow;
          }
        }

        nTargetX = nRandVal + nSplashCount * -2;
        if ((int)nRangeP1 <= 0) {
          nRandVal = 0;
        } else {
          nRandVal = pMissileUnit->sSeed.nSeedLow;
          if (nRangeP1 & nSplashX4) {
            sNewSeed = D2_SEED_NEXT(pMissileUnit->sSeed);
            pMissileUnit->sSeed.nSeedHigh = sNewSeed.nSeedHigh;
            pMissileUnit->sSeed.nSeedLow = sNewSeed.nSeedLow;
            nRandVal = (uint32_t)(sNewSeed.nSeedLow % nRangeP1);
          } else {
            sNewSeed = D2_SEED_NEXT(pMissileUnit->sSeed);
            pMissileUnit->sSeed.nSeedHigh = sNewSeed.nSeedHigh;
            pMissileUnit->sSeed.nSeedLow = sNewSeed.nSeedLow;
            nRandVal = nSplashX4 & sNewSeed.nSeedLow;
          }
        }

        MakeMissile(nTargetX, nRandVal);
        nSplashCount--;
      } while (nSplashCount);
    }
}`);
      assert.deepStrictEqual(sites, ['nRandVal=&pMissileUnit->sSeed,nRangeP1', 'nRandVal=&pMissileUnit->sSeed,nRangeP1']);
    });

    it('Objects_InitFn46 005506d0: the limit from a member of a local struct, right above the guard', () => {
      const { sites } = run(`void __fastcall Objects_InitFn46(D2ObjInitFnStrc * pInitArg) {
    uint32_t dwTmp;
    D2SeedStrc sSeedRoll;
    D2DrlgRoomCoordsStrc sRoomCoords;
    int nCurX;
    DRLGROOM_GetRoomCoordinates(pInitArg->pRoom, &sRoomCoords);
    D2SeedStrc* pObjCtrlSeed;
    pObjCtrlSeed = GetObjectControlSeed(pInitArg->pGame, pInitArg->pRoom);
    dwTmp = sRoomCoords.dwXSize - 4;
    if ((int)dwTmp <= 0) {
      dwTmp = 0;
    } else if (dwTmp & sRoomCoords.dwXSize - 5U) {
      sSeedRoll = D2_SEED_NEXT(*pObjCtrlSeed);
      pObjCtrlSeed->nSeedHigh = sSeedRoll.nSeedHigh;
      pObjCtrlSeed->nSeedLow = sSeedRoll.nSeedLow;
      dwTmp = (uint32_t)(sSeedRoll.nSeedLow % dwTmp);
    } else {
      sSeedRoll = D2_SEED_NEXT(*pObjCtrlSeed);
      pObjCtrlSeed->nSeedHigh = sSeedRoll.nSeedHigh;
      pObjCtrlSeed->nSeedLow = sSeedRoll.nSeedLow;
      dwTmp = sRoomCoords.dwXSize - 5U & sSeedRoll.nSeedLow;
    }

    nCurX = dwTmp + sRoomCoords.dwXStart;
    g(nCurX);
}`);
      assert.deepStrictEqual(sites, ['dwTmp=pObjCtrlSeed,dwTmp']);
    });

    it('MISSILE_CreateRandomOffset 004ce530: a seed pointer set once names the member it points at', () => {
      const { out, sites } = run(`D2UnitStrc * __stdcall MISSILE_CreateRandomOffset(D2UnitStrc * pUnit, int32_t nRadius, D2UnitStrc * pUnit2) {
    uint32_t nRandX;
    uint32_t sSeedTmp;
    uint32_t uSeedHighWord;
    uint32_t nRandY = nRadius * 2;
    uint32_t nDiameter = nRandY + 1;
    D2SeedStrc* pSeed = &pUnit2->sSeed;
    if ((int)nDiameter <= 0) {
      nRandX = 0;
    } else {
      uSeedHighWord = pUnit2->sSeed.nSeedHigh;
      if (nDiameter & nRandY) {
        sSeedTmp = D2_SeedRoll(pSeed);
        nRandX = (uint32_t)(sSeedTmp % nDiameter);
      } else {
        sSeedTmp = D2_SeedRoll(pSeed);
        nRandX = nRandY & sSeedTmp;
      }
    }

    return g(nRandX, pSeed);
}`);
      // The call keeps the spelling of the block's first seed access.
      assert.deepStrictEqual(sites, ['nRandX=&pUnit2->sSeed,nDiameter']);
      assert.doesNotMatch(out, /uSeedHighWord|sSeedTmp/);
    });

    describe('left alone', () => {
      const shrine = (between: string, before = '', loop = '') => `void f(D2SeedStrc* pSeed, int k) {
    uint32_t n; uint32_t x; uint32_t r;
    ${before}
    do {
      n = k - 1;
      ${between}
      if ((int)n <= 0) {
        r = 0;
      } else if (n & k - 2U) {
        x = D2_SeedRoll(pSeed);
        r = (uint32_t)(x % n);
      } else {
        x = D2_SeedRoll(pSeed);
        r = k - 2U & x;
      }
      g(r);
      ${loop}
    } while (r);
}`;
      it('the shape that is rewritten', () => {
        assert.strictEqual(run(shrine('')).sites.length, 1);
      });
      it('the operand written between the definition and the guard', () => {
        assert.strictEqual(run(shrine('k = h();')).sites.length, 0);
        assert.strictEqual(run(shrine('k++;')).sites.length, 0);
        assert.strictEqual(run(shrine('if (r) { k = 3; }')).sites.length, 0);
      });
      it('a label between the definition and the guard', () => {
        assert.strictEqual(run(shrine('again: h();', '', 'if (r == 2) goto again;')).sites.length, 0);
      });
      it('the definition above a loop that writes its operand', () => {
        const code = `void f(D2SeedStrc* pSeed, int k) {
    uint32_t n; uint32_t x; uint32_t r;
    n = k - 1;
    do {
      if ((int)n <= 0) { r = 0; }
      else if (n & k - 2U) { x = D2_SeedRoll(pSeed); r = (uint32_t)(x % n); }
      else { x = D2_SeedRoll(pSeed); r = k - 2U & x; }
      k = g(r);
    } while (k);
}`;
        assert.strictEqual(run(code).sites.length, 0);
        assert.strictEqual(run(code.replace('k = g(r);', 'g(r);')).sites.length, 1);
      });
      it('a member read above a call that may write the struct', () => {
        const code = `void f(D2SeedStrc* pSeed) {
    uint32_t n; uint32_t x; uint32_t r;
    D2DrlgRoomCoordsStrc s;
    GetCoords(&s);
    n = s.dwXSize - 4;
    BETWEEN
    if ((int)n <= 0) { r = 0; }
    else if (n & s.dwXSize - 5U) { x = D2_SeedRoll(pSeed); r = (uint32_t)(x % n); }
    else { x = D2_SeedRoll(pSeed); r = s.dwXSize - 5U & x; }
    g(r);
}`;
        assert.strictEqual(run(code.replace('BETWEEN', '')).sites.length, 1);
        assert.strictEqual(run(code.replace('BETWEEN', 'GetCoords(&s);')).sites.length, 0);
        assert.strictEqual(run(code.replace('BETWEEN', 's.dwXSize = 7;')).sites.length, 0);
      });
      it('a seed pointer set to another seed, or its base written', () => {
        const code = `void f(D2UnitStrc* pUnit, D2UnitStrc* pOther, int n) {
    uint32_t r; uint32_t x; uint32_t h;
    D2SeedStrc* pSeed = &pUnit->sSeed;
    BETWEEN
    if (n <= 0) { r = 0; }
    else { h = pUnit->sSeed.nSeedHigh;
      if (n & n - 1) { x = D2_SeedRoll(pSeed); r = x % (uint32_t)n; }
      else { x = D2_SeedRoll(pSeed); r = n - 1U & x; } }
    g(r);
}`;
        assert.strictEqual(run(code.replace('BETWEEN', '')).sites.length, 1);
        assert.strictEqual(run(code.replace('BETWEEN', 'pSeed = &pOther->sSeed;')).sites.length, 0);
        assert.strictEqual(run(code.replace('BETWEEN', 'pUnit = pOther;')).sites.length, 0);
      });
      it('a limit that is not the definition plus one: `n = k - 1` against `k - 3U`', () => {
        assert.strictEqual(run(shrine('').replace(/k - 2U/g, 'k - 3U')).sites.length, 0);
      });
    });
  });

  describe('left alone', () => {
    const shape = (guard: string, arms: [string, string], after = 'g(r);', decls = 'uint32_t r; uint32_t x;') => `void f(D2SeedStrc* pSeed, uint32_t u, int n) {
    ${decls}
    if (${guard}) {
      r = 0;
    } else if (n & n - 1) {
      x = D2_SeedRoll(pSeed);
      ${arms[0]}
    } else {
      x = D2_SeedRoll(pSeed);
      ${arms[1]}
    }
    ${after}
}`;
    const good: [string, string] = ['r = x % (uint32_t)n;', 'r = n - 1U & x;'];

    it('the shape that is rewritten', () => {
      assert.strictEqual(run(shape('n <= 0', good)).sites.length, 1);
    });
    it('an unsigned guard: `u <= 0` is `u == 0`, not the helper\'s signed test', () => {
      const code = `void f(D2SeedStrc* pSeed, uint32_t u) {
      uint32_t r; uint32_t x;
      if (u <= 0) { r = 0; }
      else if (u & u - 1) { x = D2_SeedRoll(pSeed); r = x % u; }
      else { x = D2_SeedRoll(pSeed); r = u - 1 & x; }
      g(r);
    }`;
      assert.strictEqual(run(code).sites.length, 0);
      assert.strictEqual(run(code.replace('if (u <= 0)', 'if ((int)u <= 0)')).sites.length, 1);
    });
    it('a guard on another value than the test', () => {
      assert.strictEqual(run(shape('(int)u <= 0', good)).sites.length, 0);
    });
    it('a signed remainder', () => {
      assert.strictEqual(run(shape('n <= 0', ['r = (int)x % n;', 'r = n - 1U & x;'])).sites.length, 0);
    });
    it('the arms swapped', () => {
      assert.strictEqual(run(shape('n <= 0', [good[1], good[0]])).sites.length, 0);
    });
    it('a mask by the limit, not the limit less one', () => {
      assert.strictEqual(run(shape('n <= 0', [good[0], 'r = n & x;'])).sites.length, 0);
    });
    it('a temporary read after the block', () => {
      assert.strictEqual(run(shape('n <= 0', good, 'g(r, x);')).sites.length, 0);
    });
    it('the temporary read after, but rewritten first: dead', () => {
      assert.strictEqual(run(shape('n <= 0', good, 'x = 5; g(r, x);')).sites.length, 1);
    });
    it('a 64-bit result', () => {
      assert.strictEqual(run(shape('n <= 0', good, 'g(r);', 'uint64_t r; uint32_t x;')).sites.length, 0);
    });
    it('two steps in one arm', () => {
      assert.strictEqual(run(shape('n <= 0', ['x = D2_SeedRoll(pSeed); r = x % (uint32_t)n;', good[1]])).sites.length, 0);
    });
    it('a call between', () => {
      assert.strictEqual(run(shape('n <= 0', ['h(); r = x % (uint32_t)n;', good[1]])).sites.length, 0);
    });
    it('a step of a different seed in one arm', () => {
      const code = shape('n <= 0', ['x = D2_SeedRoll(pOther); r = x % (uint32_t)n;', good[1]])
        .replace('x = D2_SeedRoll(pSeed);\n      x = D2_SeedRoll(pOther)', 'x = D2_SeedRoll(pOther)')
        .replace('int n)', 'int n, D2SeedStrc* pOther)');
      assert.strictEqual(run(code).sites.length, 0);
    });
    it('only the low word stored back', () => {
      const code = `void f(D2UnitStrc* pUnit, int n) {
      uint32_t r; uint64_t l;
      if (n <= 0) { r = 0; }
      else if (n & n - 1) { l = (uint64_t)pUnit->sSeed.nSeedLow * 0x6ac690c5 + (uint64_t)pUnit->sSeed.nSeedHigh; pUnit->sSeed.nSeedLow = (uint32_t)l; r = (uint32_t)l % (uint32_t)n; }
      else { l = (uint64_t)pUnit->sSeed.nSeedLow * 0x6ac690c5 + (uint64_t)pUnit->sSeed.nSeedHigh; pUnit->sSeed.nSeedLow = (uint32_t)l; pUnit->sSeed.nSeedHigh = (uint32_t)(l >> 0x20); r = n - 1U & (uint32_t)l; }
      g(r);
    }`;
      assert.strictEqual(run(code).sites.length, 0);
    });
    it('the high word sign-extended', () => {
      const code = `void f(D2UnitStrc* pUnit, int n) {
      uint32_t r; int64_t l;
      if (n <= 0) { r = 0; }
      else if (n & n - 1) { l = (uint64_t)pUnit->sSeed.nSeedLow * 0x6ac690c5 + (int64_t)(int)pUnit->sSeed.nSeedHigh; pUnit->sSeed.nSeedLow = (uint32_t)l; pUnit->sSeed.nSeedHigh = (uint32_t)((uint64_t)l >> 0x20); r = (uint32_t)l % (uint32_t)n; }
      else { l = (uint64_t)pUnit->sSeed.nSeedLow * 0x6ac690c5 + (int64_t)(int)pUnit->sSeed.nSeedHigh; pUnit->sSeed.nSeedLow = (uint32_t)l; pUnit->sSeed.nSeedHigh = (uint32_t)((uint64_t)l >> 0x20); r = n - 1U & (uint32_t)l; }
      g(r);
    }`;
      assert.strictEqual(run(code).sites.length, 0);
    });
    it('the same with the high word zero-extended is rewritten', () => {
      const code = `void f(D2UnitStrc* pUnit, int n) {
      uint32_t r; int64_t l;
      if (n <= 0) { r = 0; }
      else if (n & n - 1) { l = (uint64_t)pUnit->sSeed.nSeedLow * 0x6ac690c5 + (uint64_t)pUnit->sSeed.nSeedHigh; pUnit->sSeed.nSeedLow = (uint32_t)l; pUnit->sSeed.nSeedHigh = (uint32_t)((uint64_t)l >> 0x20); r = (uint32_t)l % (uint32_t)n; }
      else { l = (uint64_t)pUnit->sSeed.nSeedLow * 0x6ac690c5 + (uint64_t)pUnit->sSeed.nSeedHigh; pUnit->sSeed.nSeedLow = (uint32_t)l; pUnit->sSeed.nSeedHigh = (uint32_t)((uint64_t)l >> 0x20); r = n - 1U & (uint32_t)l; }
      g(r);
    }`;
      assert.strictEqual(run(code).sites.length, 1);
    });
    it('a memory limit read again after the seed is stored', () => {
      const code = `void f(D2UnitStrc* pUnit, D2NPCSpeechStrc* pSpeech) {
      uint32_t r; uint32_t x;
      if ((int)pSpeech->nCount <= 0) { r = 0; }
      else if (pSpeech->nCount & pSpeech->nCount - 1) { x = D2_SeedRoll(&pUnit->sSeed); r = x % pSpeech->nCount; }
      else { x = D2_SeedRoll(&pUnit->sSeed); r = pSpeech->nCount - 1 & x; }
      g(r);
    }`;
      assert.strictEqual(run(code).sites.length, 0);
    });
    it('the seed pointer written in the block', () => {
      const code = `void f(D2SeedStrc* pSeed, int n) {
      uint32_t r; uint32_t x;
      if (n <= 0) { r = 0; }
      else if (n & n - 1) { x = D2_SeedRoll(pSeed); r = x % (uint32_t)n; }
      else { pSeed = pSeed; x = D2_SeedRoll(pSeed); r = n - 1U & x; }
      g(r);
    }`;
      assert.strictEqual(run(code).sites.length, 0);
    });
    it('a result whose address is taken', () => {
      assert.strictEqual(run(shape('n <= 0', good, 'g(&r);')).sites.length, 0);
    });
  });
});
