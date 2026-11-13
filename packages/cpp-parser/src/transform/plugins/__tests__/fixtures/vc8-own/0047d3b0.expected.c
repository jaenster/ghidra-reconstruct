void dummy(D2EscMenuItemStrc* pItem, D2UIMouseMsgStrc* pMsg) {
  uint32_t nAutomapMode = (uint32_t)pItem;
  Storm::Source::SReg::SRegLoadValue("Diablo II", "AutoMapMode", 0, (int32_t*)&nAutomapMode);
  if (nAutomapMode > 2) {
    nAutomapMode = 0;
  }
  Automap::AUTOMAP_SetMiniMapType(nAutomapMode);
  int nMiniMapType = Automap::AUTOMAP_GetMiniMapType();
  pItem->nImageIndex = nMiniMapType;
}
