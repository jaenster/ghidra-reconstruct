void dummy(TSExplicitList<::CELLIST, -572662307>* pThis, ::CELLIST* pNode, uint32_t nLinkType, ::CELLIST* pExisting) {
  TSLink<::CELLIST>* pTVar1;
  TSLink<::CELLIST>* pSrcSlot;
  int pSrcEntry;
  intptr_t pTailLink2;
  intptr_t pTailLink;
  if (!pNode) {
    pSrcSlot = &this->m_terminator;
  } else {
    pSrcSlot = (TSLink<::CELLIST>*)((intptr_t)&pNode->m_hashval + this->m_linkoffset);
  }
  TSLink<::CELLIST>* pDstSlot = pSrcSlot->m_prevlink;
  if (pDstSlot) {
    TSLink<::CELLIST>** pBackLink;
    pTailLink = pSrcSlot->m_next;
    if (pTailLink < 0) {
      pBackLink = (TSLink<::CELLIST>**)~pTailLink;
    } else {
      pBackLink = (TSLink<::CELLIST>**)((int)pSrcSlot + (pTailLink - pDstSlot->m_next));
    }
    *pBackLink = pDstSlot;
    pSrcSlot->m_prevlink->m_next = pSrcSlot->m_next;
    pSrcSlot->m_prevlink = 0;
    pSrcSlot->m_next = 0;
  }
  if (!pExisting) {
    pDstSlot = &this->m_terminator;
  } else {
    pDstSlot = (TSLink<::CELLIST>*)((intptr_t)&pExisting->m_hashval + this->m_linkoffset);
  }
  switch (nLinkType) {
    case 1:
      {
        pSrcSlot->m_prevlink = pDstSlot;
        pSrcSlot->m_next = pDstSlot->m_next;
        pSrcEntry = this->m_linkoffset;
        pTailLink2 = pDstSlot->m_next;
        if (pTailLink2 < 0) {
          *(TSLink<::CELLIST>**)~pTailLink2 = (TSLink<::CELLIST>*)pSrcSlot;
          pDstSlot->m_next = (intptr_t)pNode;
          return;
        }
        if (pSrcEntry < 0) {
          pSrcEntry = (int)pDstSlot - pDstSlot->m_prevlink->m_next;
        }
        *(TSLink<::CELLIST>**)(pTailLink2 + pSrcEntry) = (TSLink<::CELLIST>*)pSrcSlot;
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
