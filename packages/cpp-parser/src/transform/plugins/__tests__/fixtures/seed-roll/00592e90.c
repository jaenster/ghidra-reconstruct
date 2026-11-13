void __fastcall
D2Game::Quests::QUESTS::A1Q4::RollStonesOrder(D2QuestDataA1Q4Strc *pQuestSpecificData)

{
  D2SeedStrc *pSeed;
  int nRandomStoneSlot;
  int aStoneClassIds [5];
  D2QuestDataA1Q4Strc *pQuestSpecificDataCopy;
  int nStonesPlaced;
  char szDebugBuf [80];
  uint32_t nStackCookie;
  D2QuestDataA1Q4SubStrc *pSubData;
  D2SeedStrc sNextSeed;
  
  nStackCookie = DEFAULT_SECURITY_COOKIE ^ (uint)&stack0xfffffffc;
  pSubData = *(D2QuestDataA1Q4SubStrc **)(pQuestSpecificData->sSub).aStones;
  pSubData->aStones[0] = 0;
  pSubData->aStones[1] = 0;
  pSubData->aStones[2] = 0;
  pSubData->aStones[3] = 0;
  pSubData->aStones[4] = 0;
  pSubData->nStoneIndex = 0;
  aStoneClassIds[0] = 0x11;
  aStoneClassIds[1] = 0x12;
  aStoneClassIds[2] = 0x13;
  aStoneClassIds[3] = 0x14;
  aStoneClassIds[4] = 0x15;
  nStonesPlaced = 0;
  pQuestSpecificDataCopy = pQuestSpecificData;
  pSeed = D2Game::Quests::QUESTS::GetQuestControlSeed(pQuestSpecificData->pGame);
  do {
    sNextSeed = (D2SeedStrc)((ulonglong)pSeed->nSeedLow * 0x6ac690c5 + (ulonglong)pSeed->nSeedHigh);
    *pSeed = sNextSeed;
    nRandomStoneSlot = (int)(((ulonglong)sNextSeed & 0xffffffff) % 5);
    if (pSubData->aStones[nRandomStoneSlot] == 0) {
      compiler::sprintf(szDebugBuf,"stone %d is class %d",nRandomStoneSlot,
                        aStoneClassIds[nStonesPlaced]);
      D2Game::Quests::QUESTS::QUEST_DebugPrint
                (pQuestSpecificDataCopy->pGame,szDebugBuf,
                 "d:\\diablo2\\Diablo2\\Source\\D2Game/Quests/a1q4.cpp",0x531);
      pSubData->aStones[nRandomStoneSlot] = (int16_t)aStoneClassIds[nStonesPlaced];
      nStonesPlaced = nStonesPlaced + 1;
    }
  } while (nStonesPlaced < 5);
  compiler::__security_check_cookie();
  return;
}
