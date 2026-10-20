
/* WARNING: Enum "eCollisionFlags": Some values do not have unique names */
/* WARNING: Enum "eD2TimerType": Some values do not have unique names */
/* WARNING: Enum "eD2TimerTypeDWORD": Some values do not have unique names */
/* @function QUEST_OnPlayerJoinGame
   @address Game.exe.ram:00546270
   @date 2026.09.11
   @calling __fastcall
   @description Server-side quest initialization run when a player joins/enters the game. On first
   call (bPickedSet==0) it picks the quest set: for fresh games (nExperienceFrame==0) handles
   reconnect carry-over of completed quests (gbQuestReconnectMode), fires each quest's join-init
   handler (state-fn index 0xD), then runs the act-quest sequence filters (Den of Evil, Radament,
   Golden Bird, Fallen Angel, Siege/Haggorath) via fpSequenceFilter. On subsequent calls fires
   handler index 0xE. Always sends the client its quest UI state: 0x5E (quest availability per
   extended quest's bIsNotIntroduction), 0x28 (PlayerQuestInfo from the difficulty's quest record),
   0x29 (quest-log prep), and 0x89 (unique events) if Den-of-Evil QuestDataBool is set. Halts via
   ERROR_UnrecoverableInternalError on bad handler pointers.
   @sourcefile .\QUESTS\QUESTS.CPP
   @sourcefile-basis Blizzard __FILE__ literal referenced from inside this function's body (2 sites:
   005465eb, 0054661d). First-party 1.14d evidence, not inferred and not from D2R. */

void __fastcall
D2Game::Quests::QUESTS::QUEST_OnPlayerJoinGame
          (D2GameStrc *pGame,D2UnitStrc *pUnit,int32_t nExperienceFrame)

