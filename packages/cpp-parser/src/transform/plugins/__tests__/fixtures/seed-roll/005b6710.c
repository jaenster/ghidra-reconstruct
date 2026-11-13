void __fastcall
D2Game::Quests::QUESTS::A4Q3::Q28_TimerCallback_DropForgeRunes
          (D2QuestDataStrc *pQuestData,D2UnitStrc *pUnit)

{
  D2SeedStrc *pSeed;
  uint32_t aRuneCode;
  int nRngMod;
  D2SeedStrc sSeedNext;
  
  switch(((pQuestData->pQuestSpecificData).pA4Q3)->nGemQuality) {
  case 1:
    pSeed = D2Game::Quests::QUESTS::GetQuestControlSeed(pQuestData->pGame);
    sSeedNext = (D2SeedStrc)
                ((ulonglong)pSeed->nSeedLow * 0x6ac690c5 + (ulonglong)pSeed->nSeedHigh);
    nRngMod = (int)(((ulonglong)sSeedNext & 0xffffffff) * 0x24924925 >> 0x20);
    *pSeed = sSeedNext;
    aRuneCode = Q28_aForgeRuneCodesAct3
                [((sSeedNext.nSeedLow - nRngMod >> 1) + nRngMod >> 2) * -7 +
                 sSeedNext.nSeedLow];
    break;
  case 2:
  case 3:
    pSeed = D2Game::Quests::QUESTS::GetQuestControlSeed(pQuestData->pGame);
    sSeedNext = (D2SeedStrc)
                ((ulonglong)pSeed->nSeedLow * 0x6ac690c5 + (ulonglong)pSeed->nSeedHigh);
    nRngMod = (int)(((ulonglong)sSeedNext & 0xffffffff) * 0x24924925 >> 0x20);
    *pSeed = sSeedNext;
    aRuneCode = Q28_aForgeRuneCodesAct2
                [((sSeedNext.nSeedLow - nRngMod >> 1) + nRngMod >> 2) * -7 +
                 sSeedNext.nSeedLow];
    break;
  default:
    return;
  }
  pUnit->dwDropItemCode = aRuneCode;
  return;
}
