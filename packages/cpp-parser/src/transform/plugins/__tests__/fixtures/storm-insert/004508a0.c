void dummy(TSExplicitList<TSHashObjectChunk<::SGAMEDATA, HASHKEY_NONE>, 16>* pThis, TSHashObjectChunk<::SGAMEDATA, HASHKEY_NONE>* pNode, uint32_t nLinkType, TSHashObjectChunk<::SGAMEDATA, HASHKEY_NONE>* pExisting) {
  TSLink<TSHashObjectChunk<::SGAMEDATA, HASHKEY_NONE>>* pTVar1;
  TSLink<TSHashObjectChunk<::SGAMEDATA, HASHKEY_NONE>>* ppNodeLink;
  int pExistingReg;
  intptr_t dwNext2;
  intptr_t dwNext;
  if (!pNode) {
    ppNodeLink = &this->m_terminator;
  } else {
    ppNodeLink = (TSLink<TSHashObjectChunk<::SGAMEDATA, HASHKEY_NONE>>*)((intptr_t)&pNode->nArrayAlloc + this->m_linkoffset);
  }
  TSLink<TSHashObjectChunk<::SGAMEDATA, HASHKEY_NONE>>* ppTargetLink = ppNodeLink->m_prevlink;
  if (ppTargetLink) {
    TSLink<TSHashObjectChunk<::SGAMEDATA, HASHKEY_NONE>>** ppPrevLink;
    dwNext = ppNodeLink->m_next;
    if (dwNext < 0) {
      ppPrevLink = (TSLink<TSHashObjectChunk<::SGAMEDATA, HASHKEY_NONE>>**)~dwNext;
    } else {
      ppPrevLink = (TSLink<TSHashObjectChunk<::SGAMEDATA, HASHKEY_NONE>>**)((int)ppNodeLink + (dwNext - ppTargetLink->m_next));
    }
    *ppPrevLink = ppTargetLink;
    ppNodeLink->m_prevlink->m_next = ppNodeLink->m_next;
    ppNodeLink->m_prevlink = 0;
    ppNodeLink->m_next = 0;
  }
  if (!pExisting) {
    ppTargetLink = &this->m_terminator;
  } else {
    ppTargetLink = (TSLink<TSHashObjectChunk<::SGAMEDATA, HASHKEY_NONE>>*)((intptr_t)&pExisting->nArrayAlloc + this->m_linkoffset);
  }
  switch (nLinkType) {
    case 1:
      {
        ppNodeLink->m_prevlink = ppTargetLink;
        ppNodeLink->m_next = ppTargetLink->m_next;
        pExistingReg = this->m_linkoffset;
        dwNext2 = ppTargetLink->m_next;
        if (dwNext2 < 0) {
          *(TSLink<TSHashObjectChunk<::SGAMEDATA, HASHKEY_NONE>>**)~dwNext2 = (TSLink<TSHashObjectChunk<::SGAMEDATA, HASHKEY_NONE>>*)ppNodeLink;
          ppTargetLink->m_next = (intptr_t)pNode;
          return;
        }
        if (pExistingReg < 0) {
          pExistingReg = (int)ppTargetLink - ppTargetLink->m_prevlink->m_next;
        }
        *(TSLink<TSHashObjectChunk<::SGAMEDATA, HASHKEY_NONE>>**)(dwNext2 + pExistingReg) = (TSLink<TSHashObjectChunk<::SGAMEDATA, HASHKEY_NONE>>*)ppNodeLink;
        ppTargetLink->m_next = (intptr_t)pNode;
        return;
      }
    default:
      {
        pTVar1 = ppTargetLink->m_prevlink;
        ppNodeLink->m_prevlink = pTVar1;
        ppNodeLink->m_next = pTVar1->m_next;
        pTVar1->m_next = (intptr_t)pNode;
        ppTargetLink->m_prevlink = ppNodeLink;
        return;
      }
  }
}
