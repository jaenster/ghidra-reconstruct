
/* WARNING: Enum "eCollisionFlags": Some values do not have unique names */
/* WARNING: Enum "eD2TimerType": Some values do not have unique names */
/* WARNING: Enum "eD2TimerTypeDWORD": Some values do not have unique names */
/* @function ITEMS_CalcTransactionCost
   @address Game.exe.ram:0062efb0
   @date 2026.09.05
   @params
     pUnit: ECX:4 (D2UnitStrc *)
     pItem: EDX:4 (D2UnitStrc *)
     nDifficulty: Stack[0x4]:4 (int32_t)
     pQuestBitBuffer: Stack[0x8]:4 (D2BitBufferStrc *)
     nNpcId: Stack[0xc]:4 (int32_t)
     nTransactionType: Stack[0x10]:4 (int32_t)
   @description Calculate NPC transaction cost (buy/sell/repair/gamble). Applies base cost, quality
   multipliers (magic/rare/set/unique), stack multipliers, discount (if any), NPC profit margin,
   quest completion discounts, and difficulty scaling.
   @sourcefile .\ITEMS\Items.cpp
   @sourcefile-basis Blizzard __FILE__ literal referenced from inside this function's body (2 sites:
   0062f13c, 0062f871). First-party 1.14d evidence, not inferred and not from D2R. */

int32_t __fastcall
D2Common::ITEMS::Items::ITEMS_CalcTransactionCost
          (D2UnitStrc *pUnit,D2UnitStrc *pItem,int32_t nDifficulty,D2BitBufferStrc *pQuestBitBuffer,
          int32_t nNpcId,int32_t nTransactionType)

