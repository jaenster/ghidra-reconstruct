
/* WARNING: Inlined function: InitSeed_Param_666 */
/* WARNING: Enum "eCollisionFlags": Some values do not have unique names */
/* WARNING: Enum "eD2TimerType": Some values do not have unique names */
/* WARNING: Enum "eD2TimerTypeDWORD": Some values do not have unique names */
/* @function ITEM_DeserializeFromBitBuffer
   @address Game.exe.ram:0062cbe0
   @date 2026.06.20
   @calling __stdcall
   @description Canonical D2 item bit-stream reader: deserializes one item from a D2BitBufferStrc
   into pUnit's item data + stat list (inverse of SerializeComplexItem). Reads version(10b),
   location code (ground=X/Y 16b each; else bodyloc+cell+inv page), item code (resolved to ClassId),
   flags, quality (switch over eD2ItemQuality decoding magic/set/rare/unique/crafted affix IDs,
   automod, charm), GUID/level/personalized char name, runeword and ear/bodypart data, then base
   stats (gold, defense, weapon min/max dmg with ethereal*3/2 and low-quality*3/4 scaling,
   durability) and a property/stat-list loop (9-bit stat IDs, grouped
   set/charge/on-hit-skill/skill-tab stats) via STATLIST_SetUnitStat. Field bit widths gated by item
   save/wire version (nParam2: <0x5d/<0x60 compact). __stdcall; returns 1 on success, -1 on parse
   error. */

int32_t D2Common::ITEMS::Items::ITEM_DeserializeFromBitBuffer
                  (D2UnitStrc *pUnit,D2BitBufferStrc *pBitBuffer,uint32_t nParam1,
                  D2ItemStatCostTxt *pItemStatCostTxt,uint *pnParam,uint32_t nParam2)

{
  short wAutoMagicIdx;
  int16_t wAffixAdj;
  uint32_t nBitsRead;
  uint32_t nBitVal;
  uint32_t nCoord;
  int32_t nClassId;
  eD2ItemQuality eQuality;
  D2MagicAffixTableStrc *pAffixTable;
  eD2ItemFlag eItemFlags;
  short wAffixIdx;
  eD2ItemFlag eItemFlag;
  DWORD dwFileIndex;
  D2SetsTxt *pSetsTxt;
  D2SetItemsTxt *pSetItemsTxt;
  D2ItemsTxt *pItemsTxt;
  int32_t nBitsPos;
  D2ItemStatCostTxt *pStatCostTxt;
  uint nTmpVal2;
  int nStatVal;
  BOOL bIsStackable;
  D2StatListExStrc *pStatsEx;
  D2PoolManagerStrc *pMemory;
  eD2UnitStat eUnitStat;
  int nSkillClassVal;
  D2SetItemsTxt **ppSetItems;
  char *szCharName;
  uint nStatIndex;
  eD2UnitStat eStatId2;
  uint nChargeSkillId;
  uint nChargeSkillLevel;
  ushort nChargeBuf [2];
  uint nChargeMax;
  uint nOnGetHitSkillLevel;
  uint nOnGetHitChance;
  byte nOnGetHitSkillBuf [4];
  uint nOnHitSkillLevel;
  uint nOnHitChance;
  byte nOnHitSkillBuf [4];
  uint nOnAttackSkillLevel;
  uint nOnAttackChance;
  byte nOnAttackSkillBuf [4];
  uint32_t nSkillId;
  uint nSkillTabGroup;
  uint nSkillTabIdx;
  uint32_t nStatListIdx;
  uint nSkillLevel;
  uint nSkillTabCount;
  uint32_t nSetBitMask;
  int nStatListCount;
  int bError;
  eD2ItemQuality eQualityType;
  bool bExtended;
  eD2UnitStat eStatId;
  
  bError = 0;
  nBitsRead = Fog::BitBuffer::ReadUnsigned(pBitBuffer,10);
  D2Common::ITEMS::Items::ITEM_SetItemData_wItemVersion(pUnit,(int16_t)nBitsRead);
  nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,3);
  if ((nBitVal == 3) || (nBitVal == 5)) {
    nCoord = Fog::BitBuffer::ReadUnsigned(pBitBuffer,0x10);
    D2Common::Units::Units::SetXForStaticUnit(pUnit,nCoord);
    nCoord = Fog::BitBuffer::ReadUnsigned(pBitBuffer,0x10);
    D2Common::Units::Units::SetYForStaticUnit(pUnit,nCoord);
  }
  else {
    nCoord = Fog::BitBuffer::ReadUnsigned(pBitBuffer,4);
    if (((pUnit != (D2UnitStrc *)0x0) && (pUnit->eUnitType == UNIT_ITEM)) &&
       ((pUnit->pUnitData).pUnitDataItem != (D2UnitDataItemStrc *)0x0)) {
      ((pUnit->pUnitData).pUnitDataItem)->eBodyLoc = (eD2BodyLoc)nCoord;
    }
    nCoord = Fog::BitBuffer::ReadUnsigned(pBitBuffer,4);
    D2Common::Units::Units::SetXForStaticUnit(pUnit,nCoord);
    nCoord = Fog::BitBuffer::ReadUnsigned(pBitBuffer,4);
    D2Common::Units::Units::SetYForStaticUnit(pUnit,nCoord);
    nCoord = Fog::BitBuffer::ReadUnsigned(pBitBuffer,3);
    if (((pUnit != (D2UnitStrc *)0x0) && (pUnit->eUnitType == UNIT_ITEM)) &&
       ((pUnit->pUnitData).pUnitDataItem != (D2UnitDataItemStrc *)0x0)) {
      ((pUnit->pUnitData).pUnitDataItem)->ePage = (char)nCoord - INVPAGE_CORPSE;
    }
  }
  D2Common::Units::Units::SetupUpdateFlag(pUnit,nBitVal);
  nStatListIdx = Fog::BitBuffer::ReadUnsigned(pBitBuffer,0x20);
  nClassId = D2Common::DATATBLS::ItemTbls::TXT_Items_ConvertItemCodeToItemClassId(nStatListIdx);
  if ((-1 < nClassId) && (pUnit != (D2UnitStrc *)0x0)) {
    pUnit->nClassId = nClassId;
  }
  if (pItemStatCostTxt != (D2ItemStatCostTxt *)0x0) {
    if ((pUnit != (D2UnitStrc *)0x0) && (pUnit->eUnitType == UNIT_ITEM)) {
      if ((pUnit->pUnitData).pUnitDataItem != (D2UnitDataItemStrc *)0x0) {
        ((pUnit->pUnitData).pUnitDataItem)->nItemLevel = 1;
      }
      if ((pUnit->eUnitType == UNIT_ITEM) &&
         ((pUnit->pUnitData).pUnitDataMissile != (D2UnitDataMissileStrc *)0x0)) {
        ((pUnit->pUnitData).pUnitDataMissile)->unk0x00 = 1;
      }
    }
    return 1;
  }
  nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,3);
  if (pnParam != (uint *)0x0) {
    *pnParam = nBitVal;
  }
  if (nParam1 != 0) {
    nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,0x20);
    pUnit->nInitSeed = nBitVal;
    (pUnit->sSeed).nSeedLow = nBitVal;
    (pUnit->sSeed).nSeedHigh = 0x29a;
  }
  nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,7);
  if ((int)nBitVal < 0) {
    nBitVal = 1;
  }
  if (((pUnit != (D2UnitStrc *)0x0) && (pUnit->eUnitType == UNIT_ITEM)) &&
     ((pUnit->pUnitData).pUnitDataItem != (D2UnitDataItemStrc *)0x0)) {
    if ((int)nBitVal < 1) {
      nBitVal = 1;
    }
    ((pUnit->pUnitData).pUnitDataItem)->nItemLevel = nBitVal;
  }
  eQuality = Fog::BitBuffer::ReadUnsigned(pBitBuffer,4);
  if (((pUnit != (D2UnitStrc *)0x0) && (pUnit->eUnitType == UNIT_ITEM)) &&
     ((pUnit->pUnitData).pUnitDataItem != (D2UnitDataItemStrc *)0x0)) {
    ((pUnit->pUnitData).pUnitDataItem)->eQuality = eQuality;
  }
  nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,1);
  if (((nBitVal != 0) &&
      (nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,3), pUnit != (D2UnitStrc *)0x0)) &&
     ((pUnit->eUnitType == UNIT_ITEM &&
      ((pUnit->pUnitData).pUnitDataItem != (D2UnitDataItemStrc *)0x0)))) {
    ((pUnit->pUnitData).pUnitDataItem)->bVariant = SUB41(nBitVal,0);
  }
  pAffixTable = D2Common::DATATBLS::ItemTbls::TXT_MagicAffixes_GetTableInfo();
  pItemStatCostTxt._0_2_ =
       (short)(((int)pAffixTable->pPrefixStart - (int)pAffixTable->pTable) / 0x90);
  wAffixIdx = (short)(((int)pAffixTable->pAutoMagicStart - (int)pAffixTable->pTable) / 0x90);
  if (true) {
    switch(nParam2) {
    case 0x48:
    case 0x49:
    case 0x50:
    case 0x51:
    case 0x52:
      pItemStatCostTxt._0_2_ = (short)pItemStatCostTxt + -0x295;
      wAffixIdx = wAffixIdx + -0x4ee;
      break;
    case 0x53:
    case 0x54:
      pItemStatCostTxt._0_2_ = (short)pItemStatCostTxt + -0x2a2;
      wAffixIdx = wAffixIdx + -0x4f1;
      break;
    case 0x55:
    case 0x56:
    case 0x57:
      pItemStatCostTxt._0_2_ = (short)pItemStatCostTxt + -0x2a3;
      wAffixIdx = wAffixIdx + -0x4f2;
      break;
    case 0x58:
      pItemStatCostTxt._0_2_ = (short)pItemStatCostTxt + -0x2d9;
      wAffixIdx = wAffixIdx + -0x5a0;
    }
  }
  nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,1);
  if (nBitVal == 0) {
    if ((pUnit != (D2UnitStrc *)0x0) && (pUnit->eUnitType == UNIT_ITEM)) {
      if ((pUnit->pUnitData).pUnitDataItem != (D2UnitDataItemStrc *)0x0) {
        ((pUnit->pUnitData).pUnitDataItem)->wAutoMagic = 0;
      }
      goto LAB_0062ce73;
    }
LAB_0062ce83:
    eQuality = QUALITY_NORMAL;
  }
  else {
    nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,0xb);
    wAutoMagicIdx = (short)nBitVal;
    if (nParam2 < 0x59) {
      wAutoMagicIdx = 0;
    }
    else {
      if (nParam2 < 0x5a) {
        wAutoMagicIdx = wAutoMagicIdx + 1;
      }
      if (wAutoMagicIdx != 0) {
        wAutoMagicIdx = wAutoMagicIdx + wAffixIdx;
      }
    }
    if ((pUnit == (D2UnitStrc *)0x0) || (pUnit->eUnitType != UNIT_ITEM)) goto LAB_0062ce83;
    if ((pUnit->pUnitData).pUnitDataItem != (D2UnitDataItemStrc *)0x0) {
      ((pUnit->pUnitData).pUnitDataItem)->wAutoMagic = wAutoMagicIdx;
    }
