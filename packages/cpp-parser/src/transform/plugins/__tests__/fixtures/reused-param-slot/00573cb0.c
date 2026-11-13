
/* WARNING: Enum "eCollisionFlags": Some values do not have unique names */
/* WARNING: Enum "eD2TimerType": Some values do not have unique names */
/* WARNING: Enum "eD2TimerTypeDWORD": Some values do not have unique names */
/* @function MONSTER_InitStats
   @address Game.exe.ram:00573cb0
   @date 2026.06.20
   @params
     pGame: Stack[0x4]:4 (SGAMEDATA *)
     pRoom: Stack[0x8]:4 (D2RoomStrc *)
     pMonRegionField: Stack[0xc]:4 (D2MonsterRegionFieldStrc *)
     pUnit: ESI:4 (D2UnitStrc *)
   @description Server-side: fully initializes a spawned monster's stats/skills/inventory. Bails
   unless pUnit is a valid UNIT_MONSTER with MonStats/MonStatsEx records. Rolls component
   appearance, applies act-boss name bytes (classId 0x137/0x138), computes level/difficulty scaling
   (player-count multipliers), then SETs resistances, block, attack/velocity/animrate, HP (rolled
   min..max + player% bonus, capped 0x7FFFFF, x256), armorclass, experience and HP-regen via
   STATLIST_SetUnitStat. Applies difficulty scaling, attaches a second stat list, creates player or
   NPC inventory, builds the skills list (8 skills from MonStatsEx with level bonus + mode), sets
   CANBEATTACKED/PETIGNORE flags, rolls up-to-6 random monster properties (MonProp txt,
   per-difficulty chance), and equips summon items. Halts on bad HP-regen value. */

void D2Game::Monster::Monster::MONSTER_InitStats
               (SGAMEDATA *pGame,D2RoomStrc *pRoom,D2MonsterRegionFieldStrc *pMonRegionField,
               D2UnitStrc *pUnit)

