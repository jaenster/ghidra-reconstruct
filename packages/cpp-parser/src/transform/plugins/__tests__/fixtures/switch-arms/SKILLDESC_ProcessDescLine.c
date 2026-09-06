/* WARNING: Enum "eCollisionFlags": Some values do not have unique names */
/* WARNING: Enum "eD2TimerType": Some values do not have unique names */
/* WARNING: Enum "eD2TimerTypeDWORD": Some values do not have unique names */
/* @function SKILLDESC_ProcessDescLine
   @address Game.exe.ram:004edea0
   @date 2026.09.05
   @calling __fastcall
   @description Diablo 2 1.14d reverse team
   https://blizzhackers.dev */

undefined4 __fastcall
D2Client::UI::SkillDesc::SKILLDESC_ProcessDescLine
          (D2UnitStrc *pUnit,WCHAR *pwszOutput,short *pnDescValues,eD2Skills eSkill,
          int32_t nSkillLevel,int32_t nCalcIndex,int32_t nDescLineIndex,char cCharClass)

{
  D2SkillDescTxt *pSkillDesc;
  D2MissilesTxt *pMissileTxt;
  uint nDifficulty;
  D2DifficultyLevelsTxt *pDifficultyTxt;
  uint16_t *nCalcValue;
  WCHAR *pWszLocaleB;
  int32_t nDescResult;
  short *pnCalcResult;
  WCHAR *pWszLocale;
  uint16_t wDescTextA;
  WCHAR wszLargeBuf [100];
  WCHAR wszMidBuf [256];
  WCHAR wszSmallBuf [32];
  CHAR szFormatBuf [32];
  WCHAR *pwszOutputLocal;
  D2SkillDescTxt *pSkillDescLocal;
  D2UnitStrc *pUnitLocal;
  uint32_t nCalcB;
  uint16_t *pnCalcA;
  int32_t nSigned;
  short nSubMissileId;
  uint16_t wDescTextB;
  
  if ((pnDescValues == (short *)0x0) ||
     (pwszOutputLocal = pwszOutput, pUnitLocal = pUnit,
     pSkillDesc = D2Client::DataTbls::DataTbls::GetSkillDescription(eSkill),
     pSkillDesc == (D2SkillDescTxt *)0x0)) {
    return 0;
  }
  pSkillDescLocal = pSkillDesc;
  pnCalcA = (uint16_t *)
            D2Common::Skills::Skills::SKILLS_EvalDescCalcBytecode
                      (pUnitLocal,(uint32_t)pSkillDesc->desccalca[nDescLineIndex],eSkill,nSkillLevel
                      );
  nCalcB = D2Common::Skills::Skills::SKILLS_EvalDescCalcBytecode
                     (pUnitLocal,(uint32_t)pSkillDesc->desccalcb[nDescLineIndex],eSkill,nSkillLevel)
  ;
  wDescTextA = pSkillDesc->desctexta[nDescLineIndex];
  wDescTextB = pSkillDescLocal->desctextb[nDescLineIndex];
  switch(pSkillDescLocal->descline[nDescLineIndex]) {
  case 1:
    D2Client::UI::SkillDesc::SKILLDESC_DescLine1_SkillParams
              ((int32_t)pnDescValues,pwszOutput,eSkill,nSkillLevel,(int32_t)pnCalcA,nCalcIndex);
    return 1;
  case 2:
    D2Client::UI::SkillDesc::SKILLDESC_FormatSignedRangeOrValue
              ((int32_t)pnCalcA,wDescTextA,wDescTextB,1,pwszOutput);
    return 1;
  case 3:
    D2Client::UI::SkillDesc::SKILLDESC_FormatSignedRangeOrValue
              ((int32_t)pnCalcA,wDescTextA,wDescTextB,0,pwszOutput);
    return 1;
  case 4:
    D2Client::UI::SkillDesc::SKILLDESC_FormatSignedValue((int32_t)pnCalcA,wDescTextA,1,pwszOutput);
    return 1;
  case 5:
    D2Client::UI::SkillDesc::SKILLDESC_FormatSignedValue((int32_t)pnCalcA,wDescTextA,0,pwszOutput);
    return 1;
  case 6:
    D2Client::UI::SkillDesc::SKILLDESC_FormatValuePercentage
              ((int32_t)pnCalcA,wDescTextA,1,pwszOutput);
    return 1;
  case 7:
    D2Client::UI::SkillDesc::SKILLDESC_FormatValuePercentage
              ((int32_t)pnCalcA,wDescTextA,0,pwszOutput);
    return 1;
  case 8:
    if (wDescTextA != 0x1506) {
      pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextA);
      D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    }
    if (wDescTextB != 0x1506) {
      pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextB);
      D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    }
    D2Client::UI::SkillDesc::SKILLDESC_DescLine8_AppendMana
              (eSkill,pUnitLocal,pwszOutput,nSkillLevel);
    return 1;
  case 9:
    if (wDescTextA != 0x1506) {
      pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextA);
      D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    }
    if (wDescTextB != 0x1506) {
      pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextB);
      D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    }
    D2Client::UI::SkillDesc::SKILLDESC_DescLine9_ElemDamage
              (pUnitLocal,pwszOutput,eSkill,nCalcB,nSkillLevel,(uint32_t)pnCalcA);
    return 1;
  case 10:
    if (wDescTextA != 0x1506) {
      pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextA);
      D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    }
    if (wDescTextB != 0x1506) {
      pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextB);
      D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    }
    D2Client::UI::SkillDesc::SKILLDESC_DescLineA_AppendDamageType
              (pUnitLocal,pwszOutput,(int32_t)pnDescValues,nSkillLevel,eSkill,0);
    return 1;
  case 0xb:
    if (wDescTextA != 0x1506) {
      pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextA);
      D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    }
    if (wDescTextB != 0x1506) {
      pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextB);
      D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    }
    D2Client::UI::SkillDesc::SKILLDESC_DescLineB_SignedFormat
              ((char)nSkillLevel,(char)eSkill,pUnitLocal,pwszOutput,(char)pnDescValues);
    return 1;
  case 0xc:
    if (wDescTextB != 0x1506) {
      pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextB);
      D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    }
    D2Client::UI::SkillDesc::SKILLDESC_FormatValueWithSign((int32_t)pnCalcA,wDescTextA,0,pwszOutput)
    ;
    return 1;
  case 0xd:
    D2Client::UI::SkillDesc::SKILLDESC_DescLineD_AppendDuration
              (pwszOutput,(int32_t)pnCalcA,nCalcB,(int)pnDescValues[0x5e]);
    return 1;
  case 0xe:
    if (wDescTextA != 0x1506) {
      pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextA);
      D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    }
    if (wDescTextB != 0x1506) {
      pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextB);
      D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    }
    D2Client::UI::SkillDesc::SKILLDESC_DescLineE_PerLevelBonus
              (eSkill,pUnitLocal,pwszOutput,nSkillLevel,(int32_t)pnDescValues);
    return 1;
  case 0xf:
    pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextA);
    D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(0xf9d);
    D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    wDescTextA = 0xf9b;
    goto LAB_004ee213;
  case 0x10:
    D2Client::UI::SkillDesc::SKILLDESC_FormatRangeWithStrings
              ((int32_t)pnCalcA,pwszOutput,0x10b0,nCalcB);
    return 1;
  case 0x11:
    if (wDescTextB != 0x1506) {
      pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextB);
      D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    }
    D2Client::UI::SkillDesc::SKILLDESC_FormatMinMaxRange
              ((int32_t)pnCalcA,nCalcB,pwszOutput,0,wDescTextA,0x10be);
    return 1;
  case 0x12:
    Fog::File::CONTAINER_InitializeBuffer
              (wszMidBuf,2,0x100,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
    pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextA);
    D2Lang::Unicode::UNISYS::STRING_CopyWideString(wszMidBuf,pWszLocale);
    goto LAB_004ee2b4;
  case 0x13:
    if (wDescTextB != 0x1506) {
      pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextB);
      D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    }
    D2Client::UI::SkillDesc::SKILLDESC_FormatDecimalSigned((int32_t)pnCalcA,wDescTextA,pwszOutput);
    return 1;
  case 0x14:
    nSigned = 1;
    goto LAB_004ee345;
  case 0x15:
    nSigned = 0;
