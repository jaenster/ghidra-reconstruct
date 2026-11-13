void dummy(int** ppListContainer, int** pNode, int32_t nInsertMode, int** ppListHead) {
  int* piVar1;
  uint32_t piVar2;
  StormLinkStrc* ppSlot = (StormLinkStrc*)pNode;
  if (!pNode) {
    ppSlot = (StormLinkStrc*)(ppListContainer + 1);
  }
  StormLinkStrc* pEntry = ppSlot->pPrevLink;
  if (pEntry) {
    StormLinkStrc** pLink;
    piVar2 = ppSlot->pNext;
    if ((int)piVar2 < 0) {
      pLink = (StormLinkStrc**)~piVar2;
    } else {
      pLink = (StormLinkStrc**)((int)ppSlot + (piVar2 - pEntry->pNext));
    }
    *pLink = pEntry;
    ppSlot->pPrevLink->pNext = ppSlot->pNext;
    ppSlot->pPrevLink = 0;
    ppSlot->pNext = 0;
  }
  if (!ppListHead) {
    ppListHead = ppListContainer + 1;
  }
  switch (nInsertMode) {
    case 1:
      {
        ppSlot->pPrevLink = (StormLinkStrc*)ppListHead;
        ppSlot->pNext = ((StormLinkStrc*)ppListHead)->pNext;
        piVar1 = *ppListContainer;
        piVar2 = ((StormLinkStrc*)ppListHead)->pNext;
        if ((int)piVar2 < 0) {
          *(StormLinkStrc**)~piVar2 = (StormLinkStrc*)ppSlot;
          ((StormLinkStrc*)ppListHead)->pNext = (intptr_t)pNode;
          return;
        }
        if ((int)piVar1 < 0) {
          piVar1 = (int*)((int)ppListHead - ((StormLinkStrc*)ppListHead)->pPrevLink->pNext);
        }
        *(StormLinkStrc**)(piVar2 + (int)piVar1) = (StormLinkStrc*)ppSlot;
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
