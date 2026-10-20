
/* WARNING: Enum "eCollisionFlags": Some values do not have unique names */
/* WARNING: Enum "eD2TimerType": Some values do not have unique names */
/* WARNING: Enum "eD2TimerTypeDWORD": Some values do not have unique names */
/* @function AUTOMAP_RevealUnitsInRoom
   @address Game.exe.ram:00458dc0
   @date 2026.06.13
   @calling __stdcall
   @description Diablo 2 1.14d reverse team
   https://blizzhackers.dev */

void D2Client::UI::Automap::AUTOMAP_RevealUnitsInRoom
               (D2RoomStrc *pRoom,D2AutomapCellStrc *pAutomapCell)

{
  eAct eAct;
  D2ObjectsTxt *pObjectTxt;
  eD2LevelId eLevelId;
  int nAutomapCel;
  int nClassId;
  D2UnitStrc *pUnit;
  
  pUnit = pRoom->pUnitList;
  do {
    if (pUnit == (D2UnitStrc *)0x0) {
      return;
    }
    if (bAutoMapRevealAll == 0) {
      if ((pUnit->eUnitFlags >> 0x1c & 1) != 0) {
        if (pUnit == (D2UnitStrc *)0x0) goto LAB_00458e18;
        if ((pUnit->eUnitFlags >> 0x1d & 1) == 0) goto LAB_00458e0a;
      }
    }
    else {
LAB_00458e0a:
      if (pUnit != (D2UnitStrc *)0x0) {
        pUnit->eUnitFlags = pUnit->eUnitFlags | UNITFLAG_AUTOMAP2;
      }
LAB_00458e18:
      if (pUnit->eUnitType == UNIT_MONSTER) {
        if (((((pUnit != (D2UnitStrc *)0x0) && (nAutomapCel = pUnit->nClassId, -1 < nAutomapCel)) &&
             (nAutomapCel < sgptDataTable->nTxtMonStatsSize)) &&
            ((nAutomapCel = (int)sgptDataTable->pTxtMonStats[nAutomapCel].MonStatsEx,
             -1 < nAutomapCel && (nAutomapCel < sgptDataTable->nTxtMonStatsExSize)))) &&
           ((sgptDataTable->pTxtMonStatsEx + nAutomapCel != (D2MonStats2Txt *)0x0 &&
            (nAutomapCel = sgptDataTable->pTxtMonStatsEx[nAutomapCel].nAutomapCel, nAutomapCel != 0)
            ))) goto LAB_00458f1e;
      }
      else if (pUnit->eUnitType == UNIT_OBJECT) {
        if (pUnit == (D2UnitStrc *)0x0) {
          nClassId = -1;
        }
        else {
          nClassId = pUnit->nClassId;
        }
        pObjectTxt = D2Common::DATATBLS::ObjectTbls::TXT_Objects_GetLine(nClassId);
        nAutomapCel = pObjectTxt->AutoMap;
        if (nAutomapCel != 0) {
          if (nClassId == 0x10b) {
            eLevelId = D2Common::DUNGEON::Dungeon::DRLGROOM_GetLevelIdFromRoom(pRoom);
            eAct = D2Common::Drlg::Drlg::GetActNoFromLevelNumber(eLevelId);
            if ((eAct != ACT_III) && (eAct != ACT_IV)) goto LAB_00458f23;
            nAutomapCel = pObjectTxt->AutoMap;
          }
          else if (nClassId == 0x16e) {
            if ((pUnit == (D2UnitStrc *)0x0) || ((pUnit->eAnimMode).ePlayerMode != Walk))
            goto LAB_00458f23;
          }
          else if (nClassId == 0x192) {
            eLevelId = D2Common::DUNGEON::Dungeon::DRLGROOM_GetLevelIdFromRoom(pRoom);
            if (eLevelId != LEVEL_ArcaneSanctuary) goto LAB_00458f23;
            nAutomapCel = pObjectTxt->AutoMap;
          }
LAB_00458f1e:
          D2Client::UI::Automap::AUTOMAP_AddCellForUnit(nAutomapCel,pAutomapCell,pUnit);
        }
      }
    }
LAB_00458f23:
    pUnit = pUnit->pRoomNext;
  } while( true );
}

