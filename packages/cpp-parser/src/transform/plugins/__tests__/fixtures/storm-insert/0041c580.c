void dummy(int** pList, int** pNode, int32_t nInsertMode, int** ppTarget) {
  int* piVar1;
  uint32_t piVar2;
  StormLinkStrc* pEffectiveNode = (StormLinkStrc*)pNode;
  if (!pNode) {
    pEffectiveNode = (StormLinkStrc*)(pList + 1);
  }
  StormLinkStrc* pLink = pEffectiveNode->pPrevLink;
  if (pLink) {
    StormLinkStrc** ppPrevLink;
    piVar2 = pEffectiveNode->pNext;
    if ((int)piVar2 < 0) {
      ppPrevLink = (StormLinkStrc**)~piVar2;
    } else {
      ppPrevLink = (StormLinkStrc**)((int)pEffectiveNode + (piVar2 - pLink->pNext));
    }
    *ppPrevLink = pLink;
    pEffectiveNode->pPrevLink->pNext = pEffectiveNode->pNext;
    pEffectiveNode->pPrevLink = 0;
    pEffectiveNode->pNext = 0;
  }
  if (!ppTarget) {
    ppTarget = pList + 1;
  }
  switch (nInsertMode) {
    case 1:
      {
        pEffectiveNode->pPrevLink = (StormLinkStrc*)ppTarget;
        pEffectiveNode->pNext = ((StormLinkStrc*)ppTarget)->pNext;
        piVar1 = *pList;
        piVar2 = ((StormLinkStrc*)ppTarget)->pNext;
        if ((int)piVar2 < 0) {
          *(StormLinkStrc**)~piVar2 = (StormLinkStrc*)pEffectiveNode;
          ((StormLinkStrc*)ppTarget)->pNext = (intptr_t)pNode;
          return;
        }
        if ((int)piVar1 < 0) {
          piVar1 = (int*)((int)ppTarget - ((StormLinkStrc*)ppTarget)->pPrevLink->pNext);
        }
        *(StormLinkStrc**)(piVar2 + (int)piVar1) = (StormLinkStrc*)pEffectiveNode;
        ((StormLinkStrc*)ppTarget)->pNext = (intptr_t)pNode;
        return;
      }
    default:
      {
        pLink = ((StormLinkStrc*)ppTarget)->pPrevLink;
        pEffectiveNode->pPrevLink = pLink;
        pEffectiveNode->pNext = pLink->pNext;
        pLink->pNext = (intptr_t)pNode;
        ((StormLinkStrc*)ppTarget)->pPrevLink = pEffectiveNode;
        return;
      }
  }
}