LAB_004ee345:
    D2Client::UI::SkillDesc::SKILLDESC_FormatThreeValues
              ((int32_t)pnCalcA,wDescTextA,0x10b3,wDescTextB,nSigned,pwszOutput);
    return 1;
  case 0x16:
    D2Client::UI::SkillDesc::SKILLDESC_DescLine16_MissileDamage
              ((int)pSkillDescLocal->descmissile[0],pUnitLocal,nSkillLevel,(int32_t)pnDescValues,
               pwszOutput);
    return 1;
  case 0x17:
    nSubMissileId = pSkillDescLocal->descmissile[0];
    goto LAB_004ee390;
  case 0x18:
    if (wDescTextB != 0x1506) {
      pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextB);
      D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    }
    D2Client::UI::SkillDesc::SKILLDESC_DescLineA_AppendDamageType
              (pUnitLocal,pwszOutput,(int32_t)pnDescValues,nSkillLevel,eSkill,wDescTextA);
    return 1;
  case 0x19:
    Fog::File::CONTAINER_InitializeBuffer
              (wszMidBuf,2,0x100,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
    pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextA);
    D2Lang::Unicode::UNISYS::STRING_CopyWideString(wszMidBuf,pWszLocale);
    if (wDescTextB != 0x1506) {
      pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextB);
      D2Lang::Unicode::UNISYS::AppendToBuffer(wszMidBuf,pWszLocale);
    }
