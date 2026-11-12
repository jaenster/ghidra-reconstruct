void dummy(int** pList, int** pNode, int32_t nInsertMode, int** ppTarget) {
  StormLinkStrc* pEffectiveNode = (StormLinkStrc*)pNode;
  if (!pNode) {
    pEffectiveNode = (StormLinkStrc*)(pList + 1);
  }
  StormLinkStrc* pLink = pEffectiveNode->pPrevLink;
  if (pLink) {
    StormLinkStrc** ppPrevLink;
    ppPrevLink = (StormLinkStrc**)D2_StormNextLink(pEffectiveNode, -1);
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
        *(StormLinkStrc**)D2_StormNextLink((StormLinkStrc*)ppTarget, (intptr_t)*pList) = (StormLinkStrc*)pEffectiveNode;
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