{
  byte nEarLevel;
  int16_t nItemVersion;
  ushort wMagicPrefixId;
  int iVar1;
  uint32_t uVar2;
  D2ItemsTxt *pItemsTxt;
  int32_t iVar3;
  int32_t nErrorAddress;
  eD2ItemFlag eItemFlags;
  eD2ItemQuality eItemQuality;
  uint uVar4;
  D2MagicAffixTxt *pMagicAffixTxt;
  D2MonStatsTxt *pMonStatsTxt;
  void *pBooksTxt;
  int nAffixSellDelta;
  int nAffixBuyDelta;
  int nAffixRepairDelta;
  uint wMagicSuffixId;
  D2UniqueItemsTxt *pUniqueItemsTxt;
  int iVar5;
  D2SetItemsTxt *pSetItemsTxt;
  D2NpcTxt *pNpcTxt;
  BOOL bIsStackable;
  int iVar6;
  int *pQuestMultEntry;
  int iVar7;
  int nQuestMultIter;
  int nAffixIter;
  int nReducedPrices;
  int nQuantity;
  uint32_t nMaxStack;
  int nSellPrice;
  int nQualityMod;
  int nRepairPrice;
  int nBuyPrice;
  
  if (((pUnit == (D2UnitStrc *)0x0) || (pItem == (D2UnitStrc *)0x0)) ||
     (pItem->eUnitType != UNIT_ITEM)) {
    return 0x7fffffff;
  }
  iVar1 = D2Common::Stats::StatsEx::STATSEX_GetCurrentStat(pUnit,UNITSTAT_level,0);
  if ((nTransactionType == 3) &&
     (uVar2 = D2Common::ITEMS::Items::ITEM_CanBeRepaired(pItem), uVar2 == 0)) {
    return 0;
  }
  if (((pItem->eUnitType == UNIT_ITEM) &&
      ((pItem->pUnitData).pUnitDataMissile != (D2UnitDataMissileStrc *)0x0)) &&
     ((((pItem->pUnitData).pUnitDataMissile)->eOwnerType & 0x20000) != UNIT_PLAYER)) {
    return 1;
  }
  pItemsTxt = D2Common::DATATBLS::ItemTbls::TXT_Items_GetLine(pItem->nClassId);
  nQuantity = D2Common::Stats::StatsEx::STATSEX_GetCurrentStat(pItem,UNITSTAT_quantity,0);
  if (nQuantity < 1) {
    nQuantity = 1;
  }
  nReducedPrices =
       D2Common::Stats::StatsEx::STATSEX_GetCurrentStat(pUnit,UNITSTAT_item_reducedprices,0);
  if (0x62 < nReducedPrices) {
    nReducedPrices = 99;
  }
  if (nTransactionType == 2) {
    nItemVersion = D2Common::ITEMS::Items::ITEM_GetItemData_wItemVersion(pItem);
    if (nItemVersion == 0) {
      uVar2 = D2Common::ITEMS::Items::IITEM_GetItemsTxt_dwNormCode(pItem);
      uVar2 = D2Common::DATATBLS::ItemTbls::TXT_Items_ConvertItemCodeToItemClassId(uVar2);
      pItemsTxt = D2Common::DATATBLS::ItemTbls::TXT_Items_GetLine(uVar2);
      return pItemsTxt->dwGambleCost;
    }
    iVar3 = D2Common::ITEMS::Items::ITEMS_CalculateGamblePrice(iVar1,pItem);
    if (nReducedPrices == 0) {
      return iVar3;
    }
    nErrorAddress = D2Client::Stats::D2ApplyPercent(iVar3,nReducedPrices,100);
    return iVar3 - nErrorAddress;
  }
  nRepairPrice = 0;
  nMaxStack = 1;
  eItemFlags = D2Common::ITEMS::Items::ITEM_GetItemData_eD2ItemFlag(pItem);
  if ((eItemFlags & ITEMFLAG_BODYPART) ==
      ~(ITEMFLAG_TAGGED|ITEMFLAG_DROW|ITEMFLAG_CURSED|ITEMFLAG_STAFFMODS|ITEMFLAG_MAGICAL|
        ITEMFLAG_RUNEWORD|ITEMFLAG_CRUDE|ITEMFLAG_PLAYERNAME|ITEMFLAG_SAVED|ITEMFLAG_ETHEREAL|
        ITEMFLAG_COMPACT|ITEMFLAG_100000|ITEMFLAG_SERVER|ITEMFLAG_RESTRICT|ITEMFLAG_BEGINNER|
        ITEMFLAG_BODYPART|ITEMFLAG_HARDCORE|ITEMFLAG_DISABLED|ITEMFLAG_NEW|ITEMFLAG_MONSTER|
        ITEMFLAG_SOCKETED|ITEMFLAG_SORTED|ITEMFLAG_RESTORED|ITEMFLAG_BROKEN|ITEMFLAG_TAKEN|
        ITEMFLAG_ADDED|ITEMFLAG_REMOVED|ITEMFLAG_IDENTIFIED|ITEMFLAG_IGNORE|ITEMFLAG_CURSOR|
        ITEMFLAG_BOUGHT|ITEMFLAG_RELOAD)) {
    uVar2 = D2Common::ITEMS::Items::ITEMS_IsA(pItem,ITEMTYPE_BodyPart);
    if (uVar2 == 0) {
      uVar2 = D2Common::ITEMS::Items::ITEMS_IsA(pItem,ITEMTYPE_Book);
      if (uVar2 == 0) {
        iVar3 = D2Common::ITEMS::Items::ITEM_GetTxtItemTypes_quiver(pItem);
        if (iVar3 == 0) {
          bIsStackable = D2Common::ITEMS::Items::IsStackable(pItem);
          iVar1 = pItemsTxt->dwCost;
          nSellPrice = iVar1;
          nRepairPrice = iVar1;
          nBuyPrice = iVar1;
          if (bIsStackable != 0) {
            iVar6 = D2Common::ITEMS::Items::ITEM_GetMaxStack(pItem);
            if (iVar6 < 2) {
              nMaxStack = 1;
            }
            else {
              nMaxStack = D2Common::ITEMS::Items::ITEM_GetMaxStack(pItem);
            }
          }
        }
        else {
          iVar1 = pItemsTxt->dwCost * nQuantity;
          iVar1 = (int)(iVar1 + (iVar1 >> 0x1f & 0x3ffU)) >> 10;
          nSellPrice = iVar1;
          nBuyPrice = iVar1;
          iVar6 = D2Common::ITEMS::Items::ITEM_GetMaxStack(pItem);
          iVar6 = iVar6 * pItemsTxt->dwCost;
          nRepairPrice = (int)(iVar6 + (iVar6 >> 0x1f & 0x3ffU)) >> 10;
        }
      }
      else {
        uVar4 = D2Common::ITEMS::Items::GetMagicSuffix(pItem,0);
        pBooksTxt = D2Common::DATATBLS::ItemTbls::TXT_Books_GetLine(uVar4 & 0xffff);
        if (pBooksTxt == (void *)0x0) {
          iVar3 = 0xbba;
          goto D2Common_ITEMS_Items_ITEMS_FatalError;
        }
        iVar1 = *(int *)((int)pBooksTxt + 0x14) * nQuantity + pItemsTxt->dwCost;
        nSellPrice = iVar1;
        nBuyPrice = iVar1;
      }
    }
    else {
      iVar1 = D2Common::ITEMS::Items::ITEM_GetItemData_nFileIndex(pItem);
      pMonStatsTxt = D2Client::DataTbls::MonsterTbls::TXT_MonStats_GetLine(iVar1);
      if (pMonStatsTxt == (D2MonStatsTxt *)0x0) {
        iVar1 = pItemsTxt->dwCost;
        nSellPrice = iVar1;
        nBuyPrice = iVar1;
      }
      else {
        iVar1 = pItemsTxt->dwCost +
                *(short *)((int)(pMonStatsTxt->TreasureClass + 4) + nDifficulty * 2 + 4) * 8;
        nSellPrice = iVar1;
        nBuyPrice = iVar1;
      }
    }
  }
  else {
    nEarLevel = D2Common::ITEMS::Items::ITEM_GetItemData_nEarLevel(pItem);
    iVar1 = (uint)nEarLevel * pItemsTxt->dwCost;
    nSellPrice = iVar1;
    nBuyPrice = iVar1;
  }
                    /* @function ITEMS_CalculateItemPrice
                       @address Game.exe.ram:0062f0f2
                       @date 2026.02.15
                       @calling __stdcall
                       @description Calculates NPC transaction price for items including quality,
                       magic, set, and unique modifiers */
  uVar2 = D2Common::ITEMS::Items::ITEMS_IsA(pItem,ITEMTYPE_AnyArmor);
  if (uVar2 != 0) {
    iVar3 = D2Common::Stats::StatsEx::SERVER_GetUnitStat(pItem,UNITSTAT_armorclass,0);
    if ((pItemsTxt->dwMaxAc - pItemsTxt->dwMinAc != -1) && (pItemsTxt->dwMaxAc != 0)) {
      iVar1 = (pItemsTxt->dwCost * iVar3) / pItemsTxt->dwMaxAc;
      nSellPrice = iVar1;
      nRepairPrice = iVar1;
      nBuyPrice = iVar1;
    }
  }
  bIsStackable = D2Common::ITEMS::Items::CheckItemFlag
                           (pItem,ITEMFLAG_IDENTIFIED,0xbe4,".\\ITEMS\\Items.cpp");
  iVar3 = D2Common::ITEMS::Items::ITEM_CheckItemData_ItemQualityIsMagicOrBetter(pItem);
  eItemQuality = D2Common::ITEMS::Items::GetItemQuality(pItem);
  if (iVar3 == 0) {
    D2Common::ITEMS::Items::ITEMS_CalcStaffModsPriceModifier
              (&nSellPrice,&nBuyPrice,&nRepairPrice,nMaxStack,pItem);
    iVar1 = nSellPrice;
  }
  if (bIsStackable == 0) goto LAB_0062f85e;
  iVar6 = 0;
  iVar7 = 0;
  nQualityMod = 0;
  uVar4 = D2Common::ITEMS::Items::GetAutoMagic(pItem);
  pMagicAffixTxt = D2Common::DATATBLS::ItemTbls::TXT_magicaffixes_GetLine(uVar4 & 0xffff);
  uVar4 = iVar1 >> 0x1f;
  if (pMagicAffixTxt != (D2MagicAffixTxt *)0x0) {
    if ((iVar1 < 0x10000) || (pMagicAffixTxt->multiply == 0)) {
      nQualityMod = pMagicAffixTxt->add;
      nAffixRepairDelta = pMagicAffixTxt->multiply;
      iVar7 = ((int)(nAffixRepairDelta * iVar1 + (nAffixRepairDelta * iVar1 >> 0x1f & 0x3ffU)) >> 10
              ) + nQualityMod;
      iVar6 = ((int)(nAffixRepairDelta * nBuyPrice +
                    (nAffixRepairDelta * nBuyPrice >> 0x1f & 0x3ffU)) >> 10) + nQualityMod;
      nQualityMod = ((int)(nAffixRepairDelta * nRepairPrice +
                          (nAffixRepairDelta * nRepairPrice >> 0x1f & 0x3ffU)) >> 10) + nQualityMod;
    }
    else {
      nQualityMod = pMagicAffixTxt->add;
      nAffixRepairDelta = pMagicAffixTxt->multiply;
      iVar7 = ((int)(iVar1 + (uVar4 & 0x3ff)) >> 10) * nAffixRepairDelta + nQualityMod;
      iVar6 = ((int)(nBuyPrice + (nBuyPrice >> 0x1f & 0x3ffU)) >> 10) * nAffixRepairDelta +
              nQualityMod;
      nQualityMod = ((int)(nRepairPrice + (nRepairPrice >> 0x1f & 0x3ffU)) >> 10) *
                    nAffixRepairDelta + nQualityMod;
    }
  }
  if (false) goto switchD_0062f3a0_caseD_2;
  switch(eItemQuality) {
  case QUALITY_LOW:
    iVar7 = -(iVar1 / 2);
    iVar6 = -(nBuyPrice / 2);
    nQualityMod = -(nRepairPrice / 2);
    break;
  case QUALITY_SUPERIOR:
  case QUALITY_TAMPERED:
    goto switchD_0062f3a0_caseD_3;
  case QUALITY_SET:
    nAffixRepairDelta = D2Common::ITEMS::Items::ITEM_GetItemData_nFileIndex(pItem);
    pSetItemsTxt = D2Client::DataTbls::DataTbls::GetSetItemsLine(nAffixRepairDelta);
    if (pSetItemsTxt != (D2SetItemsTxt *)0x0) {
      if ((iVar1 < 0x10000) || (pSetItemsTxt->costMult == 0)) {
        nAffixRepairDelta = pSetItemsTxt->costMult;
        iVar5 = pSetItemsTxt->costAdd;
        iVar7 = iVar7 + ((int)(nAffixRepairDelta * iVar1 +
                              (nAffixRepairDelta * iVar1 >> 0x1f & 0x3ffU)) >> 10) + iVar5;
        iVar6 = iVar6 + ((int)(nAffixRepairDelta * nBuyPrice +
                              (nAffixRepairDelta * nBuyPrice >> 0x1f & 0x3ffU)) >> 10) + iVar5;
        nQualityMod = nQualityMod +
                      ((int)(nAffixRepairDelta * nRepairPrice +
                            (nAffixRepairDelta * nRepairPrice >> 0x1f & 0x3ffU)) >> 10) + iVar5;
      }
      else {
        nAffixRepairDelta = pSetItemsTxt->costAdd;
        iVar5 = pSetItemsTxt->costMult;
        iVar7 = iVar7 + ((int)(iVar1 + (uVar4 & 0x3ff)) >> 10) * iVar5 + nAffixRepairDelta;
        iVar6 = iVar6 + ((int)(nBuyPrice + (nBuyPrice >> 0x1f & 0x3ffU)) >> 10) * iVar5 +
                        nAffixRepairDelta;
        nQualityMod = nQualityMod +
                      ((int)(nRepairPrice + (nRepairPrice >> 0x1f & 0x3ffU)) >> 10) * iVar5 +
                      nAffixRepairDelta;
      }
    }
    break;
  case QUALITY_RARE:
  case QUALITY_CRAFTED:
    nAffixIter = 0;
    do {
      wMagicPrefixId = D2Common::ITEMS::Items::GetMagicPrefix(pItem,nAffixIter);
      pMagicAffixTxt = D2Common::DATATBLS::ItemTbls::TXT_magicaffixes_GetLine((uint)wMagicPrefixId);
      if (pMagicAffixTxt != (D2MagicAffixTxt *)0x0) {
        if ((iVar1 < 0x10000) || (pMagicAffixTxt->multiply == 0)) {
          iVar5 = pMagicAffixTxt->multiply;
          nAffixRepairDelta = pMagicAffixTxt->add;
          nAffixSellDelta =
               ((int)(iVar5 * iVar1 + (iVar5 * iVar1 >> 0x1f & 0x3ffU)) >> 10) + nAffixRepairDelta;
          nAffixBuyDelta =
               ((int)(iVar5 * nBuyPrice + (iVar5 * nBuyPrice >> 0x1f & 0x3ffU)) >> 10) +
               nAffixRepairDelta;
          nAffixRepairDelta =
               ((int)(iVar5 * nRepairPrice + (iVar5 * nRepairPrice >> 0x1f & 0x3ffU)) >> 10) +
               nAffixRepairDelta;
        }
        else {
          iVar5 = pMagicAffixTxt->multiply;
          nAffixRepairDelta = pMagicAffixTxt->add;
          nAffixSellDelta = ((int)(iVar1 + (uVar4 & 0x3ff)) >> 10) * iVar5 + nAffixRepairDelta;
          nAffixBuyDelta =
               ((int)(nBuyPrice + (nBuyPrice >> 0x1f & 0x3ffU)) >> 10) * iVar5 + nAffixRepairDelta;
          nAffixRepairDelta =
               ((int)(nRepairPrice + (nRepairPrice >> 0x1f & 0x3ffU)) >> 10) * iVar5 +
               nAffixRepairDelta;
        }
        iVar7 = iVar7 + nAffixSellDelta;
        iVar6 = iVar6 + nAffixBuyDelta;
        nQualityMod = nQualityMod + nAffixRepairDelta;
      }
      wMagicSuffixId = D2Common::ITEMS::Items::GetMagicSuffix(pItem,nAffixIter);
      pMagicAffixTxt =
           D2Common::DATATBLS::ItemTbls::TXT_magicaffixes_GetLine(wMagicSuffixId & 0xffff);
      if (pMagicAffixTxt != (D2MagicAffixTxt *)0x0) {
        if ((iVar1 < 0x10000) || (pMagicAffixTxt->multiply == 0)) {
          iVar5 = pMagicAffixTxt->multiply;
          nAffixRepairDelta = pMagicAffixTxt->add;
          nAffixBuyDelta =
               ((int)(iVar5 * iVar1 + (iVar5 * iVar1 >> 0x1f & 0x3ffU)) >> 10) + nAffixRepairDelta;
          nAffixSellDelta =
               ((int)(iVar5 * nBuyPrice + (iVar5 * nBuyPrice >> 0x1f & 0x3ffU)) >> 10) +
               nAffixRepairDelta;
          nAffixRepairDelta =
               ((int)(iVar5 * nRepairPrice + (iVar5 * nRepairPrice >> 0x1f & 0x3ffU)) >> 10) +
               nAffixRepairDelta;
        }
        else {
          iVar5 = pMagicAffixTxt->multiply;
          nAffixRepairDelta = pMagicAffixTxt->add;
          nAffixBuyDelta = ((int)(iVar1 + (uVar4 & 0x3ff)) >> 10) * iVar5 + nAffixRepairDelta;
          nAffixSellDelta =
               ((int)(nBuyPrice + (nBuyPrice >> 0x1f & 0x3ffU)) >> 10) * iVar5 + nAffixRepairDelta;
          nAffixRepairDelta =
               ((int)(nRepairPrice + (nRepairPrice >> 0x1f & 0x3ffU)) >> 10) * iVar5 +
               nAffixRepairDelta;
        }
        iVar7 = iVar7 + nAffixBuyDelta;
        iVar6 = iVar6 + nAffixSellDelta;
        nQualityMod = nQualityMod + nAffixRepairDelta;
      }
      nAffixIter = nAffixIter + 1;
    } while (nAffixIter < 3);
    goto LAB_0062f814;
  case QUALITY_UNIQUE:
    nAffixRepairDelta = D2Common::ITEMS::Items::ITEM_GetItemData_nFileIndex(pItem);
    if (-1 < nAffixRepairDelta) {
      nAffixRepairDelta = D2Common::ITEMS::Items::ITEM_GetItemData_nFileIndex(pItem);
      pUniqueItemsTxt = D2Client::DataTbls::DataTbls::INV_GetUniqueItemsTxtLine(nAffixRepairDelta);
      if (pUniqueItemsTxt != (D2UniqueItemsTxt *)0x0) {
        if ((iVar1 < 0x10000) || (pUniqueItemsTxt->costMult == 0)) {
          nAffixRepairDelta = pUniqueItemsTxt->costMult;
          iVar5 = pUniqueItemsTxt->costAdd;
          iVar7 = iVar7 + ((int)(nAffixRepairDelta * iVar1 +
                                (nAffixRepairDelta * iVar1 >> 0x1f & 0x3ffU)) >> 10) + iVar5;
          iVar6 = iVar6 + ((int)(nAffixRepairDelta * nBuyPrice +
                                (nAffixRepairDelta * nBuyPrice >> 0x1f & 0x3ffU)) >> 10) + iVar5;
          nQualityMod = nQualityMod +
                        ((int)(nAffixRepairDelta * nRepairPrice +
                              (nAffixRepairDelta * nRepairPrice >> 0x1f & 0x3ffU)) >> 10) + iVar5;
        }
        else {
          nAffixRepairDelta = pUniqueItemsTxt->costAdd;
          iVar5 = pUniqueItemsTxt->costMult;
          iVar7 = iVar7 + ((int)(iVar1 + (uVar4 & 0x3ff)) >> 10) * iVar5 + nAffixRepairDelta;
          iVar6 = iVar6 + ((int)(nBuyPrice + (nBuyPrice >> 0x1f & 0x3ffU)) >> 10) * iVar5 +
                          nAffixRepairDelta;
          nQualityMod = nQualityMod +
                        ((int)(nRepairPrice + (nRepairPrice >> 0x1f & 0x3ffU)) >> 10) * iVar5 +
                        nAffixRepairDelta;
        }
        break;
      }
    }
  case QUALITY_MAGIC:
    wMagicPrefixId = D2Common::ITEMS::Items::GetMagicPrefix(pItem,0);
    pMagicAffixTxt = D2Common::DATATBLS::ItemTbls::TXT_magicaffixes_GetLine((uint)wMagicPrefixId);
    if (pMagicAffixTxt != (D2MagicAffixTxt *)0x0) {
      if ((iVar1 < 0x10000) || (pMagicAffixTxt->multiply == 0)) {
        iVar5 = pMagicAffixTxt->multiply;
        nAffixRepairDelta = pMagicAffixTxt->add;
        nAffixSellDelta =
             ((int)(iVar5 * iVar1 + (iVar5 * iVar1 >> 0x1f & 0x3ffU)) >> 10) + nAffixRepairDelta;
        nAffixBuyDelta =
             ((int)(iVar5 * nBuyPrice + (iVar5 * nBuyPrice >> 0x1f & 0x3ffU)) >> 10) +
             nAffixRepairDelta;
        nAffixRepairDelta =
             ((int)(iVar5 * nRepairPrice + (iVar5 * nRepairPrice >> 0x1f & 0x3ffU)) >> 10) +
             nAffixRepairDelta;
      }
      else {
        iVar5 = pMagicAffixTxt->multiply;
        nAffixRepairDelta = pMagicAffixTxt->add;
        nAffixSellDelta = ((int)(iVar1 + (uVar4 & 0x3ff)) >> 10) * iVar5 + nAffixRepairDelta;
        nAffixBuyDelta =
             ((int)(nBuyPrice + (nBuyPrice >> 0x1f & 0x3ffU)) >> 10) * iVar5 + nAffixRepairDelta;
        nAffixRepairDelta =
             ((int)(nRepairPrice + (nRepairPrice >> 0x1f & 0x3ffU)) >> 10) * iVar5 +
             nAffixRepairDelta;
      }
      iVar7 = iVar7 + nAffixSellDelta;
      iVar6 = iVar6 + nAffixBuyDelta;
      nQualityMod = nQualityMod + nAffixRepairDelta;
    }
    wMagicSuffixId = D2Common::ITEMS::Items::GetMagicSuffix(pItem,0);
    pMagicAffixTxt = D2Common::DATATBLS::ItemTbls::TXT_magicaffixes_GetLine(wMagicSuffixId & 0xffff)
    ;
    if (pMagicAffixTxt != (D2MagicAffixTxt *)0x0) {
      if ((iVar1 < 0x10000) || (pMagicAffixTxt->multiply == 0)) {
        iVar5 = pMagicAffixTxt->multiply;
        nAffixRepairDelta = pMagicAffixTxt->add;
        nAffixBuyDelta =
             ((int)(iVar5 * iVar1 + (iVar5 * iVar1 >> 0x1f & 0x3ffU)) >> 10) + nAffixRepairDelta;
        iVar1 = ((int)(iVar5 * nBuyPrice + (iVar5 * nBuyPrice >> 0x1f & 0x3ffU)) >> 10) +
                nAffixRepairDelta;
        iVar5 = (int)(iVar5 * nRepairPrice + (iVar5 * nRepairPrice >> 0x1f & 0x3ffU)) >> 10;
      }
      else {
        nAffixRepairDelta = pMagicAffixTxt->add;
        iVar5 = pMagicAffixTxt->multiply;
        nAffixBuyDelta = ((int)(iVar1 + (uVar4 & 0x3ff)) >> 10) * iVar5 + nAffixRepairDelta;
        iVar1 = ((int)(nBuyPrice + (nBuyPrice >> 0x1f & 0x3ffU)) >> 10) * iVar5 + nAffixRepairDelta;
        iVar5 = ((int)(nRepairPrice + (nRepairPrice >> 0x1f & 0x3ffU)) >> 10) * iVar5;
      }
      iVar7 = iVar7 + nAffixBuyDelta;
      iVar6 = iVar6 + iVar1;
      nQualityMod = nQualityMod + iVar5 + nAffixRepairDelta;
    }
    goto switchD_0062f3a0_caseD_3;
  }
switchD_0062f3a0_caseD_2:
  nSellPrice = iVar1 + iVar7 / (int)nMaxStack;
  nBuyPrice = nBuyPrice + iVar6 / (int)nMaxStack;
  nRepairPrice = nRepairPrice + nQualityMod / (int)nMaxStack;
  if (iVar3 != 0) {
    D2Common::ITEMS::Items::ITEMS_CalcStaffModsPriceModifier
              (&nSellPrice,&nBuyPrice,&nRepairPrice,nMaxStack,pItem);
  }
LAB_0062f85e:
  D2Common::ITEMS::Items::ITEMS_AddInventoryValueToTotal(&nSellPrice,&nBuyPrice,&nRepairPrice,pItem)
  ;
  bIsStackable = D2Common::ITEMS::Items::CheckItemFlag
                           (pItem,ITEMFLAG_ETHEREAL,0xca3,".\\ITEMS\\Items.cpp");
  if (bIsStackable != 0) {
    nBuyPrice = (int)(nBuyPrice + (nBuyPrice >> 0x1f & 3U)) >> 2;
  }
  iVar1 = nBuyPrice;
  iVar3 = D2Common::ITEMS::Items::TXT_ItemTypes_CheckClass(pItem);
  if (iVar3 != 0) {
    iVar1 = (int)(iVar1 + (iVar1 >> 0x1f & 3U)) >> 2;
    nBuyPrice = iVar1;
  }
  if (nTransactionType == 1) {
    uVar2 = D2Common::ITEMS::Items::ITEM_GetItemData_eD2ItemFlag_IsEthereal(pItem);
    if ((uVar2 != 0) &&
       (uVar2 = D2Common::ITEMS::Items::ITEM_CheckIfItemHasDurability(pItem), uVar2 != 0)) {
      iVar3 = D2Common::Stats::StatsEx::GetTxtMaxDurability(pItem);
      iVar6 = D2Common::Stats::StatsEx::STATSEX_GetCurrentStat(pItem,UNITSTAT_durability,0);
      if ((iVar3 != 0) && (iVar6 < 1)) {
        iVar1 = 0;
      }
    }
  }
  else if ((((nTransactionType == 3) &&
            (iVar3 = D2Common::ITEMS::Items::ITEM_GetTxtItemTypes_quiver(pItem), iVar3 == 0)) &&
           (iVar3 = D2Common::ITEMS::Items::ITEM_GetTxtItemTypes_throwable(pItem), iVar3 == 0)) &&
          (uVar2 = D2Common::ITEMS::Items::ITEM_CheckIfItemHasDurability(pItem), uVar2 != 0)) {
    iVar6 = D2Common::Stats::StatsEx::STATSEX_GetCurrentStat(pItem,UNITSTAT_durability,0);
    iVar3 = D2Common::Stats::StatsEx::GetTxtMaxDurability(pItem);
    if ((iVar3 == 0) || (iVar3 <= iVar6)) {
      nRepairPrice = 0;
      iVar1 = nBuyPrice;
    }
    else {
      iVar7 = D2Common::Stats::StatsEx::STATSEX_GetCurrentStat
                        (pItem,UNITSTAT_item_replenish_durability,0);
      iVar1 = nBuyPrice;
      if (iVar7 == 0) {
        nRepairPrice = ((iVar3 - iVar6) * nRepairPrice) / iVar3;
      }
      else if (iVar6 < iVar3 + -1) {
        nRepairPrice = ((iVar3 + -1) * nRepairPrice) / iVar3;
      }
      else {
        nRepairPrice = 0;
      }
    }
  }
  pNpcTxt = D2Common::DATATBLS::MonsterTbls::TXT_npc_GetLine(nNpcId);
  if (pNpcTxt != (D2NpcTxt *)0x0) {
    if ((nSellPrice < 0x10000) || (iVar6 = pNpcTxt->sellMult, iVar6 == 0)) {
      iVar6 = pNpcTxt->sellMult;
      nSellPrice = (int)(iVar6 * nSellPrice + (iVar6 * nSellPrice >> 0x1f & 0x3ffU)) >> 10;
    }
    else {
      nSellPrice = ((int)(nSellPrice + (nSellPrice >> 0x1f & 0x3ffU)) >> 10) * iVar6;
    }
    if ((iVar1 < 0x10000) || (iVar6 == 0)) {
      iVar1 = pNpcTxt->buyMult * iVar1;
      nBuyPrice = (int)(iVar1 + (iVar1 >> 0x1f & 0x3ffU)) >> 10;
    }
    else {
      nBuyPrice = ((int)(iVar1 + (iVar1 >> 0x1f & 0x3ffU)) >> 10) * pNpcTxt->buyMult;
    }
    if ((nRepairPrice < 0x10000) || (pNpcTxt->repMult == 0)) {
      iVar1 = pNpcTxt->repMult * nRepairPrice;
      iVar1 = (int)(iVar1 + (iVar1 >> 0x1f & 0x3ffU)) >> 10;
    }
    else {
      iVar1 = ((int)(nRepairPrice + (nRepairPrice >> 0x1f & 0x3ffU)) >> 10) * pNpcTxt->repMult;
    }
    pQuestMultEntry = &pNpcTxt->questsellmultA;
    nQuestMultIter = 3;
    do {
      if ((pQuestMultEntry[-3] != QUEST_SpokeToWarriv) &&
         ((bIsStackable = D2Common::QuestRecord::QuestRecord::GetQuestState
                                    (pQuestBitBuffer,pQuestMultEntry[-3],QUESTSTATE_Completed),
          bIsStackable == 1 ||
          (bIsStackable = D2Common::QuestRecord::QuestRecord::GetQuestState
                                    (pQuestBitBuffer,pQuestMultEntry[-3],QUESTSTATE_RewardAwaits),
          bIsStackable == 1)))) {
        if ((nSellPrice < 0x10000) || (*pQuestMultEntry == 0)) {
          nSellPrice = (int)(*pQuestMultEntry * nSellPrice +
                            (*pQuestMultEntry * nSellPrice >> 0x1f & 0x3ffU)) >> 10;
        }
        else {
          nSellPrice = ((int)(nSellPrice + (nSellPrice >> 0x1f & 0x3ffU)) >> 10) * *pQuestMultEntry;
        }
        if ((nBuyPrice < 0x10000) || (pQuestMultEntry[3] == 0)) {
          nBuyPrice = (int)(pQuestMultEntry[3] * nBuyPrice +
                           (pQuestMultEntry[3] * nBuyPrice >> 0x1f & 0x3ffU)) >> 10;
        }
        else {
          nBuyPrice = ((int)(nBuyPrice + (nBuyPrice >> 0x1f & 0x3ffU)) >> 10) * pQuestMultEntry[3];
        }
        if ((iVar1 < 0x10000) || (pQuestMultEntry[6] == 0)) {
          iVar1 = (int)(pQuestMultEntry[6] * iVar1 + (pQuestMultEntry[6] * iVar1 >> 0x1f & 0x3ffU))
                  >> 10;
        }
        else {
          iVar1 = ((int)(iVar1 + (iVar1 >> 0x1f & 0x3ffU)) >> 10) * pQuestMultEntry[6];
        }
      }
      pQuestMultEntry = pQuestMultEntry + 1;
      nQuestMultIter = nQuestMultIter + -1;
    } while (nQuestMultIter != 0);
    uVar2 = D2Common::ITEMS::Items::ITEMS_IsA(pItem,ITEMTYPE_Book);
    if ((uVar2 == 0) &&
       (iVar3 = D2Common::ITEMS::Items::ITEM_GetTxtItemTypes_quiver(pItem), iVar3 == 0)) {
      nSellPrice = nSellPrice * nQuantity;
      bIsStackable = D2Common::ITEMS::Items::IsStackable(pItem);
      if ((bIsStackable == 0) ||
         (uVar2 = D2Common::ITEMS::Items::ITEM_CanBeRepaired(pItem), uVar2 == 0)) {
        nBuyPrice = nBuyPrice * nQuantity;
      }
      else {
        iVar6 = D2Common::ITEMS::Items::ITEM_GetMaxStack(pItem);
        if ((nQuantity < iVar6) &&
           (iVar7 = D2Common::Stats::StatsEx::STATSEX_GetCurrentStat
                              (pItem,UNITSTAT_item_replenish_quantity,0), iVar7 == 0)) {
          iVar1 = iVar1 * (iVar6 - nQuantity);
          nBuyPrice = iVar6 * nBuyPrice - iVar1;
        }
        else {
          nBuyPrice = iVar6 * nBuyPrice;
          iVar1 = 0;
        }
      }
    }
    if ((nTransactionType == 3) &&
       (uVar2 = D2Common::ITEMS::Items::ITEM_GetItemData_eD2ItemFlag_IsEthereal(pItem), uVar2 == 0))
    {
      iVar3 = D2Common::ITEMS::Items::ITEMS_CalcChargedSkillPriceModifier(pItem,10000);
      iVar1 = iVar1 + iVar3;
    }
    iVar6 = nSellPrice;
    iVar7 = nBuyPrice;
    if (pNpcTxt->maxBuy[nDifficulty] < nBuyPrice) {
      iVar7 = pNpcTxt->maxBuy[nDifficulty];
    }
    if (nTransactionType == 1) {
      nSellPrice = 1;
      if (0 < iVar7) {
        return iVar7;
      }
    }
    else if (nTransactionType == 3) {
      if (nReducedPrices != 0) {
        iVar3 = D2Client::Stats::D2ApplyPercent(iVar1,nReducedPrices,100);
        iVar1 = iVar1 - iVar3;
      }
      nSellPrice = 1;
      if (0 < iVar1) {
        return iVar1;
      }
    }
    else {
      if (nReducedPrices != 0) {
        iVar3 = D2Client::Stats::D2ApplyPercent(nSellPrice,nReducedPrices,100);
        nSellPrice = iVar6 - iVar3;
      }
      if (nSellPrice < 1) {
        return 1;
      }
    }
    return nSellPrice;
  }
  iVar3 = 3292;
D2Common_ITEMS_Items_ITEMS_FatalError:
                    /* @function ITEMS_FatalError
                       @address Game.exe.ram:0062f288
                       @date 2026.06.12
                       @calling __stdcall
                       @description Diablo 2 1.14d reverse team
                       https://blizzhackers.dev */
  nErrorAddress = Fog::Src::ErrorManager::GetInstructionPointer();
  Fog::Src::ErrorManager::ERROR_UnrecoverableInternalError_Halt("",nErrorAddress,iVar3);
                    /* @function CRASH_EndProcessFinally
                       @address Game.exe.ram:0062f298
                       @date 2026.06.10
                       @calling __stdcall
                       @description Diablo 2 1.14d reverse team
                       https://blizzhackers.dev */
                    /* WARNING: Subroutine does not return */
  compiler::_exit(-1);
switchD_0062f3a0_caseD_3:
LAB_0062f814:
  D2Common::ITEMS::Items::ITEM_CalcRepairCosts(pItem,&nSellPrice,&nBuyPrice,&nRepairPrice,nMaxStack)
  ;
  iVar1 = nSellPrice;
  goto switchD_0062f3a0_caseD_2;
}

