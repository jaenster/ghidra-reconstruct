
/* WARNING: Enum "eCollisionFlags": Some values do not have unique names */
/* WARNING: Enum "eD2TimerType": Some values do not have unique names */
/* WARNING: Enum "eD2TimerTypeDWORD": Some values do not have unique names */
/* @function MakeMissile
   @address Game.exe.ram:004cd540
   @date 2026.06.20
   @calling __fastcall
   @description Constructs and spawns a missile unit from a D2SkillArgStrc request. Resolves spawn
   position (explicit X/Y or owner/source unit position), finds the containing room, computes
   velocity from missiles.txt Vel/VelLev scaled by skill level (with slowmissiles state applied),
   determines the target (unit, fixed point, or direction next to caster), then creates a
   UNIT_MISSILE via CreateMissileOrMonster. Sets anim frames/speed, path
   velocities/acceleration/max-velocity, owner, skill, level, pierce count, lightmap, optional
   particle/projectile init, plays the travel sound, and dispatches unique-monster mod attacks.
   Returns the new missile unit, or NULL on any failure (bad txt index, no room, no path). Used by
   the skill/missile firing pipeline. */

D2UnitStrc * __fastcall D2Client::UNIT::Missile::MakeMissile(D2SkillArgStrc *pSkillArg)

