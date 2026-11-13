void dummy(TSExplicitList<::StringEntryNode, -572662307>* pThis, ::StringEntryNode* pNode, uint32_t nLinkType, ::StringEntryNode* pExisting) {
  TSLink<::StringEntryNode>* pTVar1;
  TSLink<::StringEntryNode>* pSrcSlot;
  int pCurHead;
  intptr_t pTailLink;
  intptr_t pTailLink2;
  if (!pNode) {
    pSrcSlot = &this->m_terminator;
  } else {
    pSrcSlot = (TSLink<::StringEntryNode>*)((intptr_t)&pNode->m_hashval + this->m_linkoffset);
  }
  TSLink<::StringEntryNode>* pDstSlot = pSrcSlot->m_prevlink;
  if (pDstSlot) {
    TSLink<::StringEntryNode>** pPrevLink;
    pTailLink = pSrcSlot->m_next;
    if (pTailLink < 0) {
      pPrevLink = (TSLink<::StringEntryNode>**)~pTailLink;
    } else {
      pPrevLink = (TSLink<::StringEntryNode>**)((int)pSrcSlot + (pTailLink - pDstSlot->m_next));
    }
    *pPrevLink = pDstSlot;
    pSrcSlot->m_prevlink->m_next = pSrcSlot->m_next;
    pSrcSlot->m_prevlink = 0;
    pSrcSlot->m_next = 0;
  }
  if (!pExisting) {
    pDstSlot = &this->m_terminator;
  } else {
    pDstSlot = (TSLink<::StringEntryNode>*)((intptr_t)&pExisting->m_hashval + this->m_linkoffset);
  }
  switch (nLinkType) {
    case 1:
      {
        pSrcSlot->m_prevlink = pDstSlot;
        pSrcSlot->m_next = pDstSlot->m_next;
        pCurHead = this->m_linkoffset;
        pTailLink2 = pDstSlot->m_next;
        if (pTailLink2 < 0) {
          *(TSLink<::StringEntryNode>**)~pTailLink2 = (TSLink<::StringEntryNode>*)pSrcSlot;
          pDstSlot->m_next = (intptr_t)pNode;
          return;
        }
        if (pCurHead < 0) {
          pCurHead = (int)pDstSlot - pDstSlot->m_prevlink->m_next;
        }
        *(TSLink<::StringEntryNode>**)(pTailLink2 + pCurHead) = (TSLink<::StringEntryNode>*)pSrcSlot;
        pDstSlot->m_next = (intptr_t)pNode;
        return;
      }
    default:
      {
        pTVar1 = pDstSlot->m_prevlink;
        pSrcSlot->m_prevlink = pTVar1;
        pSrcSlot->m_next = pTVar1->m_next;
        pTVar1->m_next = (intptr_t)pNode;
        pDstSlot->m_prevlink = pSrcSlot;
        return;
      }
  }
}
