void D2Client::Source::ClientEngine::CLIENT_SendMonsterMoveToRandomNearbyPosMessage
               (uint32_t nOffsetRange,int32_t nSenderId,int32_t nSkillLvl,D2UnitStrc *pUnit)

{
  uint nOffsetY;
  uint nOffsetX;
  D2SeedStrc sSeed;
  
  nOffsetY = nOffsetRange & 0xff;
  sSeed = (D2SeedStrc)
          ((ulonglong)(pUnit->sSeed).nSeedLow * 0x6ac690c5 + (ulonglong)(pUnit->sSeed).nSeedHigh);
  pUnit->sSeed = sSeed;
  nOffsetX = nOffsetY;
  if (((ulonglong)sSeed & 1) != 0) {
    nOffsetX = -nOffsetY;
  }
  sSeed = (D2SeedStrc)(((ulonglong)sSeed & 0xffffffff) * 0x6ac690c5 + ((ulonglong)sSeed >> 0x20));
  pUnit->sSeed = sSeed;
  if (((ulonglong)sSeed & 1) != 0) {
    nOffsetY = -nOffsetY;
  }
  MonsterMessage(nSenderId,pUnit,nOffsetX,nOffsetY);
  return;
}
