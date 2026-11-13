void dummy(StormLinkedListStrc* ppListContainer, int** pNode, int32_t nInsertMode, int** ppListHead) {
  intptr_t nLinkOffset;
  uint32_t uPrevLinkRaw;
  StormLinkStrc* ppSlot = (StormLinkStrc*)pNode;
  if (!pNode) {
    ppSlot = &ppListContainer->head;
  }
  StormLinkStrc* pEntry = ppSlot->pPrevLink;
  if (pEntry) {
    StormLinkStrc** pLink;
    uPrevLinkRaw = ppSlot->pNext;
    if ((int)uPrevLinkRaw < 0) {
      pLink = (StormLinkStrc**)~uPrevLinkRaw;
    } else {
      pLink = (StormLinkStrc**)((int)ppSlot + (uPrevLinkRaw - pEntry->pNext));
    }
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
        nLinkOffset = ppListContainer->nLinkOffset;
        uPrevLinkRaw = ((StormLinkStrc*)ppListHead)->pNext;
        if ((int)uPrevLinkRaw < 0) {
          *(StormLinkStrc**)~uPrevLinkRaw = (StormLinkStrc*)ppSlot;
          ((StormLinkStrc*)ppListHead)->pNext = (intptr_t)pNode;
          return;
        }
        if (nLinkOffset < 0) {
          nLinkOffset = (int)ppListHead - ((StormLinkStrc*)ppListHead)->pPrevLink->pNext;
        }
        *(StormLinkStrc**)(uPrevLinkRaw + nLinkOffset) = (StormLinkStrc*)ppSlot;
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
