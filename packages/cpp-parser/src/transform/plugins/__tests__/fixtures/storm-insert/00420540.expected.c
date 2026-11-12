void dummy(int** ppList, int** pNode, int32_t nMode, int** ppAnchor) {
  StormLinkStrc* ppCur = (StormLinkStrc*)pNode;
  if (!pNode) {
    ppCur = (StormLinkStrc*)(ppList + 1);
  }
  StormLinkStrc* piNext = ppCur->pPrevLink;
  if (piNext) {
    StormLinkStrc** pBacklink;
    pBacklink = (StormLinkStrc**)D2_StormNextLink(ppCur, -1);
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
        *(StormLinkStrc**)D2_StormNextLink((StormLinkStrc*)ppAnchor, (intptr_t)*ppList) = (StormLinkStrc*)ppCur;
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