LAB_004ee2b4:
    if (0 < (int)pnCalcA) {
LAB_004ee2bb:
      D2Client::UI::ui::AppendAsWideChar(wszMidBuf,(char)pnCalcA);
    }
LAB_004ee2c6:
    D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,wszMidBuf);
    pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(0xf9e);
    D2Lang::Unicode::UNISYS::STRING_CopyWideString(wszMidBuf,pWszLocale);
    D2Client::UI::ui::AppendAsWideChar(wszMidBuf,cCharClass);
    D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,wszMidBuf);
    return 1;
  case 0x1a:
    if (wDescTextA != 0x1506) {
      pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextA);
      D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    }
    if (wDescTextB != 0x1506) {
      pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextB);
      D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    }
    D2Client::UI::SkillDesc::SKILLDESC_DescLine1A_SkillDamage
              (pwszOutput,(int32_t)pnDescValues,nSkillLevel,eSkill,pUnitLocal);
    return 1;
  case 0x1b:
    if (wDescTextA != 0x1506) {
      pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextA);
      D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    }
    if (wDescTextB != 0x1506) {
      pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextB);
      D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    }
    D2Client::UI::SkillDesc::SKILLDESC_DescLine1B_AppendDamage
              (pUnitLocal,nSkillLevel,eSkill,pwszOutput);
    return 1;
  case 0x1c:
    pMissileTxt = D2Client::GetMissleById((int)pSkillDescLocal->descmissile[0]);
    if (pMissileTxt != (D2MissilesTxt *)0x0) {
      D2Client::UI::SkillDesc::SKILLDESC_FormatDecimalSigned(pMissileTxt->Param1,0x10ae,pwszOutput);
      return 1;
    }
    break;
  case 0x1d:
    pMissileTxt = D2Client::GetMissleById((int)pSkillDescLocal->descmissile[0]);
    if (pMissileTxt != (D2MissilesTxt *)0x0) {
      D2Client::UI::SkillDesc::SKILLDESC_FormatValuePercentage
                ((((int)pMissileTxt->LevRange * (nSkillLevel + -1) + (int)pMissileTxt->Range) * 2) /
                 3,0x10b6,0,pwszOutput);
      return 1;
    }
    break;
  case 0x1e:
    pMissileTxt = D2Client::GetMissleById((int)pSkillDescLocal->descmissile[0]);
    if (pMissileTxt == (D2MissilesTxt *)0x0) {
      return 0;
    }
    nSubMissileId = pMissileTxt->SubMissile1;
