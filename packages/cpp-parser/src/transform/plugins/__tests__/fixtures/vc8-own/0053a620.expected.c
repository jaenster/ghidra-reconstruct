void dummy(::SGAMEDATA* pGame, D2RoomStrc* pRoom, D2ClientStrc* pClient) {
  uintptr_t nClient;
  D2ClientStrc* pRoomEnd = pClient;
  ::SGAMEDATA* pGameSave;
  uint8_t bActNo = Clients::GetAct(pClient);
  if (pGame->pAct[bActNo]->eLevelIdFirst == LEVEL_None)
    return;
  if (!pRoom) {
    Fog::Src::ErrorManager::ERROR_UnrecoverableInternalError_Halt("", Fog::Src::ErrorManager::GetInstructionPointer(), 0x57);
    exit(-1);
  }
  D2Common::DUNGEON::Dungeon::DRLGROOM_GetAdjacentRoomsList(pRoom, (D2RoomStrc***)&pGameSave, (int*)&nClient);
  D2ClientStrc* pRoomIdx = 0;
  if (nClient <= 0)
    return;
  do {
    SendRoomUnitUpdates(pGame, *(D2RoomStrc**)(pGameSave->szGameName + (int)pRoomIdx * 4 - 0x2a), pRoomEnd);
    pRoomIdx = (D2ClientStrc*)((intptr_t)&pRoomIdx->nClientNo + 1);
  } while (pRoomIdx < (D2ClientStrc*)nClient);
}