{
  bool bHasA2Quest;
  D2UnitDataPlayerStrc *pPlayerData;
  BOOL bBadCodePtr;
  int32_t nAddress;
  D2ClientStrc *pClient;
  D2ClientStrc *pClient_00;
  int nExtendedIndex;
  void *pQuestInitEntry;
  D2QuestDataStrc *pQuestDataIter;
  int32_t *pQuestNoInternal;
  uint32_t nUpdateType;
  D2QuestArgStrc sQuestArgs;
  D2GSPacketClt0x89 sPacket0x89;
  undefined2 uStack_32;
  D2GSPacketSrv0x5E sPacket0x5E;
  byte byActionType;
  uint32_t nUnitGUID;
  int32_t dwErrorLine;
  eD2Quests nQuestId_00;
  D2BitBufferStrc *pBitBuffer;
  QUESTCALLBACKFN pQVar3;
  D2QuestControlStrc *pQuestControl;
  D2BitBufferStrc *pQuestRecordPool;
  
  pQuestControl = pGame->pQuestControl;
  _sPacket0x89 = pGame;
  if (pQuestControl->bPickedSet != 0) {
    for (pQuestDataIter = pQuestControl->pQuestData; pQuestDataIter != (D2QuestDataStrc *)0x0;
        pQuestDataIter = pQuestDataIter->pPrev) {
      pQVar3 = (pQuestDataIter->sStateFunctions).fpQuestStateHandler[0xe];
      if (pQVar3 != (QUESTCALLBACKFN)0x0) {
                    /* FARPROC lpfn for IsBadCodePtr */
        bBadCodePtr = IsBadCodePtr((FARPROC)pQVar3);
        if (bBadCodePtr != 0) {
          dwErrorLine = 0x666;
          goto LAB_005463e2;
        }
        sQuestArgs.nEvent = 14;
        sQuestArgs.pGame = pGame;
        sQuestArgs.pPlayer = pUnit;
        (*(pQuestDataIter->sStateFunctions).fpQuestStateHandler[0xe])(pQuestDataIter,&sQuestArgs);
      }
    }
LAB_0054652c:
    nExtendedIndex = 0;
    sPacket0x5E.nPacketId = 0x5e;
    if (0 < nQuestDataExtendedSize) {
      pQuestNoInternal =
           (int32_t *)&D2Game::Quests::QUESTS::aQuestInitDataExtended[0].nQuestNoInternal;
      do {
        if (*pQuestNoInternal < 0) {
          dwErrorLine = 0x77;
          goto LAB_005463e2;
        }
        if (pGame->pQuestControl == (D2QuestControlStrc *)0x0) {
LAB_00546572:
          dwErrorLine = 0x67c;
          goto LAB_005463e2;
        }
        pQuestDataIter = pGame->pQuestControl->pQuestData;
        while( true ) {
          if (pQuestDataIter == (D2QuestDataStrc *)0x0) goto LAB_00546572;
          if (pQuestDataIter->nQuestNoInternal == *pQuestNoInternal) break;
          pQuestDataIter = pQuestDataIter->pPrev;
        }
        sPacket0x5E.nAvailableQuest[nExtendedIndex] = pQuestDataIter->bIsNotIntroduction;
        nExtendedIndex = nExtendedIndex + 1;
        pQuestNoInternal = pQuestNoInternal + 6;
      } while (nExtendedIndex < nQuestDataExtendedSize);
    }
    pClient = D2Game::UNIT::SUnit::SUNIT_GetClient(pUnit,".\\QUESTS\\QUESTS.CPP",0x681);
    D2Game::GAME::SCmd::NET_D2GS_SERVER_Send_0x5E_QUESTPICKS(pClient,&sPacket0x5E);
    pPlayerData = D2Common::Units::Units::GetPlayerData(pUnit);
    pQuestRecordPool = pPlayerData->pQuestRecord[pGame->nDifficulty];
    byActionType = 0;
    nUnitGUID = 0;
    nUpdateType = 6;
    pClient_00 = D2Game::UNIT::SUnit::SUNIT_GetClient(pUnit,".\\QUESTS\\QUESTS.CPP",0xca7);
    D2Game::GAME::SCmd::NET_D2GS_SERVER_Send_0x28_PlayerQuestInfo
              (pClient_00,0x28,nUpdateType,nUnitGUID,pQuestRecordPool,byActionType);
    D2Game::Quests::QUESTS::NET_D2GS_SERVER_Send_0x29_GAMEQUESTRECORD_Prepare(pGame,pClient);
    if ((pGame->pQuestControl != (D2QuestControlStrc *)0x0) &&
       (pQuestDataIter = pGame->pQuestControl->pQuestData, pQuestDataIter != (D2QuestDataStrc *)0x0)
       ) {
      while (pQuestDataIter->nQuestNoInternal != QUESTINT_DenOfEvil) {
        pQuestDataIter = pQuestDataIter->pPrev;
        if (pQuestDataIter == (D2QuestDataStrc *)0x0) {
          Fog::Debug::GuardStack();
          return;
        }
      }
      bHasA2Quest = D2Game::Quests::QUESTS::A1Q2::QuestDataBool(pQuestDataIter);
      if (bHasA2Quest) {
        _sPacket0x89 = (D2GameStrc *)CONCAT22(uStack_32,0x89);
        D2Game::GAME::SCmd::NET_D2GS_SERVER_Send_0x89_QUESTEVENTTRIGGER(pClient,&sPacket0x89);
      }
    }
    Fog::Debug::GuardStack();
    return;
  }
  pPlayerData = D2Common::Units::Units::GetPlayerData(pUnit);
  pQuestRecordPool = pPlayerData->pQuestRecord[pGame->nDifficulty];
  sQuestArgs.pTarget = (D2UnitStrc *)0x0;
  sQuestArgs.pPlayer = (D2UnitStrc *)0x0;
  sQuestArgs.field4_0x10 = 0;
  sQuestArgs.sQuestArgs.sNpcActivate.pTextControl = (D2GossipTextStrc *)0x0;
  sQuestArgs.sQuestArgs.sNpcActivate.nIndex = 0;
  pQuestControl->bPickedSet = 1;
  if (nExperienceFrame == 0) {
    if ((gbQuestReconnectMode != '\0') && (nExtendedIndex = 0, 0 < nQuestDataExtendedSize)) {
      pQuestInitEntry = &D2Game::Quests::QUESTS::aQuestInitDataExtended[0].nQuestIdReal;
      do {
                    /* nAct */
        if (4 < *(byte *)((int)pQuestInitEntry + -0x10)) {
          dwErrorLine = 0x637;
          goto LAB_005463e2;
        }
                    /* offset 0x0C */
        if ((*(char *)((int)pQuestInitEntry + -8) == '\0') &&
           ((bBadCodePtr = D2Common::QuestRecord::QuestRecord::GetQuestState
                                     (pQuestRecordPool,*(eD2Quests *)pQuestInitEntry,
                                      QUESTSTATE_Completed), bBadCodePtr != 0 ||
            (bBadCodePtr = D2Common::QuestRecord::QuestRecord::GetQuestState
                                     (pQuestRecordPool,*(eD2Quests *)pQuestInitEntry,
                                      QUESTSTATE_FinishedInPreviousGame), bBadCodePtr != 0)))) {
          D2Game::Quests::QUESTS::QUEST_ResetQuestDataForReconnect
                    (*(eD2QuestsInternal *)((int)pQuestInitEntry + -4),_sPacket0x89);
          nQuestId_00 = *(eD2Quests *)pQuestInitEntry;
          pBitBuffer = pQuestControl->pQuestFlags;
          (&sQuestArgs.pTarget)[*(byte *)((int)pQuestInitEntry + -0x10)] =
               (D2UnitStrc *)
               ((int)&(&sQuestArgs.pTarget)[*(byte *)((int)pQuestInitEntry + -0x10)]->eUnitType + 1)
          ;
          D2Common::QuestRecord::QuestRecord::SetQuestState
                    (pBitBuffer,nQuestId_00,QUESTSTATE_FinishedInPreviousGame);
        }
        nExtendedIndex = nExtendedIndex + 1;
        pQuestInitEntry = (void *)((int)pQuestInitEntry + 0x18);
      } while (nExtendedIndex < nQuestDataExtendedSize);
    }
    for (pQuestDataIter = pQuestControl->pQuestData; pQuestDataIter != (D2QuestDataStrc *)0x0;
        pQuestDataIter = pQuestDataIter->pPrev) {
      pQVar3 = (pQuestDataIter->sStateFunctions).fpQuestStateHandler[0xd];
      if (pQVar3 != (QUESTCALLBACKFN)0x0) {
                    /* FARPROC lpfn for IsBadCodePtr */
        bBadCodePtr = IsBadCodePtr((FARPROC)pQVar3);
        if (bBadCodePtr != 0) {
          dwErrorLine = 0x640;
          goto LAB_005463e2;
        }
        sQuestArgs.pGame = _sPacket0x89;
        sQuestArgs.nEvent = 13;
        sQuestArgs.pPlayer = pUnit;
        (*(pQuestDataIter->sStateFunctions).fpQuestStateHandler[0xd])(pQuestDataIter,&sQuestArgs);
      }
    }
  }
  if (_sPacket0x89->pQuestControl != (D2QuestControlStrc *)0x0) {
    for (pQuestDataIter = _sPacket0x89->pQuestControl->pQuestData;
        pQuestDataIter != (D2QuestDataStrc *)0x0; pQuestDataIter = pQuestDataIter->pPrev) {
      if (pQuestDataIter->nQuestNoInternal == QUESTINT_DenOfEvil) goto LAB_005463c3;
    }
  }
  pQuestDataIter = (D2QuestDataStrc *)0x0;
LAB_005463c3:
                    /* FARPROC lpfn for IsBadCodePtr */
  bBadCodePtr = IsBadCodePtr((FARPROC)pQuestDataIter->fpSequenceFilter);
  if (bBadCodePtr == 0) {
    (*pQuestDataIter->fpSequenceFilter)(pQuestDataIter);
    pGame = _sPacket0x89;
    if (_sPacket0x89->pQuestControl != (D2QuestControlStrc *)0x0) {
      for (pQuestDataIter = _sPacket0x89->pQuestControl->pQuestData;
          pQuestDataIter != (D2QuestDataStrc *)0x0; pQuestDataIter = pQuestDataIter->pPrev) {
        if (pQuestDataIter->nQuestNoInternal == QUESTINT_RadamentsLair) goto LAB_00546435;
      }
    }
    pQuestDataIter = (D2QuestDataStrc *)0x0;
LAB_00546435:
                    /* FARPROC lpfn for IsBadCodePtr */
    bBadCodePtr = IsBadCodePtr((FARPROC)pQuestDataIter->fpSequenceFilter);
    if (bBadCodePtr == 0) {
      (*pQuestDataIter->fpSequenceFilter)(pQuestDataIter);
      if (pGame->pQuestControl != (D2QuestControlStrc *)0x0) {
        for (pQuestDataIter = pGame->pQuestControl->pQuestData;
            pQuestDataIter != (D2QuestDataStrc *)0x0; pQuestDataIter = pQuestDataIter->pPrev) {
          if (pQuestDataIter->nQuestNoInternal == QUESTINT_TheGoldenBird) goto LAB_00546478;
        }
      }
      pQuestDataIter = (D2QuestDataStrc *)0x0;
LAB_00546478:
                    /* FARPROC lpfn for IsBadCodePtr */
      bBadCodePtr = IsBadCodePtr((FARPROC)pQuestDataIter->fpSequenceFilter);
      if (bBadCodePtr == 0) {
        (*pQuestDataIter->fpSequenceFilter)(pQuestDataIter);
        if (pGame->pQuestControl != (D2QuestControlStrc *)0x0) {
          for (pQuestDataIter = pGame->pQuestControl->pQuestData;
              pQuestDataIter != (D2QuestDataStrc *)0x0; pQuestDataIter = pQuestDataIter->pPrev) {
            if (pQuestDataIter->nQuestNoInternal == QUESTINT_TheFallenAngel) goto LAB_005464c1;
          }
        }
        pQuestDataIter = (D2QuestDataStrc *)0x0;
LAB_005464c1:
                    /* FARPROC lpfn for IsBadCodePtr */
        bBadCodePtr = IsBadCodePtr((FARPROC)pQuestDataIter->fpSequenceFilter);
        if (bBadCodePtr == 0) {
          (*pQuestDataIter->fpSequenceFilter)(pQuestDataIter);
          if (pGame->pQuestControl != (D2QuestControlStrc *)0x0) {
            for (pQuestDataIter = pGame->pQuestControl->pQuestData;
                pQuestDataIter != (D2QuestDataStrc *)0x0; pQuestDataIter = pQuestDataIter->pPrev) {
              if (pQuestDataIter->nQuestNoInternal == QUESTINT_SiegeOnHaggorath) goto LAB_00546507;
            }
          }
          pQuestDataIter = (D2QuestDataStrc *)0x0;
LAB_00546507:
                    /* FARPROC lpfn for IsBadCodePtr */
          bBadCodePtr = IsBadCodePtr((FARPROC)pQuestDataIter->fpSequenceFilter);
          if (bBadCodePtr == 0) {
            (*pQuestDataIter->fpSequenceFilter)(pQuestDataIter);
            goto LAB_0054652c;
          }
          dwErrorLine = 0x65a;
        }
        else {
          dwErrorLine = 0x656;
        }
      }
      else {
        dwErrorLine = 0x653;
      }
    }
    else {
      dwErrorLine = 0x650;
    }
  }
  else {
    dwErrorLine = 0x64d;
  }
LAB_005463e2:
  nAddress = Fog::Src::ErrorManager::GetInstructionPointer();
  Fog::Src::ErrorManager::ERROR_UnrecoverableInternalError_Halt("",nAddress,dwErrorLine);
                    /* WARNING: Subroutine does not return */
  compiler::_exit(-1);
}

