bool __fastcall D2Client::UNIT::Object::OBJECT_ClientFn_PeriodicOperate(D2UnitStrc *pUnit)

{
  D2SeedStrc DVar1;
  
  if (pUnit->eUnitFlagsEx == 0) {
    DVar1 = (D2SeedStrc)
            ((ulonglong)(pUnit->sSeed).nSeedLow * 0x6ac690c5 + (ulonglong)(pUnit->sSeed).nSeedHigh);
    pUnit->sSeed = DVar1;
    pUnit->dwTickCount = DVar1.nSeedLow & 0x3f;
    pUnit->eUnitFlagsEx = UNITFLAGEX_HASINV;
  }
  if (((pUnit->dwTickCount & 0x3f) == 0) && ((pUnit->eAnimMode).ePlayerMode != Neutral)) {
    (pUnit->eAnimMode).ePlayerMode = Neutral;
    D2Common::Units::Units::InitAnimMode(pUnit);
  }
  pUnit->dwTickCount = pUnit->dwTickCount + 1;
  if ((pUnit->eAnimMode).ePlayerMode == Walk) {
    DVar1 = (D2SeedStrc)
            ((ulonglong)(pUnit->sSeed).nSeedLow * 0x6ac690c5 + (ulonglong)(pUnit->sSeed).nSeedHigh);
    pUnit->sSeed = DVar1;
    pUnit->dwTickCount = pUnit->dwTickCount + (DVar1.nSeedLow & 0x3f);
    (pUnit->eAnimMode).ePlayerMode = Death;
    D2Common::Units::Units::InitAnimMode(pUnit);
  }
  return true;
}