LAB_0062ce73:
    if ((pUnit->eUnitType != UNIT_ITEM) ||
       ((pUnit->pUnitData).pUnitDataItem == (D2UnitDataItemStrc *)0x0)) goto LAB_0062ce83;
    eQuality = ((pUnit->pUnitData).pUnitDataItem)->eQuality;
  }
  switch(eQuality) {
  case QUALITY_LOW:
  case QUALITY_SUPERIOR:
    nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,3);
    D2Common::ITEMS::Items::ITEM_SetItemData_nFileIndex(pUnit,nBitVal);
    break;
  case QUALITY_NORMAL:
    nBitVal = D2Common::ITEMS::Items::ITEMS_IsA(pUnit,ITEMTYPE_Charm);
    if ((nBitVal != 0) &&
       ((nParam1 != 0 ||
        (eItemFlags = D2Common::ITEMS::Items::ITEM_GetItemData_eD2ItemFlag(pUnit),
        (eItemFlags & ITEMFLAG_IDENTIFIED) !=
        ~(ITEMFLAG_TAGGED|ITEMFLAG_DROW|ITEMFLAG_CURSED|ITEMFLAG_STAFFMODS|ITEMFLAG_MAGICAL|
          ITEMFLAG_RUNEWORD|ITEMFLAG_CRUDE|ITEMFLAG_PLAYERNAME|ITEMFLAG_SAVED|ITEMFLAG_ETHEREAL|
          ITEMFLAG_COMPACT|ITEMFLAG_100000|ITEMFLAG_SERVER|ITEMFLAG_RESTRICT|ITEMFLAG_BEGINNER|
          ITEMFLAG_BODYPART|ITEMFLAG_HARDCORE|ITEMFLAG_DISABLED|ITEMFLAG_NEW|ITEMFLAG_MONSTER|
          ITEMFLAG_SOCKETED|ITEMFLAG_SORTED|ITEMFLAG_RESTORED|ITEMFLAG_BROKEN|ITEMFLAG_TAKEN|
          ITEMFLAG_ADDED|ITEMFLAG_REMOVED|ITEMFLAG_IDENTIFIED|ITEMFLAG_IGNORE|ITEMFLAG_CURSOR|
          ITEMFLAG_BOUGHT|ITEMFLAG_RELOAD))))) {
      nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,1);
      if (nBitVal == 0) {
        nClassId = 0;
        nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,0xb);
        D2Common::ITEMS::Items::SetMagicSuffix(pUnit,(int16_t)nBitVal,nClassId);
      }
      else {
        nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,0xb);
        wAffixAdj = 0;
        if ((short)nBitVal != 0) {
          wAffixAdj = (short)nBitVal + (short)pItemStatCostTxt;
        }
        D2Common::ITEMS::Items::SetMagixPrefix(pUnit,wAffixAdj,0);
      }
    }
    nBitVal = D2Common::ITEMS::Items::ITEMS_IsA(pUnit,ITEMTYPE_BodyPart);
    if ((nBitVal != 0) &&
       (nBitVal = D2Common::ITEMS::Items::ITEMS_IsA(pUnit,ITEMTYPE_PlayerBodyPart), nBitVal == 0)) {
      nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,10);
      D2Common::ITEMS::Items::ITEM_SetItemData_nFileIndex(pUnit,nBitVal);
    }
    nBitVal = D2Common::ITEMS::Items::ITEMS_IsA(pUnit,ITEMTYPE_Scroll);
    if ((nBitVal != 0) ||
       (nBitVal = D2Common::ITEMS::Items::ITEMS_IsA(pUnit,ITEMTYPE_Book), nBitVal != 0)) {
      nClassId = 0;
      nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,5);
      D2Common::ITEMS::Items::SetMagicSuffix(pUnit,(int16_t)nBitVal,nClassId);
    }
    break;
  case QUALITY_MAGIC:
    if ((nParam1 != 0) ||
       (eItemFlags = D2Common::ITEMS::Items::ITEM_GetItemData_eD2ItemFlag(pUnit),
       (eItemFlags & ITEMFLAG_IDENTIFIED) !=
       ~(ITEMFLAG_TAGGED|ITEMFLAG_DROW|ITEMFLAG_CURSED|ITEMFLAG_STAFFMODS|ITEMFLAG_MAGICAL|
         ITEMFLAG_RUNEWORD|ITEMFLAG_CRUDE|ITEMFLAG_PLAYERNAME|ITEMFLAG_SAVED|ITEMFLAG_ETHEREAL|
         ITEMFLAG_COMPACT|ITEMFLAG_100000|ITEMFLAG_SERVER|ITEMFLAG_RESTRICT|ITEMFLAG_BEGINNER|
         ITEMFLAG_BODYPART|ITEMFLAG_HARDCORE|ITEMFLAG_DISABLED|ITEMFLAG_NEW|ITEMFLAG_MONSTER|
         ITEMFLAG_SOCKETED|ITEMFLAG_SORTED|ITEMFLAG_RESTORED|ITEMFLAG_BROKEN|ITEMFLAG_TAKEN|
         ITEMFLAG_ADDED|ITEMFLAG_REMOVED|ITEMFLAG_IDENTIFIED|ITEMFLAG_IGNORE|ITEMFLAG_CURSOR|
         ITEMFLAG_BOUGHT|ITEMFLAG_RELOAD))) {
      nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,0xb);
      wAffixAdj = 0;
      if ((short)nBitVal != 0) {
        wAffixAdj = (short)nBitVal + (short)pItemStatCostTxt;
      }
      D2Common::ITEMS::Items::SetMagixPrefix(pUnit,wAffixAdj,0);
      nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,0xb);
      D2Common::ITEMS::Items::SetMagicSuffix(pUnit,(int16_t)nBitVal,0);
    }
    break;
  case QUALITY_SET:
    if ((nParam1 != 0) ||
       (eItemFlags = D2Common::ITEMS::Items::ITEM_GetItemData_eD2ItemFlag(pUnit),
       (eItemFlags & ITEMFLAG_IDENTIFIED) !=
       ~(ITEMFLAG_TAGGED|ITEMFLAG_DROW|ITEMFLAG_CURSED|ITEMFLAG_STAFFMODS|ITEMFLAG_MAGICAL|
         ITEMFLAG_RUNEWORD|ITEMFLAG_CRUDE|ITEMFLAG_PLAYERNAME|ITEMFLAG_SAVED|ITEMFLAG_ETHEREAL|
         ITEMFLAG_COMPACT|ITEMFLAG_100000|ITEMFLAG_SERVER|ITEMFLAG_RESTRICT|ITEMFLAG_BEGINNER|
         ITEMFLAG_BODYPART|ITEMFLAG_HARDCORE|ITEMFLAG_DISABLED|ITEMFLAG_NEW|ITEMFLAG_MONSTER|
         ITEMFLAG_SOCKETED|ITEMFLAG_SORTED|ITEMFLAG_RESTORED|ITEMFLAG_BROKEN|ITEMFLAG_TAKEN|
         ITEMFLAG_ADDED|ITEMFLAG_REMOVED|ITEMFLAG_IDENTIFIED|ITEMFLAG_IGNORE|ITEMFLAG_CURSOR|
         ITEMFLAG_BOUGHT|ITEMFLAG_RELOAD))) {
      nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,0xc);
      if (nParam2 < 0x5d) {
        pSetsTxt = D2Client::DataTbls::DataTbls::GetSetsLine(nBitVal);
        if (pSetsTxt == (D2SetsTxt *)0x0) {
switchD_0062ce98_caseD_9:
          bError = 1;
        }
        else if (pSetsTxt->nTxtSetItemsCount < 1) {
LAB_0062d16f:
          bError = 1;
        }
        else {
          ppSetItems = pSetsTxt->pTxtSetItems;
          nStatVal = 0;
          do {
            if (*(uint32_t *)(*ppSetItems)->item == nStatListIdx) {
              if (nStatVal < 0) goto LAB_0062d16f;
              D2Common::ITEMS::Items::ITEM_SetItemData_nFileIndex
                        (pUnit,(int)pSetsTxt->pTxtSetItems[nStatVal]->nId);
              goto LAB_0062d1a6;
            }
            nStatVal = nStatVal + 1;
            ppSetItems = ppSetItems + 1;
          } while (nStatVal < pSetsTxt->nTxtSetItemsCount);
          bError = 1;
        }
      }
      else {
        pSetItemsTxt = D2Client::DataTbls::DataTbls::GetSetItemsLine(nBitVal);
        if (pSetItemsTxt == (D2SetItemsTxt *)0x0) goto switchD_0062ce98_caseD_9;
        D2Common::ITEMS::Items::ITEM_SetItemData_nFileIndex(pUnit,(int)pSetItemsTxt->nId);
      }
    }
    break;
  case QUALITY_RARE:
  case QUALITY_CRAFTED:
    if ((nParam1 != 0) ||
       (eItemFlags = D2Common::ITEMS::Items::ITEM_GetItemData_eD2ItemFlag(pUnit),
       (eItemFlags & ITEMFLAG_IDENTIFIED) !=
       ~(ITEMFLAG_TAGGED|ITEMFLAG_DROW|ITEMFLAG_CURSED|ITEMFLAG_STAFFMODS|ITEMFLAG_MAGICAL|
         ITEMFLAG_RUNEWORD|ITEMFLAG_CRUDE|ITEMFLAG_PLAYERNAME|ITEMFLAG_SAVED|ITEMFLAG_ETHEREAL|
         ITEMFLAG_COMPACT|ITEMFLAG_100000|ITEMFLAG_SERVER|ITEMFLAG_RESTRICT|ITEMFLAG_BEGINNER|
         ITEMFLAG_BODYPART|ITEMFLAG_HARDCORE|ITEMFLAG_DISABLED|ITEMFLAG_NEW|ITEMFLAG_MONSTER|
         ITEMFLAG_SOCKETED|ITEMFLAG_SORTED|ITEMFLAG_RESTORED|ITEMFLAG_BROKEN|ITEMFLAG_TAKEN|
         ITEMFLAG_ADDED|ITEMFLAG_REMOVED|ITEMFLAG_IDENTIFIED|ITEMFLAG_IGNORE|ITEMFLAG_CURSOR|
         ITEMFLAG_BOUGHT|ITEMFLAG_RELOAD))) {
      nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,8);
      D2Common::ITEMS::Items::SetRarePrefix(pUnit,(int16_t)nBitVal);
      nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,8);
      D2Common::ITEMS::Items::SetRareSuffix(pUnit,(int16_t)nBitVal);
    }
    nStatVal = 0x3e;
    do {
      nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,1);
      if (nBitVal == 0) {
        if (((pUnit != (D2UnitStrc *)0x0) && (pUnit->eUnitType == UNIT_ITEM)) &&
           ((pUnit->pUnitData).pUnitDataItem != (D2UnitDataItemStrc *)0x0)) {
          *(undefined2 *)((int)((pUnit->pUnitData).pUnitDataItem)->wMagicPrefix + nStatVal + -0x3e)
               = 0;
        }
      }
      else {
        nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,0xb);
        wAffixIdx = (short)nBitVal;
        if (nParam2 < 0x5a) {
          wAffixIdx = wAffixIdx + 1;
        }
        if (wAffixIdx != 0) {
          wAffixIdx = wAffixIdx + (short)pItemStatCostTxt;
        }
        if (((pUnit != (D2UnitStrc *)0x0) && (pUnit->eUnitType == UNIT_ITEM)) &&
           ((pUnit->pUnitData).pUnitDataItem != (D2UnitDataItemStrc *)0x0)) {
          *(short *)((int)((pUnit->pUnitData).pUnitDataItem)->wMagicPrefix + nStatVal + -0x3e) =
               wAffixIdx;
        }
      }
      nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,1);
      if (nBitVal == 0) {
        if (((pUnit != (D2UnitStrc *)0x0) && (pUnit->eUnitType == UNIT_ITEM)) &&
           ((pUnit->pUnitData).pUnitDataItem != (D2UnitDataItemStrc *)0x0)) {
          *(undefined2 *)((int)((pUnit->pUnitData).pUnitDataItem)->wMagicPrefix + nStatVal + -0x38)
               = 0;
        }
      }
      else {
        nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,0xb);
        wAffixIdx = (short)nBitVal;
        if (nParam2 < 0x5a) {
          wAffixIdx = wAffixIdx + 1;
        }
        if (((pUnit != (D2UnitStrc *)0x0) && (pUnit->eUnitType == UNIT_ITEM)) &&
           ((pUnit->pUnitData).pUnitDataItem != (D2UnitDataItemStrc *)0x0)) {
          *(short *)((int)((pUnit->pUnitData).pUnitDataItem)->wMagicPrefix + nStatVal + -0x38) =
               wAffixIdx;
        }
      }
      nStatVal = nStatVal + 2;
    } while (nStatVal < 0x44);
    break;
  case QUALITY_UNIQUE:
    if ((nParam1 != 0) ||
       (eItemFlags = D2Common::ITEMS::Items::ITEM_GetItemData_eD2ItemFlag(pUnit),
       (eItemFlags & ITEMFLAG_IDENTIFIED) !=
       ~(ITEMFLAG_TAGGED|ITEMFLAG_DROW|ITEMFLAG_CURSED|ITEMFLAG_STAFFMODS|ITEMFLAG_MAGICAL|
         ITEMFLAG_RUNEWORD|ITEMFLAG_CRUDE|ITEMFLAG_PLAYERNAME|ITEMFLAG_SAVED|ITEMFLAG_ETHEREAL|
         ITEMFLAG_COMPACT|ITEMFLAG_100000|ITEMFLAG_SERVER|ITEMFLAG_RESTRICT|ITEMFLAG_BEGINNER|
         ITEMFLAG_BODYPART|ITEMFLAG_HARDCORE|ITEMFLAG_DISABLED|ITEMFLAG_NEW|ITEMFLAG_MONSTER|
         ITEMFLAG_SOCKETED|ITEMFLAG_SORTED|ITEMFLAG_RESTORED|ITEMFLAG_BROKEN|ITEMFLAG_TAKEN|
         ITEMFLAG_ADDED|ITEMFLAG_REMOVED|ITEMFLAG_IDENTIFIED|ITEMFLAG_IGNORE|ITEMFLAG_CURSOR|
         ITEMFLAG_BOUGHT|ITEMFLAG_RELOAD))) {
      dwFileIndex = Fog::BitBuffer::ReadUnsigned(pBitBuffer,0xc);
      if ((int)dwFileIndex < 0) {
        dwFileIndex = 0xffffffff;
      }
      if (sgptDataTable->nTxtUniqueItemsSize <= (int)dwFileIndex) {
        dwFileIndex = 0xffffffff;
      }
      D2Common::ITEMS::Items::ITEM_SetItemData_nFileIndex(pUnit,dwFileIndex);
    }
    break;
  case QUALITY_TAMPERED:
    if ((nParam1 != 0) ||
       (eItemFlag = D2Common::ITEMS::Items::ITEM_GetItemData_eD2ItemFlag(pUnit),
       (eItemFlag & ITEMFLAG_IDENTIFIED) !=
       ~(ITEMFLAG_TAGGED|ITEMFLAG_DROW|ITEMFLAG_CURSED|ITEMFLAG_STAFFMODS|ITEMFLAG_MAGICAL|
         ITEMFLAG_RUNEWORD|ITEMFLAG_CRUDE|ITEMFLAG_PLAYERNAME|ITEMFLAG_SAVED|ITEMFLAG_ETHEREAL|
         ITEMFLAG_COMPACT|ITEMFLAG_100000|ITEMFLAG_SERVER|ITEMFLAG_RESTRICT|ITEMFLAG_BEGINNER|
         ITEMFLAG_BODYPART|ITEMFLAG_HARDCORE|ITEMFLAG_DISABLED|ITEMFLAG_NEW|ITEMFLAG_MONSTER|
         ITEMFLAG_SOCKETED|ITEMFLAG_SORTED|ITEMFLAG_RESTORED|ITEMFLAG_BROKEN|ITEMFLAG_TAKEN|
         ITEMFLAG_ADDED|ITEMFLAG_REMOVED|ITEMFLAG_IDENTIFIED|ITEMFLAG_IGNORE|ITEMFLAG_CURSOR|
         ITEMFLAG_BOUGHT|ITEMFLAG_RELOAD))) {
      nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,8);
      D2Common::ITEMS::Items::SetRarePrefix(pUnit,(int16_t)nBitVal);
      nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,8);
      D2Common::ITEMS::Items::SetRareSuffix(pUnit,(int16_t)nBitVal);
    }
    break;
  default:
    goto switchD_0062ce98_caseD_9;
  }