LAB_004ee390:
    pMissileTxt = D2Client::GetMissleById((int)nSubMissileId);
    if (pMissileTxt != (D2MissilesTxt *)0x0) {
      nCalcValue = (uint16_t *)(pMissileTxt->LevRange * nSkillLevel + (int)pMissileTxt->Range);
LAB_004ee3b1:
      D2Client::UI::SkillDesc::SKILLDESC_FormatValueWithSign
                ((int32_t)nCalcValue,wDescTextA,0,pwszOutput);
      return 1;
    }
    break;
  case 0x1f:
    nDifficulty = D2Client::GAME::Game::GetDificulity();
    pDifficultyTxt = D2Common::DATATBLS::DataTbls::GetDifficultyLevels(nDifficulty & 0xff);
    nCalcValue = pnCalcA;
    if (0 < pDifficultyTxt->AiCurseDivisor) {
      nCalcValue = (uint16_t *)((int)pnCalcA / pDifficultyTxt->AiCurseDivisor);
    }
    goto LAB_004ee3b1;
  case 0x20:
    pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextA);
    D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    D2Client::UI::SkillDesc::SKILLDESC_FormatSignedRangeOrValue
              ((int32_t)pnCalcA,wDescTextB,0x10b3,1,pwszOutput);
    return 1;
  case 0x21:
    if (nSkillLevel < 2) {
      return 1;
    }
