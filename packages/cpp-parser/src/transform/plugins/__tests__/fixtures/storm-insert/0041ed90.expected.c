void dummy(int** pListHead, int** pNode, int32_t nInsertAtHead, int** pInsertRef) {
  StormLinkStrc* pNodeCur = (StormLinkStrc*)pNode;
  if (!pNode) {
    pNodeCur = (StormLinkStrc*)(pListHead + 1);
  }
  StormLinkStrc* pNeighbor = pNodeCur->pPrevLink;
  if (pNeighbor) {
    StormLinkStrc** pLinkTarget;
    pLinkTarget = (StormLinkStrc**)D2_StormNextLink(pNodeCur, -1);
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
        *(StormLinkStrc**)D2_StormNextLink((StormLinkStrc*)pInsertRef, (intptr_t)*pListHead) = (StormLinkStrc*)pNodeCur;
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
