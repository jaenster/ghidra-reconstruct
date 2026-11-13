void dummy(int** pList, int** ppNodeSlot, int32_t nInsertMode, int** ppTargetList) {
  StormLinkStrc* pTargetNode = (StormLinkStrc*)ppNodeSlot;
  if (!ppNodeSlot) {
    pTargetNode = (StormLinkStrc*)(pList + 1);
  }
  StormLinkStrc* pPrevNode = pTargetNode->pPrevLink;
  if (pPrevNode) {
    StormLinkStrc** pLinkSlot;
    pLinkSlot = (StormLinkStrc**)D2_StormNextLink(pTargetNode, -1);
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
        *(StormLinkStrc**)D2_StormNextLink((StormLinkStrc*)ppTargetList, (intptr_t)*pList) = (StormLinkStrc*)pTargetNode;
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