LAB_0062d1a6:
  bExtended = false;
  if (((pUnit == (D2UnitStrc *)0x0) || (pUnit->eUnitType != UNIT_ITEM)) ||
     ((pUnit->pUnitData).pUnitDataItem == (D2UnitDataItemStrc *)0x0)) {
    eItemFlags = ~(ITEMFLAG_TAGGED|ITEMFLAG_DROW|ITEMFLAG_CURSED|ITEMFLAG_STAFFMODS|ITEMFLAG_MAGICAL
                   |ITEMFLAG_RUNEWORD|ITEMFLAG_CRUDE|ITEMFLAG_PLAYERNAME|ITEMFLAG_SAVED|
                   ITEMFLAG_ETHEREAL|ITEMFLAG_COMPACT|ITEMFLAG_100000|ITEMFLAG_SERVER|
                   ITEMFLAG_RESTRICT|ITEMFLAG_BEGINNER|ITEMFLAG_BODYPART|ITEMFLAG_HARDCORE|
                   ITEMFLAG_DISABLED|ITEMFLAG_NEW|ITEMFLAG_MONSTER|ITEMFLAG_SOCKETED|ITEMFLAG_SORTED
                   |ITEMFLAG_RESTORED|ITEMFLAG_BROKEN|ITEMFLAG_TAKEN|ITEMFLAG_ADDED|ITEMFLAG_REMOVED
                   |ITEMFLAG_IDENTIFIED|ITEMFLAG_IGNORE|ITEMFLAG_CURSOR|ITEMFLAG_BOUGHT|
                  ITEMFLAG_RELOAD);
  }
  else {
    eItemFlags = ((pUnit->pUnitData).pUnitDataItem)->dwItemFlags;
  }
  if ((eItemFlags & ITEMFLAG_RUNEWORD) ==
      ~(ITEMFLAG_TAGGED|ITEMFLAG_DROW|ITEMFLAG_CURSED|ITEMFLAG_STAFFMODS|ITEMFLAG_MAGICAL|
        ITEMFLAG_RUNEWORD|ITEMFLAG_CRUDE|ITEMFLAG_PLAYERNAME|ITEMFLAG_SAVED|ITEMFLAG_ETHEREAL|
        ITEMFLAG_COMPACT|ITEMFLAG_100000|ITEMFLAG_SERVER|ITEMFLAG_RESTRICT|ITEMFLAG_BEGINNER|
        ITEMFLAG_BODYPART|ITEMFLAG_HARDCORE|ITEMFLAG_DISABLED|ITEMFLAG_NEW|ITEMFLAG_MONSTER|
        ITEMFLAG_SOCKETED|ITEMFLAG_SORTED|ITEMFLAG_RESTORED|ITEMFLAG_BROKEN|ITEMFLAG_TAKEN|
        ITEMFLAG_ADDED|ITEMFLAG_REMOVED|ITEMFLAG_IDENTIFIED|ITEMFLAG_IGNORE|ITEMFLAG_CURSOR|
        ITEMFLAG_BOUGHT|ITEMFLAG_RELOAD)) {
LAB_0062d1ee:
    if (((pUnit == (D2UnitStrc *)0x0) || (pUnit->eUnitType != UNIT_ITEM)) ||
       ((pUnit->pUnitData).pUnitDataItem == (D2UnitDataItemStrc *)0x0)) goto LAB_0062d203;
    eItemFlags = ((pUnit->pUnitData).pUnitDataItem)->dwItemFlags;
  }
  else {
    bExtended = true;
    nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,0x10);
    if (pUnit != (D2UnitStrc *)0x0) {
      if ((pUnit->eUnitType == UNIT_ITEM) &&
         ((pUnit->pUnitData).pUnitDataItem != (D2UnitDataItemStrc *)0x0)) {
        ((pUnit->pUnitData).pUnitDataItem)->wMagicPrefix[0] = (short)nBitVal;
      }
      goto LAB_0062d1ee;
    }
