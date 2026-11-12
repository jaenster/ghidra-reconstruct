/**
 * storm-tag-word: a Storm link's sign-tagged next word copied into an integer local becomes an
 * intptr_t local, a link offset is spelled (intptr_t)p, a back-link slot is T** - each the same
 * value on the 32-bit target, where intptr_t is int.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createStormTagWordTransformer, type StormTagWordOptions } from '../builtins/storm-tag-word.js';
import { compileAndRun, hasNativeGpp, testToolchain } from '../../../testing/native-cpp.js';

const native = { skip: !hasNativeGpp() || testToolchain()?.name !== 'mingw' };

const structFields = {
  'TSLink<CMDDEF>': { m_prevlink: 'TSLink<CMDDEF>*', m_next: 'intptr_t' },
  StormLinkStrc: { pPrevLink: 'StormLinkStrc*', pNext: 'intptr_t' },
};
const O: StormTagWordOptions = { structFields };
const run = (code: string, o: StormTagWordOptions = O) =>
  emit(createStormTagWordTransformer(o)(parse(code)) as AnyNode).trim();
const flat = (s: string) => s.replace(/\s+/g, ' ').replace(/\s*\*\s*/g, '*').replace(/\(\s+/g, '(');
const has = (out: string, snippet: string) => assert.ok(flat(out).includes(flat(snippet)), `${snippet}\n${out}`);
const reports = (code: string) => {
  const lines: string[] = [];
  const out = run(code, { ...O, onReport: (_f, l) => lines.push(l) });
  return { out, lines };
};

const NEXT_LINK = `TSLink<CMDDEF> * NextLink(TSLink<CMDDEF> * pThis, intptr_t nLinkOffset) {
    uint32_t uOffset = pThis->m_next;
    if ((int)uOffset < 0) {
      return (TSLink<CMDDEF>*)~uOffset;
    }
    if (nLinkOffset < 0) {
      nLinkOffset = (int)pThis - pThis->m_prevlink->m_next;
    }
    return (TSLink<CMDDEF>*)(uOffset + nLinkOffset);
}`;

const LINK_NODE = `void Link(StormLinkStrc * pSlot, StormLinkStrc * pHead, StormLinkStrc * pNode) {
    uint32_t piVar2;
    int nOffset;
    pSlot->pPrevLink = pHead;
    pSlot->pNext = pHead->pNext;
    nOffset = 4;
    piVar2 = pHead->pNext;
    if ((int)piVar2 < 0) {
      *(StormLinkStrc**)~piVar2 = (StormLinkStrc*)pSlot;
      pHead->pNext = (intptr_t)pNode;
      return;
    }
    if (nOffset < 0) {
      nOffset = (int)pHead - pHead->pPrevLink->pNext;
    }
    *(StormLinkStrc**)(piVar2 + nOffset) = pSlot;
    pHead->pNext = (intptr_t)pNode;
}`;

const HEAD = `StormLinkStrc * Head(StormLinkStrc * pNode) {
    uint32_t nRefCount = pNode->pNext;
    return (StormLinkStrc*)((int)nRefCount <= 0 ? 0 : nRefCount);
}`;

const UNLINK = `void Unlink(StormLinkStrc * pNode) {
    int* pPrev;
    StormLinkStrc* pNext = pNode->pPrevLink;
    if (!pNext) {
      return;
    }
    pPrev = (int*)D2_StormNextLink(pNode, -1);
    *pPrev = (int)pNext;
    pNode->pPrevLink->pNext = pNode->pNext;
    pNode->pPrevLink = 0;
    pNode->pNext = 0;
}`;

describe('storm-tag-word', () => {
  it('TSLink<CMDDEF>::NextLink @006c4040: the tag local is intptr_t, its sign test loses the cast', () => {
    const out = run(NEXT_LINK);
    has(out, 'intptr_t uOffset = pThis->m_next;');
    has(out, 'if (uOffset < 0)');
    has(out, 'return (TSLink<CMDDEF>*)~uOffset;');
    has(out, 'nLinkOffset = (intptr_t)pThis - pThis->m_prevlink->m_next;');
  });

  it('a list insert: the tag local and a signed link-offset local are intptr_t', () => {
    const out = run(LINK_NODE);
    has(out, 'intptr_t piVar2;');
    has(out, 'if (piVar2 < 0)');
    has(out, '*(StormLinkStrc**)~piVar2 = (StormLinkStrc*)pSlot;');
    has(out, 'intptr_t nOffset;');
    has(out, 'nOffset = (intptr_t)pHead - pHead->pPrevLink->pNext;');
  });

  it('a sign-guarded select of the next element is the tag word', () => {
    const out = run(HEAD);
    has(out, 'intptr_t nRefCount = pNode->pNext;');
    has(out, 'return (StormLinkStrc*)(nRefCount <= 0 ? 0 : nRefCount);');
  });

  it('UnlinkListNode @0040f820: a back-link slot only stored through is T**', () => {
    const out = run(UNLINK);
    has(out, 'StormLinkStrc** pPrev;');
    has(out, 'pPrev = (StormLinkStrc**)D2_StormNextLink(pNode, -1);');
    has(out, '*pPrev = pNext;');
  });

  it('refuses an unsigned word whose read depends on its signedness, and says why', () => {
    const { out, lines } = reports(`StormLinkStrc * f(StormLinkStrc * pNode, uint32_t nLimit) {
      uint32_t nOffset = pNode->pNext;
      if ((int)nOffset < 0) return (StormLinkStrc*)~nOffset;
      if (nOffset > nLimit) return 0;
      return (StormLinkStrc*)nOffset;
    }`);
    has(out, 'uint32_t nOffset');
    assert.ok(lines.some(l => /nOffset: refused: > reads its sign/.test(l)), lines.join('\n'));
  });

  it('refuses a word whose address is taken, a pointer store, and an integer with no tag', () => {
    const r1 = reports(`StormLinkStrc * f(StormLinkStrc * pNode) {
      uint32_t nOffset = pNode->pNext;
      g(&nOffset);
      if ((int)nOffset < 0) return (StormLinkStrc*)~nOffset;
      return 0;
    }`);
    has(r1.out, 'uint32_t nOffset');
    assert.ok(r1.lines.some(l => /address is taken/.test(l)), r1.lines.join('\n'));
    const r2 = reports(`StormLinkStrc * f(StormLinkStrc * pNode) {
      uint32_t nOffset = pNode->pNext;
      if (pNode->pPrevLink) nOffset = (uint32_t)pNode;
      if ((int)nOffset < 0) return (StormLinkStrc*)~nOffset;
      return 0;
    }`);
    assert.ok(r2.lines.some(l => /a store of a pointer/.test(l)), r2.lines.join('\n'));
    has(r2.out, 'uint32_t nOffset');
    const r3 = reports(`int f(StormLinkStrc * pNode, int n) {
      int nCount = n;
      if (nCount < 0) return 0;
      return ((StormLinkStrc*)(nCount + 4))->pNext;
    }`);
    has(r3.out, 'int nCount = n;');
  });

  it('a link offset into an int parameter keeps its spelling: the parameter is Ghidra\'s', () => {
    const { out, lines } = reports(NEXT_LINK.replace('intptr_t nLinkOffset', 'int32_t nLinkOffset'));
    has(out, 'nLinkOffset = (int)pThis - pThis->m_prevlink->m_next;');
    assert.ok(lines.some(l => /nLinkOffset: refused: a link offset/.test(l)), lines.join('\n'));
  });

  it('RemoveListNode @0040fc60: a member of the slot\'s name is not the slot', () => {
    const out = run(UNLINK.replace(/pPrev\b/g, 'pPrevLink'));
    has(out, 'StormLinkStrc** pPrevLink;');
    has(out, '*pPrevLink = pNext;');
    has(out, 'pNode->pPrevLink->pNext = pNode->pNext;');
  });

  it('a back-link slot that is also read keeps its type', () => {
    const { out } = reports(UNLINK.replace('*pPrev = (int)pNext;', '*pPrev = (int)pNext; g(*pPrev);'));
    has(out, 'int* pPrev;');
  });

  it('computes what the 32-bit words computed: tag test, complement and link offset', native, () => {
    const prelude = `
      #include <stdint.h>
      #include <stdio.h>
      struct CMDDEF;
      template<class T> struct TSLink { TSLink *m_prevlink; intptr_t m_next; };
      struct StormLinkStrc { StormLinkStrc *pPrevLink; intptr_t pNext; };
      static intptr_t D2_StormNextLink(const void *p, intptr_t off) {
        const StormLinkStrc *l = (const StormLinkStrc *)p;
        if (l->pNext < 0) return ~l->pNext;
        if (off < 0) off = (intptr_t)l - l->pPrevLink->pNext;
        return l->pNext + off;
      }
      static StormLinkStrc gA, gB, gC, gTerm;`;
    const fns = (src: string) => [NEXT_LINK, LINK_NODE, HEAD, UNLINK].map(f => src === 'out' ? run(f) : f).join('\n');
    const call = `
      TSLink<CMDDEF> l[3];
      l[0].m_prevlink = &l[2]; l[0].m_next = ~(intptr_t)&l[2];
      l[1].m_prevlink = &l[0]; l[1].m_next = (intptr_t)&l[2] - 8;
      l[2].m_prevlink = &l[1]; l[2].m_next = 0x40;
      printf("%d %d %d\\n", (int)((char*)NextLink(&l[0], -1) - (char*)l), (int)((char*)NextLink(&l[1], -1) - (char*)l),
        (int)((char*)NextLink(&l[1], 8) - (char*)l));
      gTerm.pPrevLink = &gTerm; gTerm.pNext = ~(intptr_t)&gTerm;
      gB.pPrevLink = 0; gB.pNext = 0;
      Link(&gB, &gTerm, (StormLinkStrc*)&gC);
      printf("%d %d %d\\n", gTerm.pNext == (intptr_t)&gC, gTerm.pPrevLink == &gB, gB.pPrevLink == &gTerm);
      printf("%p %p\\n", (void*)Head(&gTerm), (void*)Head(&gB));
      gA.pPrevLink = &gTerm; gA.pNext = ~(intptr_t)&gTerm; gTerm.pPrevLink = &gA;
      Unlink(&gA);
      printf("%d %d\\n", gTerm.pPrevLink == &gTerm, (int)gA.pNext);`;
    const before = compileAndRun(prelude + fns('in'), call);
    const after = compileAndRun(prelude + fns('out'), call);
    assert.strictEqual(after, before);
    assert.ok(/^\d+ \d+ \d+\n1 1 1\n/.test(before), before);
  });
});
