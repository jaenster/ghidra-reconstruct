uint32_t D2Common::PATH::DynamicPath::PATH_CalculatePath
                   (D2DynamicPathStrc *pDynamicPath,D2UnitStrc *pUnit,int32_t bIgnoreAreaCheck)

{
  D2DynamicPathStrc *pDynamicPath_00;
  bool bBadCodePtr;
  void *nErrorAddr;
  uint32_t nPathPoints;
  int32_t iVar1;
  int nDeltaX;
  uint32_t nResult;
  int32_t nCalcPathPoints;
  int32_t bCanPath;
  BOOL BVar2;
  BOOL bCanProceed;
  D2PathTypeArg sPathTypeArg;
  uint32_t dwFlags;
  int32_t nLine;
  D2UnitStrc *pTargetUnit;
  short sCurX;
  short sCurY;
  
  pDynamicPath_00 = pDynamicPath;
  if (pDynamicPath == (D2DynamicPathStrc *)0x0) {
    return 0;
  }
  if (pDynamicPath->pOwner != pUnit) {
LAB_00649994:
    nErrorAddr = Fog::Src::ErrorManager::GetInstructionPointer();
    Fog::Src::ErrorManager::ERROR_UnrecoverableInternalError_Halt("",nErrorAddr,nLine);
                    /* WARNING: Subroutine does not return */
    compiler::exit(-1);
  }
  if ((pDynamicPath->nFlags & 0x40000U) != 0) {
    nPathPoints = D2Common::PATH::DynamicPath::PATH_CalculateMissilePath(pDynamicPath,pUnit);
    return nPathPoints;
  }
  pTargetUnit = pDynamicPath->pTargetUnit;
  pDynamicPath->eCollisionFlag = 0;
  if ((pTargetUnit != (D2UnitStrc *)0x0) &&
     ((iVar1 = D2Common::Units::Units::GetXPosFromDynamicPathUnit(pTargetUnit), iVar1 == 0 ||
      (iVar1 = D2Common::Units::Units::GetYPosFromDynamicPathUnit(pTargetUnit), iVar1 == 0)))) {
    return 0;
  }
  sCurX = (pDynamicPath->Coords).tSubtile.nPosX;
  sCurY = (pDynamicPath->Coords).tSubtile.nPosY;
  pDynamicPath = (D2DynamicPathStrc *)CONCAT22(sCurY,sCurX);
  sPathTypeArg.tStartCoord = (D2PathPointStrc)pDynamicPath;
  if ((sCurX != 0) || (sCurY != 0)) {
    sPathTypeArg.nUnitSize = pDynamicPath_00->nUnitSize;
    sPathTypeArg.nUnitWidth = pDynamicPath_00->nUnitWidth;
    sPathTypeArg.nCollisionPattern = pDynamicPath_00->nCollisionPattern;
    sPathTypeArg.nDistMax = (int)pDynamicPath_00->nDistMax;
    sPathTypeArg.nIdaStarInitCopy._0_1_ = pDynamicPath_00->nIdaStarVariable;
    sPathTypeArg.pDynamicPath = pDynamicPath_00;
    sPathTypeArg.nIdaStarVariable =
         D2Common::PATH::DynamicPath::PATH_ResolveTargetPosition
                   (&sPathTypeArg,sPathTypeArg.nDistMax);
    if ((pDynamicPath_00->nTargetX != 0) || (pDynamicPath_00->nTargetY != 0)) {
      sPathTypeArg.tTargetCoord.nX = pDynamicPath_00->nTargetX;
      sPathTypeArg.tTargetCoord.nY = pDynamicPath_00->nTargetY;
      if ((sPathTypeArg.tStartCoord.nX != sPathTypeArg.tTargetCoord.nX) ||
         (sPathTypeArg.tStartCoord.nY != sPathTypeArg.tTargetCoord.nY)) {
        nDeltaX = ((uint)sPathTypeArg.tTargetCoord & 0xffff) - ((uint)sPathTypeArg.tStartCoord & 0xffff);
        bCanPath = ((uint)sPathTypeArg.tTargetCoord >> 0x10) -
                   (uint)(ushort)sPathTypeArg.tStartCoord.nY;
        if ((nDeltaX < 0x65) &&
           (((nDeltaX == -100 || -nDeltaX < 100 && (bCanPath < 0x65)) &&
            (bCanPath == -100 || -bCanPath < 100)))) {
          sPathTypeArg.pRoom = pDynamicPath_00->pRoom;
          sPathTypeArg.pRoomNext =
               D2Common::Collision::Collision::DRLGROOM_FindBetterNearbyRoom
                         (sPathTypeArg.pRoom,(uint)sPathTypeArg.tTargetCoord & 0xffff,
                          (uint)sPathTypeArg.tTargetCoord >> 0x10);
          if (((sPathTypeArg.pRoom != (D2RoomStrc *)0x0) &&
              (sPathTypeArg.pRoomNext != (D2RoomStrc *)0x0)) &&
             ((nResult = D2Common::PATH::DynamicPath::PATH_CanMonsterPathInArea
                                   (pUnit,(ushort *)&sPathTypeArg), nResult != 0 ||
              (bIgnoreAreaCheck != 0)))) {
            sPathTypeArg.ePathType = pDynamicPath_00->ePathType;
            pTargetUnit = pDynamicPath_00->pTargetUnit;
            BVar2 = 0;
            D2Common::PATH::DynamicPath::PATH_RemoveUnitCollision(pUnit,0);
            if (((pTargetUnit != (D2UnitStrc *)0x0) &&
                (iVar1 = D2Common::Units::Units::GetUnitSizeX(pTargetUnit), iVar1 != 0)) &&
               ((pDynamicPath_00->nFlags & 0x800U) != 0)) {
              BVar2 = D2Common::PATH::DynamicPath::PATH_RemoveUnitCollision(pTargetUnit,0);
            }
            bCanProceed = 1;
            if (((pDynamicPath_00->nFlags & 0x1000U) != 0) &&
               (iVar1 = D2Common::Collision::Collision::CheckCollision_BlockPlayer_Type
                                  (sPathTypeArg.pRoom,(uint)sPathTypeArg.tTargetCoord & 0xffff,
                                   (uint)sPathTypeArg.tTargetCoord >> 0x10,
                                   pDynamicPath_00->nUnitWidth,pDynamicPath_00->nCollisionPattern),
               iVar1 != 0)) {
              bCanProceed = D2Common::PATH::Path::PATH_FindAlternateAroundObstacle(&sPathTypeArg);
            }
            pDynamicPath_00->nSavedTargetX = sPathTypeArg.tTargetCoord.nX;
            nCalcPathPoints = 0;
            pDynamicPath_00->nPathPointIndex = 0;
            pDynamicPath_00->nSavedTargetY = sPathTypeArg.tTargetCoord.nY;
            pDynamicPath_00->dwPathPoints = 0;
            pDynamicPath_00->nPathPointIndex = 0;
            if (bCanProceed != 0) {
                    /* FARPROC lpfn for IsBadCodePtr */
              bCanProceed = IsBadCodePtr((FARPROC)PATHTYPEFUNC[sPathTypeArg.ePathType]);
              if (bCanProceed != 0) {
                nLine = 0x37e;
                goto LAB_00649994;
              }
              nCalcPathPoints = (*PATHTYPEFUNC[sPathTypeArg.ePathType])(&sPathTypeArg);
            }
            pDynamicPath_00->dwPathPoints = nCalcPathPoints;
            if ((sPathTypeArg.tStartCoord.nX != sCurX) || (sPathTypeArg.tStartCoord.nY != sCurY)) {
              nLine = 0x389;
              goto LAB_00649994;
            }
            if (BVar2 != 0) {
              D2Common::PATH::DynamicPath::PATH_AddUnitCollision(pDynamicPath_00->pTargetUnit);
            }
            D2Common::PATH::DynamicPath::PATH_AddUnitCollision(pUnit);
            if (pDynamicPath_00->dwPathPoints == 0) goto LAB_00649c83;
            D2Common::PATH::Path::DRLGPATH_AdvanceAlongPathPoints(pDynamicPath_00,1,1);
            if (pDynamicPath_00->nPathPointIndex < pDynamicPath_00->dwPathPoints) {
              D2Common::PATH::Path::PATH_CheckPathPointsInRoom(pDynamicPath_00);
              pDynamicPath_00->nPrevTargetY = pDynamicPath_00->nTargetY;
              dwFlags = pDynamicPath_00->nFlags;
              pDynamicPath_00->nSavedPathPoints = 0;
              pDynamicPath_00->nPrevTargetX = pDynamicPath_00->nTargetX;
              if (((dwFlags & 0x10) == 0) && (pDynamicPath_00->pTargetUnit == (D2UnitStrc *)0x0)) {
                pDynamicPath_00->nTargetX =
                     pDynamicPath_00->PathPoints[pDynamicPath_00->dwPathPoints + -1].nX;
                pDynamicPath_00->nTargetY =
                     pDynamicPath_00->PathPoints[pDynamicPath_00->dwPathPoints + -1].nY;
              }
              nResult = pDynamicPath_00->dwPathPoints;
              if (pDynamicPath_00->dwPathPoints == 0) {
                pDynamicPath_00->nFlags = dwFlags & 0xffffffdf;
                return nResult;
              }
              pDynamicPath_00->nFlags = dwFlags | 0x20;
              return nResult;
            }
          }
        }
      }
    }
  }
  pDynamicPath_00->nPathPointIndex = 0;
  pDynamicPath_00->dwPathPoints = 0;
LAB_00649c83:
  pDynamicPath_00->nFlags = pDynamicPath_00->nFlags & 0xffffffdf;
  return 0;
}
