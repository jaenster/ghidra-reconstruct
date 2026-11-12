void dummy(TSExplicitList<::MappingEntryNode, -572662307>* pThis, ::MappingEntryNode* pNode, uint32_t nLinkType, ::MappingEntryNode* pExisting) {
  TSLink<::MappingEntryNode>* pTVar1;
  TSLink<::MappingEntryNode>* pSrcSlot;
  if (!pNode) {
    pSrcSlot = &this->m_terminator;
  } else {
    pSrcSlot = (TSLink<::MappingEntryNode>*)((intptr_t)&pNode->m_hashval + this->m_linkoffset);
  }
  TSLink<::MappingEntryNode>* pDestSlot = pSrcSlot->m_prevlink;
  if (pDestSlot) {
    TSLink<::MappingEntryNode>** pPrevLink;
    pPrevLink = (TSLink<::MappingEntryNode>**)D2_StormNextLink(pSrcSlot, -1);
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
        *(TSLink<::MappingEntryNode>**)D2_StormNextLink(pDestSlot, this->m_linkoffset) = (TSLink<::MappingEntryNode>*)pSrcSlot;
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
