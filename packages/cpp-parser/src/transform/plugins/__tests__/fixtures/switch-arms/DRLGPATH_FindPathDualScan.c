/* WARNING: Unable to use type for symbol nPackedSrc2 */
/* WARNING: Enum "eCollisionFlags": Some values do not have unique names */
/* WARNING: Enum "eD2TimerType": Some values do not have unique names */
/* WARNING: Enum "eD2TimerTypeDWORD": Some values do not have unique names */
/* @function DRLGPATH_FindPathDualScan
   @address Game.exe.ram:0067bdf0
   @date 2026.09.05
   @calling __fastcall
   @description Main pathfinding function for PathTypeFunc_15. Uses a dual-scanner approach: two
   independent directional scanners advance from the start toward the path endpoints. Handles loop
   detection, waypoint insertion, and selects the better of the two scan results based on squared
   distance to the target. Returns the best path length found. */

int32_t __fastcall
D2Common::Drlg::Path::DRLGPATH_FindPathDualScan
          (uint *pPathGrid,int32_t nGridSize,uint32_t nStartPos,int *pStartX,int *pStartY,
          int32_t nEndX,uint32_t nEndY)

{
  uint uVar1;
  int32_t nWaypointBuf;
  bool bStepFailed;
  undefined3 byStepHi;
  uint32_t nNextPosPacked;
  int32_t nPathLengthSave;
  int *pScannerTemp;
  int32_t nWaypointIdx;
  int nDistSqScanA;
  int32_t nDistSqDiff;
  int iVar2;
  int *pActiveScannerA;
  int nDistSqScanB;
  uint32_t *pCopySrc;
  int32_t nDistSqA;
  int32_t nDistSqB;
  uint32_t *pCopyDst;
  int32_t nScannerADir;
  int32_t nScannerAWaypointCount;
  uint32_t nScannerAPosPacked;
  ushort wScannerACurYCoord;
  ushort wScannerAPrevXCoord;
  int32_t nScannerALoopPos;
  int *pScannerADirTableX;
  int *pScannerADirTableY;
  int32_t nScannerAFlags;
  uint32_t nScannerADone;
  uint32_t nScannerACurPosPacked;
  int32_t nScannerBDir;
  int32_t nScannerBWaypointCount;
  uint32_t nScannerBPosPacked;
  ushort wScannerBCurYCoord;
  ushort wScannerBPrevXCoord;
  int32_t nScannerBLoopPos;
  int *pScannerBDirTableX;
  int *pScannerBDirTableY;
  int32_t nScannerBFlags;
  uint32_t nScannerBDone;
  uint32_t nScannerBCurPosPacked;
  uint32_t nStartX;
  D2PathTypeArg *pPathTypeArgLocal;
  int *pScannerB;
  int *pActiveScannerB;
  int32_t nGridSizeSave;
  int32_t nErrorLine;
  uint nPackedSrc2;
  ushort wCurX;
  
  nScannerAWaypointCount = 0;
  wScannerACurYCoord = 0;
  wScannerAPrevXCoord = 0;
  nScannerALoopPos = 0;
  pScannerADirTableX = (int *)&gaPathDualScanDirTableX_A;
  pScannerADirTableY = (int *)&gaPathDualScanDirTableY_A;
  nScannerAFlags = 0;
  nScannerADone = 0;
  nScannerACurPosPacked._0_2_ = 0;
  pPathTypeArgLocal = (D2PathTypeArg *)pPathGrid;
  nGridSizeSave = nGridSize;
  compiler::memset((void *)((int)&nScannerACurPosPacked + 2),0,0x322);
  nScannerBWaypointCount = 0;
  wScannerBCurYCoord = 0;
  wScannerBPrevXCoord = 0;
  nScannerBLoopPos = 0;
  pScannerBDirTableX = (int *)&gaPathDualScanDirTableX_B;
  pScannerBDirTableY = (int *)&gaPathDualScanDirTableY_B;
  nScannerBFlags = 0;
  nScannerBDone = 0;
  nScannerBCurPosPacked._0_2_ = 0;
  compiler::memset((void *)((int)&nScannerBCurPosPacked + 2),0,0x322);
  pActiveScannerB = &nScannerBDir;
  uVar1 = *(uint *)(nGridSize + *pStartX * 4);
  nStartX = nStartPos & 0xffff;
  pActiveScannerA = &nScannerADir;
  pScannerB = pActiveScannerA;
  nScannerADir = gaPathDirectionLookupTable
                 [(((uVar1 >> 0x10) - (nStartPos >> 0x10)) * 3 - (nStartPos & 0xffff)) +
                  (uVar1 & 0xffff)] + 1;
  nScannerBDir = gaPathDirectionLookupTable
                 [(((uVar1 >> 0x10) - (nStartPos >> 0x10)) * 3 - (nStartPos & 0xffff)) +
                  (uVar1 & 0xffff)] + 7;
  nScannerBPosPacked = nStartPos;
  nScannerAPosPacked = nStartPos;
  do {
    pScannerTemp = pActiveScannerB;
    if (pActiveScannerA[8] != 0) goto LAB_0067c024;
    bStepFailed = D2Common::Drlg::Path::DRLGPATH_TryStepWithFallbackDirections
                            (pPathTypeArgLocal,pActiveScannerA);
    nWaypointBuf = nGridSizeSave;
    pScannerTemp = pActiveScannerB;
    if (CONCAT31(byStepHi,bStepFailed) == 0) {
      pActiveScannerA[8] = 1;
      pScannerTemp = pActiveScannerB;
      goto LAB_0067c024;
    }
    if (pActiveScannerA[1] < 1) goto LAB_0067bf97;
    switch(nEndY) {
    case 0:
      wCurX = *(ushort *)((int)pActiveScannerA + 0xe);
      nNextPosPacked = (uint32_t)nStartPos._2_2_;
      goto LAB_0067bf65;
    case 1:
      iVar2 = *(ushort *)(pActiveScannerA + 3) - nStartX;
      break;
    case 2:
      iVar2 = (uint)*(ushort *)((int)pActiveScannerA + 0xe) - (uint)nStartPos._2_2_;
      break;
    case 3:
      wCurX = *(ushort *)(pActiveScannerA + 3);
      nNextPosPacked = nStartX;
LAB_0067bf65:
      iVar2 = nNextPosPacked - wCurX;
      break;
    default:
      goto LAB_0067bf97;
    }
    if ((((0 < iVar2) && (iVar2 = iVar2 + -1 + *pStartX, iVar2 < *pStartY)) &&
        ((short)pActiveScannerA[3] == *(short *)(nGridSizeSave + iVar2 * 4))) &&
       (*(short *)((int)pActiveScannerA + 0xe) == *(short *)(nGridSizeSave + 2 + iVar2 * 4))) {
      if (nEndX <= pActiveScannerA[1]) {
        nErrorLine = 0x1bb;
        nPathLengthSave = Fog::Src::ErrorManager::GetInstructionPointer();
                    /* WARNING: Subroutine does not return */
        Fog::Src::ErrorManager::ERROR_UnrecoverableInternalError_Halt("",nPathLengthSave,nErrorLine)
        ;
      }
      pActiveScannerA[pActiveScannerA[1] + 9] = pActiveScannerA[3];
      pActiveScannerA[1] = pActiveScannerA[1] + 1;
      *(undefined2 *)(pActiveScannerA + pActiveScannerA[1] + 9) = 0;
      D2Common::Drlg::Path::DRLGPATH_InsertWaypointsIntoBuffer
                ((int32_t)pActiveScannerA,nWaypointBuf,iVar2,pStartX,pStartY);
      return pScannerB[1];
    }
LAB_0067bf97:
    if (1 < pActiveScannerB[1]) {
      iVar2 = pActiveScannerA[7];
      if (iVar2 != 0) {
        if (((short)pActiveScannerA[3] == (short)pActiveScannerB[iVar2 + 7]) &&
           (*(short *)((int)pActiveScannerA + 0xe) ==
            *(short *)((int)pActiveScannerB + iVar2 * 4 + 0x1e))) {
          *(undefined2 *)(nGridSizeSave + *pStartX * 4) = 0;
          *pStartY = *pStartX;
          return 0;
        }
        pActiveScannerA[7] = 0;
      }
      if (((short)pActiveScannerA[3] == (short)pScannerTemp[2]) &&
         (*(short *)((int)pActiveScannerA + 0xe) == *(short *)((int)pScannerTemp + 10))) {
        pActiveScannerA[7] = pScannerTemp[1];
      }
    }
    pActiveScannerA[pActiveScannerA[1] + 9] = pActiveScannerA[3];
    pActiveScannerA[1] = pActiveScannerA[1] + 1;
    pActiveScannerA[2] = pActiveScannerA[3];
    *pActiveScannerA = *(int *)(pActiveScannerA[5] + *pActiveScannerA * 4);
    if ((nEndX - *pStartY) + -1 <= pActiveScannerA[1]) {
      pActiveScannerA[8] = 1;
    }
LAB_0067c024:
    if (pActiveScannerA[7] == 0) {
      pActiveScannerB = pActiveScannerA;
      pScannerB = pScannerTemp;
      pActiveScannerA = pScannerTemp;
    }
  } while ((nScannerADone == 0) && (nScannerBDone == 0));
  if (0x50 < nEndX) {
    *(undefined2 *)(nGridSizeSave + *pStartX * 4) = 0;
    *pStartY = *pStartX;
    return 0;
  }
  uVar1._0_2_ = (pPathTypeArgLocal->pCoords).nOffsetY;
  uVar1._2_2_ = (pPathTypeArgLocal->pCoords).nPosY;
  nDistSqDiff = ((&nScannerADone)[nScannerAWaypointCount] & 0xffff) - (uVar1 & 0xffff);
  nWaypointIdx = ((&nScannerADone)[nScannerAWaypointCount] >> 0x10) - (uVar1 >> 0x10);
  nDistSqScanA = nWaypointIdx * nWaypointIdx + nDistSqDiff * nDistSqDiff;
  nDistSqA = ((&nScannerBDone)[nScannerBWaypointCount] & 0xffff) - (uVar1 & 0xffff);
  iVar2 = ((&nScannerBDone)[nScannerBWaypointCount] >> 0x10) - (uVar1 >> 0x10);
  nDistSqScanB = iVar2 * iVar2 + nDistSqA * nDistSqA;
  nPackedSrc2._0_2_ = (pPathTypeArgLocal->pCoords).nOffsetX;
  nPackedSrc2._2_2_ = (pPathTypeArgLocal->pCoords).nPosX;
  iVar2 = (nPackedSrc2 & 0xffff) - (uVar1 & 0xffff);
  nDistSqB = (nPackedSrc2 >> 0x10) - (uVar1 >> 0x10);
  iVar2 = nDistSqB * nDistSqB + iVar2 * iVar2;
  if (nDistSqScanA < nDistSqScanB) {
    if (iVar2 < nDistSqScanA) {
      return 0;
    }
    iVar2 = *pStartX;
    nScannerBWaypointCount = nScannerAWaypointCount;
    if (nScannerAWaypointCount < 1) goto LAB_0067c1b0;
    pCopySrc = &nScannerACurPosPacked;
  }
  else {
    if (iVar2 < nDistSqScanB) {
      return 0;
    }
    iVar2 = *pStartX;
    if (nScannerBWaypointCount < 1) goto LAB_0067c1b0;
    pCopySrc = &nScannerBCurPosPacked;
  }
  pCopyDst = (uint32_t *)(nGridSizeSave + iVar2 * 4);
  for (nDistSqScanA = nScannerBWaypointCount; nDistSqScanA != 0; nDistSqScanA = nDistSqScanA + -1) {
    *pCopyDst = *pCopySrc;
    pCopySrc = pCopySrc + 1;
    pCopyDst = pCopyDst + 1;
  }
LAB_0067c1b0:
  *pStartX = *pStartX + nScannerBWaypointCount;
  *pStartY = *pStartX;
  *(undefined2 *)(nGridSizeSave + *pStartX * 4) = 0;
  return pActiveScannerA[1];
}

