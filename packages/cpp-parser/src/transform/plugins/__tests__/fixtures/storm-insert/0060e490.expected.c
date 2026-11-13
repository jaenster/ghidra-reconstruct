void dummy(TSExplicitList<::StringEntryNode, -572662307>* pThis, ::StringEntryNode* pNode, uint32_t nLinkType, ::StringEntryNode* pExisting) {
  TSLink<::StringEntryNode>* pTVar1;
  TSLink<::StringEntryNode>* pSrcSlot;
  if (!pNode) {
    pSrcSlot = &this->m_terminator;
  } else {
    pSrcSlot = (TSLink<::StringEntryNode>*)((intptr_t)&pNode->m_hashval + this->m_linkoffset);
  }
  TSLink<::StringEntryNode>* pDstSlot = pSrcSlot->m_prevlink;
  if (pDstSlot) {
    TSLink<::StringEntryNode>** pPrevLink;
    pPrevLink = (TSLink<::StringEntryNode>**)D2_StormNextLink(pSrcSlot, -1);
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
        *(TSLink<::StringEntryNode>**)D2_StormNextLink(pDstSlot, this->m_linkoffset) = (TSLink<::StringEntryNode>*)pSrcSlot;
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
