/**
 * The flattened inline TSLink::NextLink(-1) of a Storm unlink becomes a call to the inline helper
 * (storm-next-link). The positives are the shapes the tree holds: SFILE_CloseAllOpenFiles1
 * 00418be0 (struct link at offset 0), the D2CMP TCELENTRY walk (`int*` words, prev a local copy
 * of `*pNode`), and the TSLink member form. The refusals are the shapes where the helper's reads
 * would not see what the flattened code computed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createStormNextLinkTransformer, STORM_LINK_SUPPORT_LINES } from '../builtins/storm-next-link.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const structFields = {
  D2ArchiveStrc: { pPrevLink: 'D2ArchiveStrc*', pNext: 'D2ArchiveStrc*', nFlags: 'int32_t' },
  'TSLink<TCELENTRY>': { m_prevlink: 'TSLink<TCELENTRY>*', m_next: 'int' },
  TCELENTRY: { nKey: 'int', m_link: 'TSLink<TCELENTRY>' },
  Shifted: { nPad: 'int', pPrevLink: 'Shifted*', pNext: 'Shifted*' },
  Gapped: { pPrevLink: 'Gapped*', nGap: 'int', pNext: 'Gapped*' },
};
const structFieldOffsets = {
  D2ArchiveStrc: { pPrevLink: 0, pNext: 4, nFlags: 8 },
  'TSLink<TCELENTRY>': { m_prevlink: 0, m_next: 4 },
  TCELENTRY: { nKey: 0, m_link: 4 },
  Shifted: { nPad: 0, pPrevLink: 4, pNext: 8 },
  Gapped: { pPrevLink: 0, nGap: 4, pNext: 8 },
};
const aggregateSizes = { D2ArchiveStrc: 12, 'TSLink<TCELENTRY>': 8, TCELENTRY: 12, Shifted: 12, Gapped: 12 };
const sites: Array<{ target: string; droppedLocal?: string }> = [];
const xf = createStormNextLinkTransformer({
  structFields, structFieldOffsets, aggregateSizes, onSite: s => sites.push(s),
});
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const run = (code: string) => norm(emit(xf(parse(code)) as AnyNode));
const same = (code: string) => assert.strictEqual(run(code), norm(emit(parse(code) as AnyNode)));

const CLOSE_ALL = `void __fastcall SFILE_CloseAllOpenFiles1(D2ArchiveStrc * pArchive) {
    int* ppPrevSlot;
    D2ArchiveStrc* pNextNode = pArchive->pPrevLink;
    if (!pNextNode) {
      return;
    }
    D2ArchiveStrc* nPrevLink = pArchive->pNext;
    if ((int)nPrevLink < 0) {
      ppPrevSlot = (int*)~(uint32_t)nPrevLink;
    } else {
      ppPrevSlot = (int*)((int)nPrevLink + ((int)pArchive - (int)pNextNode->pNext));
    }
    *ppPrevSlot = (int)pNextNode;
    pArchive->pPrevLink->pNext = pArchive->pNext;
    pArchive->pPrevLink = 0;
    pArchive->pNext = 0;
}`;

const CEL_WALK = `void f(int* pNode) {
  int nNext;
  int uLinkOffset;
  int* pBackLink;
  nNext = *pNode;
  if (nNext) {
    uLinkOffset = pNode[1];
    if ((int)uLinkOffset < 0) {
      pBackLink = (int*)~uLinkOffset;
    } else {
      pBackLink = (int*)((int)pNode + (uLinkOffset - *(int*)(nNext + 4)));
    }
    *pBackLink = nNext;
  }
}`;

const MEMBER_LINK = `void f(TCELENTRY* pNewFrame) {
  TSLink<TCELENTRY>* uPrevHeadNode;
  int uLinkOffset;
  int* pBackLink;
  uPrevHeadNode = pNewFrame->m_link.m_prevlink;
  if (uPrevHeadNode) {
    uLinkOffset = pNewFrame->m_link.m_next;
    if ((int)uLinkOffset < 0) {
      pBackLink = (int*)~uLinkOffset;
    } else {
      pBackLink = (int*)((int)&pNewFrame->m_link + (uLinkOffset - uPrevHeadNode->m_next));
    }
    *pBackLink = (int)uPrevHeadNode;
  }
}`;

describe('storm-next-link', () => {
  it('SFILE_CloseAllOpenFiles1 00418be0: the if/else is one call, the local that carried next goes', () => {
    sites.length = 0;
    const out = run(CLOSE_ALL);
    assert.match(out, /ppPrevSlot = \(int\*\)D2_StormNextLink\(pArchive, -1\); \*ppPrevSlot = \(int\)pNextNode;/);
    assert.doesNotMatch(out, /nPrevLink/);
    assert.doesNotMatch(out, /~/);
    assert.deepStrictEqual(sites, [{ line: 8, target: 'ppPrevSlot', droppedLocal: 'nPrevLink' }]);
  });

  it('the int-word walk: prev is a local copy of *pNode, read before an enclosing guard', () => {
    const out = run(CEL_WALK);
    assert.match(out, /if \(nNext\) \{ pBackLink = \(int\*\)D2_StormNextLink\(pNode, -1\); \*pBackLink = nNext; \}/);
    assert.doesNotMatch(out, /uLinkOffset/);
  });

  it('a TSLink member at offset 4 of its node', () => {
    assert.match(run(MEMBER_LINK), /pBackLink = \(int\*\)D2_StormNextLink\(&pNewFrame->m_link, -1\);/);
  });

  it('the sum written first, under `N >= 0`; and an int-typed slot', () => {
    assert.match(run(`void f(D2ArchiveStrc* p) { int s; D2ArchiveStrc* q = p->pPrevLink; int n = (int)p->pNext;
      if (n >= 0) { s = n + ((int)p - (int)q->pNext); } else { s = ~n; } g(s, n); }`),
      /s = D2_StormNextLink\(p, -1\); g\(s, n\);/);
  });

  it('a link at offset 4 of the node is spelled by the term that holds it', () => {
    assert.match(run(`void f(Shifted* p) { int* s; Shifted* q = p->pPrevLink; int n = (int)p->pNext;
      if (n < 0) { s = (int*)~n; } else { s = (int*)(n + ((int)&p->pPrevLink - *(int*)((int)q + 4))); } h(s); }`),
      /s = \(int\*\)D2_StormNextLink\(&p->pPrevLink, -1\);/);
  });

  it('refuses what it cannot prove', () => {
    // prev typed as the node where the link sits at offset 4: q->pNext is at q + 8, not at the
    // prev link's next word.
    same(`void f(Shifted* p) { int* s; Shifted* q = p->pPrevLink; int n = (int)p->pNext;
      if (n < 0) { s = (int*)~n; } else { s = (int*)(n + ((int)&p->pPrevLink - (int)q->pNext)); } h(s); }`);
    // The node itself where the link sits at offset 4: the sum is off by 4.
    same(`void f(Shifted* p) { int* s; Shifted* q = p->pPrevLink; int n = (int)p->pNext;
      if (n < 0) { s = (int*)~n; } else { s = (int*)(n + ((int)p - (int)q->pNext)); } h(s); }`);
    // prev and next not adjacent.
    same(`void f(Gapped* p) { int* s; Gapped* q = p->pPrevLink; int n = (int)p->pNext;
      if (n < 0) { s = (int*)~n; } else { s = (int*)(n + ((int)p - (int)q->pNext)); } h(s); }`);
    // A call between the read of next and the site may have moved it.
    same(`void f(D2ArchiveStrc* p) { int* s; D2ArchiveStrc* q = p->pPrevLink; int n = (int)p->pNext; g();
      if (n < 0) { s = (int*)~n; } else { s = (int*)(n + ((int)p - (int)q->pNext)); } h(s); }`);
    // A store between.
    same(`void f(D2ArchiveStrc* p) { int* s; D2ArchiveStrc* q = p->pPrevLink; int n = (int)p->pNext; p->nFlags = 0;
      if (n < 0) { s = (int*)~n; } else { s = (int*)(n + ((int)p - (int)q->pNext)); } h(s); }`);
    // The node pointer reassigned after prev was read through it.
    same(`void f(D2ArchiveStrc* p, D2ArchiveStrc* r) { int* s; D2ArchiveStrc* q = p->pPrevLink; p = r; int n = (int)p->pNext;
      if (n < 0) { s = (int*)~n; } else { s = (int*)(n + ((int)p - (int)q->pNext)); } h(s); }`);
    // prev->next is some other member.
    same(`void f(D2ArchiveStrc* p) { int* s; D2ArchiveStrc* q = p->pPrevLink; int n = (int)p->pNext;
      if (n < 0) { s = (int*)~n; } else { s = (int*)(n + ((int)p - q->nFlags)); } h(s); }`);
    // The sign flipped on the link term.
    same(`void f(D2ArchiveStrc* p) { int* s; D2ArchiveStrc* q = p->pPrevLink; int n = (int)p->pNext;
      if (n < 0) { s = (int*)~n; } else { s = (int*)(n - ((int)p - (int)q->pNext)); } h(s); }`);
    // The negated arm negates something else.
    same(`void f(D2ArchiveStrc* p, int m) { int* s; D2ArchiveStrc* q = p->pPrevLink; int n = (int)p->pNext;
      if (n < 0) { s = (int*)~m; } else { s = (int*)(n + ((int)p - (int)q->pNext)); } h(s); }`);
    // Two targets, or more than the store in an arm.
    same(`void f(D2ArchiveStrc* p) { int* s; int* t; D2ArchiveStrc* q = p->pPrevLink; int n = (int)p->pNext;
      if (n < 0) { s = (int*)~n; } else { t = (int*)(n + ((int)p - (int)q->pNext)); } h(s, t); }`);
    same(`void f(D2ArchiveStrc* p) { int* s; D2ArchiveStrc* q = p->pPrevLink; int n = (int)p->pNext;
      if (n < 0) { s = (int*)~n; } else { g(); s = (int*)(n + ((int)p - (int)q->pNext)); } h(s); }`);
    // An unsigned test is not the sign test.
    same(`void f(D2ArchiveStrc* p) { int* s; D2ArchiveStrc* q = p->pPrevLink; uint32_t n = (uint32_t)p->pNext;
      if (n < 0) { s = (int*)~n; } else { s = (int*)(n + ((int)p - (int)q->pNext)); } h(s); }`);
    // The site inside a loop whose earlier iteration redefines the copy: no walk past the loop head.
    same(`void f(D2ArchiveStrc* p) { int* s; D2ArchiveStrc* q = p->pPrevLink; int n = (int)p->pNext;
      while (k()) { if (n < 0) { s = (int*)~n; } else { s = (int*)(n + ((int)p - (int)q->pNext)); } n = 3; } }`);
    // A definition reading its own old value.
    same(`void f(int* pNode, int n) { int* s; int q = *pNode; n = n + pNode[1] - n;
      if (n < 0) { s = (int*)~n; } else { s = (int*)((int)pNode + (n - *(int*)(q + 4))); } h(s); }`);
    // Unknown layout.
    same(`void f(Other* p) { int* s; Other* q = p->pPrevLink; int n = (int)p->pNext;
      if (n < 0) { s = (int*)~n; } else { s = (int*)(n + ((int)p - (int)q->pNext)); } h(s); }`);
  });

  it('keeps a local that is still read after the site', () => {
    const out = run(`void f(D2ArchiveStrc* p) { int* s; D2ArchiveStrc* q = p->pPrevLink; int n = (int)p->pNext;
      if (n < 0) { s = (int*)~n; } else { s = (int*)(n + ((int)p - (int)q->pNext)); } h(s, n); }`);
    assert.match(out, /int n = \(int\)p->pNext; s = \(int\*\)D2_StormNextLink\(p, -1\); h\(s, n\);/);
  });

  it('the helper computes the same slot as the flattened code', { skip: !hasNativeGpp() }, () => {
    const types = `struct D2ArchiveStrc { D2ArchiveStrc* pPrevLink; D2ArchiveStrc* pNext; int32_t nFlags; };
${STORM_LINK_SUPPORT_LINES.join('\n')}
`;
    const before = CLOSE_ALL.replace('void __fastcall SFILE_CloseAllOpenFiles1', 'void before');
    const after = run(CLOSE_ALL).replace('void __fastcall SFILE_CloseAllOpenFiles1', 'void after');
    const walkBefore = CEL_WALK.replace('void f(', 'void walkBefore(');
    const walkAfter = run(CEL_WALK).replace('void f(', 'void walkAfter(');
    const main = `
  int bad = 0;
  for (int round = 0; round < 2; round++) {
    // head.pNext is the terminator's ~address when the list is empty past a node.
    D2ArchiveStrc head = {0, 0, 0}, a = {0, 0, 0}, b = {0, 0, 0};
    D2ArchiveStrc h2 = {0, 0, 0}, a2 = {0, 0, 0}, b2 = {0, 0, 0};
    D2ArchiveStrc* H[2] = {&head, &h2}; D2ArchiveStrc* A[2] = {&a, &a2}; D2ArchiveStrc* B[2] = {&b, &b2};
    for (int k = 0; k < 2; k++) {
      H[k]->pNext = A[k]; A[k]->pPrevLink = H[k];
      if (round == 0) { A[k]->pNext = B[k]; B[k]->pPrevLink = A[k]; B[k]->pNext = (D2ArchiveStrc*)~(uintptr_t)&H[k]->pPrevLink; H[k]->pPrevLink = B[k]; }
      else { A[k]->pNext = (D2ArchiveStrc*)~(uintptr_t)&H[k]->pPrevLink; H[k]->pPrevLink = A[k]; }
    }
    before(&a); after(&a2);
    for (int k = 0; k < 2; k++) {
      if (round == 0 && (H[k]->pNext != B[k] || B[k]->pPrevLink != H[k])) bad |= 1 << k;
      if (round == 1 && (H[k]->pPrevLink != H[k] || (uintptr_t)H[k]->pNext != ~(uintptr_t)&H[k]->pPrevLink)) bad |= 4 << k;
    }
  }
  int w1[2] = {0, 0}, w2[2] = {0, 0}, n1[2] = {0, 0}, n2[2] = {0, 0};
  int* W[2] = {w1, w2}; int* N[2] = {n1, n2};
  for (int neg = 0; neg < 2; neg++) {
    for (int k = 0; k < 2; k++) {
      W[k][0] = 0; W[k][1] = 4;
      N[k][0] = (int)(intptr_t)W[k];
      N[k][1] = neg ? ~(int)(intptr_t)&W[k][0] : 8;
    }
    walkBefore(n1); walkAfter(n2);
    for (int k = 0; k < 2; k++) {
      if (!neg && N[k][1] != (int)(intptr_t)W[k]) bad |= 16 << k;
      if (neg && W[k][0] != (int)(intptr_t)W[k]) bad |= 64 << k;
    }
  }
  printf("%d\\n", bad);`;
    const out = compileAndRun(`${types}\n${before}\n${after}\n${walkBefore}\n${walkAfter}`, main);
    assert.strictEqual(out.trim(), '0');
  });
});

describe('storm-next-link on a member definition', () => {
  // TSExplicitList<SGAMEDATA>::Destructor 0044fbe0 as v2075 prints it: `this` is the list, the
  // link is the terminator at offset 4, and the sum is a byte pointer plus an int.
  const L = 'TSLink<SGAMEDATA>';
  const C = 'TSExplicitList<SGAMEDATA, -572662307>';
  // The tables are keyed by Ghidra's spelling of the name, without the parser's space.
  const G = 'TSExplicitList<SGAMEDATA,-572662307>';
  const xm = createStormNextLinkTransformer({
    structFields: { [L]: { m_prevlink: `${L}*`, m_next: 'intptr_t' }, [G]: { m_unk: 'int', m_terminator: L } },
    structFieldOffsets: { [L]: { m_prevlink: 0, m_next: 4 }, [G]: { m_unk: 0, m_terminator: 4 } },
    aggregateSizes: { [L]: 8, [G]: 12 },
  });
  const runM = (code: string) => norm(emit(xm(parse(code)) as AnyNode));
  const DESTRUCTOR = (between = '') => `template<> void ${C}::Destructor() {
    TSLink<::SGAMEDATA>** pPrevLink;
    this->UnlinkAll();
    TSLink<::SGAMEDATA>* pTVar1 = &this->m_terminator;
    TSLink<::SGAMEDATA>* pNext = pTVar1->m_prevlink;
    if (!pNext) {
      return;
    }
    intptr_t encPrev = this->m_terminator.m_next;
    if (encPrev < 0) {
      pPrevLink = (TSLink<::SGAMEDATA>**)~encPrev;
    } else {
      pPrevLink = (TSLink<::SGAMEDATA>**)((char*)pTVar1 + (encPrev - pNext->m_next));
    }
    *pPrevLink = pNext;${between}
    pTVar1->m_prevlink->m_next = this->m_terminator.m_next;
    pTVar1->m_prevlink = 0;
    pTVar1->m_next = 0;
}`;

  it('0044fbe0: `this` has the class type, the byte-pointer sum is the helper, the next word reads through the link', () => {
    assert.strictEqual(runM(DESTRUCTOR()), norm(`template<> void ${C}::Destructor() {
    TSLink<::SGAMEDATA>** pPrevLink;
    this->UnlinkAll();
    TSLink<::SGAMEDATA>* pTVar1 = &this->m_terminator;
    TSLink<::SGAMEDATA>* pNext = pTVar1->m_prevlink;
    if (!pNext) {
      return;
    }
    pPrevLink = (TSLink<::SGAMEDATA>**)D2_StormNextLink(pTVar1, -1);
    *pPrevLink = pNext;
    pTVar1->m_prevlink->m_next = pTVar1->m_next;
    pTVar1->m_prevlink = 0;
    pTVar1->m_next = 0;
}`));
  });

  it('the next word keeps its spelling past a store to a local', () => {
    const out = runM(DESTRUCTOR('\n    pTVar1 = pNext;'));
    assert.match(out, /D2_StormNextLink\(pTVar1, -1\)/);
    assert.match(out, /pTVar1->m_prevlink->m_next = this->m_terminator\.m_next;/);
  });

  it('the next word keeps its spelling past a call', () => {
    const out = runM(DESTRUCTOR('\n    g();'));
    assert.match(out, /pTVar1->m_prevlink->m_next = this->m_terminator\.m_next;/);
  });

  it('a free function has no `this` shape and is left alone', () => {
    const code = DESTRUCTOR().replace(`template<> void ${C}::Destructor()`, 'void Destructor()');
    assert.strictEqual(runM(code), norm(emit(parse(code) as AnyNode)));
  });

  it('a byte-pointer sum with the wrong link is refused', () => {
    const code = DESTRUCTOR().replace('(char*)pTVar1 + (encPrev', '(char*)pNext + (encPrev');
    assert.doesNotMatch(runM(code), /D2_StormNextLink/);
  });

  it('Ghidra\'s pseudo-C: `this` as a parameter (self), its type spelled with `_` for the minus', () => {
    const out = runM(`void __thiscall Destructor(TSExplicitList<SGAMEDATA,_572662307> * self) {
  TSLink<SGAMEDATA> *pTVar1;
  TSLink<SGAMEDATA> **pPrevLink;
  intptr_t encPrev;
  TSLink<SGAMEDATA> *pNext;
  UnlinkAll(self);
  pTVar1 = &self->m_terminator;
  pNext = pTVar1->m_prevlink;
  if (pNext != (TSLink<SGAMEDATA> *)0x0) {
    encPrev = (self->m_terminator).m_next;
    if (encPrev < 0) {
      pPrevLink = (TSLink<SGAMEDATA> **)~encPrev;
    }
    else {
      pPrevLink = (TSLink<SGAMEDATA> **)((int)pTVar1 + (encPrev - pNext->m_next));
    }
    *pPrevLink = pNext;
    pTVar1->m_prevlink->m_next = (self->m_terminator).m_next;
    pTVar1->m_prevlink = (TSLink<SGAMEDATA> *)0x0;
    (self->m_terminator).m_next = 0;
  }
}`);
    assert.match(out, /pPrevLink = \(TSLink<SGAMEDATA>\*\*\)D2_StormNextLink\(pTVar1, -1\); \*pPrevLink = pNext; pTVar1->m_prevlink->m_next = pTVar1->m_next;/);
    assert.doesNotMatch(out, /encPrev/);
  });

  it('the generator\'s wrapper: a method body keeps `this`, the first parameter pThis is its pointer', () => {
    const body = DESTRUCTOR().slice(DESTRUCTOR().indexOf('{'));
    const out = runM(`void dummy(TSExplicitList<::SGAMEDATA, -572662307>* pThis) ${body}`);
    assert.match(out, /D2_StormNextLink\(pTVar1, -1\); \*pPrevLink = pNext; pTVar1->m_prevlink->m_next = pTVar1->m_next;/);
  });

  it('a first parameter by any other name says nothing about `this`', () => {
    const body = DESTRUCTOR().slice(DESTRUCTOR().indexOf('{'));
    const code = `void dummy(TSExplicitList<::SGAMEDATA, -572662307>* pList) ${body}`;
    assert.strictEqual(runM(code), norm(emit(parse(code) as AnyNode)));
  });
});
