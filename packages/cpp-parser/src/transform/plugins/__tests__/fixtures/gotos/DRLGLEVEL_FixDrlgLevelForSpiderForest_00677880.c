
/* WARNING: Enum "eCollisionFlags": Some values do not have unique names */
/* WARNING: Enum "eD2TimerType": Some values do not have unique names */
/* WARNING: Enum "eD2TimerTypeDWORD": Some values do not have unique names */
/* @function DRLGLEVEL_FixDrlgLevelForSpiderForest
   @address Game.exe.ram:00677880
   @date 2026.09.05
   @params
     pLevel: EAX:4 (D2DrlgLevelStrc *)
   @description Server-side DRLG out-of-placement generator for the Spider Forest level
   (LEVEL_SpiderForest). Places three procedurally-connected sub-levels (ids 0x4c..0x4e) inside the
   forest using the drlg RNG seed: picks non-overlapping room placements (FreeRoomEx), allocates
   four scratch tile maps from the level memory pool, carves a maze of connecting paths/exits
   between sub-levels (flood/adjacency passes building per-cell connection-flag bitmasks
   0x10/0x20/0x40/0x80), maps cell flags to tile codes via the gdwOutPlaceMap* lookup tables, writes
   the resulting grids back into each sub-level, sorts the three sub-levels, then GetLevelAndAllocs
   each and stores coords/size/automap. Frees the scratch maps and returns the last allocated
   sub-level. Halts via Fog ErrorManager on overflow/invalid tile. pLevel passed in EAX (custom
   convention); mutates pDrlg->nSeed throughout. */

D2DrlgLevelStrc * __cdecl
D2Common::Drlg::OutPlace::DRLGLEVEL_FixDrlgLevelForSpiderForest(D2DrlgLevelStrc *pLevel)