LAB_0062d203:
    eItemFlags = ~(ITEMFLAG_TAGGED|ITEMFLAG_DROW|ITEMFLAG_CURSED|ITEMFLAG_STAFFMODS|ITEMFLAG_MAGICAL
                   |ITEMFLAG_RUNEWORD|ITEMFLAG_CRUDE|ITEMFLAG_PLAYERNAME|ITEMFLAG_SAVED|
                   ITEMFLAG_ETHEREAL|ITEMFLAG_COMPACT|ITEMFLAG_100000|ITEMFLAG_SERVER|
                   ITEMFLAG_RESTRICT|ITEMFLAG_BEGINNER|ITEMFLAG_BODYPART|ITEMFLAG_HARDCORE|
                   ITEMFLAG_DISABLED|ITEMFLAG_NEW|ITEMFLAG_MONSTER|ITEMFLAG_SOCKETED|ITEMFLAG_SORTED
                   |ITEMFLAG_RESTORED|ITEMFLAG_BROKEN|ITEMFLAG_TAKEN|ITEMFLAG_ADDED|ITEMFLAG_REMOVED
                   |ITEMFLAG_IDENTIFIED|ITEMFLAG_IGNORE|ITEMFLAG_CURSOR|ITEMFLAG_BOUGHT|
                  ITEMFLAG_RELOAD);
  }
  if ((eItemFlags & ITEMFLAG_BODYPART) ==
      ~(ITEMFLAG_TAGGED|ITEMFLAG_DROW|ITEMFLAG_CURSED|ITEMFLAG_STAFFMODS|ITEMFLAG_MAGICAL|
        ITEMFLAG_RUNEWORD|ITEMFLAG_CRUDE|ITEMFLAG_PLAYERNAME|ITEMFLAG_SAVED|ITEMFLAG_ETHEREAL|
        ITEMFLAG_COMPACT|ITEMFLAG_100000|ITEMFLAG_SERVER|ITEMFLAG_RESTRICT|ITEMFLAG_BEGINNER|
        ITEMFLAG_BODYPART|ITEMFLAG_HARDCORE|ITEMFLAG_DISABLED|ITEMFLAG_NEW|ITEMFLAG_MONSTER|
        ITEMFLAG_SOCKETED|ITEMFLAG_SORTED|ITEMFLAG_RESTORED|ITEMFLAG_BROKEN|ITEMFLAG_TAKEN|
        ITEMFLAG_ADDED|ITEMFLAG_REMOVED|ITEMFLAG_IDENTIFIED|ITEMFLAG_IGNORE|ITEMFLAG_CURSOR|
        ITEMFLAG_BOUGHT|ITEMFLAG_RELOAD)) {
    if (((pUnit == (D2UnitStrc *)0x0) || (pUnit->eUnitType != UNIT_ITEM)) ||
       ((pUnit->pUnitData).pUnitDataItem == (D2UnitDataItemStrc *)0x0)) {
      eItemFlags = ~(ITEMFLAG_TAGGED|ITEMFLAG_DROW|ITEMFLAG_CURSED|ITEMFLAG_STAFFMODS|
                     ITEMFLAG_MAGICAL|ITEMFLAG_RUNEWORD|ITEMFLAG_CRUDE|ITEMFLAG_PLAYERNAME|
                     ITEMFLAG_SAVED|ITEMFLAG_ETHEREAL|ITEMFLAG_COMPACT|ITEMFLAG_100000|
                     ITEMFLAG_SERVER|ITEMFLAG_RESTRICT|ITEMFLAG_BEGINNER|ITEMFLAG_BODYPART|
                     ITEMFLAG_HARDCORE|ITEMFLAG_DISABLED|ITEMFLAG_NEW|ITEMFLAG_MONSTER|
                     ITEMFLAG_SOCKETED|ITEMFLAG_SORTED|ITEMFLAG_RESTORED|ITEMFLAG_BROKEN|
                     ITEMFLAG_TAKEN|ITEMFLAG_ADDED|ITEMFLAG_REMOVED|ITEMFLAG_IDENTIFIED|
                     ITEMFLAG_IGNORE|ITEMFLAG_CURSOR|ITEMFLAG_BOUGHT|ITEMFLAG_RELOAD);
    }
    else {
      eItemFlags = ((pUnit->pUnitData).pUnitDataItem)->dwItemFlags;
    }
    if ((eItemFlags & ITEMFLAG_PLAYERNAME) !=
        ~(ITEMFLAG_TAGGED|ITEMFLAG_DROW|ITEMFLAG_CURSED|ITEMFLAG_STAFFMODS|ITEMFLAG_MAGICAL|
          ITEMFLAG_RUNEWORD|ITEMFLAG_CRUDE|ITEMFLAG_PLAYERNAME|ITEMFLAG_SAVED|ITEMFLAG_ETHEREAL|
          ITEMFLAG_COMPACT|ITEMFLAG_100000|ITEMFLAG_SERVER|ITEMFLAG_RESTRICT|ITEMFLAG_BEGINNER|
          ITEMFLAG_BODYPART|ITEMFLAG_HARDCORE|ITEMFLAG_DISABLED|ITEMFLAG_NEW|ITEMFLAG_MONSTER|
          ITEMFLAG_SOCKETED|ITEMFLAG_SORTED|ITEMFLAG_RESTORED|ITEMFLAG_BROKEN|ITEMFLAG_TAKEN|
          ITEMFLAG_ADDED|ITEMFLAG_REMOVED|ITEMFLAG_IDENTIFIED|ITEMFLAG_IGNORE|ITEMFLAG_CURSOR|
          ITEMFLAG_BOUGHT|ITEMFLAG_RELOAD)) {
      if (((pUnit == (D2UnitStrc *)0x0) || (pUnit->eUnitType != UNIT_ITEM)) ||
         ((pUnit->pUnitData).pUnitDataItem == (D2UnitDataItemStrc *)0x0)) {
        szCharName = (char *)0x0;
      }
      else {
        szCharName = ((pUnit->pUnitData).pUnitDataItem)->szPlayerName;
      }
      do {
        nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,7);
        *szCharName = (char)nBitVal;
        szCharName = szCharName + 1;
      } while ((char)nBitVal != '\0');
    }
  }
  else {
    if (((pUnit == (D2UnitStrc *)0x0) || (pUnit->eUnitType != UNIT_ITEM)) ||
       ((pUnit->pUnitData).pUnitDataItem == (D2UnitDataItemStrc *)0x0)) {
      szCharName = (char *)0x0;
    }
    else {
      szCharName = ((pUnit->pUnitData).pUnitDataItem)->szPlayerName;
    }
    nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,3);
    D2Common::ITEMS::Items::ITEM_SetItemData_nFileIndex(pUnit,nBitVal);
    nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,7);
    if (((pUnit != (D2UnitStrc *)0x0) && (pUnit->eUnitType == UNIT_ITEM)) &&
       ((pUnit->pUnitData).pUnitDataItem != (D2UnitDataItemStrc *)0x0)) {
      ((pUnit->pUnitData).pUnitDataItem)->nEarLevel = (byte)nBitVal;
    }
    do {
      nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,7);
      *szCharName = (char)nBitVal;
      szCharName = szCharName + 1;
    } while ((char)nBitVal != '\0');
  }
  if (((nParam1 != 0) && (0x56 < nParam2)) &&
     (nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,1), nBitVal != 0)) {
    nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,0x20);
    nCoord = Fog::BitBuffer::ReadUnsigned(pBitBuffer,0x20);
    if (0x5d < nParam2) {
      Fog::BitBuffer::ReadUnsigned(pBitBuffer,0x20);
    }
    D2Common::ITEMS::Items::ITEM_SetItemData_0x1Cand0x20(pUnit,nBitVal,nCoord);
  }
  nStatIndex = (uint)(nParam2 < 0x5d);
  nBitVal = D2Common::ITEMS::Items::ITEMS_IsA(pUnit,ITEMTYPE_AnyArmor);
  if (nBitVal == 0) {
    nBitVal = D2Common::ITEMS::Items::ITEMS_IsA(pUnit,ITEMTYPE_Weapon);
    if (nBitVal == 0) {
      nBitVal = D2Common::ITEMS::Items::ITEMS_IsA(pUnit,ITEMTYPE_Gold);
      if (nBitVal != 0) {
        nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,1);
        nClassId = 0;
        if (nBitVal == 0) {
          nBitsPos = 0xc;
        }
        else {
          nBitsPos = 0x20;
        }
        nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,nBitsPos);
        eStatId = UNITSTAT_gold;
        goto LAB_0062d7a7;
      }
    }
    else {
      if (pUnit == (D2UnitStrc *)0x0) {
        nBitVal = 0xffffffff;
      }
      else {
        nBitVal = pUnit->nClassId;
      }
      pItemsTxt = D2Common::DATATBLS::ItemTbls::TXT_Items_GetLine(nBitVal);
      if (pItemsTxt == (D2ItemsTxt *)0x0) {
        nClassId = 0x18cd;
        goto LAB_0062d370;
      }
      D2Common::Stats::StatsEx::STATLIST_SetUnitStat
                (pUnit,UNITSTAT_attackrate,-pItemsTxt->dwSpeed,0);
      nStatVal = D2Common::ITEMS::Items::GetItemQuality(pUnit);
      if (nStatVal == 1) {
        if (pItemsTxt->nMaxDam != 0) {
          nTmpVal2 = (int)((uint)(byte)pItemsTxt->nMaxDam * 3) >> 2;
          if (nTmpVal2 < 2) {
            nTmpVal2 = 2;
          }
          D2Common::Stats::StatsEx::STATLIST_SetUnitStat(pUnit,UNITSTAT_maxdamage,nTmpVal2,0);
        }
        if (pItemsTxt->nMinDam != 0) {
          nClassId = (int)((uint)(byte)pItemsTxt->nMinDam * 3) >> 2;
          if (nClassId == 0) {
            nClassId = 1;
          }
          D2Common::Stats::StatsEx::STATLIST_SetUnitStat(pUnit,UNITSTAT_mindamage,nClassId,0);
        }
        if (pItemsTxt->n2HandMaxDam != 0) {
          nTmpVal2 = (int)((uint)(byte)pItemsTxt->n2HandMaxDam * 3) >> 2;
          if (nTmpVal2 < 2) {
            nTmpVal2 = 2;
          }
          D2Common::Stats::StatsEx::STATLIST_SetUnitStat
                    (pUnit,UNITSTAT_secondary_maxdamage,nTmpVal2,0);
        }
        if (pItemsTxt->n2HandMinDam != 0) {
          nClassId = (int)((uint)(byte)pItemsTxt->n2HandMinDam * 3) >> 2;
          if (nClassId == 0) {
            nClassId = 1;
          }
          D2Common::Stats::StatsEx::STATLIST_SetUnitStat
                    (pUnit,UNITSTAT_secondary_mindamage,nClassId,0);
        }
        if (pItemsTxt->nMaxMisDam != '\0') {
          nClassId = (int)((uint)(byte)pItemsTxt->nMinMisDam * 3) >> 2;
          if (nClassId == 0) {
            nClassId = 1;
          }
          D2Common::Stats::StatsEx::STATLIST_SetUnitStat
                    (pUnit,UNITSTAT_item_throw_mindamage,nClassId,0);
          nTmpVal2 = (int)((uint)(byte)pItemsTxt->nMaxMisDam * 3) >> 2;
          if (nTmpVal2 < 2) {
            nTmpVal2 = 2;
          }
LAB_0062d626:
          D2Common::Stats::StatsEx::STATLIST_SetUnitStat
                    (pUnit,UNITSTAT_item_throw_maxdamage,nTmpVal2,0);
        }
      }
      else {
        D2Common::Stats::StatsEx::STATLIST_SetUnitStat
                  (pUnit,UNITSTAT_maxdamage,(uint)(byte)pItemsTxt->nMaxDam,0);
        D2Common::Stats::StatsEx::STATLIST_SetUnitStat
                  (pUnit,UNITSTAT_mindamage,(uint)(byte)pItemsTxt->nMinDam,0);
        D2Common::Stats::StatsEx::STATLIST_SetUnitStat
                  (pUnit,UNITSTAT_secondary_maxdamage,(uint)(byte)pItemsTxt->n2HandMaxDam,0);
        D2Common::Stats::StatsEx::STATLIST_SetUnitStat
                  (pUnit,UNITSTAT_secondary_mindamage,(uint)(byte)pItemsTxt->n2HandMinDam,0);
        if (pItemsTxt->nMaxMisDam != '\0') {
          D2Common::Stats::StatsEx::STATLIST_SetUnitStat
                    (pUnit,UNITSTAT_item_throw_mindamage,(uint)(byte)pItemsTxt->nMinMisDam,0);
          nTmpVal2 = (uint)(byte)pItemsTxt->nMaxMisDam;
          goto LAB_0062d626;
        }
      }
      nBitVal = D2Common::ITEMS::Items::ITEM_GetItemData_eD2ItemFlag_IsEthereal(pUnit);
      if (nBitVal != 0) {
        nBitsPos = 0;
        nClassId = D2Common::Stats::StatsEx::SERVER_GetUnitStat(pUnit,UNITSTAT_mindamage,0);
        D2Common::Stats::StatsEx::STATLIST_SetUnitStat
                  (pUnit,UNITSTAT_mindamage,(nClassId * 3) / 2,nBitsPos);
        nBitsPos = 0;
        nClassId = D2Common::Stats::StatsEx::SERVER_GetUnitStat(pUnit,UNITSTAT_maxdamage,0);
        D2Common::Stats::StatsEx::STATLIST_SetUnitStat
                  (pUnit,UNITSTAT_maxdamage,(nClassId * 3) / 2,nBitsPos);
        nBitsPos = 0;
        nClassId = D2Common::Stats::StatsEx::SERVER_GetUnitStat
                             (pUnit,UNITSTAT_secondary_mindamage,0);
        D2Common::Stats::StatsEx::STATLIST_SetUnitStat
                  (pUnit,UNITSTAT_secondary_mindamage,(nClassId * 3) / 2,nBitsPos);
        nBitsPos = 0;
        nClassId = D2Common::Stats::StatsEx::SERVER_GetUnitStat
                             (pUnit,UNITSTAT_secondary_maxdamage,0);
        D2Common::Stats::StatsEx::STATLIST_SetUnitStat
                  (pUnit,UNITSTAT_secondary_maxdamage,(nClassId * 3) / 2,nBitsPos);
        nBitsPos = 0;
        nClassId = D2Common::Stats::StatsEx::SERVER_GetUnitStat
                             (pUnit,UNITSTAT_item_throw_mindamage,0);
        D2Common::Stats::StatsEx::STATLIST_SetUnitStat
                  (pUnit,UNITSTAT_item_throw_mindamage,(nClassId * 3) / 2,nBitsPos);
        nBitsPos = 0;
        nClassId = D2Common::Stats::StatsEx::SERVER_GetUnitStat
                             (pUnit,UNITSTAT_item_throw_maxdamage,0);
        D2Common::Stats::StatsEx::STATLIST_SetUnitStat
                  (pUnit,UNITSTAT_item_throw_maxdamage,(nClassId * 3) / 2,nBitsPos);
      }
      if (sgptDataTable->nTxtItemStatCostSize < 0x4a) {
        pStatCostTxt = (D2ItemStatCostTxt *)0x0;
      }
      else {
        pStatCostTxt = sgptDataTable->pTxtItemStatCost + 0x49;
      }
      nBitVal = Fog::BitBuffer::ReadUnsigned
                          (pBitBuffer,
                           (uint)*(byte *)((int)pStatCostTxt->aOpBaseDependents +
                                          (nStatIndex - 0x45)));
      nStatVal = nBitVal - *(int *)(pStatCostTxt->aOpBaseDependents + nStatIndex * 2 + -0x21);
      D2Common::Stats::StatsEx::STATLIST_SetUnitStat(pUnit,UNITSTAT_maxdurability,nStatVal,0);
      if (nStatVal != 0) {
        if (sgptDataTable->nTxtItemStatCostSize < 0x49) {
          pStatCostTxt = (D2ItemStatCostTxt *)0x0;
        }
        else {
          pStatCostTxt = sgptDataTable->pTxtItemStatCost + 0x48;
        }
        nTmpVal2 = (uint)*(byte *)((int)pStatCostTxt->aOpBaseDependents + (nStatIndex - 0x45));
        if (nParam2 < 0x60) {
          nTmpVal2 = 8;
        }
        nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,nTmpVal2);
        nBitVal = nBitVal - *(int *)(pStatCostTxt->aOpBaseDependents + nStatIndex * 2 + -0x21);
        nClassId = 0;
        eStatId = UNITSTAT_durability;
        goto LAB_0062d7a7;
      }
    }
  }
  else {
    if (sgptDataTable->nTxtItemStatCostSize < 0x20) {
      pItemStatCostTxt = (D2ItemStatCostTxt *)0x0;
    }
    else {
      pItemStatCostTxt = sgptDataTable->pTxtItemStatCost + 0x1f;
    }
    nBitVal = Fog::BitBuffer::ReadUnsigned
                        (pBitBuffer,
                         (uint)*(byte *)((int)pItemStatCostTxt->aOpBaseDependents +
                                        (nStatIndex - 0x45)));
    D2Common::Stats::StatsEx::STATLIST_SetUnitStat
              (pUnit,UNITSTAT_armorclass,
               nBitVal - *(int *)(pItemStatCostTxt->aOpBaseDependents + nStatIndex * 2 + -0x21),0);
    if (pUnit == (D2UnitStrc *)0x0) {
      nBitVal = 0xffffffff;
    }
    else {
      nBitVal = pUnit->nClassId;
    }
    pItemsTxt = D2Common::DATATBLS::ItemTbls::TXT_Items_GetLine(nBitVal);
    if (pItemsTxt == (D2ItemsTxt *)0x0) {
      nClassId = 0x18b6;
LAB_0062d370:
      nBitsPos = Fog::Src::ErrorManager::GetInstructionPointer();
      Fog::Src::ErrorManager::ERROR_UnrecoverableInternalError_Halt("",nBitsPos,nClassId);
                    /* WARNING: Subroutine does not return */
      compiler::_exit(-1);
    }
    D2Common::Stats::StatsEx::STATLIST_SetUnitStat
              (pUnit,UNITSTAT_toblock,(uint)(byte)pItemsTxt->bBlock,0);
    D2Common::Stats::StatsEx::STATLIST_SetUnitStat
              (pUnit,UNITSTAT_velocitypercent,-pItemsTxt->dwSpeed,0);
    if (sgptDataTable->nTxtItemStatCostSize < 0x4a) {
      pItemStatCostTxt = (D2ItemStatCostTxt *)0x0;
    }
    else {
      pItemStatCostTxt = sgptDataTable->pTxtItemStatCost + 0x49;
    }
    nBitVal = Fog::BitBuffer::ReadUnsigned
                        (pBitBuffer,
                         (uint)*(byte *)((int)pItemStatCostTxt->aOpBaseDependents +
                                        (nStatIndex - 0x45)));
    nStatVal = nBitVal - *(int *)(pItemStatCostTxt->aOpBaseDependents + nStatIndex * 2 + -0x21);
    D2Common::Stats::StatsEx::STATLIST_SetUnitStat(pUnit,UNITSTAT_maxdurability,nStatVal,0);
    if (nStatVal == 0) goto LAB_0062d7ad;
    if (sgptDataTable->nTxtItemStatCostSize < 0x49) {
      pStatCostTxt = (D2ItemStatCostTxt *)0x0;
    }
    else {
      pStatCostTxt = sgptDataTable->pTxtItemStatCost + 0x48;
    }
    nTmpVal2 = (uint)*(byte *)((int)pStatCostTxt->aOpBaseDependents + (nStatIndex - 0x45));
    if (nParam2 < 0x60) {
      nTmpVal2 = 8;
    }
    nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,nTmpVal2);
    nBitVal = nBitVal - *(int *)(pStatCostTxt->aOpBaseDependents + nStatIndex * 2 + -0x21);
    nClassId = 0;
    eStatId = UNITSTAT_durability;
