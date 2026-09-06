/* WARNING: Unknown calling convention */
/* WARNING: Enum "eCollisionFlags": Some values do not have unique names */
/* WARNING: Enum "eD2TimerType": Some values do not have unique names */
/* WARNING: Enum "eD2TimerTypeDWORD": Some values do not have unique names */
/* @function CheckCollision_BlockPlayer_Cross
   @address Game.exe.ram:0064d4e0
   @date 2026.09.05
   @params
     pRoom: Stack[0x4]:4 (D2RoomStrc *)
     nX: Stack[0x8]:4 (int32_t)
     nY: Stack[0xc]:4 (int32_t)
     eCollisionFlag: ESI:4 (int32_t)
   @description Tests player collision in a plus/cross pattern (center + 4 orthogonal neighbors) at
   tile (nX,nY) against eCollisionFlag in the room's collision grid. Resolves the owning room via
   DRLGROOM_FindBetterNearbyRoom and the grid via DRLGROOM_GetCollisionGridFromRoom; returns
   COLLIDE_BLOCK_PLAYER if the room/grid is missing. Builds an edge-case mask (cEdgeCase bits) for
   cells that fall outside the current room's bounds and recurses into the neighbor room via
   CheckCollision_BlockPlayerMissile_Internal1 for those. Returns COLLIDE_NONE only if all sampled
   cells are clear, else COLLIDE_BLOCK_PLAYER. Uses custom register args (eCollisionFlag in SI). */

int32_t D2Common::Collision::Collision::CheckCollision_BlockPlayer_Cross
                  (D2RoomStrc *pRoom,int32_t nX,int32_t nY,int32_t eCollisionFlag)

{
  eCollisionFlags eNeighborCollision;
  eCollisionFlags eAdjacentResult;
  eCollisionFlags eCollisionResult;
  D2RoomStrc *pRoom_00;
  D2RoomCollisionGridStrc *pCollisionGrid;
  eCollisionFlags eCollisionMask;
  int32_t nXp1;
  char cEdgeCase;
  int nGridStride;
  int nXStart;
  int nYStart;
  int nYp1;
  eCollisionFlags *pCell;
  
  pRoom_00 = D2Client::UNIT::Player::DRLGROOM_FindBetterNearbyRoom(pRoom,nX,nY);
  if (pRoom_00 == (D2RoomStrc *)0x0) {
    return 1;
  }
  pCollisionGrid = D2Common::DUNGEON::Dungeon::DRLGROOM_GetCollisionGridFromRoom(pRoom_00);
  if (pCollisionGrid == (D2RoomCollisionGridStrc *)0x0) {
    return 1;
  }
  if (pCollisionGrid->pMapStart == (eCollisionFlags *)0x0) {
    return 1;
  }
  nXStart = (pCollisionGrid->sCoords).dwXStart;
  cEdgeCase = nX <= nXStart;
  nYStart = (pCollisionGrid->sCoords).dwYStart;
  if (nY <= nYStart) {
    cEdgeCase = cEdgeCase + '\x02';
  }
  nGridStride = (pCollisionGrid->sCoords).dwXSize;
  nXp1 = nX + 1;
  if (nGridStride + nXStart <= nXp1) {
    cEdgeCase = cEdgeCase + '\x04';
  }
  nYp1 = nY + 1;
  if ((pCollisionGrid->sCoords).dwYSize + nYStart <= nYp1) {
    cEdgeCase = cEdgeCase + '\b';
  }
  pCell = pCollisionGrid->pMapStart + ((nY - nYStart) * nGridStride - nXStart) + nX;
  if (false) {
    return 1;
  }
  eCollisionMask = (eCollisionFlags)eCollisionFlag;
  switch(cEdgeCase) {
  case '\0':
    if ((*pCell & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    if ((pCell[-1] & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    if ((pCell[1] & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    if ((pCell[-nGridStride] & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    if ((pCell[nGridStride] & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    return 0;
  case '\x01':
    if ((*pCell & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    if ((pCell[1] & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    if ((pCell[-nGridStride] & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    if ((pCell[nGridStride] & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    nX = nX + -1;
    break;
  case '\x02':
    if ((*pCell & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    if ((pCell[-1] & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    if ((pCell[1] & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    if ((pCell[nGridStride] & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    nY = nY + -1;
    break;
  case '\x03':
    if ((*pCell & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    if ((pCell[1] & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    if ((pCell[nGridStride] & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    eNeighborCollision =
         D2Common::Collision::Collision::CheckCollision_BlockPlayerMissile_Internal1
                   (pRoom_00,nX,nY + -1,eCollisionFlag);
    if (eNeighborCollision != COLLIDE_NONE ) {
      return 1;
    }
    nX = nX + -1;
    break;
  case '\x04':
    if ((*pCell & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    if ((pCell[-1] & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    if ((pCell[-nGridStride] & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    eAdjacentResult = pCell[nGridStride] & eCollisionMask;
    nX = nXp1;
    goto joined_r0x0064d758;
  default:
    goto switchD_0064d58f_caseD_5;
  case '\x06':
    if ((*pCell & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    if ((pCell[-1] & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    if ((pCell[nGridStride] & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    eNeighborCollision =
         D2Common::Collision::Collision::CheckCollision_BlockPlayerMissile_Internal1
                   (pRoom_00,nXp1,nY,eCollisionFlag);
    if (eNeighborCollision != COLLIDE_NONE ) {
      return 1;
    }
    nY = nY + -1;
    break;
  case '\b':
    if ((*pCell & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    if ((pCell[-1] & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    if ((pCell[1] & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    eAdjacentResult = pCell[-nGridStride] & eCollisionMask;
    nY = nYp1;
    goto joined_r0x0064d758;
  case '\t':
    if ((*pCell & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    if ((pCell[1] & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    if ((pCell[-nGridStride] & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    nXp1 = nX + -1;
    goto LAB_0064d748;
  case '\f':
    if ((*pCell & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    if ((pCell[-1] & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
    if ((pCell[-nGridStride] & eCollisionMask) != COLBIT_NONE) {
      return 1;
    }
LAB_0064d748:
    eAdjacentResult =
         D2Common::Collision::Collision::CheckCollision_BlockPlayerMissile_Internal1
                   (pRoom_00,nXp1,nY,eCollisionFlag);
    nY = nYp1;
joined_r0x0064d758:
    if (eAdjacentResult != COLBIT_NONE) {
      return 1;
    }
  }
  eCollisionResult =
       D2Common::Collision::Collision::CheckCollision_BlockPlayerMissile_Internal1
                 (pRoom_00,nX,nY,eCollisionFlag);
  if (eCollisionResult == COLBIT_NONE) {
    return 0;
  }
switchD_0064d58f_caseD_5:
  return 1;
}