{
  D2DrlgStrc *pDrlg;
  D2PoolManagerStrc *pPoolManagerStrc;
  size_t nSize;
  D2LevelDefsTxt *pSpiderForestDefs;
  int iVar1;
  int iVar2;
  int bNoOverlap;
  uint nConnFlags;
  int32_t nAddress;
  int iVar3;
  void *pSubLevelMap;
  void *pDistWorkMap;
  void *pDistMap;
  uint *pSubLevelDistMap;
  void *pSubGridData;
  int *pCellPtr;
  int nExitDistIdx;
  int *pAdjPtr;
  uint *pConnFlags;
  D2DrlgLevelStrc *pSubLevel;
  uint uVar4;
  int iVar5;
  int nBottomRow;
  uint *pRowPtr;
  D2DrlgCoordsStrc *pOutCoords;
  int nGridX;
  uint uVar6;
  int nCellIdx;
  int nGridY;
  D2DrlgCoordsStrc *pCoords1;
  int nAdjIdx;
  int *pSwapDst;
  bool bSwapped;
  int aSwapBuffer [14];
  int aSubLevelRecords [42];
  int nMinY;
  int nMinX;
  int nMaxX;
  int *pSubLevelRowPtr;
  uint nRandExitIdx;
  uint nFlipState;
  int nSortPass;
  int nSubOffset;
  uint nSubLevelCount;
  uint nRandIdx;
  int nExitCol;
  int *pSubIdx;
  int nRowIter;
  int *pExitCount;
  uint *pFlagsRow;
  bool bFoundExit;
  int32_t nLine;
  LONG *pSubLevelSizeYSrc;
  D2SeedStrc sNewSeed;
  ulonglong uSeedHigh64;
  
  pSpiderForestDefs = D2Common::DATATBLS::LvlTbls::TXT_LevelDefs_GetLine(LEVEL_SpiderForest);
  pDrlg = pLevel->pDrlg;
  iVar3 = pSpiderForestDefs->SizeY[pDrlg->nDifficulty];
  pPoolManagerStrc = pDrlg->pMemoryPool;
  iVar5 = pSpiderForestDefs->SizeX[pDrlg->nDifficulty];
  iVar1 = (int)(iVar5 + (iVar5 >> 0x1f & 0x1fU)) >> 5;
  nMinX = (pLevel->sCoordinatesAndSize).WorldPosition.x;
  iVar2 = (int)(iVar3 + (iVar3 >> 0x1f & 0x1fU)) >> 5;
  nGridY = (pLevel->sCoordinatesAndSize).WorldPosition.y;
  nMaxX = nMinX + iVar5;
  nMinY = nGridY - iVar3;
  nSubLevelCount = 1;
  compiler::memset(aSubLevelRecords,0,0xa8);
  aSubLevelRecords[0] = (pLevel->sCoordinatesAndSize).WorldPosition.x;
  aSubLevelRecords[1] = (pLevel->sCoordinatesAndSize).WorldPosition.y - iVar3;
  aSubLevelRecords[4] = 0;
  pOutCoords = (D2DrlgCoordsStrc *)(aSubLevelRecords + 0xe);
  aSubLevelRecords[2] = iVar5;
  aSubLevelRecords[3] = iVar3;
  do {
    if ((int)nSubLevelCount < 1) {
      nRandIdx = 0;
    }
    else {
      nConnFlags = (pDrlg->nSeed).nSeedLow;
      uSeedHigh64 = (ulonglong)(uint)(pDrlg->nSeed).nSeedHigh;
      if ((nSubLevelCount & nSubLevelCount - 1) == 0) {
        sNewSeed = (D2SeedStrc)((ulonglong)nConnFlags * 0x6ac690c5 + uSeedHigh64);
        nRandIdx = nSubLevelCount - 1 & sNewSeed.nSeedLow;
        pDrlg->nSeed = sNewSeed;
      }
      else {
        sNewSeed = (D2SeedStrc)((ulonglong)nConnFlags * 0x6ac690c5 + uSeedHigh64);
        pDrlg->nSeed = sNewSeed;
        nRandIdx = (uint)(((ulonglong)sNewSeed & 0xffffffff) % (ulonglong)nSubLevelCount);
      }
    }
    sNewSeed = (D2SeedStrc)
               ((ulonglong)(uint)(pDrlg->nSeed).nSeedLow * 0x6ac690c5 +
               (ulonglong)(uint)(pDrlg->nSeed).nSeedHigh);
    pDrlg->nSeed = sNewSeed;
    D2Common::Drlg::OutPlace::DRLGOUTPLACE_CalcSubLevelPlacement
              (iVar3,iVar5,pOutCoords,aSubLevelRecords + nRandIdx * 0xe,
               sNewSeed.nSeedLow + (int)(((ulonglong)sNewSeed & 0xffffffff) / 5) * -5);
    nGridX = 0;
    if (0 < (int)nSubLevelCount) {
      pCoords1 = (D2DrlgCoordsStrc *)aSubLevelRecords;
      do {
        bNoOverlap = D2Common::Drlg::DrlgRoom::DRLGROOM_CoordsWithinDistance(pCoords1,pOutCoords,0);
        if (bNoOverlap == 0) {
          if (nGridX < (int)nSubLevelCount) goto LAB_00677a7a;
          break;
        }
        nGridX = nGridX + 1;
        pCoords1 = (D2DrlgCoordsStrc *)&pCoords1[3].WorldSize;
      } while (nGridX < (int)nSubLevelCount);
    }
    pCellPtr = aSubLevelRecords + nRandIdx * 0xe + 5;
    aSubLevelRecords[*pCellPtr + nRandIdx * 0xe + 7] = (int)pOutCoords;
    pOutCoords[1].WorldSize.x = (LONG)(aSubLevelRecords + nRandIdx * 0xe);
    *pCellPtr = *pCellPtr + 1;
    if (3 < *pCellPtr) {
      nLine = 0x63e;
      goto LAB_00677aa7;
    }
    nGridX = (pOutCoords->WorldPosition).x;
    if (nGridX < nMinX) {
      nMinX = nGridX;
    }
    bNoOverlap = (pOutCoords->WorldPosition).y;
    if (bNoOverlap < nMinY) {
      nMinY = bNoOverlap;
    }
    nGridX = nGridX + (pOutCoords->WorldSize).x;
    if (nMaxX < nGridX) {
      nMaxX = nGridX;
    }
    nSubLevelCount = nSubLevelCount + 1;
    pOutCoords = (D2DrlgCoordsStrc *)&pOutCoords[3].WorldSize;
LAB_00677a7a:
    if (2 < (int)nSubLevelCount) {
      nConnFlags = nMaxX - nMinX;
      uVar4 = nConnFlags & 0x8000001f;
      bSwapped = uVar4 == 0;
      if ((int)uVar4 < 0) {
        bSwapped = (uVar4 - 1 | 0xffffffe0) == 0xffffffff;
      }
      if (bSwapped) {
        uVar6 = nGridY - nMinY;
        uVar4 = uVar6 & 0x8000001f;
        bSwapped = uVar4 == 0;
        if ((int)uVar4 < 0) {
          bSwapped = (uVar4 - 1 | 0xffffffe0) == 0xffffffff;
        }
        if (bSwapped) {
          iVar3 = ((int)(uVar6 + ((int)uVar6 >> 0x1f & 0x1fU)) >> 5) + 2;
          iVar5 = ((int)(nConnFlags + ((int)nConnFlags >> 0x1f & 0x1fU)) >> 5) + 2;
          nSize = iVar3 * iVar5 * 4;
          pSubLevelMap = Fog::Memory::AllocServerMemory
                                   (pPoolManagerStrc,nSize,".\\DRLG\\OutPlace.cpp",0x658,0);
          pDistWorkMap = Fog::Memory::AllocServerMemory
                                   (pPoolManagerStrc,nSize,".\\DRLG\\OutPlace.cpp",0x659,0);
          pDistMap = Fog::Memory::AllocServerMemory
                               (pPoolManagerStrc,nSize,".\\DRLG\\OutPlace.cpp",0x65a,0);
          pSubLevelDistMap =
               Fog::Memory::AllocServerMemory
                         (pPoolManagerStrc,nSize,".\\DRLG\\OutPlace.cpp",0x65b,0);
LAB_00677b80:
          compiler::memset(pSubLevelMap,0,nSize);
          compiler::memset(pDistWorkMap,0,nSize);
          compiler::memset(pDistMap,0,nSize);
          compiler::memset(pSubLevelDistMap,0,nSize);
          pSubIdx = (int *)0x0;
          do {
            nGridY = ((int)((aSubLevelRecords[(int)pSubIdx * 0xe] - nMinX) +
                           (aSubLevelRecords[(int)pSubIdx * 0xe] - nMinX >> 0x1f & 0x1fU)) >> 5) + 1
            ;
            nGridX = (int)((aSubLevelRecords[(int)pSubIdx * 0xe + 1] - nMinY) +
                          (aSubLevelRecords[(int)pSubIdx * 0xe + 1] - nMinY >> 0x1f & 0x1fU)) >> 5;
            bNoOverlap = nGridX + 1;
            aSubLevelRecords[(int)pSubIdx * 0xe + 10] = nGridY;
            aSubLevelRecords[(int)pSubIdx * 0xe + 0xb] = bNoOverlap;
            pSubGridData = Fog::Memory::AllocServerMemory
                                     (pPoolManagerStrc,iVar2 * iVar1 * 4,".\\DRLG\\OutPlace.cpp",
                                      0x66f,0);
            aSubLevelRecords[(int)pSubIdx * 0xe + 0xc] = (int)pSubGridData;
            if (pSubIdx == (int *)0x0) {
              sNewSeed = (D2SeedStrc)
                         ((ulonglong)(uint)(pDrlg->nSeed).nSeedLow * 0x6ac690c5 +
                         (ulonglong)(uint)(pDrlg->nSeed).nSeedHigh);
              nConnFlags = sNewSeed.nSeedLow & 1;
              pDrlg->nSeed = sNewSeed;
            }
            else {
              nConnFlags = aSubLevelRecords[(int)pSubIdx * 0xe + 4] & 0x80000001;
              if ((int)nConnFlags < 0) {
                nConnFlags = (nConnFlags - 1 | 0xfffffffe) + 1;
              }
              nConnFlags = (uint)(nConnFlags == 1);
            }
            nBottomRow = nGridX + iVar2;
            nFlipState = nConnFlags;
            do {
              if (0 < iVar2) {
                pExitCount = (int *)((int)pDistWorkMap + (bNoOverlap * iVar5 + nGridY) * 4);
                nSubOffset = iVar2;
                do {
                  if (0 < iVar1) {
                    pCellPtr = pExitCount;
                    nAdjIdx = iVar1;
                    do {
                      *(int *)(((int)pSubLevelMap - (int)pDistWorkMap) + (int)pCellPtr) =
                           (int)pSubIdx + 1;
                      *pCellPtr = 0;
                      *(undefined4 *)(((int)pDistMap - (int)pDistWorkMap) + (int)pCellPtr) = 0;
                      *(undefined4 *)(((int)pSubLevelDistMap - (int)pDistWorkMap) + (int)pCellPtr) =
                           0;
                      pCellPtr = pCellPtr + 1;
                      nAdjIdx = nAdjIdx + -1;
                      nConnFlags = nFlipState;
                    } while (nAdjIdx != 0);
                  }
                  pExitCount = pExitCount + iVar5;
                  nSubOffset = nSubOffset + -1;
                } while (nSubOffset != 0);
              }
              nExitCol = nConnFlags + nGridY;
              if (pSubIdx != (int *)0x0) {
                *(undefined4 *)((int)pDistMap + (iVar5 * nBottomRow + nExitCol) * 4) = 1;
                *(undefined4 *)
                 ((int)pDistMap +
                 ((uint)(nConnFlags == 0) * 2 + -1 + iVar5 * nBottomRow + nExitCol) * 4) = 2;
              }
              nSubOffset = 0;
              if (0 < aSubLevelRecords[(int)pSubIdx * 0xe + 5]) {
                pExitCount = aSubLevelRecords + (int)pSubIdx * 0xe + 7;
                do {
                  switch(*(undefined4 *)(*pExitCount + 0x10)) {
                  case 0:
                    *(undefined4 *)((int)pDistMap + (bNoOverlap * iVar5 + nGridY) * 4) = 1;
                    break;
                  case 1:
                    *(undefined4 *)((int)pDistMap + ((nGridX + 4) * iVar5 + nGridY) * 4) = 1;
                    break;
                  case 2:
                    nAdjIdx = nGridX + 4;
                    goto LAB_00677dd2;
                  case 3:
                    *(undefined4 *)((int)pDistMap + ((nGridX + 2) * iVar5 + nGridY) * 4) = 1;
                    break;
                  case 4:
                    nAdjIdx = nGridX + 2;
LAB_00677dd2:
                    *(undefined4 *)((int)pDistMap + (nAdjIdx * iVar5 + nGridY) * 4 + 4) = 1;
                  }
                  pExitCount = pExitCount + 1;
                  nSubOffset = nSubOffset + 1;
                } while (nSubOffset < aSubLevelRecords[(int)pSubIdx * 0xe + 5]);
              }
              pExitCount = (int *)0x0;
              nRandIdx = (uint)(pSubIdx != (int *)0x0);
              if (bNoOverlap <= nBottomRow) {
                nCellIdx = iVar5 * nBottomRow;
                nAdjIdx = ((int)pSubIdx + 1) * 100;
                nRowIter = nBottomRow;
                do {
                  *(int *)((int)pDistWorkMap + (nExitCol + nCellIdx) * 4) = nAdjIdx;
                  nAdjIdx = nAdjIdx + 1;
                  if ((pExitCount == (int *)0x0) || (nRowIter == bNoOverlap)) {
LAB_00677e9f:
                    pExitCount = (int *)((int)pExitCount + 1);
                    if (((1 < (int)pExitCount) && (1 < nRowIter)) &&
                       (nExitDistIdx = (uint)(nConnFlags == 0) * 2 + -1 + nCellIdx + nExitCol,
                       *(int *)((int)pDistMap + nExitDistIdx * 4) == 0)) {
                      nRandIdx = nRandIdx + 1;
                      *(undefined4 *)((int)pDistMap + nExitDistIdx * 4) = 2;
                    }
                    nRowIter = nRowIter + -1;
                    nCellIdx = nCellIdx - iVar5;
                  }
                  else {
                    sNewSeed = (D2SeedStrc)
                               ((ulonglong)(uint)(pDrlg->nSeed).nSeedLow * 0x6ac690c5 +
                               (ulonglong)(uint)(pDrlg->nSeed).nSeedHigh);
                    pDrlg->nSeed = sNewSeed;
                    nConnFlags = nFlipState;
                    if (sNewSeed.nSeedLow + (int)(((ulonglong)sNewSeed & 0xffffffff) / 3) * -3 != 0)
                    goto LAB_00677e9f;
                    pExitCount = (int *)0x0;
                    if (nFlipState == 0) {
                      nConnFlags = 1;
                      nExitCol = nExitCol + 1;
                      nFlipState = 1;
                    }
                    else {
                      nExitCol = nExitCol + -1;
                      nConnFlags = (uint)pExitCount;
                      nFlipState = (uint)pExitCount;
                    }
                  }
                } while (bNoOverlap <= nRowIter);
              }
            } while ((int)nRandIdx < 2);
joined_r0x00677ef5:
            if (3 < (int)nRandIdx) {
              if ((int)nRandIdx < 1) {
                nRandExitIdx = 0;
              }
              else {
                uSeedHigh64 = (ulonglong)(uint)(pDrlg->nSeed).nSeedHigh;
                nConnFlags = (pDrlg->nSeed).nSeedLow;
                if ((nRandIdx & nRandIdx - 1) == 0) {
                  sNewSeed = (D2SeedStrc)((ulonglong)nConnFlags * 0x6ac690c5 + uSeedHigh64);
                  pDrlg->nSeed = sNewSeed;
                  nRandExitIdx = nRandIdx - 1 & sNewSeed.nSeedLow;
                }
                else {
                  sNewSeed = (D2SeedStrc)((ulonglong)nConnFlags * 0x6ac690c5 + uSeedHigh64);
                  pDrlg->nSeed = sNewSeed;
                  nRandExitIdx = (uint)(((ulonglong)sNewSeed & 0xffffffff) % (ulonglong)nRandIdx);
                }
              }
              bSwapped = false;
              pExitCount = (int *)0x0;
              nRowIter = 0;
              if (0 < iVar2) {
                nGridX = bNoOverlap * iVar5 + nGridY;
                do {
                  if (bSwapped) break;
                  nBottomRow = 0;
                  if (0 < iVar1) {
                    do {
                      if (bSwapped) break;
                      if (*(int *)((int)pDistMap + (nGridX + nBottomRow) * 4) == 2) {
                        if ((int *)nRandExitIdx == pExitCount) {
                          *(undefined4 *)((int)pDistMap + (nGridX + nBottomRow) * 4) = 0;
                          bSwapped = true;
                          nRandIdx = nRandIdx - 1;
                        }
                        pExitCount = (int *)((int)pExitCount + 1);
                      }
                      nBottomRow = nBottomRow + 1;
                    } while (nBottomRow < iVar1);
                  }
                  nGridX = nGridX + iVar5;
                  nRowIter = nRowIter + 1;
                } while (nRowIter < iVar2);
              }
              goto joined_r0x00677ef5;
            }
            pSubIdx = (int *)((int)pSubIdx + 1);
          } while ((int)pSubIdx < 3);
          nRowIter = 0;
          if (0 < iVar3) {
            do {
              nExitCol = 0;
              if (0 < iVar5) {
                nGridY = iVar5 * nRowIter * 4;
                pSubLevelRowPtr = (int *)(nGridY + (int)pSubLevelMap);
                pSubIdx = (int *)(nGridY + 4 + (int)pDistWorkMap);
                pFlagsRow = pSubLevelDistMap + iVar5 * nRowIter + -1;
                do {
                  nGridY = *pSubLevelRowPtr;
                  pCellPtr = (int *)0x0;
                  nRandExitIdx = 0x7fffffff;
                  pExitCount = (int *)0x0;
                  if (*(int *)(((int)pDistMap - (int)pSubLevelMap) + (int)pSubLevelRowPtr) == 1) {
                    nBottomRow = (nRowIter + -1) * iVar5 + nExitCol;
                    bNoOverlap = nBottomRow * 4;
                    nGridX = *(int *)(bNoOverlap + (int)pDistWorkMap);
                    if (((nGridX != 0) && (nGridX < 0x7fffffff)) &&
                       (*(int *)(bNoOverlap + (int)pSubLevelMap) == nGridY)) {
                      pCellPtr = (int *)0x8;
                      pExitCount = (int *)0x8;
                      nRandExitIdx = nGridX;
                    }
                    nCellIdx = (nRowIter + 1) * iVar5 + nExitCol;
                    nAdjIdx = nCellIdx * 4;
                    nGridX = *(int *)(nAdjIdx + (int)pDistWorkMap);
                    if (((nGridX != 0) && (nGridX < (int)nRandExitIdx)) &&
                       (pCellPtr = pExitCount, *(int *)(nAdjIdx + (int)pSubLevelMap) == nGridY)) {
                      pExitCount = (int *)0x4;
                      pCellPtr = (int *)4;
                      nRandExitIdx = nGridX;
                    }
                    nGridX = *pSubIdx;
                    if (((nGridX != 0) && (nGridX < (int)nRandExitIdx)) &&
                       (pCellPtr = pExitCount,
                       *(int *)((int)pSubIdx + ((int)pSubLevelMap - (int)pDistWorkMap)) == nGridY))
                    {
                      nRandExitIdx = nGridX;
                      pCellPtr = (int *)2;
                    }
                    nGridX = *(int *)(((int)pDistWorkMap - (int)pSubLevelDistMap) + (int)pFlagsRow);
                    if (((nGridX != 0) && (nGridX < (int)nRandExitIdx)) &&
                       (*(int *)(((int)pSubLevelMap - (int)pSubLevelDistMap) + (int)pFlagsRow) ==
                        nGridY)) {
                      pCellPtr = (int *)0x1;
                    }
                    if (((uint)pCellPtr & 8) != 0) {
                      pSubLevelDistMap[nBottomRow] = pSubLevelDistMap[nBottomRow] | 4;
                    }
                    if (((uint)pCellPtr & 4) != 0) {
                      pSubLevelDistMap[nCellIdx] = pSubLevelDistMap[nCellIdx] | 8;
                    }
                    if (((uint)pCellPtr & 2) != 0) {
                      pFlagsRow[2] = pFlagsRow[2] | 1;
                    }
                    if (((uint)pCellPtr & 1) != 0) {
                      *pFlagsRow = *pFlagsRow | 2;
                    }
                    if ((*(int *)(bNoOverlap + (int)pDistMap) == 1) &&
                       (*(int *)(bNoOverlap + (int)pSubLevelMap) != nGridY)) {
                      pCellPtr = (int *)((uint)pCellPtr | 8);
                    }
                    if ((*(int *)(nAdjIdx + (int)pDistMap) == 1) &&
                       (*(int *)(nAdjIdx + (int)pSubLevelMap) != nGridY)) {
                      pCellPtr = (int *)((uint)pCellPtr | 4);
                    }
                    pAdjPtr = (int *)((int)pSubIdx + ((int)pSubLevelMap - (int)pDistWorkMap));
                    if ((*(int *)((int)pAdjPtr + ((int)pDistMap - (int)pSubLevelMap)) == 1) &&
                       (*pAdjPtr != nGridY)) {
                      pCellPtr = (int *)((uint)pCellPtr | 2);
                    }
                    if ((*(int *)(((int)pDistMap - (int)pSubLevelDistMap) + (int)pFlagsRow) == 1) &&
                       (*(int *)(((int)pSubLevelMap - (int)pSubLevelDistMap) + (int)pFlagsRow) !=
                        nGridY)) {
                      pCellPtr = (int *)((uint)pCellPtr | 1);
                    }
                  }
                  nGridY = pSubIdx[-1];
                  if (nGridY != 0) {
                    nGridX = nGridY - *(int *)((int)pDistWorkMap +
                                              ((nRowIter + -1) * iVar5 + nExitCol) * 4);
                    if (nGridX < 0) {
                      nGridX = -nGridX;
                    }
                    if (nGridX == 1) {
                      pCellPtr = (int *)((uint)pCellPtr | 8);
                    }
                    nGridX = nGridY - *(int *)((int)pDistWorkMap +
                                              ((nRowIter + 1) * iVar5 + nExitCol) * 4);
                    if (nGridX < 0) {
                      nGridX = -nGridX;
                    }
                    if (nGridX == 1) {
                      pCellPtr = (int *)((uint)pCellPtr | 4);
                    }
                    nGridX = nGridY - *pSubIdx;
                    if (nGridX < 0) {
                      nGridX = -nGridX;
                    }
                    if (nGridX == 1) {
                      pCellPtr = (int *)((uint)pCellPtr | 2);
                    }
                    nGridY = nGridY - *(int *)(((int)pDistWorkMap - (int)pSubLevelDistMap) +
                                              (int)pFlagsRow);
                    if (nGridY < 0) {
                      nGridY = -nGridY;
                    }
                    if (nGridY == 1) {
                      pCellPtr = (int *)((uint)pCellPtr | 1);
                    }
                  }
                  pFlagsRow[1] = pFlagsRow[1] | (uint)pCellPtr;
                  pSubLevelRowPtr = pSubLevelRowPtr + 1;
                  pSubIdx = pSubIdx + 1;
                  nExitCol = nExitCol + 1;
                  pFlagsRow = pFlagsRow + 1;
                } while (nExitCol < iVar5);
              }
              nRowIter = nRowIter + 1;
            } while (nRowIter < iVar3);
          }
          for (nGridY = 0; nGridY < iVar3; nGridY = nGridY + 1) {
            nExitCol = 0;
            if (0 < iVar5) {
              pConnFlags = pSubLevelDistMap + iVar5 * nGridY;
              nGridX = (int)pSubLevelMap - (int)pDistMap;
              do {
                nConnFlags = *pConnFlags;
                pCellPtr = (int *)(((int)pDistMap - (int)pSubLevelDistMap) + (int)pConnFlags);
                bNoOverlap = *(int *)((int)pCellPtr + nGridX);
                sNewSeed = (D2SeedStrc)
                           ((ulonglong)(uint)(pDrlg->nSeed).nSeedLow * 0x6ac690c5 +
                           (ulonglong)(uint)(pDrlg->nSeed).nSeedHigh);
                uVar4 = sNewSeed.nSeedLow & 3;
                bSwapped = nConnFlags == 0;
                pDrlg->nSeed = sNewSeed;
                if (*pCellPtr == 2) {
                  pSubIdx = (int *)0x0;
                  bFoundExit = true;
                  do {
                    if (!bFoundExit) break;
                    uVar6 = (int)pSubIdx + uVar4 & 0x80000003;
                    if ((int)uVar6 < 0) {
                      uVar6 = (uVar6 - 1 | 0xfffffffc) + 1;
                    }
                    switch(uVar6) {
                    case 0:
                      nBottomRow = (nGridY + -1) * iVar5 + nExitCol;
                      if (((*(int *)(nBottomRow * 4 + (int)pSubLevelMap) == bNoOverlap) &&
                          (pSubLevelDistMap[nBottomRow] != 0)) &&
                         ((int)pSubLevelDistMap[nBottomRow] < 0xf)) {
                        nConnFlags = nConnFlags | 0x80;
LAB_006783b9:
                        bFoundExit = false;
                      }
                      break;
                    case 1:
                      nBottomRow = (nGridY + 1) * iVar5 + nExitCol;
                      if (((*(int *)(nBottomRow * 4 + (int)pSubLevelMap) == bNoOverlap) &&
                          (pSubLevelDistMap[nBottomRow] != 0)) &&
                         ((int)pSubLevelDistMap[nBottomRow] < 0xf)) {
                        nConnFlags = nConnFlags | 0x40;
                        goto LAB_006783b9;
                      }
                      break;
                    case 2:
                      if (((*(int *)((int)pCellPtr + nGridX + 4) == bNoOverlap) &&
                          (pConnFlags[1] != 0)) && ((int)pConnFlags[1] < 0xf)) {
                        nConnFlags = nConnFlags | 0x20;
                        goto LAB_006783b9;
                      }
                      break;
                    case 3:
                      if (((*(int *)((int)pCellPtr + nGridX + -4) == bNoOverlap) &&
                          (pConnFlags[-1] != 0)) && ((int)pConnFlags[-1] < 0xf)) {
                        nConnFlags = nConnFlags | 0x10;
                        goto LAB_006783b9;
                      }
                    }
                    pSubIdx = (int *)((int)pSubIdx + 1);
                  } while ((int)pSubIdx < 4);
                  if (nConnFlags == 0) goto LAB_00677b80;
                  if (bSwapped) {
                    pSubIdx = (int *)0x0;
                    bSwapped = true;
                    do {
                      if (!bSwapped) break;
                      uVar6 = (int)pSubIdx + uVar4 & 0x80000003;
                      if ((int)uVar6 < 0) {
                        uVar6 = (uVar6 - 1 | 0xfffffffc) + 1;
                      }
                      switch(uVar6) {
                      case 0:
                        nBottomRow = ((nGridY + -1) * iVar5 + nExitCol) * 4;
                        if ((*(int *)(nBottomRow + (int)pSubLevelMap) != bNoOverlap) &&
                           (*(int *)(nBottomRow + (int)pDistMap) == 2)) {
                          nConnFlags = nConnFlags | 0x80;
LAB_00678494:
                          bSwapped = false;
                        }
                        break;
                      case 1:
                        nBottomRow = ((nGridY + 1) * iVar5 + nExitCol) * 4;
                        if ((*(int *)(nBottomRow + (int)pSubLevelMap) != bNoOverlap) &&
                           (*(int *)(nBottomRow + (int)pDistMap) == 2)) {
                          nConnFlags = nConnFlags | 0x40;
                          goto LAB_00678494;
                        }
                        break;
                      case 2:
                        if ((*(int *)((int)pCellPtr + nGridX + 4) != bNoOverlap) &&
                           (pCellPtr[1] == 2)) {
                          nConnFlags = nConnFlags | 0x20;
                          goto LAB_00678494;
                        }
                        break;
                      case 3:
                        if ((*(int *)((int)pCellPtr + nGridX + -4) != bNoOverlap) &&
                           (pCellPtr[-1] == 2)) {
                          nConnFlags = nConnFlags | 0x10;
                          goto LAB_00678494;
                        }
                      }
                      pSubIdx = (int *)((int)pSubIdx + 1);
                    } while ((int)pSubIdx < 4);
                    sNewSeed = (D2SeedStrc)
                               (((ulonglong)sNewSeed & 0xffffffff) * 0x6ac690c5 +
                               ((ulonglong)sNewSeed >> 0x20));
                    pDrlg->nSeed = sNewSeed;
                    if ((((ulonglong)sNewSeed & 1) == 0) || (bFoundExit = true, !bSwapped)) {
                      bFoundExit = false;
                    }
                    sNewSeed = (D2SeedStrc)
                               (((ulonglong)sNewSeed & 0xffffffff) * 0x6ac690c5 +
                               ((ulonglong)sNewSeed >> 0x20));
                    pDrlg->nSeed = sNewSeed;
                    pSubIdx = (int *)0x0;
                    do {
                      if (!bFoundExit) break;
                      uVar4 = (sNewSeed.nSeedLow & 3U) + (int)pSubIdx & 0x80000003;
                      if ((int)uVar4 < 0) {
                        uVar4 = (uVar4 - 1 | 0xfffffffc) + 1;
                      }
                      switch(uVar4) {
                      case 0:
                        if (((pSubLevelDistMap[(nGridY + -1) * iVar5 + nExitCol] != 0) &&
                            ((int)pSubLevelDistMap[(nGridY + -1) * iVar5 + nExitCol] < 0xf)) &&
                           (-1 < (char)nConnFlags)) {
                          nConnFlags = nConnFlags | 0x80;
LAB_006785a0:
                          bFoundExit = false;
                        }
                        break;
                      case 1:
                        if (((pSubLevelDistMap[(nGridY + 1) * iVar5 + nExitCol] != 0) &&
                            ((int)pSubLevelDistMap[(nGridY + 1) * iVar5 + nExitCol] < 0xf)) &&
                           ((nConnFlags & 0x40) == 0)) {
                          nConnFlags = nConnFlags | 0x40;
                          goto LAB_006785a0;
                        }
                        break;
                      case 2:
                        if (((pConnFlags[1] != 0) && ((int)pConnFlags[1] < 0xf)) &&
                           ((nConnFlags & 0x20) == 0)) {
                          nConnFlags = nConnFlags | 0x20;
                          goto LAB_006785a0;
                        }
                        break;
                      case 3:
                        if (((pConnFlags[-1] != 0) && ((int)pConnFlags[-1] < 0xf)) &&
                           ((nConnFlags & 0x10) == 0)) {
                          nConnFlags = nConnFlags | 0x10;
                          goto LAB_006785a0;
                        }
                      }
                      pSubIdx = (int *)((int)pSubIdx + 1);
                    } while ((int)pSubIdx < 4);
                  }
                  if ((char)nConnFlags < '\0') {
                    pSubLevelDistMap[(nGridY + -1) * iVar5 + nExitCol] =
                         pSubLevelDistMap[(nGridY + -1) * iVar5 + nExitCol] | 0x40;
                  }
                  if ((nConnFlags & 0x40) != 0) {
                    pSubLevelDistMap[(nGridY + 1) * iVar5 + nExitCol] =
                         pSubLevelDistMap[(nGridY + 1) * iVar5 + nExitCol] | 0x80;
                  }
                  if ((nConnFlags & 0x20) != 0) {
                    pConnFlags[1] = pConnFlags[1] | 0x10;
                  }
                  if ((nConnFlags & 0x10) != 0) {
                    pConnFlags[-1] = pConnFlags[-1] | 0x20;
                  }
                  *pCellPtr = 0;
                }
                *pConnFlags = *pConnFlags | nConnFlags;
                nExitCol = nExitCol + 1;
                pConnFlags = pConnFlags + 1;
              } while (nExitCol < iVar5);
            }
          }
          nGridY = 0;
          pConnFlags = pSubLevelDistMap;
          if (0 < iVar3) {
            do {
              nGridX = 0;
              pRowPtr = pConnFlags;
              if (0 < iVar5) {
                do {
                  nConnFlags = *pRowPtr;
                  uVar4 = nConnFlags & 0x8000000f;
                  if ((int)uVar4 < 0) {
                    uVar4 = (uVar4 - 1 | 0xfffffff0) + 1;
                  }
                  if (uVar4 == 0) {
                    if ((0xf < (int)nConnFlags) &&
                       (uVar4 = gaWildernessLevelSeedOffsets[((int)nConnFlags >> 4) + 0x59],
                       uVar4 == 0)) {
                      nLine = 0x799;
                      goto LAB_00677aa7;
                    }
                  }
                  else if ((int)nConnFlags < 0x10) {
                    uVar4 = uVar4 + 0x211;
                  }
                  else {
                    if ((nConnFlags & 0x10) != 0) {
                      uVar4 = gaWildernessLevelSeedOffsets[uVar4 * 4 + 0x66];
                    }
                    if ((nConnFlags & 0x20) != 0) {
                      uVar4 = gaWildernessLevelSeedOffsets[uVar4 * 4 + 0x67];
                    }
                    if ((nConnFlags & 0x40) != 0) {
                      uVar4 = gaWildernessLevelSeedOffsets[uVar4 * 4 + 0x68];
                    }
                    if ((char)nConnFlags < '\0') {
                      uVar4 = gaWildernessLevelSeedOffsets[uVar4 * 4 + 0x69];
                    }
                    if (uVar4 == 0) {
                      nLine = 0x78c;
                      goto LAB_00677aa7;
                    }
                  }
                  *pRowPtr = uVar4;
                  nGridX = nGridX + 1;
                  pRowPtr = pRowPtr + 1;
                } while (nGridX < iVar5);
              }
              nGridY = nGridY + 1;
              pConnFlags = pConnFlags + iVar5;
            } while (nGridY < iVar3);
          }
          nSubOffset = 0;
          do {
            iVar3 = 0;
            nGridY = 0;
            if (0 < iVar2) {
              do {
                nGridX = 0;
                if (0 < iVar1) {
                  bNoOverlap = *(int *)((int)aSubLevelRecords + nSubOffset + 0x30);
                  do {
                    *(uint *)(bNoOverlap + iVar3 * 4) =
                         pSubLevelDistMap
                         [(*(int *)((int)aSubLevelRecords + nSubOffset + 0x2c) + nGridY) * iVar5 +
                          nGridX + *(int *)((int)aSubLevelRecords + nSubOffset + 0x28)];
                    bNoOverlap = *(int *)((int)aSubLevelRecords + nSubOffset + 0x30);
                    if (0x23e < *(int *)(bNoOverlap + iVar3 * 4)) {
                      pCellPtr = (int *)((int)aSubLevelRecords + nSubOffset + 0x34);
                      *pCellPtr = *pCellPtr + 1;
                    }
                    nGridX = nGridX + 1;
                    iVar3 = iVar3 + 1;
                  } while (nGridX < iVar1);
                }
                nGridY = nGridY + 1;
              } while (nGridY < iVar2);
            }
            nSubOffset = nSubOffset + 0x38;
          } while (nSubOffset < 0xa8);
          do {
            bSwapped = false;
            pCellPtr = aSubLevelRecords + 0xf;
            nSortPass = 2;
            do {
              if (pCellPtr[-0xe] < *pCellPtr) {
                pAdjPtr = pCellPtr + -1;
                pSwapDst = aSwapBuffer;
                for (iVar3 = 0xe; iVar3 != 0; iVar3 = iVar3 + -1) {
                  *pSwapDst = *pAdjPtr;
                  pAdjPtr = pAdjPtr + 1;
                  pSwapDst = pSwapDst + 1;
                }
                pAdjPtr = pCellPtr + -0xf;
                pSwapDst = pCellPtr + -1;
                for (iVar3 = 0xe; iVar3 != 0; iVar3 = iVar3 + -1) {
                  *pSwapDst = *pAdjPtr;
                  pAdjPtr = pAdjPtr + 1;
                  pSwapDst = pSwapDst + 1;
                }
                pAdjPtr = aSwapBuffer;
                pSwapDst = pCellPtr + -0xf;
                for (iVar3 = 0xe; iVar3 != 0; iVar3 = iVar3 + -1) {
                  *pSwapDst = *pAdjPtr;
                  pAdjPtr = pAdjPtr + 1;
                  pSwapDst = pSwapDst + 1;
                }
                bSwapped = true;
              }
              pCellPtr = pCellPtr + 0xe;
              nSortPass = nSortPass + -1;
            } while (nSortPass != 0);
          } while (bSwapped);
          iVar3 = 0;
          pCellPtr = aSubLevelRecords + 0xd;
          do {
            pSubLevel = D2Common::Drlg::Drlg::GetLevelAndAlloc(pDrlg,iVar3 + 0x4c);
            pSubLevel->pAutomapEx = (void *)pCellPtr[-1];
            pSubLevel->nUnknown_1B8 = *pCellPtr;
            (pSubLevel->sCoordinatesAndSize).WorldPosition.x = pCellPtr[-0xd];
            (pSubLevel->sCoordinatesAndSize).WorldPosition.y = pCellPtr[-0xc];
            (pSubLevel->sCoordinatesAndSize).WorldSize.x = pCellPtr[-0xb];
            pSubLevelSizeYSrc = pCellPtr + -10;
            iVar3 = iVar3 + 1;
            pCellPtr = pCellPtr + 0xe;
            (pSubLevel->sCoordinatesAndSize).WorldSize.y = *pSubLevelSizeYSrc;
          } while (iVar3 < 3);
          Fog::Memory::FreeServerMemory
                    (pPoolManagerStrc,pSubLevelMap,".\\DRLG\\OutPlace.cpp",0x7d2,0);
          Fog::Memory::FreeServerMemory
                    (pPoolManagerStrc,pDistWorkMap,".\\DRLG\\OutPlace.cpp",0x7d3,0);
          Fog::Memory::FreeServerMemory(pPoolManagerStrc,pDistMap,".\\DRLG\\OutPlace.cpp",0x7d4,0);
          Fog::Memory::FreeServerMemory
                    (pPoolManagerStrc,pSubLevelDistMap,".\\DRLG\\OutPlace.cpp",0x7d5,0);
          return pSubLevel;
        }
        nLine = 0x64e;
      }
      else {
        nLine = 0x64d;
      }
LAB_00677aa7:
      nAddress = Fog::Src::ErrorManager::GetInstructionPointer();
      Fog::Src::ErrorManager::ERROR_UnrecoverableInternalError_Halt("",nAddress,nLine);
                    /* WARNING: Subroutine does not return */
      compiler::_exit(-1);
    }
  } while( true );
}