LAB_0062d7a7:
    D2Common::Stats::StatsEx::STATLIST_SetUnitStat(pUnit,eStatId,nBitVal,nClassId);
  }
LAB_0062d7ad:
  bIsStackable = D2Common::ITEMS::Items::IsStackable(pUnit);
  if (bIsStackable != 0) {
    nClassId = 0;
    if (nParam2 < 0x51) {
      nBitsPos = 8;
    }
    else {
      nBitsPos = 9;
    }
    nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,nBitsPos);
    D2Common::Stats::StatsEx::STATLIST_SetUnitStat(pUnit,UNITSTAT_quantity,nBitVal,nClassId);
  }
  if (((pUnit == (D2UnitStrc *)0x0) || (pUnit->eUnitType != UNIT_ITEM)) ||
     ((pUnit->pUnitData).pUnitDataItem == (D2UnitDataItemStrc *)0x0)) {
    eItemFlags = ~(ITEMFLAG_TAGGED|ITEMFLAG_DROW|ITEMFLAG_CURSED|ITEMFLAG_STAFFMODS|ITEMFLAG_MAGICAL
                   |ITEMFLAG_RUNEWORD|ITEMFLAG_CRUDE|ITEMFLAG_PLAYERNAME|ITEMFLAG_SAVED|
                   ITEMFLAG_ETHEREAL|ITEMFLAG_COMPACT|ITEMFLAG_100000|ITEMFLAG_SERVER|
                   ITEMFLAG_RESTRICT|ITEMFLAG_BEGINNER|ITEMFLAG_BODYPART|ITEMFLAG_HARDCORE|
                   ITEMFLAG_DISABLED|ITEMFLAG_NEW|ITEMFLAG_MONSTER|ITEMFLAG_SOCKETED|ITEMFLAG_SORTED
                   |ITEMFLAG_RESTORED|ITEMFLAG_BROKEN|ITEMFLAG_TAKEN|ITEMFLAG_ADDED|ITEMFLAG_REMOVED
                   |ITEMFLAG_IDENTIFIED|ITEMFLAG_IGNORE|ITEMFLAG_CURSOR|ITEMFLAG_BOUGHT|
                  ITEMFLAG_RELOAD);
  }
  else {
    eItemFlags = ((pUnit->pUnitData).pUnitDataItem)->dwItemFlags;
  }
  if ((eItemFlags & ITEMFLAG_SOCKETED) !=
      ~(ITEMFLAG_TAGGED|ITEMFLAG_DROW|ITEMFLAG_CURSED|ITEMFLAG_STAFFMODS|ITEMFLAG_MAGICAL|
        ITEMFLAG_RUNEWORD|ITEMFLAG_CRUDE|ITEMFLAG_PLAYERNAME|ITEMFLAG_SAVED|ITEMFLAG_ETHEREAL|
        ITEMFLAG_COMPACT|ITEMFLAG_100000|ITEMFLAG_SERVER|ITEMFLAG_RESTRICT|ITEMFLAG_BEGINNER|
        ITEMFLAG_BODYPART|ITEMFLAG_HARDCORE|ITEMFLAG_DISABLED|ITEMFLAG_NEW|ITEMFLAG_MONSTER|
        ITEMFLAG_SOCKETED|ITEMFLAG_SORTED|ITEMFLAG_RESTORED|ITEMFLAG_BROKEN|ITEMFLAG_TAKEN|
        ITEMFLAG_ADDED|ITEMFLAG_REMOVED|ITEMFLAG_IDENTIFIED|ITEMFLAG_IGNORE|ITEMFLAG_CURSOR|
        ITEMFLAG_BOUGHT|ITEMFLAG_RELOAD)) {
    if (sgptDataTable->nTxtItemStatCostSize < 0xc3) {
      pStatCostTxt = (D2ItemStatCostTxt *)0x0;
    }
    else {
      pStatCostTxt = sgptDataTable->pTxtItemStatCost + 0xc2;
    }
    nBitVal = Fog::BitBuffer::ReadUnsigned
                        (pBitBuffer,
                         (uint)*(byte *)((int)pStatCostTxt->aOpBaseDependents + (nStatIndex - 0x45))
                        );
    D2Common::ITEMS::Items::ITEM_SetSocketCount(pUnit,nBitVal);
  }
  if (nParam1 == 0) {
    if (((pUnit == (D2UnitStrc *)0x0) || (pUnit->eUnitType != UNIT_ITEM)) ||
       ((pUnit->pUnitData).pUnitDataItem == (D2UnitDataItemStrc *)0x0)) {
      eItemFlags = ~(ITEMFLAG_TAGGED|ITEMFLAG_DROW|ITEMFLAG_CURSED|ITEMFLAG_STAFFMODS|
                     ITEMFLAG_MAGICAL|ITEMFLAG_RUNEWORD|ITEMFLAG_CRUDE|ITEMFLAG_PLAYERNAME|
                     ITEMFLAG_SAVED|ITEMFLAG_ETHEREAL|ITEMFLAG_COMPACT|ITEMFLAG_100000|
                     ITEMFLAG_SERVER|ITEMFLAG_RESTRICT|ITEMFLAG_BEGINNER|ITEMFLAG_BODYPART|
                     ITEMFLAG_HARDCORE|ITEMFLAG_DISABLED|ITEMFLAG_NEW|ITEMFLAG_MONSTER|
                     ITEMFLAG_SOCKETED|ITEMFLAG_SORTED|ITEMFLAG_RESTORED|ITEMFLAG_BROKEN|
                     ITEMFLAG_TAKEN|ITEMFLAG_ADDED|ITEMFLAG_REMOVED|ITEMFLAG_IDENTIFIED|
                     ITEMFLAG_IGNORE|ITEMFLAG_CURSOR|ITEMFLAG_BOUGHT|ITEMFLAG_RELOAD);
    }
    else {
      eItemFlags = ((pUnit->pUnitData).pUnitDataItem)->dwItemFlags;
    }
    if ((eItemFlags & ITEMFLAG_IDENTIFIED) ==
        ~(ITEMFLAG_TAGGED|ITEMFLAG_DROW|ITEMFLAG_CURSED|ITEMFLAG_STAFFMODS|ITEMFLAG_MAGICAL|
          ITEMFLAG_RUNEWORD|ITEMFLAG_CRUDE|ITEMFLAG_PLAYERNAME|ITEMFLAG_SAVED|ITEMFLAG_ETHEREAL|
          ITEMFLAG_COMPACT|ITEMFLAG_100000|ITEMFLAG_SERVER|ITEMFLAG_RESTRICT|ITEMFLAG_BEGINNER|
          ITEMFLAG_BODYPART|ITEMFLAG_HARDCORE|ITEMFLAG_DISABLED|ITEMFLAG_NEW|ITEMFLAG_MONSTER|
          ITEMFLAG_SOCKETED|ITEMFLAG_SORTED|ITEMFLAG_RESTORED|ITEMFLAG_BROKEN|ITEMFLAG_TAKEN|
          ITEMFLAG_ADDED|ITEMFLAG_REMOVED|ITEMFLAG_IDENTIFIED|ITEMFLAG_IGNORE|ITEMFLAG_CURSOR|
          ITEMFLAG_BOUGHT|ITEMFLAG_RELOAD)) goto LAB_0062e268;
  }
  nStatVal = 0;
  nStatListCount = 0;
  nSetBitMask = 0;
  if (((0x54 < nParam2) && (pUnit != (D2UnitStrc *)0x0)) &&
     ((pUnit->eUnitType == UNIT_ITEM &&
      (((pUnit->pUnitData).pUnitDataItem != (D2UnitDataItemStrc *)0x0 &&
       (((pUnit->pUnitData).pUnitDataItem)->eQuality == QUALITY_SET)))))) {
    nStatVal = 5;
    nStatListCount = 5;
    nSetBitMask = Fog::BitBuffer::ReadUnsigned(pBitBuffer,5);
  }
  if (bExtended) {
    nStatVal = nStatVal + 1;
    nStatListCount = nStatVal;
  }
  nStatListIdx = 0xffffffff;
  if (true) {
    do {
      if ((int)nStatListIdx < 0) {
        pItemStatCostTxt = (D2ItemStatCostTxt *)0x0;
        nParam1 = 0x40;
LAB_0062d8f7:
        pStatsEx = D2Common::Stats::StatsEx::GetStatListByStateOrFlagsIfNotExists
                             (pUnit,(eD2States)pItemStatCostTxt,nParam1);
        if (pStatsEx == (D2StatListExStrc *)0x0) {
          nClassId = D2Client::UNIT::GetGUID(pUnit);
          eQualityType = QUALITY_MAGIC;
          pMemory = D2Client::UNIT::CUnitEvent::GetMemPool(pUnit);
          pStatsEx = (D2StatListExStrc *)
                     D2Common::Stats::StatsEx::AllocStatList
                               (pMemory,nParam1,(int32_t)pStatsEx,eQualityType,nClassId);
          D2Common::Stats::StatsEx::STATLIST_AttachStatListToUnit(pUnit,pStatsEx,1);
          D2Common::Stats::StatsEx::SetState(pStatsEx,(eD2States)pItemStatCostTxt);
        }
        eStatId = Fog::BitBuffer::ReadUnsigned(pBitBuffer,9);
        eStatId2 = ~UNITSTAT_strength;
        if (eStatId != (UNITSTAT_item_slash_damage|UNITSTAT_item_find_item)) {
          while ((eUnitStat = eStatId, eUnitStat != UNITSTAT_strength ||
                 (eStatId2 != UNITSTAT_strength))) {
            if ((sgptDataTable->nTxtItemStatCostSize <= (int)eUnitStat) ||
               (((int)eUnitStat < 0 ||
                (pStatCostTxt = sgptDataTable->pTxtItemStatCost + eUnitStat,
                pStatCostTxt == (D2ItemStatCostTxt *)0x0)))) goto LAB_0062e1da;
            eStatId = eUnitStat;
            if (false) {
switchD_0062d9ae_caseD_4:
LAB_0062e1a9:
              D2Common::ITEMS::Items::ITEMS_DeserializeSingleStat
                        (nParam2,eStatId,pBitBuffer,pStatsEx,(int32_t)pStatCostTxt,nStatIndex);
            }
            else {
              switch(eUnitStat) {
              case UNITSTAT_strength:
              case UNITSTAT_dexterity:
                nBitVal = Fog::BitBuffer::ReadUnsigned
                                    (pBitBuffer,
                                     (uint)*(byte *)((int)pStatCostTxt->aOpBaseDependents +
                                                    (nStatIndex - 0x45)));
                D2Common::Stats::StatsEx::D2AddStatToStatsListEx
                          (pStatsEx,eUnitStat,
                           nBitVal - *(int *)(pStatCostTxt->aOpBaseDependents +
                                             nStatIndex * 2 + -0x21),0);
                break;
              case UNITSTAT_energy:
                nBitVal = Fog::BitBuffer::ReadUnsigned
                                    (pBitBuffer,
                                     (uint)*(byte *)((int)pStatCostTxt->aOpBaseDependents +
                                                    (nStatIndex - 0x45)));
                D2Common::Stats::StatsEx::D2AddStatToStatsListEx
                          (pStatsEx,UNITSTAT_energy,
                           nBitVal - *(int *)(pStatCostTxt->aOpBaseDependents +
                                             nStatIndex * 2 + -0x21),0);
                if (nParam2 < 0x56) {
                  if (sgptDataTable->nTxtItemStatCostSize < 10) {
                    pStatCostTxt = (D2ItemStatCostTxt *)0x0;
                  }
                  else {
                    pStatCostTxt = sgptDataTable->pTxtItemStatCost + 9;
                  }
                  nBitVal = Fog::BitBuffer::ReadUnsigned
                                      (pBitBuffer,
                                       (uint)*(byte *)((int)pStatCostTxt->aOpBaseDependents +
                                                      (nStatIndex - 0x45)));
                  D2Common::Stats::StatsEx::D2AddStatToStatsListEx
                            (pStatsEx,UNITSTAT_maxmana,
                             nBitVal - *(int *)(pStatCostTxt->aOpBaseDependents +
                                               nStatIndex * 2 + -0x21),0);
                }
                break;
              case UNITSTAT_vitality:
                nBitVal = Fog::BitBuffer::ReadUnsigned
                                    (pBitBuffer,
                                     (uint)*(byte *)((int)pStatCostTxt->aOpBaseDependents +
                                                    (nStatIndex - 0x45)));
                D2Common::Stats::StatsEx::D2AddStatToStatsListEx
                          (pStatsEx,UNITSTAT_vitality,
                           nBitVal - *(int *)(pStatCostTxt->aOpBaseDependents +
                                             nStatIndex * 2 + -0x21),0);
                if (nParam2 < 0x56) {
                  if (sgptDataTable->nTxtItemStatCostSize < 8) {
                    pStatCostTxt = (D2ItemStatCostTxt *)0x0;
                  }
                  else {
                    pStatCostTxt = sgptDataTable->pTxtItemStatCost + 7;
                  }
                  nBitVal = Fog::BitBuffer::ReadUnsigned
                                      (pBitBuffer,
                                       (uint)*(byte *)((int)pStatCostTxt->aOpBaseDependents +
                                                      (nStatIndex - 0x45)));
                  D2Common::Stats::StatsEx::D2AddStatToStatsListEx
                            (pStatsEx,UNITSTAT_maxhp,
                             (nBitVal -
                             *(int *)(pStatCostTxt->aOpBaseDependents + nStatIndex * 2 + -0x21)) *
                             0x100,0);
                }
                break;
              default:
                goto switchD_0062d9ae_caseD_4;
              case UNITSTAT_item_maxdamage_percent:
                D2Common::ITEMS::Items::ITEM_ResolvePercentStatToBaseValue
                          (UNITSTAT_item_maxdamage_percent,pUnit);
                nBitVal = Fog::BitBuffer::ReadUnsigned
                                    (pBitBuffer,
                                     (uint)*(byte *)((int)pStatCostTxt->aOpBaseDependents +
                                                    (nStatIndex - 0x45)));
                D2Common::Stats::StatsEx::D2AddStatToStatsListEx
                          (pStatsEx,UNITSTAT_item_maxdamage_percent,
                           nBitVal - *(int *)(pStatCostTxt->aOpBaseDependents +
                                             nStatIndex * 2 + -0x21),0);
                D2Common::ITEMS::Items::ITEM_ResolvePercentStatToBaseValue
                          (UNITSTAT_item_mindamage_percent,pUnit);
                if (sgptDataTable->nTxtItemStatCostSize < 0x13) {
                  pStatCostTxt = (D2ItemStatCostTxt *)0x0;
                }
                else {
                  pStatCostTxt = sgptDataTable->pTxtItemStatCost + 0x12;
                }
                nBitVal = Fog::BitBuffer::ReadUnsigned
                                    (pBitBuffer,
                                     (uint)*(byte *)((int)pStatCostTxt->aOpBaseDependents +
                                                    (nStatIndex - 0x45)));
                D2Common::Stats::StatsEx::D2AddStatToStatsListEx
                          (pStatsEx,UNITSTAT_item_mindamage_percent,
                           nBitVal - *(int *)(pStatCostTxt->aOpBaseDependents +
                                             nStatIndex * 2 + -0x21),0);
                break;
              case UNITSTAT_firemindam:
                nTmpVal2 = (uint)*(byte *)((int)pStatCostTxt->aOpBaseDependents +
                                          (nStatIndex - 0x45));
                if (nParam2 < 0x52) {
                  nTmpVal2 = 6;
                }
                nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,nTmpVal2);
                D2Common::Stats::StatsEx::D2AddStatToStatsListEx
                          (pStatsEx,UNITSTAT_firemindam,
                           nBitVal - *(int *)(pStatCostTxt->aOpBaseDependents +
                                             nStatIndex * 2 + -0x21),0);
                if (sgptDataTable->nTxtItemStatCostSize < 0x32) {
                  pStatCostTxt = (D2ItemStatCostTxt *)0x0;
                }
                else {
                  pStatCostTxt = sgptDataTable->pTxtItemStatCost + 0x31;
                }
                nTmpVal2 = (uint)*(byte *)((int)pStatCostTxt->aOpBaseDependents +
                                          (nStatIndex - 0x45));
                if (nParam2 < 0x52) {
                  nTmpVal2 = 7;
                }
                nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,nTmpVal2);
                D2Common::Stats::StatsEx::D2AddStatToStatsListEx
                          (pStatsEx,UNITSTAT_firemaxdam,
                           nBitVal - *(int *)(pStatCostTxt->aOpBaseDependents +
                                             nStatIndex * 2 + -0x21),0);
                break;
              case UNITSTAT_lightmindam:
                nBitVal = Fog::BitBuffer::ReadUnsigned
                                    (pBitBuffer,
                                     (uint)*(byte *)((int)pStatCostTxt->aOpBaseDependents +
                                                    (nStatIndex - 0x45)));
                D2Common::Stats::StatsEx::D2AddStatToStatsListEx
                          (pStatsEx,UNITSTAT_lightmindam,
                           nBitVal - *(int *)(pStatCostTxt->aOpBaseDependents +
                                             nStatIndex * 2 + -0x21),0);
                if (sgptDataTable->nTxtItemStatCostSize < 0x34) {
                  pStatCostTxt = (D2ItemStatCostTxt *)0x0;
                }
                else {
                  pStatCostTxt = sgptDataTable->pTxtItemStatCost + 0x33;
                }
                nTmpVal2 = (uint)*(byte *)((int)pStatCostTxt->aOpBaseDependents +
                                          (nStatIndex - 0x45));
                if (nParam2 < 0x52) {
                  nTmpVal2 = 7;
                }
                nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,nTmpVal2);
                D2Common::Stats::StatsEx::D2AddStatToStatsListEx
                          (pStatsEx,UNITSTAT_lightmaxdam,
                           nBitVal - *(int *)(pStatCostTxt->aOpBaseDependents +
                                             nStatIndex * 2 + -0x21),0);
                break;
              case UNITSTAT_magicmindam:
                nBitVal = Fog::BitBuffer::ReadUnsigned
                                    (pBitBuffer,
                                     (uint)*(byte *)((int)pStatCostTxt->aOpBaseDependents +
                                                    (nStatIndex - 0x45)));
                D2Common::Stats::StatsEx::D2AddStatToStatsListEx
                          (pStatsEx,UNITSTAT_magicmindam,
                           nBitVal - *(int *)(pStatCostTxt->aOpBaseDependents +
                                             nStatIndex * 2 + -0x21),0);
                if (sgptDataTable->nTxtItemStatCostSize < 0x36) {
                  pStatCostTxt = (D2ItemStatCostTxt *)0x0;
                }
                else {
                  pStatCostTxt = sgptDataTable->pTxtItemStatCost + 0x35;
                }
                nBitVal = Fog::BitBuffer::ReadUnsigned
                                    (pBitBuffer,
                                     (uint)*(byte *)((int)pStatCostTxt->aOpBaseDependents +
                                                    (nStatIndex - 0x45)));
                D2Common::Stats::StatsEx::D2AddStatToStatsListEx
                          (pStatsEx,UNITSTAT_magicmaxdam,
                           nBitVal - *(int *)(pStatCostTxt->aOpBaseDependents +
                                             nStatIndex * 2 + -0x21),0);
                break;
              case UNITSTAT_coldmindam:
                nBitVal = Fog::BitBuffer::ReadUnsigned
                                    (pBitBuffer,
                                     (uint)*(byte *)((int)pStatCostTxt->aOpBaseDependents +
                                                    (nStatIndex - 0x45)));
                D2Common::Stats::StatsEx::D2AddStatToStatsListEx
                          (pStatsEx,UNITSTAT_coldmindam,
                           nBitVal - *(int *)(pStatCostTxt->aOpBaseDependents +
                                             nStatIndex * 2 + -0x21),0);
                if (sgptDataTable->nTxtItemStatCostSize < 0x38) {
                  pStatCostTxt = (D2ItemStatCostTxt *)0x0;
                }
                else {
                  pStatCostTxt = sgptDataTable->pTxtItemStatCost + 0x37;
                }
                nTmpVal2 = (uint)*(byte *)((int)pStatCostTxt->aOpBaseDependents +
                                          (nStatIndex - 0x45));
                if (nParam2 < 0x52) {
                  nTmpVal2 = 7;
                }
                nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,nTmpVal2);
                D2Common::Stats::StatsEx::D2AddStatToStatsListEx
                          (pStatsEx,UNITSTAT_coldmaxdam,
                           nBitVal - *(int *)(pStatCostTxt->aOpBaseDependents +
                                             nStatIndex * 2 + -0x21),0);
                if (sgptDataTable->nTxtItemStatCostSize < 0x39) {
                  pStatCostTxt = (D2ItemStatCostTxt *)0x0;
                }
                else {
                  pStatCostTxt = sgptDataTable->pTxtItemStatCost + 0x38;
                }
                nBitVal = Fog::BitBuffer::ReadUnsigned
                                    (pBitBuffer,
                                     (uint)*(byte *)((int)pStatCostTxt->aOpBaseDependents +
                                                    (nStatIndex - 0x45)));
                D2Common::Stats::StatsEx::D2AddStatToStatsListEx
                          (pStatsEx,UNITSTAT_coldlength,
                           nBitVal - *(int *)(pStatCostTxt->aOpBaseDependents +
                                             nStatIndex * 2 + -0x21),0);
                break;
              case UNITSTAT_poisonmindam:
                nTmpVal2 = (uint)*(byte *)((int)pStatCostTxt->aOpBaseDependents +
                                          (nStatIndex - 0x45));
                if (nParam2 < 0x52) {
                  nTmpVal2 = 7;
                }
                nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,nTmpVal2);
                D2Common::Stats::StatsEx::D2AddStatToStatsListEx
                          (pStatsEx,UNITSTAT_poisonmindam,
                           nBitVal - *(int *)(pStatCostTxt->aOpBaseDependents +
                                             nStatIndex * 2 + -0x21),0);
                if (sgptDataTable->nTxtItemStatCostSize < 0x3b) {
                  pStatCostTxt = (D2ItemStatCostTxt *)0x0;
                }
                else {
                  pStatCostTxt = sgptDataTable->pTxtItemStatCost + 0x3a;
                }
                nTmpVal2 = (uint)*(byte *)((int)pStatCostTxt->aOpBaseDependents +
                                          (nStatIndex - 0x45));
                if (nParam2 < 0x52) {
                  nTmpVal2 = 8;
                }
                nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,nTmpVal2);
                D2Common::Stats::StatsEx::D2AddStatToStatsListEx
                          (pStatsEx,UNITSTAT_poisonmaxdam,
                           nBitVal - *(int *)(pStatCostTxt->aOpBaseDependents +
                                             nStatIndex * 2 + -0x21),0);
                if (sgptDataTable->nTxtItemStatCostSize < 0x3c) {
                  pStatCostTxt = (D2ItemStatCostTxt *)0x0;
                }
                else {
                  pStatCostTxt = sgptDataTable->pTxtItemStatCost + 0x3b;
                }
                nBitVal = Fog::BitBuffer::ReadUnsigned
                                    (pBitBuffer,
                                     (uint)*(byte *)((int)pStatCostTxt->aOpBaseDependents +
                                                    (nStatIndex - 0x45)));
                D2Common::Stats::StatsEx::D2AddStatToStatsListEx
                          (pStatsEx,UNITSTAT_poisonlength,
                           nBitVal - *(int *)(pStatCostTxt->aOpBaseDependents +
                                             nStatIndex * 2 + -0x21),0);
                D2Common::Stats::StatsEx::D2AddStatToStatsListEx(pStatsEx,UNITSTAT_poison_count,1,0)
                ;
                break;
              case UNITSTAT_item_addclassskills:
                if (nParam2 < 0x5d) {
                  nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,3);
                  D2Common::Stats::StatsEx::STATLIST_SetStatValue
                            (pStatsEx,UNITSTAT_item_addclassskills,nBitVal,0);
                  break;
                }
                eStatId = UNITSTAT_item_addclassskills;
                goto LAB_0062e1a9;
              case UNITSTAT_unsentparam1:
                if (0x5c < nParam2) {
                  eStatId = UNITSTAT_unsentparam1;
                  goto LAB_0062e1a9;
                }
                nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,3);
                D2Common::Stats::StatsEx::STATLIST_SetStatValue
                          (pStatsEx,UNITSTAT_item_addclassskills,nBitVal,3);
                break;
              case UNITSTAT_item_addexperience:
                if (0x5c < nParam2) {
                  eStatId = UNITSTAT_item_addexperience;
                  goto LAB_0062e1a9;
                }
                nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,3);
                D2Common::Stats::StatsEx::STATLIST_SetStatValue
                          (pStatsEx,UNITSTAT_item_addclassskills,nBitVal,2);
                break;
              case UNITSTAT_item_healafterkill:
                if (0x5c < nParam2) {
                  eStatId = UNITSTAT_item_healafterkill;
                  goto LAB_0062e1a9;
                }
                nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,3);
                D2Common::Stats::StatsEx::STATLIST_SetStatValue
                          (pStatsEx,UNITSTAT_item_addclassskills,nBitVal,1);
                break;
              case UNITSTAT_item_reducedprices:
                if (0x5c < nParam2) {
                  eStatId = UNITSTAT_item_reducedprices;
                  goto LAB_0062e1a9;
                }
                nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,3);
                D2Common::Stats::StatsEx::STATLIST_SetStatValue
                          (pStatsEx,UNITSTAT_item_addclassskills,nBitVal,4);
                break;
              case UNITSTAT_item_singleskill:
              case UNITSTAT_item_restinpeace:
              case UNITSTAT_curse_resistance:
              case UNITSTAT_fade:
              case UNITSTAT_armor_override_percent:
              case UNITSTAT_unused183:
              case UNITSTAT_unused184:
              case UNITSTAT_unused185:
              case UNITSTAT_unused186:
              case UNITSTAT_unused187:
                if (0x5c < nParam2) goto switchD_0062d9ae_caseD_4;
                nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,0xe);
                D2Common::ITEMS::ItemMods::ITEMMODS_GetQualityMinMax(nBitVal,&nSkillId,&nSkillLevel)
                ;
                nStatVal = 7;
                pStatCostTxt = D2Client::GAME::SCmd::TXT_ItemStatCost_GetLine
                                         (UNITSTAT_item_singleskill);
                nBitVal = nSkillId;
                if (pStatCostTxt != (D2ItemStatCostTxt *)0x0) {
                  nStatVal = (1 << (pStatCostTxt->saveBits & 0x1fU)) + -1;
                }
                if (((0 < (int)nSkillLevel) && ((int)nSkillLevel <= nStatVal)) &&
                   (bIsStackable = D2Common::Stats::StatsEx::SKILLS_ValidateSkillDescIndex(nSkillId)
                   , bIsStackable != 0)) {
                  D2Common::Stats::StatsEx::STATLIST_SetStatValue
                            (pStatsEx,UNITSTAT_item_singleskill,nSkillLevel,nBitVal);
                }
                break;
              case UNITSTAT_item_elemskill:
                if (0x5c < nParam2) {
                  eStatId = UNITSTAT_item_elemskill;
                  goto LAB_0062e1a9;
                }
                nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,4);
                D2Common::Stats::StatsEx::STATLIST_SetStatValue
                          (pStatsEx,UNITSTAT_item_elemskill,nBitVal,1);
                break;
              case UNITSTAT_item_freeze:
                if (0x59 < nParam2) {
                  eStatId = UNITSTAT_item_freeze;
                  goto LAB_0062e1a9;
                }
                Fog::BitBuffer::ReadUnsigned(pBitBuffer,0x10);
                D2Common::Stats::StatsEx::D2AddStatToStatsListEx(pStatsEx,UNITSTAT_item_freeze,1,0);
                break;
              case UNITSTAT_attack_vs_montype:
                if (0x5c < nParam2) {
                  eStatId = UNITSTAT_attack_vs_montype;
                  goto LAB_0062e1a9;
                }
                nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,3);
                D2Common::Stats::StatsEx::STATLIST_SetStatValue
                          (pStatsEx,UNITSTAT_item_addclassskills,nBitVal,5);
                break;
              case UNITSTAT_damage_vs_montype:
                if (0x5c < nParam2) {
                  eStatId = UNITSTAT_damage_vs_montype;
                  goto LAB_0062e1a9;
                }
                nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,3);
                D2Common::Stats::StatsEx::STATLIST_SetStatValue
                          (pStatsEx,UNITSTAT_item_addclassskills,nBitVal,6);
                break;
              case UNITSTAT_item_addskill_tab:
              case UNITSTAT_unused189:
              case UNITSTAT_unused190:
              case UNITSTAT_unused191:
              case UNITSTAT_unused192:
              case UNITSTAT_unused193:
                if (0x5c < nParam2) goto LAB_0062e1a9;
                nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,10);
                D2Common::ITEMS::ItemMods::ITEMMODS_GetQualityFields1_2_3
                          (nBitVal,&nSkillTabGroup,&nSkillTabIdx,&nSkillTabCount);
                if (7 < (int)nSkillTabCount) {
                  nSkillTabCount = 7;
                }
                D2Common::Stats::StatsEx::STATLIST_SetStatValue
                          (pStatsEx,UNITSTAT_item_addskill_tab,nSkillTabCount,
                           nSkillTabIdx + nSkillTabGroup * 8);
                break;
              case UNITSTAT_item_skillonattack:
              case UNITSTAT_item_skillonkill:
              case UNITSTAT_item_skillondeath:
                if (0x5c < nParam2) goto LAB_0062e1a9;
                nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,0x15);
                D2Common::ITEMS::ItemMods::ITEMMODS_GetQualityFields2_3_4
                          (nBitVal,&nOnAttackChance,(uint *)nOnAttackSkillBuf,&nOnAttackSkillLevel);
                D2Common::Stats::StatsEx::STATLIST_SetStatValue
                          (pStatsEx,UNITSTAT_item_skillonattack,nOnAttackSkillLevel,
                           (nOnAttackSkillBuf[0] & 0x3f) + nOnAttackChance * 0x40);
                break;
              case UNITSTAT_item_skillonhit:
              case UNITSTAT_item_skillonlevelup:
              case UNITSTAT_unused200:
                if (0x5c < nParam2) goto LAB_0062e1a9;
                nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,0x15);
                D2Common::ITEMS::ItemMods::ITEMMODS_GetQualityFields2_3_4
                          (nBitVal,&nOnHitChance,(uint *)nOnHitSkillBuf,&nOnHitSkillLevel);
                D2Common::Stats::StatsEx::STATLIST_SetStatValue
                          (pStatsEx,UNITSTAT_item_skillonhit,nOnHitSkillLevel,
                           (nOnHitSkillBuf[0] & 0x3f) + nOnHitChance * 0x40);
                break;
              case UNITSTAT_item_skillongethit:
              case UNITSTAT_unused202:
              case UNITSTAT_unused203:
                if (0x5c < nParam2) goto LAB_0062e1a9;
                nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,0x15);
                D2Common::ITEMS::ItemMods::ITEMMODS_GetQualityFields2_3_4
                          (nBitVal,&nOnGetHitChance,(uint *)nOnGetHitSkillBuf,&nOnGetHitSkillLevel);
                D2Common::Stats::StatsEx::STATLIST_SetStatValue
                          (pStatsEx,UNITSTAT_item_skillongethit,nOnGetHitSkillLevel,
                           (nOnGetHitSkillBuf[0] & 0x3f) + nOnGetHitChance * 0x40);
                break;
              case UNITSTAT_item_charged_skill:
              case UNITSTAT_unused204:
              case UNITSTAT_unused205:
              case UNITSTAT_unused206:
              case UNITSTAT_unused207:
              case UNITSTAT_unused208:
              case UNITSTAT_unused209:
              case UNITSTAT_unused210:
              case UNITSTAT_unused211:
              case UNITSTAT_unused212:
                if (0x5c < nParam2) goto LAB_0062e1a9;
                if (nParam2 < 0x4a) {
                  nClassId = 0x1d;
                }
                else {
                  nClassId = 0x1e;
                }
                nBitVal = Fog::BitBuffer::ReadUnsigned(pBitBuffer,nClassId);
                D2Common::ITEMS::ItemMods::ITEMMODS_GetQualityAllFields
                          (nBitVal,&nChargeMax,(uint *)nChargeBuf,&nChargeSkillLevel,&nChargeSkillId
                          );
                nStatVal = nChargeMax << ((byte)sgptDataTable->nChargedSkillLevelBits & 0x1f);
                D2Common::Stats::StatsEx::STATLIST_SetStatValue
                          (pStatsEx,UNITSTAT_item_charged_skill,
                           (nChargeSkillLevel & 0xff) + nChargeSkillId * 0x100,
                           CONCAT22((short)((uint)nStatVal >> 0x10),
                                    (short)nStatVal +
                                    ((ushort)sgptDataTable->dwChargedSkillLevelMask & nChargeBuf[0])
                                   ));
              }
            }
            eStatId = Fog::BitBuffer::ReadUnsigned(pBitBuffer,9);
            eStatId2 = eUnitStat;
            if (eStatId == (UNITSTAT_item_slash_damage|UNITSTAT_item_find_item)) goto LAB_0062e1da;
          }
          bError = 1;
        }
