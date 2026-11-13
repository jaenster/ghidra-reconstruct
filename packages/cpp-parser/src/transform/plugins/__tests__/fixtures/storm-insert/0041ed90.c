void dummy(int** pListHead, int** pNode, int32_t nInsertAtHead, int** pInsertRef) {
  int* piVar1;
  uint32_t pNeighbor2;
  StormLinkStrc* pNodeCur = (StormLinkStrc*)pNode;
  if (!pNode) {
    pNodeCur = (StormLinkStrc*)(pListHead + 1);
  }
  StormLinkStrc* pNeighbor = pNodeCur->pPrevLink;
  if (pNeighbor) {
    StormLinkStrc** pLinkTarget;
    pNeighbor2 = pNodeCur->pNext;
    if ((int)pNeighbor2 < 0) {
      pLinkTarget = (StormLinkStrc**)~pNeighbor2;
    } else {
      pLinkTarget = (StormLinkStrc**)((int)pNodeCur + (pNeighbor2 - pNeighbor->pNext));
    }
    *pLinkTarget = pNeighbor;
    pNodeCur->pPrevLink->pNext = pNodeCur->pNext;
    pNodeCur->pPrevLink = 0;
    pNodeCur->pNext = 0;
  }
  if (!pInsertRef) {
    pInsertRef = pListHead + 1;
  }
  switch (nInsertAtHead) {
    case 1:
      {
        pNodeCur->pPrevLink = (StormLinkStrc*)pInsertRef;
        pNodeCur->pNext = ((StormLinkStrc*)pInsertRef)->pNext;
        piVar1 = *pListHead;
        pNeighbor2 = ((StormLinkStrc*)pInsertRef)->pNext;
        if ((int)pNeighbor2 < 0) {
          *(StormLinkStrc**)~pNeighbor2 = (StormLinkStrc*)pNodeCur;
          ((StormLinkStrc*)pInsertRef)->pNext = (intptr_t)pNode;
          return;
        }
        if ((int)piVar1 < 0) {
          piVar1 = (int*)((int)pInsertRef - ((StormLinkStrc*)pInsertRef)->pPrevLink->pNext);
        }
        *(StormLinkStrc**)(pNeighbor2 + (int)piVar1) = (StormLinkStrc*)pNodeCur;
        ((StormLinkStrc*)pInsertRef)->pNext = (intptr_t)pNode;
        return;
      }
    default:
      {
        pNeighbor = ((StormLinkStrc*)pInsertRef)->pPrevLink;
        pNodeCur->pPrevLink = pNeighbor;
        pNodeCur->pNext = pNeighbor->pNext;
        pNeighbor->pNext = (intptr_t)pNode;
        ((StormLinkStrc*)pInsertRef)->pPrevLink = pNodeCur;
        return;
      }
  }
}
