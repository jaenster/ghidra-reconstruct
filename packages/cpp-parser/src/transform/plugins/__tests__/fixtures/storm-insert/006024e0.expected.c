void dummy(TSExplicitList<::CELLIST, -572662307>* pThis, ::CELLIST* pNode, uint32_t nLinkType, ::CELLIST* pExisting) {
  TSLink<::CELLIST>* pTVar1;
  TSLink<::CELLIST>* pSrcSlot;
  if (!pNode) {
    pSrcSlot = &this->m_terminator;
  } else {
    pSrcSlot = (TSLink<::CELLIST>*)((intptr_t)&pNode->m_hashval + this->m_linkoffset);
  }
  TSLink<::CELLIST>* pDstSlot = pSrcSlot->m_prevlink;
  if (pDstSlot) {
    TSLink<::CELLIST>** pBackLink;
    pBackLink = (TSLink<::CELLIST>**)D2_StormNextLink(pSrcSlot, -1);
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
        *(TSLink<::CELLIST>**)D2_StormNextLink(pDstSlot, this->m_linkoffset) = (TSLink<::CELLIST>*)pSrcSlot;
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
