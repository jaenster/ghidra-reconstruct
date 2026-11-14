int32_t dummy(::SGAMEDATA* pGame, D2UnitStrc* pUnit, int32_t nLevel) {
  int aActLevels[5];
  int nNpcIndex;
  int32_t nEffectiveLevel = nLevel;
  if (pGame->nDifficulty)
    return nEffectiveLevel;
  D2GameNpcStrc* pGameNpc = sunitproxy::GetGameNpcByUnit(pGame, pUnit, &nNpcIndex);
  if (!pGameNpc)
    return nEffectiveLevel;
  uint8_t nAct = pGameNpc->sTrade.nAct;
  aActLevels[0] = 12;
  aActLevels[1] = L'\x14';
  aActLevels[2] = L'\x1c';
  aActLevels[3] = 36;
  aActLevels[4] = 45;
  if (nAct < 5) {
    nEffectiveLevel = aActLevels[nAct];
    if (nEffectiveLevel >= nLevel) {
      return nLevel;
    }
  }
  return nEffectiveLevel;
}