LAB_0062e1da:
        if ((((nParam2 < 0x5d) &&
             (nStatVal = D2Common::Stats::StatsEx::STATLIST_GetBaseStatValue
                                   (pStatsEx,UNITSTAT_item_addclassskills,0), 0 < nStatVal)) &&
            ((nSkillClassVal =
                   D2Common::Stats::StatsEx::STATLIST_GetBaseStatValue
                             (pStatsEx,UNITSTAT_item_addclassskills,1), nStatVal == nSkillClassVal
             && ((nSkillClassVal =
                       D2Common::Stats::StatsEx::STATLIST_GetBaseStatValue
                                 (pStatsEx,UNITSTAT_item_addclassskills,2),
                 nStatVal == nSkillClassVal &&
                 (nSkillClassVal =
                       D2Common::Stats::StatsEx::STATLIST_GetBaseStatValue
                                 (pStatsEx,UNITSTAT_item_addclassskills,3),
                 nStatVal == nSkillClassVal)))))) &&
           (nSkillClassVal =
                 D2Common::Stats::StatsEx::STATLIST_GetBaseStatValue
                           (pStatsEx,UNITSTAT_item_addclassskills,4), nStatVal == nSkillClassVal)) {
          nBitVal = 0;
          do {
            D2Common::Stats::StatsEx::D2AddStatToStatsListEx
                      (pStatsEx,UNITSTAT_item_addclassskills,0,nBitVal);
            nBitVal = nBitVal + 1;
          } while ((int)nBitVal < 7);
          D2Common::Stats::StatsEx::D2AddStatToStatsListEx
                    (pStatsEx,UNITSTAT_item_allskills,nStatVal,0);
        }
      }
      else {
        if ((bExtended) && (nStatListIdx == nStatVal - 1U)) {
          pItemStatCostTxt = (D2ItemStatCostTxt *)0xab;
          nParam1 = 0x40;
          goto LAB_0062d8f7;
        }
        if ((nSetBitMask & 1 << ((byte)nStatListIdx & 0x1f)) != 0) {
          pItemStatCostTxt = (D2ItemStatCostTxt *)aSetItemsStateList[nStatListIdx];
          nParam1 = 0x2040;
          goto LAB_0062d8f7;
        }
      }
      nStatListIdx = nStatListIdx + 1;
      nStatVal = nStatListCount;
    } while ((int)nStatListIdx < nStatListCount);
  }
LAB_0062e268:
  return (uint)(bError == 0) * 2 + -1;
}