{
  D2SeedStrc DVar1;
  int nMonStatsExId;
  uint32_t dwTmpStat;
  uint32_t nTmpVal;
  eD2LevelId eRoomLevelId;
  int32_t nScaledStat;
  void *nAddress;
  D2StatListExStrc *pStatsEx;
  D2InventoryStrc *pNpcInventory;
  D2SkillListStrc *pSkillsList;
  D2SkillStrc *pSkill;
  int nTmpInt;
  D2MonsterRegionFieldStrc *pDVar2;
  uint16_t nLayer;
  D2MonStatsInitStrc sMonStats;
  D2MonsterLevelDataStrc monLevelData;
  D2MonStatsExTxtSlot uMonTxt;
  int nMonClassId;
  int nPlayerCount;
  int nMonLevel;
  D2MonStatsTxt *pMonStatsTxt;
  int32_t nStatLayer;
  uint32_t nErrorLine;
  uint32_t dwHpRegenRaw;
  byte byDifficultyIdx;

  if (pUnit == (D2UnitStrc *)0x0) {
    return;
  }
  nTmpInt = pUnit->nClassId;
  if (pUnit->eUnitType != UNIT_MONSTER) {
    return;
  }
  if ((pUnit->pUnitData).pUnitDataMonster == (D2UnitDataMonsterStrc *)0x0) {
    return;
  }
  pMonStatsTxt = ((pUnit->pUnitData).pUnitDataMonster)->pMonStatsTxt;
  if (pMonStatsTxt == (D2MonStatsTxt *)0x0) {
    return;
  }
  if (nTmpInt < 0) {
    return;
  }
  if (D2Common::ITEMS::Items::sgptDataTable->nTxtMonStatsSize <= nTmpInt) {
    return;
  }
  nMonStatsExId = (int)D2Common::ITEMS::Items::sgptDataTable->pTxtMonStats[nTmpInt].MonStatsEx;
  if (nMonStatsExId < 0) {
    return;
  }
  if (D2Common::ITEMS::Items::sgptDataTable->nTxtMonStatsExSize <= nMonStatsExId) {
    return;
  }
  uMonTxt.pMonStats2Txt = D2Common::ITEMS::Items::sgptDataTable->pTxtMonStatsEx + nMonStatsExId;
                    /* uMonTxt (Stack[-0x14]) holds a D2MonStats2Txt* here (IMUL 0x134 off
                       sgptDataTable+0xa90) until the isAtt test at 00574146;
                       it is reused for a D2MonPropTxt* from 00574174 on, hence union
                       D2MonStatsExTxtSlot. */
  if (uMonTxt.pMonStats2Txt == (D2MonStats2Txt *)0x0) {
    return;
  }
  nMonClassId = nTmpInt;
  D2Game::Monster::Monster::MONSTER_RollComponentAppearance(pMonRegionField,pUnit);
  if (D2Common::ITEMS::Items::sgptDataTable->nTxtMonStatsSize <= nTmpInt) {
    nTmpInt = -1;
  }
  if (nTmpInt == 0x137) {
    nTmpVal = D2Common::Seed::UNIT_GetModuloFromSeed(&pUnit->sSeed,4);
    if ((pUnit->eUnitType == UNIT_MONSTER) &&
       ((pUnit->pUnitData).pUnitDataMonster != (D2UnitDataMonsterStrc *)0x0)) {
      ((pUnit->pUnitData).pUnitDataMonster)->Components[10] = (byte)nTmpVal;
    }
  }
  else if ((nTmpInt == 0x138) &&
          (dwTmpStat = D2Common::Seed::UNIT_GetModuloFromSeed(&pUnit->sSeed,4),
          pUnit->eUnitType == UNIT_MONSTER)) {
    if ((pUnit->pUnitData).pUnitDataMonster != (D2UnitDataMonsterStrc *)0x0) {
      ((pUnit->pUnitData).pUnitDataMonster)->Components[10] = (byte)dwTmpStat;
    }
    if ((pUnit->eUnitType == UNIT_MONSTER) &&
       ((pUnit->pUnitData).pUnitDataMonster != (D2UnitDataMonsterStrc *)0x0)) {
      ((pUnit->pUnitData).pUnitDataMonster)->Components[0xb] = (byte)dwTmpStat;
    }
  }
  D2Game::Monster::Monster::MONSTER_InitLevelDifficultyScaling(pGame,&monLevelData,pRoom,pUnit);
  byDifficultyIdx = pGame->nDifficulty;
  if (byDifficultyIdx != 0) {
    if (1 < byDifficultyIdx) {
      pMonRegionField = (D2MonsterRegionFieldStrc *)&DAT_00000002;
      goto init_stats_for_difficulty;
    }
    if (byDifficultyIdx != 0) {
      pMonRegionField = (D2MonsterRegionFieldStrc *)(uint)byDifficultyIdx;
      goto init_stats_for_difficulty;
    }
  }
  pMonRegionField = (D2MonsterRegionFieldStrc *)0x0;
init_stats_for_difficulty:
  nTmpVal = D2Common::Monsters::MONSTERS::MONSTER_GetMercType(pUnit);
  if (nTmpVal != 0) {
    pMonRegionField = (D2MonsterRegionFieldStrc *)0x0;
  }
  nPlayerCount = 1;
  if (0 < (int)monLevelData.nPlayerMultiplyer3) {
    nPlayerCount = monLevelData.nPlayerMultiplyer3;
  }
  nMonLevel = (int)pMonStatsTxt->aLevel[(int)pMonRegionField];
  nTmpInt = pGame->bExpansion;
  if ((((nTmpInt != 0) && (pMonRegionField != (D2MonsterRegionFieldStrc *)0x0)) &&
      ((Fog::BitBuffer::gadwBitMasks[2] & (byte)pMonStatsTxt->field_0xc) == 0)) &&
     ((Fog::BitBuffer::gadwBitMasks[6] & (byte)pMonStatsTxt->field_0xc) == 0)) {
    pDVar2 = pMonRegionField;
    eRoomLevelId = D2Common::DUNGEON::Dungeon::DRLGROOM_GetLevelIdFromRoom(pRoom);
    nMonLevel = D2Common::DATATBLS::LvlTbls::TXT_Levels_GetMonLvlForDifficulty
                          (eRoomLevelId,(eD2Difficulty)pDVar2,nTmpInt);
  }
  D2Common::Stats::StatsEx::AllocStatListEx
            (pUnit,0,D2Game::ITEMS::ItemMode::STATSLISTEX_FunctionCallback,pGame);
  D2Common::Stats::StatsEx::STATLIST_SetUnitStat(pUnit,UNITSTAT_level,nMonLevel,0);
  D2Common::Stats::StatsEx::STATLIST_SetUnitStat(pUnit,UNITSTAT_monster_playercount,nPlayerCount,0);
  D2Common::Stats::StatsEx::STATLIST_SetUnitStat
            (pUnit,UNITSTAT_damageresist,(int)pMonStatsTxt->aResDm[(int)pMonRegionField],0);
  D2Common::Stats::StatsEx::STATLIST_SetUnitStat
            (pUnit,UNITSTAT_magicresist,(int)pMonStatsTxt->aResMa[(int)pMonRegionField],0);
  D2Common::Stats::StatsEx::STATLIST_SetUnitStat
            (pUnit,UNITSTAT_fireresist,(int)pMonStatsTxt->aResFi[(int)pMonRegionField],0);
  D2Common::Stats::StatsEx::STATLIST_SetUnitStat
            (pUnit,UNITSTAT_lightresist,(int)pMonStatsTxt->aResLi[(int)pMonRegionField],0);
  D2Common::Stats::StatsEx::STATLIST_SetUnitStat
            (pUnit,UNITSTAT_coldresist,(int)pMonStatsTxt->aResCo[(int)pMonRegionField],0);
  D2Common::Stats::StatsEx::STATLIST_SetUnitStat
            (pUnit,UNITSTAT_poisonresist,(int)pMonStatsTxt->aResPo[(int)pMonRegionField],0);
  D2Common::Stats::StatsEx::STATLIST_SetUnitStat
            (pUnit,UNITSTAT_toblock,
             (uint)(pMonRegionField[3].aArray[0].aComponentVariants + 3)[(int)pMonStatsTxt],0);
  D2Common::Stats::StatsEx::STATLIST_SetUnitStat(pUnit,UNITSTAT_attackrate,100,0);
  D2Common::Stats::StatsEx::STATLIST_SetUnitStat(pUnit,UNITSTAT_velocitypercent,0x4b,0);
  D2Common::Stats::StatsEx::STATLIST_SetUnitStat(pUnit,UNITSTAT_other_animrate,100,0);
  D2Common::Stats::StatsEx::STATLIST_SetUnitStat(pUnit,UNITSTAT_last_sent_hp_pct,0x80,0);
  if ((pGame->nGameType != SGAMETYPE_BNET_HOST) ||
     (pRoom = (D2RoomStrc *)0x0, pGame->eGameType != GAMETYPE_SINGLEPLAYER)) {
    pRoom = (D2RoomStrc *)0x1;
  }
  compiler::memset(&sMonStats,0,0x38);
  D2Common::DATATBLS::MonsterTbls::MONSTER_CalculateLevelScaledStats
            (pUnit->nClassId,(int32_t)pRoom,(uint32_t)pMonRegionField,nMonLevel,7,&sMonStats);
  nTmpVal = D2Common::Seed::RANDOM_RandomNumberSelector
                      (&pUnit->sSeed,(sMonStats.nMaxHP - sMonStats.nMinHP) + 1);
  nScaledStat = D2Common::DATATBLS::DataTbls::D2ApplyPercent
                          (nTmpVal + sMonStats.nMinHP,monLevelData.nPlayerMultiplyer,100);
  nTmpInt = nTmpVal + sMonStats.nMinHP + nScaledStat;
  if (0x7fffff < nTmpInt) {
    nTmpInt = 0x7fffff;
  }
  nTmpInt = nTmpInt * 0x100;
  D2Common::Stats::StatsEx::STATLIST_SetUnitStat(pUnit,UNITSTAT_maxhp,nTmpInt,0);
  D2Common::Stats::StatsEx::STATLIST_SetUnitStat(pUnit,UNITSTAT_hitpoints,nTmpInt,0);
  D2Common::Stats::StatsEx::STATLIST_SetUnitStat(pUnit,UNITSTAT_armorclass,sMonStats.nAC,0);
  nLayer = 0;
  nScaledStat = D2Common::DATATBLS::DataTbls::D2ApplyPercent
                          (sMonStats.nExp,monLevelData.nPlayerMultiplyer2,100);
  D2Common::Stats::StatsEx::STATLIST_SetUnitStat
            (pUnit,UNITSTAT_experience,nScaledStat + sMonStats.nExp,nLayer);
  dwHpRegenRaw = pMonStatsTxt->DamageRegen;
  if ((int)dwHpRegenRaw < 0) {
    nErrorLine = 0xde;
  }
  else {
    if ((dwHpRegenRaw & 0xfffff000) == 0) {
      nScaledStat = 0;
      if (dwHpRegenRaw != 0) {
        if ((int)(0x7fffffff / (longlong)(int)dwHpRegenRaw) < nTmpInt) {
          nScaledStat = (nTmpInt >> 0xc) * dwHpRegenRaw;
        }
        else {
          nScaledStat = (int)(dwHpRegenRaw * nTmpInt) >> 0xc;
        }
      }
      D2Common::Stats::StatsEx::STATLIST_SetUnitStat(pUnit,UNITSTAT_hpregen,nScaledStat,0);
      D2Common::Monsters::MONSTERS::MONSTER_ApplyDifficultyScaling
                (pUnit,pGame->bExpansion,pGame->nDifficulty);
      pStatsEx = (D2StatListExStrc *)
                 D2Common::Stats::StatsEx::AllocStatList
                           (pGame->pMemoryPool,1,0,UNIT_MONSTER,pUnit->nUnitGUID);
      D2Common::Stats::StatsEx::STATLIST_AttachStatListToUnit(pUnit,pStatsEx,1);
      if ((pMonStatsTxt->field_0xf & (byte)Fog::BitBuffer::gadwBitMasks[0]) != 0) {
        if ((pMonStatsTxt->field_0xd & (byte)Fog::BitBuffer::gadwBitMasks[1]) == 0) {
          D2Common::INVENTORY::Inventory::STRUCT_CreatePlayerInventory
                    ((D2PoolManagerStrc *)0x0,pUnit);
        }
        else {
          nScaledStat = D2Common::DATATBLS::MonsterTbls::ValidateClassId(nMonClassId);
          pNpcInventory = D2Game::UNIT::sunitproxy::SUNITPROXY_GetNpcInventory(pGame,nScaledStat);
          pUnit->pInventory = pNpcInventory;
        }
      }
      pSkillsList = D2Common::Skills::Skills::STRUCT_CreateSkillsList(pGame->pMemoryPool);
      pUnit->pSkillsList = pSkillsList;
      pRoom = (D2RoomStrc *)pMonStatsTxt->aSkill;
      nTmpInt = 0;
      do {
        if ((-1 < *(short *)&pRoom->ppRoomList) && ('\0' < pMonStatsTxt->aSkLvl[nTmpInt])) {
          D2Game::SKILLS::SkillsServer::SetSkill
                    (pUnit,(int)*(short *)&pRoom->ppRoomList,
                     (int)pMonStatsTxt->aSkLvl[nTmpInt] + monLevelData.nMonsterSkillBonus,0);
          if (-1 < pMonStatsTxt->aSkMode[nTmpInt]) {
            nTmpVal = (uint32_t)pMonStatsTxt->aSkMode[nTmpInt];
            pSkill = D2Common::Skills::Skills::SKILLS_GetSkillByEnum
                               (pUnit,(int)*(short *)&pRoom->ppRoomList);
            D2Common::Skills::Skills::SetSkillMode(pSkill,nTmpVal);
          }
        }
        pRoom = (D2RoomStrc *)((int)&pRoom->ppRoomList + 2);
        nTmpInt = nTmpInt + 1;
      } while (nTmpInt < 8);
      D2Common::Monsters::MONSTERS::MONSTERS_OnInitMonster_NoOp
                (pUnit,monLevelData.nMonsterSkillBonus);
      if (((uMonTxt.pMonStats2Txt)->field_0x5 & (byte)Fog::BitBuffer::gadwBitMasks[1]) != 0) {
        pUnit->eUnitFlags = pUnit->eUnitFlags | UNITFLAG_CANBEATTACKED;
      }
      if ((pMonStatsTxt->field_0xe & (byte)Fog::BitBuffer::gadwBitMasks[3]) != 0) {
        pUnit->eUnitFlags = pUnit->eUnitFlags | UNITFLAG_PETIGNORE;
      }
      uMonTxt.pMonPropTxt = D2Game::Monster::Monster::MONSTER_GetMonPropTxtRecord(pUnit->nClassId);
                    /* uMonTxt now holds a D2MonPropTxt* (MONSTER_GetMonPropTxtRecord); see
                       00573d35. */
      if (uMonTxt.pMonPropTxt != (D2MonPropTxt *)0x0) {
        pRoom = (D2RoomStrc *)((uMonTxt.pMonPropTxt)->entry + (int)pMonRegionField);
        nPlayerCount = 0;
        do {
          if ((int)pRoom->ppRoomList < 0) break;
          if ((uMonTxt.pMonPropTxt)->chance[(int)pMonRegionField][nPlayerCount] == '\0') {
LAB_005741f6:
            D2Common::ITEMS::ItemMods::ITEMMOD_ApplyPropertyToUnitStatsExpansion
                      (0,(D2UnitStrc *)0x0,pUnit,(void *)0x0,0,0,(D2SetsTxtFStrc *)pRoom,0,0x40,
                       (D2UnitStrc *)0x0);
          }
          else {
            DVar1 = (D2SeedStrc)
                    ((ulonglong)(pUnit->sSeed).nSeedLow * 0x6ac690c5 +
                    (ulonglong)(pUnit->sSeed).nSeedHigh);
            pUnit->sSeed = DVar1;
            if ((int)(DVar1.nSeedLow + (int)(((ulonglong)DVar1 & 0xffffffff) / 100) * -100) <
                (int)(uint)(byte)(uMonTxt.pMonPropTxt)->chance[(int)pMonRegionField][nPlayerCount])
            goto LAB_005741f6;
          }
          pRoom = (D2RoomStrc *)&pRoom->pRoomEx;
          nPlayerCount = nPlayerCount + 1;
        } while (nPlayerCount < 6);
      }
      D2Game::SKILLS::SkillAss::SKILLASS_EquipSummonItems
                (pGame,(D2UnitStrc *)0x0,pUnit,0xffffffff,nMonLevel,nMonLevel,1);
      return;
    }
    nErrorLine = 0xdf;
  }
  nAddress = Fog::Src::ErrorManager::GetInstructionPointer();
  Fog::Src::ErrorManager::ERROR_UnrecoverableInternalError_Halt("",nAddress,nErrorLine);
                    /* WARNING: Subroutine does not return */
  compiler::exit(-1);
}
