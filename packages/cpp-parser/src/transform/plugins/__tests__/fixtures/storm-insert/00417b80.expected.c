void dummy(StormLinkedListStrc* ppListContainer, int** pNode, int32_t nInsertMode, int** ppListHead) {
  StormLinkStrc* ppSlot = (StormLinkStrc*)pNode;
  if (!pNode) {
    ppSlot = &ppListContainer->head;
  }
  StormLinkStrc* pEntry = ppSlot->pPrevLink;
  if (pEntry) {
    StormLinkStrc** pLink;
    pLink = (StormLinkStrc**)D2_StormNextLink(ppSlot, -1);
    *pLink = pEntry;
    ppSlot->pPrevLink->pNext = ppSlot->pNext;
    ppSlot->pPrevLink = 0;
    ppSlot->pNext = 0;
  }
  if (!ppListHead) {
    ppListHead = (int**)&ppListContainer->head;
  }
  switch (nInsertMode) {
    case 1:
      {
        ppSlot->pPrevLink = (StormLinkStrc*)ppListHead;
        ppSlot->pNext = ((StormLinkStrc*)ppListHead)->pNext;
        *(StormLinkStrc**)D2_StormNextLink((StormLinkStrc*)ppListHead, ppListContainer->nLinkOffset) = (StormLinkStrc*)ppSlot;
        ((StormLinkStrc*)ppListHead)->pNext = (intptr_t)pNode;
        return;
      }
    default:
      {
        pEntry = ((StormLinkStrc*)ppListHead)->pPrevLink;
        ppSlot->pPrevLink = pEntry;
        ppSlot->pNext = pEntry->pNext;
        pEntry->pNext = (intptr_t)pNode;
        ((StormLinkStrc*)ppListHead)->pPrevLink = ppSlot;
        return;
      }
  }
}
