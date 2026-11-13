void dummy(int** pList, int** ppNodeSlot, int32_t nInsertMode, int** ppTargetList) {
  int* piVar1;
  uint32_t piVar2;
  StormLinkStrc* pTargetNode = (StormLinkStrc*)ppNodeSlot;
  if (!ppNodeSlot) {
    pTargetNode = (StormLinkStrc*)(pList + 1);
  }
  StormLinkStrc* pPrevNode = pTargetNode->pPrevLink;
  if (pPrevNode) {
    StormLinkStrc** pLinkSlot;
    piVar2 = pTargetNode->pNext;
    if ((int)piVar2 < 0) {
      pLinkSlot = (StormLinkStrc**)~piVar2;
    } else {
      pLinkSlot = (StormLinkStrc**)((int)pTargetNode + (piVar2 - pPrevNode->pNext));
    }
    *pLinkSlot = pPrevNode;
    pTargetNode->pPrevLink->pNext = pTargetNode->pNext;
    pTargetNode->pPrevLink = 0;
    pTargetNode->pNext = 0;
  }
  if (!ppTargetList) {
    ppTargetList = pList + 1;
  }
  switch (nInsertMode) {
    case 1:
      {
        pTargetNode->pPrevLink = (StormLinkStrc*)ppTargetList;
        pTargetNode->pNext = ((StormLinkStrc*)ppTargetList)->pNext;
        piVar1 = *pList;
        piVar2 = ((StormLinkStrc*)ppTargetList)->pNext;
        if ((int)piVar2 < 0) {
          *(StormLinkStrc**)~piVar2 = (StormLinkStrc*)pTargetNode;
          ((StormLinkStrc*)ppTargetList)->pNext = (intptr_t)ppNodeSlot;
          return;
        }
        if ((int)piVar1 < 0) {
          piVar1 = (int*)((int)ppTargetList - ((StormLinkStrc*)ppTargetList)->pPrevLink->pNext);
        }
        *(StormLinkStrc**)(piVar2 + (int)piVar1) = (StormLinkStrc*)pTargetNode;
        ((StormLinkStrc*)ppTargetList)->pNext = (intptr_t)ppNodeSlot;
        return;
      }
    default:
      {
        pPrevNode = ((StormLinkStrc*)ppTargetList)->pPrevLink;
        pTargetNode->pPrevLink = pPrevNode;
        pTargetNode->pNext = pPrevNode->pNext;
        pPrevNode->pNext = (intptr_t)ppNodeSlot;
        ((StormLinkStrc*)ppTargetList)->pPrevLink = pTargetNode;
        return;
      }
  }
}