LAB_004ee213:
    pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextA);
    D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextB);
    goto LAB_004eed95;
  case 0x22:
    D2Client::UI::SkillDesc::SKILLDESC_DescLine22_SkillSynergies
              (pUnitLocal,pwszOutput,eSkill,pnDescValues,nSkillLevel);
    return 1;
  case 0x23:
    pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextA);
    D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(0xf9d);
    D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(0xf9b);
    D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    Fog::File::CONTAINER_InitializeBuffer
              (wszSmallBuf,2,0x20,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
                    /* LPCSTR param_2 for wsprintfA */
                    /* LPSTR param_1 for wsprintfA */
    wsprintfA(szFormatBuf,"%d-%d",pnCalcA,nCalcB);
    D2Lang::UTF8_ConvertToWideChar(wszSmallBuf,szFormatBuf,0x20);
    pWszLocale = wszSmallBuf;
    goto LAB_004eed95;
  case 0x24:
    D2Client::UI::SkillDesc::SKILLDESC_FormatTwoValuesSigned
              (wDescTextA,wDescTextB,0,(int32_t)pnCalcA,pwszOutput);
    return 1;
  case 0x25:
    D2Client::UI::SkillDesc::DistanceToYardsText(wDescTextA,pwszOutput,(int32_t)pnCalcA);
    return 1;
  case 0x26:
    nSigned = 0;
    goto LAB_004ee6c3;
  case 0x27:
    D2Client::UI::SkillDesc::SKILLDESC_DescLine27_SkillElemCalc
              (pUnitLocal,pwszOutput,eSkill,nSkillLevel,(int32_t)pnDescValues);
    return 1;
  case 0x28:
    if (wDescTextA == 0x1506) {
      return 0;
    }
    Fog::File::CONTAINER_InitializeBuffer
              (wszMidBuf,2,0x100,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
    pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextB);
    pWszLocaleB = D2Lang::StrTable::strtable::GetLocaleString(wDescTextA);
    goto LAB_004ee73e;
  case 0x29:
    D2Client::UI::SkillDesc::SKILLDESC_DescLine29_FormatMonster
              (pwszOutput,(int32_t)pnDescValues,(int32_t)pnCalcA,nCalcB);
    return 1;
  case 0x2a:
    D2Client::UI::SkillDesc::SKILLDESC_DescLine2A_DecimalRange
              (nCalcB,wDescTextB,1,0,wDescTextA,pwszOutput,(int32_t)pnCalcA);
    return 1;
  case 0x2b:
    D2Client::UI::SkillDesc::SKILLDESC_FormatRangeDivided
              (pwszOutput,wDescTextA,wDescTextB,nCalcB,(uint32_t)pnCalcA,10);
    return 1;
  case 0x2c:
    D2Client::UI::SkillDesc::SKILLDESC_FormatRangeDivided
              (pwszOutput,wDescTextA,wDescTextB,nCalcB,(uint32_t)pnCalcA,100);
    return 1;
  case 0x2d:
    D2Client::UI::SkillDesc::SKILLDESC_DescLine2D_SkillPassive(nSkillLevel,pwszOutput,eSkill);
    return 1;
  case 0x2e:
    if (nCalcB == 0) {
      return 0;
    }
    if (wDescTextA == 0x1506) {
      return 0;
    }
    Fog::File::CONTAINER_InitializeBuffer
              (wszMidBuf,2,0x100,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
    pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextB);
    pWszLocaleB = D2Lang::StrTable::strtable::GetLocaleString(wDescTextA);
LAB_004ee73e:
    D2Lang::Unicode::UNISYS::UNICODE_FormatWideString
              (0x100,wszMidBuf,pWszLocaleB,(uint16_t *)pWszLocale);
    if ((int)pnCalcA < 1) goto LAB_004ee2c6;
    goto LAB_004ee2bb;
  case 0x2f:
    D2Client::UI::SkillDesc::SKILLDESC_FormatDamageMinMax
              ((int32_t)pnCalcA,nCalcB,pwszOutput,0,wDescTextA,0);
    return 1;
  case 0x30:
    D2Client::UI::SkillDesc::SKILLDESC_DescLine30_DamageMinMax
              (pUnitLocal,pwszOutput,eSkill,(int32_t)pnDescValues,nSkillLevel);
    return 1;
  case 0x31:
    nSigned = D2Common::Skills::Skills::SKILL_CalcMinDamage(pUnitLocal,eSkill,nSkillLevel,1);
    nDescResult = D2Common::Skills::Skills::SKILL_CalcMaxDamage(pUnitLocal,eSkill,nSkillLevel,1);
    D2Client::UI::SkillDesc::SKILLDESC_FormatDamageMinMax
              (nSigned >> 8,nDescResult >> 8,pwszOutput,1,wDescTextA,1);
    return 1;
  case 0x32:
    D2Client::UI::SkillDesc::SKILLDESC_DescLine32_MissileDamage
              (pUnitLocal,nSkillLevel,(int)pSkillDescLocal->descmissile[0],pwszOutputLocal,
               wDescTextA);
    return 1;
  case 0x33:
    D2Client::UI::SkillDesc::SKILLDESC_FormatStringWithCalc
              (nDescLineIndex,wDescTextA,(short *)pnCalcA,pwszOutput);
    return 1;
  case 0x34:
    nSigned = 1;
LAB_004ee6c3:
    D2Client::UI::SkillDesc::SKILLDESC_FormatMinMaxRange
              ((int32_t)pnCalcA,nCalcB,pwszOutput,nSigned,wDescTextA,wDescTextB);
    return 1;
  case 0x35:
    pnCalcResult = (short *)D2Client::UI::SpellSel::SPELLSEL_FindChargedSkill1(pUnitLocal,eSkill);
    D2Client::UI::SkillDesc::SKILLDESC_DescLine35_BonusList(pnCalcResult,wDescTextA);
    return 1;
  case 0x36:
    pnCalcResult = (short *)D2Client::UI::SpellSel::SPELLSEL_FindChargedSkill2(pUnitLocal,eSkill);
    D2Client::UI::SkillDesc::SKILLDESC_DescLine35_BonusList(pnCalcResult,wDescTextA);
    return 1;
  case 0x37:
    pnCalcResult = (short *)D2Client::UI::SpellSel::SPELLSEL_FindChargedSkill3(pUnitLocal,eSkill);
    D2Client::UI::SkillDesc::SKILLDESC_DescLine35_BonusList(pnCalcResult,wDescTextA);
    return 1;
  case 0x38:
    pnCalcResult = (short *)D2Client::UI::SpellSel::SPELLSEL_FindChargedSkill4(pUnitLocal,eSkill);
    D2Client::UI::SkillDesc::SKILLDESC_DescLine35_BonusList(pnCalcResult,wDescTextA);
    return 1;
  case 0x39:
    D2Client::UI::SkillDesc::SKILLDESC_FormatValueWithSign((int32_t)pnCalcA,wDescTextA,1,pwszOutput)
    ;
    return 1;
  case 0x3a:
    D2Client::UI::SkillDesc::SKILLDESC_FormatMinMaxRangeAlt
              ((int32_t)pnCalcA,nCalcB,pwszOutput,1,wDescTextB,wDescTextA);
    return 1;
  case 0x3b:
    if (wDescTextB != 0x1506) {
      pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextB);
      D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    }
    D2Client::UI::SkillDesc::DamgeTypeToText
              ((uint)*(byte *)(pnDescValues + 0xee),wDescTextA,(int32_t)pnCalcA,nCalcB,pwszOutput);
    return 1;
  case 0x3c:
    if (nCalcB == 0) {
      nCalcB = 10;
    }
    D2Client::UI::SkillDesc::SKILLDESC_FormatDecimalWithStrings
              (wDescTextA,wDescTextB,nCalcB,(uint32_t)pnCalcA,pwszOutput,1);
    return 1;
  case 0x3d:
    if (nCalcB == 0) {
      nCalcB = 10;
    }
    D2Client::UI::SkillDesc::SKILLDESC_FormatDecimalWithStrings
              (wDescTextA,wDescTextB,nCalcB,(uint32_t)pnCalcA,pwszOutput,0);
    return 1;
  case 0x3e:
    D2Client::UI::SkillDesc::SKILLDESC_FormatMinMaxRangeAlt
              ((int32_t)pnCalcA,nCalcB,pwszOutput,0,wDescTextB,wDescTextA);
    return 1;
  case 0x3f:
    D2Client::UI::SkillDesc::SKILLDESC_DescLine3F_SignedPctRange
              ((int32_t)pnCalcA,wDescTextB,1,1,wDescTextA,pwszOutput);
    return 1;
  case 0x40:
    D2Client::UI::SkillDesc::SKILLDESC_DescLine40_DecimalLabel
              (wDescTextB,(int32_t)pnCalcA,1,wDescTextA,pwszOutputLocal,nCalcB);
    return 1;
  case 0x41:
    D2Client::UI::SkillDesc::SKILLDESC_DescLine41_AppendStrings(wDescTextA,pwszOutput,wDescTextB);
    return 1;
  case 0x42:
    D2Client::UI::SkillDesc::SKILLDESC_DescLine42_CalcByIndex
              (nDescLineIndex,wDescTextA,(short *)pnCalcA,pwszOutput);
    return 1;
  case 0x43:
    D2Client::UI::SkillDesc::SKILLDESC_DescLine3F_SignedPctRange
              ((int32_t)pnCalcA,wDescTextB,1,0,wDescTextA,pwszOutput);
    return 1;
  case 0x44:
    D2Client::UI::SkillDesc::SKILLDESC_FormatValueTwoStrings
              ((int32_t)pnCalcA,wDescTextA,wDescTextB,0,pwszOutput);
    return 1;
  case 0x45:
    D2Client::UI::SkillDesc::SKILLDESC_DescLine45_DecimalLabel
              (wDescTextB,0,0,wDescTextA,pwszOutput,(int32_t)pnCalcA);
    return 1;
  case 0x46:
    pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextA);
    D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    D2Client::UI::SkillDesc::SKILLDESC_FormatSignedValue((int32_t)pnCalcA,wDescTextB,1,pwszOutput);
    return 1;
  case 0x47:
    if (wDescTextA == 0x1506) {
      return 0;
    }
    if (wDescTextB == 0x1506) {
      return 0;
    }
    Fog::File::CONTAINER_InitializeBuffer
              (wszLargeBuf,2,100,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
    nCalcValue = pnCalcA;
    pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextB);
    D2Lang::Unicode::UNISYS::UNICODE_FormatWideString(100,wszLargeBuf,pWszLocale,nCalcValue);
    pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextA);
    D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(0xf9d);
    D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(0xf9b);
    D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    goto LAB_004eed8f;
  case 0x48:
    if (pnCalcA == (uint16_t *)0x0) {
      return 0;
    }
    if ((int)nCalcB < 1) {
      return 0;
    }
    Fog::File::CONTAINER_InitializeBuffer
              (wszSmallBuf,2,0x20,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
    D2Client::UI::SkillDesc::SKILLDESC_FormatIntValue(wszSmallBuf,1,(int32_t)pnCalcA);
    D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,wszSmallBuf);
    pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(4000);
    D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
                    /* LPCSTR param_2 for wsprintfA */
                    /* LPSTR param_1 for wsprintfA */
    wsprintfA(szFormatBuf,"%d",nCalcB);
    goto LAB_004eec5c;
  case 0x49:
    if (pnCalcA == (uint16_t *)0x0) {
      return 0;
    }
    if ((int)nCalcB < 1) {
      return 0;
    }
    Fog::File::CONTAINER_InitializeBuffer
              (wszSmallBuf,2,0x20,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
                    /* LPCSTR param_2 for wsprintfA */
                    /* LPSTR param_1 for wsprintfA */
    wsprintfA(szFormatBuf,"%d",pnCalcA);
    D2Lang::UTF8_ConvertToWideChar(wszSmallBuf,szFormatBuf,0x20);
    D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,wszSmallBuf);
    pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(4000);
    D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
                    /* LPCSTR param_2 for wsprintfA */
                    /* LPSTR param_1 for wsprintfA */
    wsprintfA(szFormatBuf,"%d",nCalcB);
