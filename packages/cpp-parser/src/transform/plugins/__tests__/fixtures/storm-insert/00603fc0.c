void dummy(TSExplicitList<TSHashObjectChunk<::CELLIST, HASHKEY_NONE>, 16>* pThis, TSHashObjectChunk<::CELLIST, HASHKEY_NONE>* pNode, uint32_t nLinkType, TSHashObjectChunk<::CELLIST, HASHKEY_NONE>* pExisting) {
  TSLink<TSHashObjectChunk<::CELLIST, HASHKEY_NONE>>* pTVar1;
  TSLink<TSHashObjectChunk<::CELLIST, HASHKEY_NONE>>* ppSrcSlot;
  int pOldNext;
  intptr_t pBackLinkDst;
  intptr_t pBackLinkDst2;
  if (!pNode) {
    ppSrcSlot = &this->m_terminator;
  } else {
    ppSrcSlot = (TSLink<TSHashObjectChunk<::CELLIST, HASHKEY_NONE>>*)((intptr_t)&pNode->nArrayAlloc + this->m_linkoffset);
  }
  TSLink<TSHashObjectChunk<::CELLIST, HASHKEY_NONE>>* ppDstSlot = ppSrcSlot->m_prevlink;
  if (ppDstSlot) {
    TSLink<TSHashObjectChunk<::CELLIST, HASHKEY_NONE>>** pBackLinkSrc;
    pBackLinkDst = ppSrcSlot->m_next;
    if (pBackLinkDst < 0) {
      pBackLinkSrc = (TSLink<TSHashObjectChunk<::CELLIST, HASHKEY_NONE>>**)~pBackLinkDst;
    } else {
      pBackLinkSrc = (TSLink<TSHashObjectChunk<::CELLIST, HASHKEY_NONE>>**)((int)ppSrcSlot + (pBackLinkDst - ppDstSlot->m_next));
    }
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
        pOldNext = this->m_linkoffset;
        pBackLinkDst2 = ppDstSlot->m_next;
        if (pBackLinkDst2 < 0) {
          *(TSLink<TSHashObjectChunk<::CELLIST, HASHKEY_NONE>>**)~pBackLinkDst2 = (TSLink<TSHashObjectChunk<::CELLIST, HASHKEY_NONE>>*)ppSrcSlot;
          ppDstSlot->m_next = (intptr_t)pNode;
          return;
        }
        if (pOldNext < 0) {
          pOldNext = (int)ppDstSlot - ppDstSlot->m_prevlink->m_next;
        }
        *(TSLink<TSHashObjectChunk<::CELLIST, HASHKEY_NONE>>**)(pBackLinkDst2 + pOldNext) = (TSLink<TSHashObjectChunk<::CELLIST, HASHKEY_NONE>>*)ppSrcSlot;
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
