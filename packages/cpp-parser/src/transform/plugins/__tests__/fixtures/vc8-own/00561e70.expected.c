void dummy(::SGAMEDATA* pGame, D2UnitStrc* pUnit, D2UnitStrc* pItem) {
  D2ClientStrc* pClient = UNIT::SUnit::SUNIT_GetClient(pUnit, ".\\ITEMS\\ItemMode.cpp", 0xf94);
  uint32_t eItemFlags = 0;
  D2Common::ITEMS::Items::ITEM_SetServerSideFlag(&eItemFlags, 0x20, 1);
  GAME::SCmd::Send0x9CItemRemoveFromBelt(pClient, pUnit, pItem, eItemFlags);
  ITEMMODE_DeleteItemFromCorpse(pGame, pUnit, pItem);
}
