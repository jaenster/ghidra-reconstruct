void dummy(int** ppList, int** pNode, int32_t nMode, int** ppAnchor) {
  int* piVar1;
  uint32_t piTmp;
  StormLinkStrc* ppCur = (StormLinkStrc*)pNode;
  if (!pNode) {
    ppCur = (StormLinkStrc*)(ppList + 1);
  }
  StormLinkStrc* piNext = ppCur->pPrevLink;
  if (piNext) {
    StormLinkStrc** pBacklink;
    piTmp = ppCur->pNext;
    if ((int)piTmp < 0) {
      pBacklink = (StormLinkStrc**)~piTmp;
    } else {
      pBacklink = (StormLinkStrc**)((int)ppCur + (piTmp - piNext->pNext));
    }
    *pBacklink = piNext;
    ppCur->pPrevLink->pNext = ppCur->pNext;
    ppCur->pPrevLink = 0;
    ppCur->pNext = 0;
  }
  if (!ppAnchor) {
    ppAnchor = ppList + 1;
  }
  switch (nMode) {
    case 1:
      {
        ppCur->pPrevLink = (StormLinkStrc*)ppAnchor;
        ppCur->pNext = ((StormLinkStrc*)ppAnchor)->pNext;
        piVar1 = *ppList;
        piTmp = ((StormLinkStrc*)ppAnchor)->pNext;
        if ((int)piTmp < 0) {
          *(StormLinkStrc**)~piTmp = (StormLinkStrc*)ppCur;
          ((StormLinkStrc*)ppAnchor)->pNext = (intptr_t)pNode;
          return;
        }
        if ((int)piVar1 < 0) {
          piVar1 = (int*)((int)ppAnchor - ((StormLinkStrc*)ppAnchor)->pPrevLink->pNext);
        }
        *(StormLinkStrc**)(piTmp + (int)piVar1) = (StormLinkStrc*)ppCur;
        ((StormLinkStrc*)ppAnchor)->pNext = (intptr_t)pNode;
        return;
      }
    default:
      {
        piNext = ((StormLinkStrc*)ppAnchor)->pPrevLink;
        ppCur->pPrevLink = piNext;
        ppCur->pNext = piNext->pNext;
        piNext->pNext = (intptr_t)pNode;
        ((StormLinkStrc*)ppAnchor)->pPrevLink = ppCur;
        return;
      }
  }
}
