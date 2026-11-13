void dummy(TSExplicitList<TSHashObjectChunk<::CELLIST, HASHKEY_NONE>, 16>* pThis, TSHashObjectChunk<::CELLIST, HASHKEY_NONE>* pNode, uint32_t nLinkType, TSHashObjectChunk<::CELLIST, HASHKEY_NONE>* pExisting) {
  TSLink<TSHashObjectChunk<::CELLIST, HASHKEY_NONE>>* pTVar1;
  TSLink<TSHashObjectChunk<::CELLIST, HASHKEY_NONE>>* ppSrcSlot;
  if (!pNode) {
    ppSrcSlot = &this->m_terminator;
  } else {
    ppSrcSlot = (TSLink<TSHashObjectChunk<::CELLIST, HASHKEY_NONE>>*)((intptr_t)&pNode->nArrayAlloc + this->m_linkoffset);
  }
  TSLink<TSHashObjectChunk<::CELLIST, HASHKEY_NONE>>* ppDstSlot = ppSrcSlot->m_prevlink;
  if (ppDstSlot) {
    TSLink<TSHashObjectChunk<::CELLIST, HASHKEY_NONE>>** pBackLinkSrc;
    pBackLinkSrc = (TSLink<TSHashObjectChunk<::CELLIST, HASHKEY_NONE>>**)D2_StormNextLink(ppSrcSlot, -1);
    *pBackLinkSrc = ppDstSlot;
    ppSrcSlot->m_prevlink->m_next = ppSrcSlot->m_next;
    ppSrcSlot->m_prevlink = 0;
    ppSrcSlot->m_next = 0;
  }
  if (!pExisting) {
    ppDstSlot = &this->m_terminator;
  } else {
    ppDstSlot = (TSLink<TSHashObjectChunk<::CELLIST, HASHKEY_NONE>>*)((intptr_t)&pExisting->nArrayAlloc + this->m_linkoffset);
  }
  switch (nLinkType) {
    case 1:
      {
        ppSrcSlot->m_prevlink = ppDstSlot;
        ppSrcSlot->m_next = ppDstSlot->m_next;
        *(TSLink<TSHashObjectChunk<::CELLIST, HASHKEY_NONE>>**)D2_StormNextLink(ppDstSlot, this->m_linkoffset) = (TSLink<TSHashObjectChunk<::CELLIST, HASHKEY_NONE>>*)ppSrcSlot;
        ppDstSlot->m_next = (intptr_t)pNode;
        return;
      }
    default:
      {
        pTVar1 = ppDstSlot->m_prevlink;
        ppSrcSlot->m_prevlink = pTVar1;
        ppSrcSlot->m_next = pTVar1->m_next;
        pTVar1->m_next = (intptr_t)pNode;
        ppDstSlot->m_prevlink = ppSrcSlot;
        return;
      }
  }
}
