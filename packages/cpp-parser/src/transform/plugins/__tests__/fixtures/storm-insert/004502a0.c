void dummy(TSExplicitList<::SGAMEDATA, -572662307>* pThis, ::SGAMEDATA* pNode, uint32_t nLinkType, ::SGAMEDATA* pExisting) {
  TSLink<::SGAMEDATA>* pTVar1;
  TSLink<::SGAMEDATA>* pNodeLink;
  int pTarget;
  intptr_t dwNext2;
  intptr_t dwNext;
  if (!pNode) {
    pNodeLink = &this->m_terminator;
  } else {
    pNodeLink = (TSLink<::SGAMEDATA>*)(pNode->szGameName + this->m_linkoffset - 0x2a);
  }
  TSLink<::SGAMEDATA>* pAnchorLink = pNodeLink->m_prevlink;
  if (pAnchorLink) {
    TSLink<::SGAMEDATA>** pPrevLink;
    dwNext = pNodeLink->m_next;
    if (dwNext < 0) {
      pPrevLink = (TSLink<::SGAMEDATA>**)~dwNext;
    } else {
      pPrevLink = (TSLink<::SGAMEDATA>**)((int)pNodeLink + (dwNext - pAnchorLink->m_next));
    }
    *pPrevLink = pAnchorLink;
    pNodeLink->m_prevlink->m_next = pNodeLink->m_next;
    pNodeLink->m_prevlink = 0;
    pNodeLink->m_next = 0;
  }
  if (!pExisting) {
    pAnchorLink = &this->m_terminator;
  } else {
    pAnchorLink = (TSLink<::SGAMEDATA>*)(pExisting->szGameName + this->m_linkoffset - 0x2a);
  }
  switch (nLinkType) {
    case 1:
      {
        pNodeLink->m_prevlink = pAnchorLink;
        pNodeLink->m_next = pAnchorLink->m_next;
        pTarget = this->m_linkoffset;
        dwNext2 = pAnchorLink->m_next;
        if (dwNext2 < 0) {
          *(TSLink<::SGAMEDATA>**)~dwNext2 = (TSLink<::SGAMEDATA>*)pNodeLink;
          pAnchorLink->m_next = (intptr_t)pNode;
          return;
        }
        if (pTarget < 0) {
          pTarget = (int)pAnchorLink - pAnchorLink->m_prevlink->m_next;
        }
        *(TSLink<::SGAMEDATA>**)(dwNext2 + pTarget) = (TSLink<::SGAMEDATA>*)pNodeLink;
        pAnchorLink->m_next = (intptr_t)pNode;
        return;
      }
    default:
      {
        pTVar1 = pAnchorLink->m_prevlink;
        pNodeLink->m_prevlink = pTVar1;
        pNodeLink->m_next = pTVar1->m_next;
        pTVar1->m_next = (intptr_t)pNode;
        pAnchorLink->m_prevlink = pNodeLink;
        return;
      }
  }
}