{
  D2DynamicPathStrc *pDynamicPath;
  int nY;
  D2RoomStrc *pRoom;
  eD2States eSlowState;
  D2StatListExStrc *pStatList;
  int32_t nTargetX;
  D2UnitStrc *pDVar6;
  int32_t nDistX;
  uint32_t nVelFinal;
  uint32_t nFramesByDist;
  D2LightMapStrc *pLightMap;
  int nMissileX;
  D2MissilesTxt *pTxtFinal;
  uint nVelocityRaw;
  int nPosY;
  longlong ullVelDiv;
  D2UnitStrc *pTargetUnit;
  uint32_t nSlowPct;
  uint32_t nVelocity;
  int32_t nDestX;
  int32_t nDestY;
  int32_t nDestXLocal;
  uint32_t nVelForPath;
  D2MissilesTxt *pMissileTxt;
  eMissilesId eMissileId;
  uint nFlags;
  short sTravelSoundId;
  
  eMissileId = pSkillArg->nMissileTxtNo;
  if ((((int)eMissileId < 0) || (sgptDataTable->nTxtMissilesSize <= (int)eMissileId)) ||
     (pMissileTxt = sgptDataTable->pTxtMissiles + eMissileId, pMissileTxt == (D2MissilesTxt *)0x0))
  {
    return (D2UnitStrc *)0x0;
  }
  if ((pSkillArg->nFlags & 1) == 0) {
    if (pSkillArg->pMissile == (D2UnitStrc *)0x0) {
      return (D2UnitStrc *)0x0;
    }
    nMissileX = D2Client::Units::Units::GetXPosFromDynamicPathUnit(pSkillArg->pMissile);
    nY = D2Client::Units::Units::GetYPosFromDynamicPathUnit(pSkillArg->pMissile);
  }
  else {
    nMissileX = pSkillArg->nX;
    nY = pSkillArg->nY;
  }
  if (pSkillArg->pOwner == (D2UnitStrc *)0x0) {
    pDVar6 = D2Client::UNIT::Player::GetPlayerUnit_UI();
    if (pDVar6 != (D2UnitStrc *)0x0) {
      nPosY = nY;
      pRoom = D2Common::Units::Units::UNITS_GetRoom(pDVar6);
      pRoom = D2Client::UNIT::Player::DRLGROOM_FindBetterNearbyRoom(pRoom,nMissileX,nPosY);
      if ((pRoom == (D2RoomStrc *)0x0) &&
         (pRoom = D2Common::DUNGEON::Dungeon::FindRoomBySubtileCoordinates(sgpDrlgAct,nMissileX,nY),
         pRoom == (D2RoomStrc *)0x0)) {
        return (D2UnitStrc *)0x0;
      }
    }
  }
  else {
    nPosY = nY;
    pRoom = D2Common::Units::Units::UNITS_GetRoom(pSkillArg->pOwner);
    pRoom = D2Client::UNIT::Player::DRLGROOM_FindBetterNearbyRoom(pRoom,nMissileX,nPosY);
    if ((pRoom == (D2RoomStrc *)0x0) &&
       (pRoom = D2Common::DUNGEON::Dungeon::FindRoomBySubtileCoordinates(sgpDrlgAct,nMissileX,nY),
       pRoom == (D2RoomStrc *)0x0)) {
      return (D2UnitStrc *)0x0;
    }
  }
  nFlags = pSkillArg->nFlags;
  if ((nFlags & 2) == 0) {
    nDestY = nY;
    nDestXLocal = nMissileX;
    if ((nFlags & 0x20) != 0) {
      nDestY = pSkillArg->nUnitY;
      nDestXLocal = pSkillArg->nUnitX;
    }
  }
  else {
    nDestY = pSkillArg->nUnitY + nY;
    nDestXLocal = pSkillArg->nUnitX + nMissileX;
  }
  if ((nFlags & 4) == 0) {
    nPosY = (uint)(byte)pMissileTxt->VelLev * pSkillArg->nToHit;
    nVelocityRaw = ((int)(nPosY + (nPosY >> 0x1f & 7U)) >> 3) + (uint)(byte)pMissileTxt->Vel;
LAB_004cd678:
    nVelocityRaw = nVelocityRaw << 8;
  }
  else {
    nVelocityRaw = pSkillArg->nVelocityOverride;
    if ((nFlags & 0x10) == 0) goto LAB_004cd678;
  }
  nSlowPct = 100;
  nVelForPath = nVelocityRaw;
  if ((((pSkillArg->pOwner != (D2UnitStrc *)0x0) && (pMissileTxt->CanSlow != 0)) &&
      (eSlowState = D2Common::DATATBLS::ItemStats::UNIT_GetUnitState
                              (pSkillArg->pOwner,STATE_slowmissiles), eSlowState != STATE_none)) &&
     (pStatList = D2Common::Stats::StatsEx::GetStatsByState(pSkillArg->pOwner,STATE_slowmissiles),
     pStatList != (D2StatListExStrc *)0x0)) {
    nSlowPct = D2Common::Stats::StatsEx::STATLIST_GetBaseStatValue
                         (pStatList,UNITSTAT_skill_handofathena,0);
    nVelocityRaw = D2Client::Stats::D2ApplyPercent(nVelocityRaw,nSlowPct,100);
    nVelForPath = nVelocityRaw;
  }
  nVelFinal = 0;
  if (nVelocityRaw != 0) {
    if ((int)nVelocityRaw < 0x100001) {
      nVelFinal = (int)(nVelocityRaw * 0x4b) / 100;
      nVelForPath = nVelFinal;
    }
    else if ((int)(nVelocityRaw & 0xfffffff0) < 0x640) {
      ullVelDiv = compiler::__allmul(nVelocityRaw,(int)nVelocityRaw >> 0x1f,0x4b,0);
      ullVelDiv = compiler::__alldiv((uint)ullVelDiv,(uint)((ulonglong)ullVelDiv >> 0x20),100,0);
      nVelFinal = (uint32_t)ullVelDiv;
      nVelForPath = nVelFinal;
    }
    else {
      nVelFinal = ((int)nVelocityRaw / 100) * 0x4b;
      nVelForPath = nVelFinal;
    }
  }
  pTargetUnit = (D2UnitStrc *)pSkillArg->pTarget;
  if (nVelFinal == 0) goto LAB_004cd7f1;
  pDVar6 = pSkillArg->pOwner;
  if (pDVar6 == (D2UnitStrc *)0x0) {
    if (pTargetUnit != (D2UnitStrc *)0x0) goto LAB_004cd774;
  }
  else if (pTargetUnit == (D2UnitStrc *)0x0) {
    if ((nDestXLocal == nMissileX) && (nDestY == nY)) {
      D2Client::SKILLS::Skills::GetPositionNextToPlayerDirection(pDVar6,&nDestXLocal,&nDestY);
    }
  }
  else {
LAB_004cd774:
    if ((pDVar6 != (D2UnitStrc *)0x0) && (pTargetUnit != pDVar6)) {
      nDistX = D2Client::Units::Units::GetXPosFromDynamicPathUnit(pDVar6);
      nTargetX = D2Client::Units::Units::GetXPosFromDynamicPathUnit(pTargetUnit);
      if (nTargetX == nDistX) {
        nDistX = D2Client::Units::Units::GetYPosFromDynamicPathUnit(pTargetUnit);
        nTargetX = D2Client::Units::Units::GetYPosFromDynamicPathUnit(pSkillArg->pOwner);
        if (nDistX == nTargetX) {
          D2Client::SKILLS::Skills::GetPositionNextToPlayerDirection
                    (pSkillArg->pOwner,&nDestXLocal,&nDestY);
          pTargetUnit = (D2UnitStrc *)0x0;
        }
      }
    }
  }
  nDistX = nDestY;
  nTargetX = nDestXLocal;
  if (pTargetUnit != (D2UnitStrc *)0x0) {
    nTargetX = D2Client::Units::Units::GetXPosFromDynamicPathUnit(pTargetUnit);
    nDistX = D2Client::Units::Units::GetYPosFromDynamicPathUnit(pTargetUnit);
  }
  nPosY = nTargetX - nMissileX;
  if (nPosY < 0) {
    nPosY = -nPosY;
  }
  if (99 < nPosY) {
    return (D2UnitStrc *)0x0;
  }
  nPosY = nDistX - nY;
  if (nPosY < 0) {
    nPosY = -nPosY;
  }
  if (99 < nPosY) {
    return (D2UnitStrc *)0x0;
  }
LAB_004cd7f1:
  pDVar6 = D2Client::UNIT::CUnit::CreateMissileOrMonster
                     (pSkillArg->nMissileTxtNo,nMissileX,nY,UNIT_MISSILE,0);
  if (pDVar6 != (D2UnitStrc *)0x0) {
    D2Common::Units::Units::InitAnimMode(pDVar6);
    D2Common::Stats::StatsEx::AllocStatListEx
              (pDVar6,0,(fpStatListExChangeCb *)0x0,(D2GameStrc *)0x0);
    pDVar6->nFrameCount = (uint)(byte)pMissileTxt->AnimLen << 8;
    D2Common::Units::Missile::SetAnimSpeed(pDVar6,(uint)(byte)pMissileTxt->AnimSpeed << 4);
    if ((pSkillArg->nFlags & 0x8000U) == 0) {
      nMissileX = (int)pMissileTxt->LevRange * pSkillArg->nToHit + (int)pMissileTxt->Range;
      if (((pSkillArg->nFlags & 8U) != 0) && (pMissileTxt->SubLoop != '\0')) {
        nMissileX = nMissileX +
                    ((uint)(byte)pMissileTxt->SubStop - (uint)(byte)pMissileTxt->SubStart) *
                    pSkillArg->nSubLoopMult;
      }
      if ((nSlowPct != 0) && (nSlowPct != 100)) {
        nDistX = D2Client::Stats::D2ApplyPercent(nMissileX,100,nSlowPct);
        nMissileX = nMissileX + nDistX;
      }
    }
    else {
      nMissileX = pSkillArg->nTotalFrames;
    }
    if ((pSkillArg->nFlags & 0x200U) != 0) {
      nMissileX = nMissileX - pSkillArg->nStartFrame;
      pDVar6->nGfxCurrentFrame = pSkillArg->nStartFrame << 8;
    }
    D2Common::Units::Missile::SetTotalFrames(pDVar6,nMissileX);
    D2Common::Units::Missile::SetCurrentFrame(pDVar6,nMissileX);
    if ((pSkillArg->nFlags & 0x800U) == 0) {
      nFlags = (uint)(byte)pMissileTxt->Activate;
    }
    else {
      nFlags = pSkillArg->nActivateFrame;
    }
    D2Common::Units::Missile::SetActivateFrame(pDVar6,nMissileX - nFlags);
    pDynamicPath = (pDVar6->pPath).pDynamicPath;
    if (pDynamicPath != (D2DynamicPathStrc *)0x0) {
      D2Common::PATH::DynamicPath::SetVelocities(pDynamicPath,0,".\\UNIT\\Missile.cpp",0x1ef4);
      if (pTargetUnit == (D2UnitStrc *)0x0) {
        D2Common::PATH::DynamicPath::SetSP1(pDynamicPath,(int16_t)nDestXLocal,(int16_t)nDestY);
      }
      else {
        D2Common::PATH::DynamicPath::SetTarget(pDynamicPath,pTargetUnit);
      }
      if (nVelForPath != 0) {
        D2Common::PATH::DynamicPath::SetVelocities
                  (pDynamicPath,nVelForPath,".\\UNIT\\Missile.cpp",0x1eff);
        D2Common::PATH::DynamicPath::PATH_CalculatePath(pDynamicPath,pDVar6,0);
      }
      if (pMissileTxt->InitSteps != '\0') {
        pDVar6->eUnitFlagsEx = pDVar6->eUnitFlagsEx | UNITFLAGEX_NODRAW;
      }
      D2Common::Units::Missile::SetOwner(pDVar6,pSkillArg->pOwner);
      D2Common::PATH::DynamicPath::SetAcceleration(pDynamicPath,(int)pMissileTxt->Accel);
      D2Common::PATH::DynamicPath::SetMaxVelocity(pDynamicPath,(uint)(byte)pMissileTxt->MaxVel << 8)
      ;
      if ((pSkillArg->nFlags & 0x2000U) != 0) {
        nVelFinal = D2Client::Archive::UNIT_GetModuloFromSeed(&pDVar6->sSeed,0x40);
        D2Common::PATH::DynamicPath::SetDirectionAndNewDirection
                  ((pDVar6->pPath).pDynamicPath,(byte)nVelFinal);
      }
      D2Client::Engine::Particle::AllocParticle(pDVar6);
      D2Client::Engine::Particle::PARTICLE_SetStoppedWithFade(pDVar6);
      if ((pSkillArg->nFlags & 0x400U) != 0) {
        nMissileX = D2Common::Collision::Collision::GetDistanceToXY(pDVar6,nDestXLocal,nDestY);
        if (nMissileX == 0) {
          nMissileX = 1;
        }
        if (nVelForPath << 4 != 0) {
          nFramesByDist = (uint)(nMissileX << 0x10) / (nVelForPath << 4);
          D2Common::Units::Missile::SetCurrentFrame(pDVar6,nFramesByDist);
          D2Common::Units::Missile::SetTotalFrames(pDVar6,nFramesByDist);
        }
      }
      if ((pSkillArg->nFlags & 0x100U) != 0) {
        nDistX = D2Common::Units::Missile::GetTotalFrames(pDVar6);
        D2Client::Engine::Particle::PARTICLE_InitProjectile(pDVar6,pSkillArg->nParticleParam,nDistX)
        ;
        D2Client::Engine::Particle::PARTICLE_UpdatePosition(pDVar6);
        D2Common::PATH::DynamicPath::SetDirectionAndNewDirection
                  (pDynamicPath,(char)nDestXLocal + (char)nDestY & 0x3f);
        D2Common::PATH::DynamicPath::SetUnsetFlags0x40(pDynamicPath,0);
      }
      D2Common::Units::Missile::SetSkill(pDVar6,pSkillArg->eSkillNo);
      D2Common::Units::Missile::SetLevel(pDVar6,(int16_t)pSkillArg->nToHit);
      if (pSkillArg->pOwner != (D2UnitStrc *)0x0) {
        D2Common::Units::Units::StoreOwner(pDVar6,pSkillArg->pOwner);
        D2Client::UNIT::Missile::MISSILE_CalculatePierceCount(pDVar6,pSkillArg->pOwner);
      }
      pTxtFinal = pMissileTxt;
      pDVar6->eUnitFlags = pDVar6->eUnitFlags & ~UNITFLAG_ISVALIDTARGET;
      if ((gnLightmapQualityLastCheck == 0) || ((pSkillArg->nFlags & 0x4000U) != 0)) {
        D2Client::UNIT::CUnit::FreeLightMap(pDVar6);
        pTxtFinal = pMissileTxt;
      }
      else if ((pMissileTxt->Light != '\0') || (*(char *)&pSkillArg->nLightRadius != '\0')) {
        D2Client::UNIT::CUnit::FreeLightMap(pDVar6);
        pLightMap = D2Client::Draw::LightMap::AllocLightMap
                              (pDVar6,1,(uint)(byte)pTxtFinal->Light,0xff,pTxtFinal->Red,
                               pTxtFinal->Green,pTxtFinal->Blue);
        (pDVar6->uSideData).pClientSide.pLight = pLightMap;
      }
      if (pSkillArg->fpFunction != (fpMissileInitFunction *)0x0) {
        (*pSkillArg->fpFunction)(pDVar6,(int32_t)pSkillArg->pMissileEx);
      }
      sTravelSoundId = pTxtFinal->TravelSound;
      if ((sTravelSoundId != 0) && ((int)sTravelSoundId != SOUND_NONE)) {
        D2Client::Sound::SOUND_PlaySound((int)sTravelSoundId,pDVar6,0,0,0);
        if ((pSkillArg->pOwner != (D2UnitStrc *)0x0) &&
           (nDistX = D2Client::UNIT::UnitSnd::UNITSND_GetMissileSound
                               ((int32_t)pSkillArg->pOwner,0x13a), nDistX != 0)) {
          D2Client::Sound::SOUND_StopById(nDistX);
        }
      }
      if (pSkillArg->pOwner != (D2UnitStrc *)0x0) {
        D2Client::UNIT::Monster::MONUNIQUE_DispatchModAttack(pSkillArg->pOwner,pDVar6);
      }
      return pDVar6;
    }
    D2Client::UNIT::CUnit::UNITS_RemoveFromClientHashTable(pDVar6->nUnitGUID,pDVar6->eUnitType);
  }
  return (D2UnitStrc *)0x0;
}

