void dummy(TSExplicitList<::MappingEntryNode, -572662307>* pThis, ::MappingEntryNode* pNode, uint32_t nLinkType, ::MappingEntryNode* pExisting) {
  TSLink<::MappingEntryNode>* pTVar1;
  TSLink<::MappingEntryNode>* pSrcSlot;
  int pCurHead;
  intptr_t pTailLink2;
  intptr_t pTailLink;
  if (!pNode) {
    pSrcSlot = &this->m_terminator;
  } else {
    pSrcSlot = (TSLink<::MappingEntryNode>*)((intptr_t)&pNode->m_hashval + this->m_linkoffset);
  }
  TSLink<::MappingEntryNode>* pDestSlot = pSrcSlot->m_prevlink;
  if (pDestSlot) {
    TSLink<::MappingEntryNode>** pPrevLink;
    pTailLink = pSrcSlot->m_next;
    if (pTailLink < 0) {
      pPrevLink = (TSLink<::MappingEntryNode>**)~pTailLink;
    } else {
      pPrevLink = (TSLink<::MappingEntryNode>**)((int)pSrcSlot + (pTailLink - pDestSlot->m_next));
    }
    *pPrevLink = pDestSlot;
    pSrcSlot->m_prevlink->m_next = pSrcSlot->m_next;
    pSrcSlot->m_prevlink = 0;
    pSrcSlot->m_next = 0;
  }
  if (!pExisting) {
    pDestSlot = &this->m_terminator;
  } else {
    pDestSlot = (TSLink<::MappingEntryNode>*)((intptr_t)&pExisting->m_hashval + this->m_linkoffset);
  }
  switch (nLinkType) {
    case 1:
      {
        pSrcSlot->m_prevlink = pDestSlot;
        pSrcSlot->m_next = pDestSlot->m_next;
        pCurHead = this->m_linkoffset;
        pTailLink2 = pDestSlot->m_next;
        if (pTailLink2 < 0) {
          *(TSLink<::MappingEntryNode>**)~pTailLink2 = (TSLink<::MappingEntryNode>*)pSrcSlot;
          pDestSlot->m_next = (intptr_t)pNode;
          return;
        }
        if (pCurHead < 0) {
          pCurHead = (int)pDestSlot - pDestSlot->m_prevlink->m_next;
        }
        *(TSLink<::MappingEntryNode>**)(pTailLink2 + pCurHead) = (TSLink<::MappingEntryNode>*)pSrcSlot;
        pDestSlot->m_next = (intptr_t)pNode;
        return;
      }
    default:
      {
        pTVar1 = pDestSlot->m_prevlink;
        pSrcSlot->m_prevlink = pTVar1;
        pSrcSlot->m_next = pTVar1->m_next;
        pTVar1->m_next = (intptr_t)pNode;
        pDestSlot->m_prevlink = pSrcSlot;
        return;
      }
  }
}
