
/* WARNING: Function: __alloca_probe replaced with injection: alloca_probe */
/* WARNING: Enum "eCollisionFlags": Some values do not have unique names */
/* WARNING: Enum "eD2TimerType": Some values do not have unique names */
/* WARNING: Enum "eD2TimerTypeDWORD": Some values do not have unique names */
/* @function GetItemName
   @address Game.exe.ram:0048c060
   @date 2026.06.12
   @calling __fastcall
   @description Diablo 2 1.14d reverse team
   https://blizzhackers.dev */

void __fastcall D2Client::UI::Inv::GetItemName(D2UnitStrc *pUnit,wchar_t *wBuffer,size_t nSize)

{
  char cVar1;
  uint16_t wStringId;
  ushort wAffixId;
  byte byEarLevel;
  D2ItemsTxt *pItemsTxt;
  int32_t nStrLen;
  eD2ItemTypes eItemType;
  BOOL bFlagCheck;
  WCHAR *pwLocaleStr;
  uint32_t nIsOfType;
  char *pcNameSrc;
  D2MonStatsTxt *pMonStatsTxt;
  D2MagicAffixTxt *pPrefixAffix;
  byte *pcNameDst;
  WCHAR *pwFormatStr;
  D2UniqueItemsTxt *pUniqueItemsTxt;
  D2SetItemsTxt *pSetItemsTxt;
  WCHAR *pwFmtStr;
  D2MagicAffixTxt *pAffixNameTail;
  byte *pbVar2;
  WCHAR *wszFormat;
  int iScratch;
  uint nCopyLen;
  wchar_t *pwOutCursor;
  char *pcCopyTmp;
  D2MagicAffixTxt *pAffixCopyPtr;
  char *pcNameSrc2;
  char *pwSuffixLocale;
  undefined2 *pwCloseParenPtr;
  undefined4 uVar3;
  WCHAR wszLargeWorkBuf [512];
  WCHAR wszPrefix [512];
  WCHAR wszBaseName [512];
  WCHAR wszSuffix [512];
  WCHAR wszScratch [512];
  WCHAR wszNameScratch [256];
  WCHAR wszPlayerName [256];
  WCHAR wszRareName;
  undefined1 wszRareNameBuf [198];
  WCHAR wszPossessive;
  WCHAR wszAffixWork [99];
  byte szUtf8Buf [512];
  char szPlayerNameCopy [20];
  char szEarLevelStr;
  char szEarLevelPad [19];
  byte *wszEarLevel [2];
  D2MagicAffixTxt *pPrefixAffix2;
  WCHAR *pwSeparator;
  WCHAR *pSuffixAffix;
  D2ItemsTxt *pItemsTxtSaved;
  D2UnitStrc *pUnitSaved;
  wchar_t *pwOutBuffer;
  int32_t nErrorLine;
  D2InventoryStrc *pInventory;
  WCHAR wChar;
  
  if (pUnit == (D2UnitStrc *)0x0) {
    return;
  }
  pwLocaleStr = wszPrefix;
  for (iScratch = 0x100; iScratch != 0; iScratch = iScratch + -1) {
    pwLocaleStr[0] = L'\0';
    pwLocaleStr[1] = L'\0';
    pwLocaleStr = pwLocaleStr + 2;
  }
  pwLocaleStr = wszSuffix;
  pUnitSaved = pUnit;
  pwOutBuffer = wBuffer;
  for (iScratch = 0x100; iScratch != 0; iScratch = iScratch + -1) {
    pwLocaleStr[0] = L'\0';
    pwLocaleStr[1] = L'\0';
    pwLocaleStr = pwLocaleStr + 2;
  }
  pwLocaleStr = wszLargeWorkBuf;
  for (iScratch = 0x100; iScratch != 0; iScratch = iScratch + -1) {
    pwLocaleStr[0] = L'\0';
    pwLocaleStr[1] = L'\0';
    pwLocaleStr = pwLocaleStr + 2;
  }
  pSuffixAffix = D2Lang::StrTable::strtable::GetLocaleString(0xf9b);
  pwSeparator = D2Lang::StrTable::strtable::GetLocaleString(0xf9e);
  wszEarLevel[0] = (byte *)0x0;
  nErrorLine = 0x48c0d2;
  pItemsTxt = D2Common::DATATBLS::ItemTbls::TXT_Items_GetLine(pUnit->nClassId);
  pItemsTxtSaved = pItemsTxt;
  if (pItemsTxt == (D2ItemsTxt *)0x0) goto LAB_0048c0e0;
  eItemType = D2Common::ITEMS::Items::ITEM_GetItemData_wType(pUnit);
  bFlagCheck = D2Common::ITEMS::Items::CheckItemFlag(pUnit,ITEMFLAG_RUNEWORD,0x735,".\\UI\\inv.cpp")
  ;
  if (bFlagCheck != 0) {
    Fog::File::CONTAINER_InitializeBuffer
              (wszNameScratch,2,0x200,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
    pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(pItemsTxt->wNameStr);
    D2Lang::Unicode::UNISYS::STRING_CopyWideString(wszNameScratch,pwLocaleStr);
    pwLocaleStr = D2Client::_SkillHelpers::INV_SkipColorCodeSuffix(wszNameScratch);
    D2Lang::Unicode::UNISYS::STRING_CopyWideString(wszPrefix,pwLocaleStr);
    D2Lang::Unicode::UNISYS::AppendToBuffer(wszPrefix,pwSeparator);
    wStringId = D2Common::ITEMS::Items::GetMagicPrefix(pUnit,0);
    pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(wStringId);
    if (pwLocaleStr == (WCHAR *)0x0) {
      pwLocaleStr = pSuffixAffix;
    }
    D2Lang::Unicode::UNISYS::STRING_CopyWideString(wszSuffix,pwLocaleStr);
    D2Lang::Unicode::UNISYS::AppendToBuffer(wszLargeWorkBuf,wszSuffix);
    D2Client::UI::ui::AppendAsWideChar(wszLargeWorkBuf,'\x04');
    pwOutCursor = pwOutBuffer;
    D2Lang::Unicode::UNISYS::AppendToBuffer(pwOutBuffer,wszPrefix);
    D2Lang::Unicode::UNISYS::AppendToBuffer(pwOutCursor,wszLargeWorkBuf);
    goto LAB_0048cafc;
  }
  bFlagCheck = D2Common::ITEMS::Items::CheckItemFlag
                         (pUnit,ITEMFLAG_IDENTIFIED,0x748,".\\UI\\inv.cpp");
  if (bFlagCheck == 0) {
    Fog::File::CONTAINER_InitializeBuffer
              (wszScratch,2,0x200,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
    pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(pItemsTxt->wNameStr);
    D2Lang::Unicode::UNISYS::STRING_CopyWideString(wszScratch,pwLocaleStr);
    pwLocaleStr = D2Client::_SkillHelpers::INV_SkipColorCodeSuffix(wszScratch);
    D2Lang::Unicode::UNISYS::STRING_CopyWideString(pwOutBuffer,pwLocaleStr);
    goto LAB_0048cafc;
  }
  iScratch = D2Common::ITEMS::Items::GetItemQuality(pUnit);
  switch(iScratch) {
  case 1:
    iScratch = D2Common::ITEMS::Items::ITEM_GetItemData_nFileIndex(pUnit);
    nErrorLine = D2Common::DATATBLS::ItemTbls::TXT_LowQualityItems_GetLine(iScratch);
    if (nErrorLine == 0) break;
    uVar3 = 0;
    pwFmtStr = D2Lang::StrTable::strtable::GetLocaleString(pItemsTxt->wNameStr);
    pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(*(uint16_t *)(nErrorLine + 0x20));
    wStringId = 0x6b0;
    goto LAB_0048c243;
  case 2:
    nIsOfType = D2Common::ITEMS::Items::ITEMS_IsA(pUnit,ITEMTYPE_Scroll);
    if ((nIsOfType != 0) ||
       (nIsOfType = D2Common::ITEMS::Items::ITEMS_IsA(pUnit,ITEMTYPE_Book), nIsOfType != 0)) {
      nCopyLen = D2Common::ITEMS::Items::GetMagicSuffix(pUnit,0);
      if ((nCopyLen & 0xffff) == 0) {
        wStringId = 0x897;
        if (eItemType != ITEMTYPE_Book) {
          wStringId = 0x898;
        }
        pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(wStringId);
        D2Lang::Unicode::UNISYS::STRING_CopyWideString(pwOutBuffer,pwLocaleStr);
      }
      else if ((nCopyLen & 0xffff) == 1) {
        wStringId = 0x899;
        if (eItemType != ITEMTYPE_Book) {
          wStringId = 0x89a;
        }
        pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(wStringId);
        D2Lang::Unicode::UNISYS::STRING_CopyWideString(pwOutBuffer,pwLocaleStr);
      }
      break;
    }
    nIsOfType = D2Common::ITEMS::Items::ITEMS_IsA(pUnit,ITEMTYPE_PlayerBodyPart);
    if (nIsOfType != 0) {
      szEarLevelStr = '\0';
      szEarLevelPad[0] = '\0';
      szEarLevelPad[1] = '\0';
      szEarLevelPad[2] = '\0';
      szEarLevelPad[3] = '\0';
      szEarLevelPad[4] = '\0';
      szEarLevelPad[5] = '\0';
      szEarLevelPad[6] = '\0';
      szEarLevelPad[7] = '\0';
      szEarLevelPad[8] = '\0';
      szEarLevelPad[9] = '\0';
      szEarLevelPad[10] = '\0';
      szEarLevelPad[0xb] = '\0';
      szEarLevelPad[0xc] = '\0';
      szEarLevelPad[0xd] = '\0';
      szEarLevelPad[0xe] = '\0';
      szEarLevelPad[0xf] = '\0';
      szEarLevelPad[0x10] = '\0';
      Fog::File::CONTAINER_InitializeBuffer
                (szUtf8Buf,2,0x100,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
      Fog::File::CONTAINER_InitializeBuffer
                (wszEarLevel,2,3,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
      byEarLevel = D2Common::ITEMS::Items::ITEM_GetItemData_nEarLevel(pUnit);
      Storm::Source::SSTR::SStrPrintf(&szEarLevelStr,3,"%d",(uint)byEarLevel);
      D2Lang::Unicode::UNISYS::STRING_CopyCharToWCharWithSetMaxSize
                ((WCHAR *)wszEarLevel,(D2CharSelStrc *)&szEarLevelStr,3);
      Fog::File::CONTAINER_InitializeBuffer
                (wszPlayerName,2,0x100,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
      pcNameSrc = D2Common::ITEMS::Items::ITEM_GetItemData_szPlayerName(pUnit);
      pwSuffixLocale = szPlayerNameCopy;
      do {
        cVar1 = *pcNameSrc;
        *pwSuffixLocale = cVar1;
        pcNameSrc = pcNameSrc + 1;
        pwSuffixLocale = pwSuffixLocale + 1;
      } while (cVar1 != '\0');
      D2Lang::Unicode::UNISYS::STRING_CopyCharToWCharWithSetMaxSize
                ((WCHAR *)szUtf8Buf,(D2CharSelStrc *)szPlayerNameCopy,0x100);
      bFlagCheck = D2Common::ITEMS::Items::CheckItemFlag
                             (pUnit,ITEMFLAG_HARDCORE,0x775,".\\UI\\inv.cpp");
      if (bFlagCheck == 0) {
        pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(0x102d);
        pwOutCursor = pwOutBuffer;
        D2Lang::Unicode::UNISYS::STRING_CopyWideString(pwOutBuffer,pwLocaleStr);
      }
      else {
        pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(0x1406);
        pwOutCursor = pwOutBuffer;
        D2Lang::Unicode::UNISYS::STRING_CopyWideString(pwOutBuffer,pwLocaleStr);
        D2Lang::Unicode::UNISYS::AppendToBuffer(pwOutCursor,pwSeparator);
        pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(0x102d);
        D2Lang::Unicode::UNISYS::AppendToBuffer(pwOutCursor,pwLocaleStr);
      }
      D2Lang::Unicode::UNISYS::AppendToBuffer(pwOutCursor,pSuffixAffix);
      D2Lang::Unicode::UNISYS::AppendToBuffer(pwOutCursor,(WCHAR *)wszEarLevel);
      D2Lang::Unicode::UNISYS::AppendToBuffer(pwOutCursor,pwSeparator);
      nCopyLen = D2Common::ITEMS::Items::ITEM_GetItemData_nFileIndex(pUnit);
      pwLocaleStr = D2Client::UI::Inv::INV_GetInventoryPageName(nCopyLen);
      D2Lang::Unicode::UNISYS::AppendToBuffer(pwOutCursor,pwLocaleStr);
      D2Lang::Unicode::UNISYS::AppendToBuffer(pwOutCursor,pwSeparator);
      wszPossessive = L'\0';
      Fog::File::CONTAINER_InitializeBuffer
                (wszAffixWork,2,99,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
      Fog::File::CONTAINER_InitializeBuffer
                (wszBaseName,2,0x200,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
      pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(pItemsTxt->wNameStr);
      D2Lang::Unicode::UNISYS::STRING_CopyWideString(wszBaseName,pwLocaleStr);
      nIsOfType = D2Lang::StrTable::strtable::MISC_GetLanguageCode();
      D2Lang::Unicode::UNISYS::UNICODE_FormatPossessiveName
                (&wszPossessive,(WCHAR *)szUtf8Buf,wszBaseName,100,nIsOfType);
      D2Lang::Unicode::UNISYS::AppendToBuffer(pwOutCursor,&wszPossessive);
      break;
    }
    nIsOfType = D2Common::ITEMS::Items::ITEMS_IsA(pUnit,ITEMTYPE_BodyPart);
    if (nIsOfType == 0) {
      pInventory = pUnit->pInventory;
      bFlagCheck = D2Common::ITEMS::Items::CheckItemFlag
                             (pUnit,ITEMFLAG_SOCKETED,0x799,".\\UI\\inv.cpp");
      if (((bFlagCheck == 0) || (pInventory == (D2InventoryStrc *)0x0)) ||
         (nErrorLine = D2Common::INVENTORY::Inventory::ITEM_ItemsInItem(pInventory), nErrorLine == 0
         )) {
        Fog::File::CONTAINER_InitializeBuffer
                  (wszBaseName,2,0x200,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
        pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(pItemsTxt->wNameStr);
        D2Lang::Unicode::UNISYS::STRING_CopyWideString(wszBaseName,pwLocaleStr);
        pwLocaleStr = D2Client::_SkillHelpers::INV_SkipColorCodeSuffix(wszBaseName);
        D2Lang::Unicode::UNISYS::STRING_CopyWideString(pwOutBuffer,pwLocaleStr);
      }
      else {
        uVar3 = 0;
        pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(pItemsTxt->wNameStr);
        pwFmtStr = D2Lang::StrTable::strtable::GetLocaleString(0x6c0);
        pwFormatStr = D2Lang::StrTable::strtable::GetLocaleString(0x6b3);
        D2Client::UI::Inv::wsprintf(pwOutBuffer,pwFormatStr,pwFmtStr,pwLocaleStr,uVar3);
      }
      break;
    }
    iScratch = D2Common::ITEMS::Items::ITEM_GetItemData_nFileIndex(pUnit);
    pMonStatsTxt = D2Client::DataTbls::MonsterTbls::TXT_MonStats_GetLine(iScratch);
    uVar3 = 0;
    pwFmtStr = D2Lang::StrTable::strtable::GetLocaleString(pItemsTxt->wNameStr);
    pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(pMonStatsTxt->NameStr);
    wStringId = 0x6b4;
    goto LAB_0048c243;
  case 3:
    uVar3 = 0;
    pwFmtStr = D2Lang::StrTable::strtable::GetLocaleString(pItemsTxt->wNameStr);
    pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(0x6bf);
    wStringId = 0x6af;
LAB_0048c243:
    pwFormatStr = D2Lang::StrTable::strtable::GetLocaleString(wStringId);
    D2Client::UI::Inv::wsprintf(pwOutBuffer,pwFormatStr,pwLocaleStr,pwFmtStr,uVar3);
    break;
  case 4:
    wAffixId = D2Common::ITEMS::Items::GetMagicPrefix(pUnit,0);
    pPrefixAffix = D2Common::DATATBLS::ItemTbls::TXT_magicaffixes_GetLine((uint)wAffixId);
    nCopyLen = D2Common::ITEMS::Items::GetMagicSuffix(pUnit,0);
    pPrefixAffix2 = D2Common::DATATBLS::ItemTbls::TXT_magicaffixes_GetLine(nCopyLen & 0xffff);
    if (pPrefixAffix == (D2MagicAffixTxt *)0x0) {
      wszPrefix[0] = L'\0';
      pcNameDst = wszEarLevel[0];
    }
    else if (pPrefixAffix->wNameStr == 0) {
      szUtf8Buf[0] = 0x28;
      szUtf8Buf[1] = 0;
      pAffixNameTail = pPrefixAffix;
      do {
        pwSuffixLocale = pAffixNameTail->name;
        pAffixNameTail = (D2MagicAffixTxt *)(pAffixNameTail->name + 1);
      } while (*pwSuffixLocale != '\0');
      pwSuffixLocale = (char *)((int)wszAffixWork + 0xc5);
      do {
        pcNameSrc = pwSuffixLocale + 1;
        pwSuffixLocale = pwSuffixLocale + 1;
      } while (*pcNameSrc != '\0');
      pAffixCopyPtr = pPrefixAffix;
      for (nCopyLen = (uint)((int)pAffixNameTail - (int)pPrefixAffix) >> 2; nCopyLen != 0;
          nCopyLen = nCopyLen - 1) {
        *(undefined4 *)pwSuffixLocale = *(undefined4 *)pAffixCopyPtr->name;
        pAffixCopyPtr = (D2MagicAffixTxt *)(pAffixCopyPtr->name + 4);
        pwSuffixLocale = pwSuffixLocale + 4;
      }
      for (nCopyLen = (int)pAffixNameTail - (int)pPrefixAffix & 3; nCopyLen != 0;
          nCopyLen = nCopyLen - 1) {
        *pwSuffixLocale = pAffixCopyPtr->name[0];
        pAffixCopyPtr = (D2MagicAffixTxt *)(pAffixCopyPtr->name + 1);
        pwSuffixLocale = pwSuffixLocale + 1;
      }
      pwCloseParenPtr = (undefined2 *)((int)wszAffixWork + 0xc5);
      do {
        pwSuffixLocale = (char *)((int)pwCloseParenPtr + 1);
        pwCloseParenPtr = (undefined2 *)((int)pwCloseParenPtr + 1);
      } while (*pwSuffixLocale != '\0');
      pcNameDst = szUtf8Buf;
      *pwCloseParenPtr = 0x29;
      do {
        byEarLevel = *pcNameDst;
        pcNameDst = pcNameDst + 1;
      } while (byEarLevel != 0);
      D2Lang::UTF8_ConvertToWideChar(wszPrefix,(char *)szUtf8Buf,0x200);
      pcNameDst = pcNameDst + -(int)(szUtf8Buf + 1);
      pUnit = pUnitSaved;
    }
    else {
      pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(pPrefixAffix->wNameStr);
      pcNameDst = (byte *)D2Lang::Unicode::UNISYS::STRING_GetWideStringLength(pwLocaleStr);
      pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(pPrefixAffix->wNameStr);
      D2Lang::Unicode::UNISYS::STRING_CopyWideString(wszPrefix,pwLocaleStr);
    }
    pPrefixAffix = pPrefixAffix2;
    if (pPrefixAffix2 == (D2MagicAffixTxt *)0x0) {
      wszSuffix[0] = L'\0';
    }
    else if (pPrefixAffix2->wNameStr == 0) {
      Fog::File::CONTAINER_InitializeBuffer
                (wszScratch,2,0x200,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
      szUtf8Buf[0] = 0x28;
      szUtf8Buf[1] = 0;
      pAffixNameTail = pPrefixAffix;
      do {
        pwSuffixLocale = pAffixNameTail->name;
        pAffixNameTail = (D2MagicAffixTxt *)(pAffixNameTail->name + 1);
      } while (*pwSuffixLocale != '\0');
      pwSuffixLocale = (char *)((int)wszAffixWork + 0xc5);
      do {
        pcNameSrc = pwSuffixLocale + 1;
        pwSuffixLocale = pwSuffixLocale + 1;
      } while (*pcNameSrc != '\0');
      pAffixCopyPtr = pPrefixAffix;
      for (nCopyLen = (uint)((int)pAffixNameTail - (int)pPrefixAffix) >> 2; nCopyLen != 0;
          nCopyLen = nCopyLen - 1) {
        *(undefined4 *)pwSuffixLocale = *(undefined4 *)pAffixCopyPtr->name;
        pAffixCopyPtr = (D2MagicAffixTxt *)(pAffixCopyPtr->name + 4);
        pwSuffixLocale = pwSuffixLocale + 4;
      }
      for (nCopyLen = (int)pAffixNameTail - (int)pPrefixAffix & 3; nCopyLen != 0;
          nCopyLen = nCopyLen - 1) {
        *pwSuffixLocale = pAffixCopyPtr->name[0];
        pAffixCopyPtr = (D2MagicAffixTxt *)(pAffixCopyPtr->name + 1);
        pwSuffixLocale = pwSuffixLocale + 1;
      }
      pwCloseParenPtr = (undefined2 *)((int)wszAffixWork + 0xc5);
      do {
        pwSuffixLocale = (char *)((int)pwCloseParenPtr + 1);
        pwCloseParenPtr = (undefined2 *)((int)pwCloseParenPtr + 1);
      } while (*pwSuffixLocale != '\0');
      pbVar2 = szUtf8Buf;
      *pwCloseParenPtr = 0x29;
      do {
        byEarLevel = *pbVar2;
        pbVar2 = pbVar2 + 1;
      } while (byEarLevel != 0);
      pcNameDst = pbVar2 + ((int)pcNameDst - (int)(szUtf8Buf + 1));
      D2Lang::UTF8_ConvertToWideChar(wszScratch,(char *)szUtf8Buf,0x200);
      D2Lang::Unicode::UNISYS::AppendToBuffer(wszSuffix,wszScratch);
      pUnit = pUnitSaved;
    }
    else {
      pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(pPrefixAffix2->wNameStr);
      nErrorLine = D2Lang::Unicode::UNISYS::STRING_GetWideStringLength(pwLocaleStr);
      pcNameDst = pcNameDst + nErrorLine;
      pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(pPrefixAffix->wNameStr);
      D2Lang::Unicode::UNISYS::AppendToBuffer(wszSuffix,pwLocaleStr);
    }
    pItemsTxt = pItemsTxtSaved;
    pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(pItemsTxtSaved->wNameStr);
    nErrorLine = D2Lang::Unicode::UNISYS::STRING_GetWideStringLength(pwLocaleStr);
    if ((int)nSize <= (int)(pcNameDst + nErrorLine + 3)) {
      nErrorLine = 0x8c5;
      goto LAB_0048c0e0;
    }
    uVar3 = 0;
    pwLocaleStr = wszSuffix;
    pwFormatStr = D2Lang::StrTable::strtable::GetLocaleString(pItemsTxt->wNameStr);
    pwFmtStr = wszPrefix;
    wszFormat = D2Lang::StrTable::strtable::GetLocaleString(0x6b2);
    D2Client::UI::Inv::wsprintf(pwOutBuffer,wszFormat,pwFmtStr,pwFormatStr,pwLocaleStr,uVar3);
    break;
  case 5:
    iScratch = D2Common::ITEMS::Items::ITEM_GetItemData_nFileIndex(pUnit);
    pSetItemsTxt = D2Client::DataTbls::DataTbls::GetSetItemsLine(iScratch);
    pItemsTxt = pItemsTxtSaved;
    if (pSetItemsTxt != (D2SetItemsTxt *)0x0) {
      Fog::File::CONTAINER_InitializeBuffer
                (wszScratch,2,0x200,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
      pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(pItemsTxtSaved->wNameStr);
      D2Lang::Unicode::UNISYS::STRING_CopyWideString(wszScratch,pwLocaleStr);
      pwLocaleStr = D2Client::_SkillHelpers::INV_SkipColorCodeSuffix(wszScratch);
      pwOutCursor = pwOutBuffer;
      D2Lang::Unicode::UNISYS::STRING_CopyWideString(pwOutBuffer,pwLocaleStr);
      D2Lang::Unicode::UNISYS::AppendToBuffer(pwOutCursor,pwSeparator);
      pItemsTxt = pItemsTxtSaved;
      if (pSetItemsTxt->stringId != 0) {
        Fog::File::CONTAINER_InitializeBuffer
                  (wszBaseName,2,0x200,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
        Fog::File::CONTAINER_InitializeBuffer
                  (wszNameScratch,2,0x200,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
        pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(pSetItemsTxt->stringId);
        D2Lang::Unicode::UNISYS::STRING_CopyWideString(wszNameScratch,pwLocaleStr);
        bFlagCheck = D2Client::UI::Inv::INV_FormatPlayerNameWithBase
                               (wszBaseName,wszNameScratch,pUnit);
        if (bFlagCheck == 0) {
          wszPossessive = L'\0';
          Fog::File::CONTAINER_InitializeBuffer
                    (wszAffixWork,2,99,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
          uVar3 = 0;
          pwLocaleStr = wszNameScratch;
          pwFmtStr = D2Lang::StrTable::strtable::GetLocaleString(0x2769);
          D2Client::UI::Inv::wsprintf(&wszPossessive,pwFmtStr,pwLocaleStr,uVar3);
          pwLocaleStr = &wszPossessive;
        }
        else {
          pwLocaleStr = wszBaseName;
        }
        D2Lang::Unicode::UNISYS::AppendToBuffer(pwOutCursor,pwLocaleStr);
        pItemsTxt = pItemsTxtSaved;
      }
    }
    break;
  case 6:
  case 8:
  case 9:
    wAffixId = D2Common::ITEMS::Items::GetRarePrefix(pUnit);
    pPrefixAffix = (D2MagicAffixTxt *)
                   D2Common::DATATBLS::ItemTbls::TXT_RareAffixes_GetLine((uint)wAffixId);
    pPrefixAffix2 = pPrefixAffix;
    wAffixId = D2Common::ITEMS::Items::GetRareSuffix(pUnit);
    pSuffixAffix = (WCHAR *)D2Common::DATATBLS::ItemTbls::TXT_RareAffixes_GetLine((uint)wAffixId);
    if (pPrefixAffix == (D2MagicAffixTxt *)0x0) {
      wszPrefix[0] = L'\0';
      pcNameDst = wszEarLevel[0];
    }
    else if (*(uint16_t *)(pPrefixAffix->name + 0xc) == 0) {
      pwSuffixLocale = (char *)((int)&pPrefixAffix->mod[0].code + 2);
      szUtf8Buf[0] = 0x28;
      szUtf8Buf[1] = 0;
      pcNameSrc = pwSuffixLocale;
      do {
        cVar1 = *pcNameSrc;
        pcNameSrc = pcNameSrc + 1;
      } while (cVar1 != '\0');
      pcNameSrc2 = (char *)((int)wszAffixWork + 0xc5);
      do {
        pcCopyTmp = pcNameSrc2 + 1;
        pcNameSrc2 = pcNameSrc2 + 1;
      } while (*pcCopyTmp != '\0');
      pcCopyTmp = pwSuffixLocale;
      for (nCopyLen = (uint)((int)pcNameSrc - (int)pwSuffixLocale) >> 2; nCopyLen != 0;
          nCopyLen = nCopyLen - 1) {
        *(undefined4 *)pcNameSrc2 = *(undefined4 *)pcCopyTmp;
        pcCopyTmp = pcCopyTmp + 4;
        pcNameSrc2 = pcNameSrc2 + 4;
      }
      for (nCopyLen = (int)pcNameSrc - (int)pwSuffixLocale & 3; nCopyLen != 0;
          nCopyLen = nCopyLen - 1) {
        *pcNameSrc2 = *pcCopyTmp;
        pcCopyTmp = pcCopyTmp + 1;
        pcNameSrc2 = pcNameSrc2 + 1;
      }
      pwCloseParenPtr = (undefined2 *)((int)wszAffixWork + 0xc5);
      do {
        pwSuffixLocale = (char *)((int)pwCloseParenPtr + 1);
        pwCloseParenPtr = (undefined2 *)((int)pwCloseParenPtr + 1);
      } while (*pwSuffixLocale != '\0');
      pcNameDst = szUtf8Buf;
      *pwCloseParenPtr = 0x29;
      do {
        byEarLevel = *pcNameDst;
        pcNameDst = pcNameDst + 1;
      } while (byEarLevel != 0);
      D2Lang::UTF8_ConvertToWideChar(wszPrefix,(char *)szUtf8Buf,0x200);
      pcNameDst = pcNameDst + -(int)(szUtf8Buf + 1);
      pUnit = pUnitSaved;
      pItemsTxt = pItemsTxtSaved;
    }
    else {
      pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString
                              (*(uint16_t *)(pPrefixAffix->name + 0xc));
      pcNameDst = (byte *)D2Lang::Unicode::UNISYS::STRING_GetWideStringLength(pwLocaleStr);
      pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString
                              (*(uint16_t *)(pPrefixAffix2->name + 0xc));
      D2Lang::Unicode::UNISYS::STRING_CopyWideString(wszPrefix,pwLocaleStr);
    }
    if (pSuffixAffix == (WCHAR *)0x0) {
      wszSuffix[0] = L'\0';
    }
    else if (pSuffixAffix[6] == L'\0') {
      Fog::File::CONTAINER_InitializeBuffer
                (wszNameScratch,2,0x200,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
      pwFmtStr = pSuffixAffix + 0x13;
      szUtf8Buf[0] = 0x28;
      szUtf8Buf[1] = 0;
      pwLocaleStr = pwFmtStr;
      do {
        wChar = *pwLocaleStr;
        pwLocaleStr = (WCHAR *)((int)pwLocaleStr + 1);
      } while ((char)wChar != '\0');
      pwSuffixLocale = (char *)((int)wszAffixWork + 0xc5);
      do {
        pcNameSrc = pwSuffixLocale + 1;
        pwSuffixLocale = pwSuffixLocale + 1;
      } while (*pcNameSrc != '\0');
      pwFormatStr = pwFmtStr;
      for (nCopyLen = (uint)((int)pwLocaleStr - (int)pwFmtStr) >> 2; nCopyLen != 0;
          nCopyLen = nCopyLen - 1) {
        *(undefined4 *)pwSuffixLocale = *(undefined4 *)pwFormatStr;
        pwFormatStr = pwFormatStr + 2;
        pwSuffixLocale = pwSuffixLocale + 4;
      }
      for (nCopyLen = (int)pwLocaleStr - (int)pwFmtStr & 3; nCopyLen != 0; nCopyLen = nCopyLen - 1)
      {
        *pwSuffixLocale = (char)*pwFormatStr;
        pwFormatStr = (WCHAR *)((int)pwFormatStr + 1);
        pwSuffixLocale = pwSuffixLocale + 1;
      }
      pwCloseParenPtr = (undefined2 *)((int)wszAffixWork + 0xc5);
      do {
        pwSuffixLocale = (char *)((int)pwCloseParenPtr + 1);
        pwCloseParenPtr = (undefined2 *)((int)pwCloseParenPtr + 1);
      } while (*pwSuffixLocale != '\0');
      *pwCloseParenPtr = 0x29;
      D2Lang::UTF8_ConvertToWideChar(wszNameScratch,(char *)szUtf8Buf,0x200);
      nErrorLine = D2Lang::Unicode::UNISYS::STRING_GetWideStringLength(wszNameScratch);
      pcNameDst = pcNameDst + nErrorLine;
      if (pPrefixAffix2 == (D2MagicAffixTxt *)0x0) {
        D2Lang::Unicode::UNISYS::STRING_CopyWideString(wszSuffix,wszNameScratch);
        pUnit = pUnitSaved;
        pItemsTxt = pItemsTxtSaved;
      }
      else {
        D2Lang::Unicode::UNISYS::AppendToBuffer(wszSuffix,wszNameScratch);
        pUnit = pUnitSaved;
        pItemsTxt = pItemsTxtSaved;
      }
    }
    else {
      pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(pSuffixAffix[6]);
      nErrorLine = D2Lang::Unicode::UNISYS::STRING_GetWideStringLength(pwLocaleStr);
      pcNameDst = pcNameDst + nErrorLine;
      if (pPrefixAffix2 == (D2MagicAffixTxt *)0x0) {
        pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(pSuffixAffix[6]);
        D2Lang::Unicode::UNISYS::STRING_CopyWideString(wszSuffix,pwLocaleStr);
      }
      else {
        pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(pSuffixAffix[6]);
        D2Lang::Unicode::UNISYS::AppendToBuffer(wszSuffix,pwLocaleStr);
      }
    }
    pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(pItemsTxt->wNameStr);
    nErrorLine = D2Lang::Unicode::UNISYS::STRING_GetWideStringLength(pwLocaleStr);
    if ((int)nSize <= (int)(pcNameDst + nErrorLine + 3)) {
      nErrorLine = 0x822;
      goto LAB_0048c0e0;
    }
    Fog::File::CONTAINER_InitializeBuffer
              (wszBaseName,2,0x200,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
    pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(pItemsTxt->wNameStr);
    D2Lang::Unicode::UNISYS::STRING_CopyWideString(wszBaseName,pwLocaleStr);
    pwLocaleStr = D2Client::_SkillHelpers::INV_SkipColorCodeSuffix(wszBaseName);
    D2Lang::Unicode::UNISYS::STRING_CopyWideString(wszLargeWorkBuf,pwLocaleStr);
    D2Lang::Unicode::UNISYS::AppendToBuffer(wszLargeWorkBuf,pwSeparator);
    wszRareName = L'\0';
    Fog::File::CONTAINER_InitializeBuffer
              (wszRareNameBuf,2,199,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
    uVar3 = 0;
    pwLocaleStr = wszSuffix;
    pwFmtStr = wszPrefix;
    pwFormatStr = D2Lang::StrTable::strtable::GetLocaleString(0x6b6);
    D2Client::UI::Inv::wsprintf(&wszRareName,pwFormatStr,pwFmtStr,pwLocaleStr,uVar3);
    Fog::File::CONTAINER_InitializeBuffer
              (wszScratch,2,0x200,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
    bFlagCheck = D2Client::UI::Inv::INV_FormatPlayerNameWithBase(wszScratch,&wszRareName,pUnit);
    pwLocaleStr = wszScratch;
    if (bFlagCheck == 0) {
      pwLocaleStr = &wszRareName;
    }
    D2Lang::Unicode::UNISYS::AppendToBuffer(wszLargeWorkBuf,pwLocaleStr);
    D2Lang::Unicode::UNISYS::AppendToBuffer(pwOutBuffer,wszLargeWorkBuf);
    pUnit = pUnitSaved;
    break;
  case 7:
    Fog::File::CONTAINER_InitializeBuffer
              (wszNameScratch,2,0x200,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
    pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(pItemsTxt->wNameStr);
    D2Lang::Unicode::UNISYS::STRING_CopyWideString(wszNameScratch,pwLocaleStr);
    iScratch = D2Common::ITEMS::Items::ITEM_GetItemData_nFileIndex(pUnit);
    if (-1 < iScratch) {
      iScratch = D2Common::ITEMS::Items::ITEM_GetItemData_nFileIndex(pUnit);
      pUniqueItemsTxt = D2Client::DataTbls::DataTbls::INV_GetUniqueItemsTxtLine(iScratch);
      if (pUniqueItemsTxt != (D2UniqueItemsTxt *)0x0) {
        if (pItemsTxt->bSkipName == '\0') {
          pwLocaleStr = D2Client::_SkillHelpers::INV_SkipColorCodeSuffix(wszNameScratch);
          D2Lang::Unicode::UNISYS::STRING_CopyWideString(pwOutBuffer,pwLocaleStr);
          D2Lang::Unicode::UNISYS::AppendToBuffer(pwOutBuffer,pwSeparator);
        }
        Fog::File::CONTAINER_InitializeBuffer
                  (wszScratch,2,0x200,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
        pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(pUniqueItemsTxt->wNameStr);
        pwLocaleStr = D2Client::_SkillHelpers::INV_SkipColorCodeSuffix(pwLocaleStr);
        bFlagCheck = D2Client::UI::Inv::INV_FormatPlayerNameWithBase(wszScratch,pwLocaleStr,pUnit);
        if (bFlagCheck == 0) {
          pwLocaleStr = D2Lang::StrTable::strtable::GetLocaleString(pUniqueItemsTxt->wNameStr);
          pwLocaleStr = D2Client::_SkillHelpers::INV_SkipColorCodeSuffix(pwLocaleStr);
          D2Lang::Unicode::UNISYS::AppendToBuffer(pwOutBuffer,pwLocaleStr);
        }
        else {
          D2Lang::Unicode::UNISYS::AppendToBuffer(pwOutBuffer,wszScratch);
        }
        break;
      }
    }
    pwLocaleStr = D2Client::_SkillHelpers::INV_SkipColorCodeSuffix(wszNameScratch);
    D2Lang::Unicode::UNISYS::STRING_CopyWideString(pwOutBuffer,pwLocaleStr);
    break;
  default:
    nErrorLine = 0x8ce;
LAB_0048c0e0:
    nStrLen = Fog::Src::ErrorManager::GetInstructionPointer();
    Fog::Src::ErrorManager::ERROR_UnrecoverableInternalError_Halt("",nStrLen,nErrorLine);
                    /* WARNING: Subroutine does not return */
    compiler::_exit(-1);
  }
LAB_0048cafc:
  pwOutCursor = pwOutBuffer;
  D2Client::UI::Inv::INV_FormatPlayerNameOnItem(pwOutBuffer,pUnit);
  D2Client::UI::ui::MoveArgumentToEAX(pwOutCursor);
  if (pItemsTxt->bQuest != false) {
    if (pItemsTxt->bQuestDiffCheck != '\0') {
      iScratch = D2Common::Stats::StatsEx::STATSEX_GetCurrentStat
                           (pUnitSaved,UNITSTAT_questitemdifficulty,0);
      byEarLevel = D2Client::GAME::Game::GetDificulity();
      if (iScratch < (int)(uint)byEarLevel) {
        D2Client::UI::ui::AppendAsWideChar(pwOutBuffer,'\x01');
        return;
      }
    }
    if (*(int *)pItemsTxt->szCode != 0x2067656c) {
      D2Client::UI::ui::AppendAsWideChar(pwOutBuffer,'\x04');
    }
  }
  return;
}