LAB_004eec5c:
    D2Lang::UTF8_ConvertToWideChar(wszSmallBuf,szFormatBuf,0x20);
    D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,wszSmallBuf);
    pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(0xf9b);
    D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextA);
    goto LAB_004eed95;
  case 0x4a:
    if (wDescTextA == 0x1506) {
      return 0;
    }
    Fog::File::CONTAINER_InitializeBuffer
              (wszLargeBuf,2,100,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
    nCalcValue = pnCalcA;
    pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextA);
    D2Lang::Unicode::UNISYS::UNICODE_FormatWideString(100,wszLargeBuf,pWszLocale,nCalcValue);
    goto LAB_004eed8f;
  case 0x4b:
    if (wDescTextA == 0x1506) {
      return 0;
    }
    Fog::File::CONTAINER_InitializeBuffer
              (wszLargeBuf,2,100,D2Launch::MainMenus::STRING_ZeroOneWCHAR);
    nCalcValue = pnCalcA;
    pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(wDescTextA);
    D2Lang::Unicode::UNISYS::UNICODE_FormatWideString(100,wszLargeBuf,pWszLocale,nCalcValue);
LAB_004eed8f:
    pWszLocale = wszLargeBuf;
LAB_004eed95:
    D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    pWszLocale = D2Lang::StrTable::strtable::GetLocaleString(0xf9e);
    D2Lang::Unicode::UNISYS::AppendToBuffer(pwszOutput,pWszLocale);
    return 1;
  }
  return 0;
}

