void __fastcall SKILLDESC_DrawSkillDmgType3(D2UnitStrc * pUnit, D2SkillStrc * pSkill, D2SkillsTxt * pSkillsTxt, int32_t nSkillLevel, int32_t nXLeft, int32_t nY, int32_t nXRight) {
    uint32_t pDamCalc2;
    uint32_t nMinDamage;
    int32_t nSkillLevelTmp;
    if (!(pSkill && pSkillsTxt)) {
      return;
    }

    D2SkillDescTxt* pSkillDescTxt = D2Common::Skills::GetSkillDescription((int)pSkillsTxt->skill);
    if (!pSkillDescTxt) {
      return;
    }

    BOOL bCanDualWield = D2Common::Units::CanDualWield(pUnit);
    if (bCanDualWield) {
      nSkillLevelTmp = nSkillLevel;
      nMinDamage = D2Common::Skills::SKILLS_EvalDescCalcBytecode(pUnit, pSkillDescTxt->ddamCalc1, D2Common::Skills::GetSkillId(pSkill, ".\\UI\\SkillDesc.cpp", 0xa02), nSkillLevelTmp);
      nSkillLevelTmp = nSkillLevel;
      pDamCalc2 = D2Common::Skills::SKILLS_EvalDescCalcBytecode(pUnit, pSkillDescTxt->ddamCalc2, D2Common::Skills::GetSkillId(pSkill, ".\\UI\\SkillDesc.cpp", 0xa03), nSkillLevelTmp);
      SKILLDESC_DrawSkillDmgPhysical(pUnit, pSkill, pSkillsTxt, nSkillLevel, (pfnSkillDescWeaponDmgCalc)SKILLDESC_DrawDamageWithRange, nMinDamage, pDamCalc2, nXLeft, nY, nXRight, 1);
      return;
    }

    nMinDamage = 0;
    int nMaxDamage = 0;
    int32_t nSkillsTxt = 0x0;
    nSkillLevelTmp = nSkillLevel;
    pDamCalc2 = D2Common::Skills::SKILLS_EvalDescCalcBytecode(pUnit, pSkillDescTxt->ddamCalc1, D2Common::Skills::GetSkillId(pSkill, ".\\UI\\SkillDesc.cpp", 0xa0c), nSkillLevelTmp);
    nSkillLevelTmp = nSkillLevel;
    uint32_t uDamCalc2 = D2Common::Skills::SKILLS_EvalDescCalcBytecode(pUnit, pSkillDescTxt->ddamCalc2, D2Common::Skills::GetSkillId(pSkill, ".\\UI\\SkillDesc.cpp", 0xa0d), nSkillLevelTmp);
    SKILLDESC_DrawDamageWithRange(pUnit, (int*)&nMinDamage, &nMaxDamage, (int32_t*)&nSkillsTxt, pDamCalc2, uDamCalc2, pSkill, 0, nullptr);
    SKILLDESC_DrawDamageNumbers(nMinDamage, nMaxDamage, nSkillsTxt, nXLeft, nY, nXRight);
}