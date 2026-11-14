void D2Client::UNIT::Missile::MISSILE_CalculatePierceCount(D2UnitStrc *pUnit,D2UnitStrc *pUnit2)

{
  D2MissilesTxt *pMissileTxt;
  int nPierceChance;
  int32_t nMissileClassId;
  D2UnitStrc *pLocalPlayer;
  D2SeedStrc sSeed;
  int32_t nPierceCount;
  
  nPierceCount = 0;
  if (((pUnit2 == (D2UnitStrc *)0x0) || (pUnit2->eUnitType == UNIT_PLAYER)) ||
     (pUnit2->eUnitType == UNIT_MONSTER)) {
    nMissileClassId = D2Common::Units::Missile::GetClassId(pUnit);
    if ((nMissileClassId < 0) ||
       (D2Common::ITEMS::Items::sgptDataTable->nTxtMissilesSize <= nMissileClassId)) {
      pMissileTxt = (D2MissilesTxt *)0x0;
    }
    else {
      pMissileTxt = D2Common::ITEMS::Items::sgptDataTable->pTxtMissiles + nMissileClassId;
    }
    if ((pMissileTxt->field_0x4 & (byte)Fog::BitBuffer::gadwBitMasks[2]) != 0) {
      nPierceChance =
           D2Common::Stats::StatsEx::STATSEX_GetCurrentStat(pUnit2,UNITSTAT_skill_pierce,0);
      nMissileClassId =
           D2Common::Stats::StatsEx::ITEM_GetMinimalStatValueShifted(pUnit2,UNITSTAT_item_pierce,0);
      nPierceChance = nPierceChance + nMissileClassId;
      if (nPierceChance != 0) {
        if (((pUnit2 == (D2UnitStrc *)0x0) || (pUnit2->eUnitType != UNIT_PLAYER)) ||
           (pLocalPlayer = D2Client::UNIT::Player::GetPlayerUnit_UI(), pLocalPlayer == pUnit2)) {
          nMissileClassId =
               D2Common::Stats::StatsEx::SERVER_GetUnitStat(pUnit2,UNITSTAT_pierce_idx,0);
        }
        else {
          nPierceChance = 100;
          nMissileClassId = 0;
        }
        D2Common::Seed::InitSeed_Param_666(&sSeed,nMissileClassId);
        while ((nPierceCount < 4 &&
               (sSeed = (D2SeedStrc)
                        (((ulonglong)sSeed & 0xffffffff) * 0x6ac690c5 + ((ulonglong)sSeed >> 0x20)),
               (int)(sSeed.nSeedLow + (int)(((ulonglong)sSeed & 0xffffffff) / 100) * -100) <
               nPierceChance))) {
          nPierceCount = nPierceCount + 1;
        }
        D2Common::Stats::StatsEx::STATLIST_SetUnitStat(pUnit,UNITSTAT_pierce_idx,nPierceCount,0);
      }
    }
  }
  return;
}
