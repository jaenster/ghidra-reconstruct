/**
 * Pointer-Word Cast Plugin Tests
 *
 * The must-fix cases are the address-arithmetic shapes Ghidra routes through a
 * 32-bit int. Each rewrite must keep the value AND, for the integer forms, the
 * type on the 32-bit target - so the expected text pins the exact spelling,
 * including which of intptr_t/uintptr_t the signedness maps to.
 *
 * The must-NOT-fix cases are the typing signal the pass promises to keep: a
 * pointer's word landing in an int-typed slot, an int variable cast to a
 * pointer, and casts through a type that is not `int` itself.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import {
  pointerWordCastPlugin, getPointerWordCastStats, resetPointerWordCastStats,
} from '../builtins/pointer-word-cast.js';
import { compileAndRun, hasNativeGpp, testToolchain } from '../../../testing/native-cpp.js';

describe('pointerWordCastPlugin', () => {
  const transform = (code: string, options?: Record<string, unknown>): string => {
    const t = pointerWordCastPlugin.createTransformer(options as never);
    return emit(t(parse(code)) as AnyNode).replace(/\s+/g, ' ').trim();
  };
  const squash = (s: string) => s.replace(/\s+/g, '');

  // --- byte arithmetic -------------------------------------------------------

  it('respells an offset onto an untyped pointer as byte arithmetic', () => {
    const out = transform(`void f() { void* p; int n; n = *(int*)((int)p + 0x10); }`);
    assert.ok(squash(out).includes('*(int*)((char*)p+0x10)'), out);
    assert.ok(!/\(int\)\s*p/.test(out), out);
  });

  it('keeps a subtracted offset subtracted', () => {
    const out = transform(`void f() { D2UnitStrc* p; g((D2RoomStrc*)((int)p - 8)); }`);
    assert.ok(squash(out).includes('(D2RoomStrc*)((char*)p-8)'), out);
  });

  it('folds a chain of offsets onto the one pointer term', () => {
    const out = transform(`void f(int i) { uint8_t* p; g((uint16_t*)((int)p + i * 4 + 2)); }`);
    assert.ok(squash(out).includes('(uint16_t*)((char*)p+i*4+2)'), out);
  });

  it('accepts the pointer term on the right of a sum', () => {
    const out = transform(`void f(int i) { uint8_t* p; g((uint16_t*)(i * 4 + (uint32_t)p)); }`);
    assert.ok(squash(out).includes('(uint16_t*)(i*4+(char*)p)'), out);
  });

  // --- words in an integer that becomes a pointer ------------------------------
  // Not byte arithmetic (no single positive pointer base), so each word is respelled
  // pointer-sized in place: the same type on the 32-bit target, so the same value.

  it('respells a negated pointer term in place', () => {
    const out = transform(`void f(int i) { uint8_t* p; g((uint16_t*)(i - (int)p)); }`);
    assert.ok(squash(out).includes('(uint16_t*)(i-(intptr_t)p)'), out);
  });

  it('respells the word beside an unknown term in place', () => {
    const out = transform(`void f() { uint8_t* p; g((uint16_t*)((int)p + nUnknown)); }`);
    assert.ok(squash(out).includes('(uint16_t*)((intptr_t)p+nUnknown)'), out);
  });

  it('respells the word beside a 64-bit term in place, never as a byte base', () => {
    const out = transform(`void f(long long k) { uint8_t* p; g((uint16_t*)((int)p + k)); }`);
    assert.ok(squash(out).includes('(uint16_t*)((intptr_t)p+k)'), out);
  });

  it('respells both words of a sum of two pointer words', () => {
    const out = transform(`void f() { uint8_t* p; uint8_t* q; g((uint16_t*)((int)p + (int)q)); }`);
    assert.ok(squash(out).includes('(uint16_t*)((intptr_t)p+(intptr_t)q)'), out);
  });

  it('does not take a function pointer as a byte base', () => {
    const out = transform(`void f() { Draw pfn; g((uint16_t*)((int)pfn + 4)); }`, { funcdefNames: ['Draw'] });
    assert.ok(squash(out).includes('(uint16_t*)((intptr_t)pfn+4)'), out);
  });

  // --- round trip --------------------------------------------------------------

  it('drops a word round trip between two pointers', () => {
    const out = transform(
      `void f() { Halt("", (void*)(int32_t)GetInstructionPointer(), 0x25e); }`,
      { functionReturnTypes: { GetInstructionPointer: 'void *' } },
    );
    assert.ok(squash(out).includes('Halt("",(void*)GetInstructionPointer(),0x25e)'), out);
  });

  it('keeps a narrowing round trip', () => {
    const out = transform(`void f() { uint32_t* p; g((int**)(uint8_t)(uint32_t)p); }`);
    assert.ok(squash(out).includes('(int**)(uint8_t)(uint32_t)p'), out);
  });

  it('keeps an int variable cast to a pointer', () => {
    const out = transform(`void f(int n) { g((D2UnitStrc*)(n + 4)); g((D2UnitStrc*)(int)n); }`);
    assert.ok(squash(out).includes('(D2UnitStrc*)(n+4)'), out);
    assert.ok(squash(out).includes('(D2UnitStrc*)(int)n'), out);
  });

  // --- integer forms -------------------------------------------------------------

  it('keeps a signed comparison signed', () => {
    const out = transform(`void f() { int* pLink; if ((int)pLink < 0) { return; } }`);
    assert.ok(squash(out).includes('if((intptr_t)pLink<0)'), out);
  });

  it('keeps an unsigned comparison unsigned', () => {
    const out = transform(`void f() { int* a; int* b; if ((uint32_t)a < (uint32_t)b) { return; } }`);
    assert.ok(squash(out).includes('if((uintptr_t)a<(uintptr_t)b)'), out);
  });

  it('respells the pointer term of a compared sum', () => {
    const out = transform(`void f() { char* a; char* b; if ((int)a + 0x10 <= (int)b) { return; } }`);
    assert.ok(squash(out).includes('if((intptr_t)a+0x10<=(intptr_t)b)'), out);
  });

  it('respells an alignment test and a hash', () => {
    const out = transform(`void f() { void* p; if (((uint32_t)p & 3) != 0) { h((uint16_t)((uint32_t)p >> 0x10)); } }`);
    assert.ok(squash(out).includes('((uintptr_t)p&3)!=0'), out);
    assert.ok(squash(out).includes('(uint16_t)((uintptr_t)p>>0x10)'), out);
  });

  it('respells both sides of a distance', () => {
    const out = transform(`void f() { D2ItemsTxt* a; D2ItemsTxt* b; int n; n = ((int)a - (int)b) / 0x1a8; }`);
    assert.ok(squash(out).includes('n=((intptr_t)a-(intptr_t)b)/0x1a8'), out);
  });

  // --- the typing signal stays ------------------------------------------------------

  it('leaves a pointer word stored into an int slot', () => {
    const out = transform(`void f() { void* p; int n; n = (int)p; g((int)p); n = (int)p + 4; }`);
    assert.ok(!/intptr_t|char\s*\*/.test(out), out);
  });

  it('leaves long, DWORD and enum casts alone', () => {
    const out = transform(
      `void f() { void* p; if ((DWORD)p < 4) { return; } if ((long)p == 0) { return; } if ((eX)p == 1) { return; } }`,
      { typedefTargets: { eX: 'int' } },
    );
    assert.ok(!/intptr_t/.test(out), out);
  });

  it('leaves an int operand of a comparison alone', () => {
    const out = transform(`void f(int n, uint32_t u) { if ((int)u < n) { return; } }`);
    assert.ok(!/intptr_t/.test(out), out);
  });

  // --- the Storm link words --------------------------------------------------------

  it('respells a terminator complement that becomes a link pointer', () => {
    // SFILE TSList_FILEREC_LinkNode (00417a70): a negative next is ~&terminator.
    const out = transform(`void f() { int* pLink; pLink = (int*)~(uint32_t)pLink; }`);
    assert.ok(squash(out).includes('pLink=(int*)~(uintptr_t)pLink;'), out);
  });

  it('respells the backlink sum of a node, a slot and a loaded offset', () => {
    const out = transform(`void f() { int* pLink; int** ppSlot; int* pEntry; pLink = (int*)((int)pLink + ((int)ppSlot - pEntry[1])); }`);
    assert.ok(squash(out).includes('pLink=(int*)((intptr_t)pLink+((intptr_t)ppSlot-pEntry[1]));'), out);
  });

  it('respells a word stored into a pointer-sized link field with its own signedness', () => {
    const out = transform(`void f(TSLink* pThis, Node* pNode) { pThis->m_next = ~(uint32_t)pNode; pThis->m_next = (int)pNode; }`,
      { structFields: { TSLink: { m_next: 'intptr_t' } } });
    assert.ok(squash(out).includes('pThis->m_next=~(uintptr_t)pNode;'), out);
    assert.ok(squash(out).includes('pThis->m_next=(intptr_t)pNode;'), out);
  });

  // --- offsets onto a pointer -------------------------------------------------------

  it('respells the strength-reduced distance a pointer is offset by', () => {
    const out = transform(`void f(char* szText, char* pDst, int n) { char* p; p = pDst + (0x24 - (int)szText); p = (n - (int)szText) + pDst; }`);
    assert.ok(squash(out).includes('p=pDst+(0x24-(intptr_t)szText);'), out);
    assert.ok(squash(out).includes('p=n-(intptr_t)szText+pDst;'), out);
  });

  it('respells a subscript and a compound step onto a pointer', () => {
    const out = transform(`void f(char* pRoster, char* szTag, char* pCursor, char c) { pCursor[(int)pRoster + (0x46 - (int)szTag)] = c; pCursor += -(int)szTag; }`);
    assert.ok(squash(out).includes('pCursor[(intptr_t)pRoster+(0x46-(intptr_t)szTag)]=c;'), out);
    assert.ok(squash(out).includes('pCursor+=-(intptr_t)szTag;'), out);
  });

  it('respells a word of a pointer sum: (int)(p + K)', () => {
    const out = transform(`void f(char* pBase, char* p) { char* q; q = pBase + (int)(p + 1); }`);
    assert.ok(squash(out).includes('q=pBase+(intptr_t)(p+1);'), out);
  });

  it('respells a value made a size on purpose', () => {
    const out = transform(`void f(char* pEnd, char* pBase) { g((size_t)(pEnd + (0x15 - (int)pBase))); size_t n = (int)pEnd - 7; }`);
    assert.ok(squash(out).includes('g((size_t)(pEnd+(0x15-(intptr_t)pBase)));'), out);
    assert.ok(squash(out).includes('size_tn=(intptr_t)pEnd-7;'), out);
  });

  // --- what stays for Ghidra --------------------------------------------------------

  it('leaves a pointer word stored into an int slot', () => {
    const out = transform(`void f(char* p, int* pPrev, Node* pNext) { int n; n = 0x40 - (int)p; *pPrev = (int)pNext; }`);
    assert.ok(squash(out).includes('n=0x40-(int)p;'), out);
    assert.ok(squash(out).includes('*pPrev=(int)pNext;'), out);
  });

  it('does not reach through a load into the address it reads', () => {
    const out = transform(`void f(int* p) { char* q; q = (char*)(*(int*)((int)p + 4) + 8); }`);
    // the inner address is byte arithmetic; the loaded int is a value Ghidra types
    assert.ok(squash(out).includes('q=(char*)(*(int*)((char*)p+4)+8);'), out);
  });

  it('counts each form', () => {
    resetPointerWordCastStats();
    transform(`void f(int* a, int* b) {
      g((char*)((int)a + 1)); g((void*)(int)a);
      if ((int)a < (int)b) { return; }
      h((uint32_t)a & 3); h((int)a - (int)b);
    }`);
    assert.deepStrictEqual(getPointerWordCastStats(), {
      byteArith: 1, roundTrip: 1, compare: 2, bitwise: 1, distance: 1, toPointer: 0, offset: 0, sizedSlot: 0, balanced: 0, literal: 0,
      byteDistance: 0, select: 0,
    });
  });

  it('SAVE_SerializeItemIfValid call: a reassociated distance is pointer-sized', () => {
    const out = transform(`void f(char* pBuffer, char* pWrite, int nSize) { g(pWrite, (int)pBuffer + (nSize - (int)pWrite)); }`);
    assert.ok(squash(out).includes('g(pWrite,(intptr_t)pBuffer+(nSize-(intptr_t)pWrite));'), out);
  });

  it('leaves a sum whose addresses do not cancel', () => {
    const out = transform(`void f(char* a, char* b, int n) { int k; k = (int)a + (n + (int)b); }`);
    assert.ok(squash(out).includes('k=(int)a+n+(int)b;'), out);
  });

  it('a value passed to a size_t parameter is a pointer-sized slot', () => {
    const out = transform(`void f(void* p, int* q, int n) { memset(p, 0, (int)q * n); Copy(p, (int)q * n); Keep((int)q); }`,
      { functionParamTypes: { Copy: ['void *', 'size_t'], Keep: ['int'] } });
    assert.ok(squash(out).includes('memset(p,0,(intptr_t)q*n);'), out);
    assert.ok(squash(out).includes('Copy(p,(intptr_t)q*n);'), out);
    assert.ok(squash(out).includes('Keep((int)q);'), out);
  });

  it('SSTR: a constant through a pointer cast is the constant', () => {
    const out = transform(`void f() { int n; n = (int)(uint16_t*)0x1; n = (int32_t)(char*)-4; n = (int)(char*)m; }`);
    assert.ok(squash(out).includes('n=(int)0x1;'), out);
    assert.ok(squash(out).includes('n=(int32_t)-4;'), out);
    assert.ok(squash(out).includes('n=(int)(char*)m;'), out);
  });
});

describe('pointer-word-cast after the source forms', () => {
  // A vc8form anchors on the comparison as the decompiler printed it. The
  // respelling has to come after it, or the form finds no site and the
  // function loses its recorded shape (MONSTERAI_FindNearestAllyCallback's
  // merge-tail on `(int)pDistAsUnit >= (int)ppAllyData[3]`).
  it('applies a form anchored on (int)p, then respells it', async () => {
    const { transformGhidraCode } = await import('../../../ghidra.js');
    const { parseVc8Form } = await import('../builtins/vc8-form.js');
    const form = parseVc8Form('cmp((int)pA < (int)pB,mirror)')!;
    assert.ok(form);
    const sites: Array<{ applied: boolean }> = [];
    const r = transformGhidraCode(
      'int f(int* pA, int* pB) { g((int)pA < (int)pB); return 0; }',
      {
        usePluginRegistry: true, tolerateErrors: true, preset: 'full',
        vc8Forms: { forms: [{ form }], onSite: s => sites.push(s as { applied: boolean }) },
      },
    );
    assert.ok(r.success, r.error);
    assert.deepStrictEqual(sites.map(s => s.applied), [true]);
    assert.ok(/g\(\(intptr_t\)\s*pB\s*>\s*\(intptr_t\)\s*pA\)/.test(r.code), r.code);
  });
});

describe('pointer-word-cast: distances and selects the decompiler spelled in integers', () => {
  const transform = (code: string, options?: Record<string, unknown>): string => {
    const t = pointerWordCastPlugin.createTransformer(options as never);
    return emit(t(parse(code)) as AnyNode).replace(/\s+/g, ' ').trim();
  };
  const squash = (s: string) => s.replace(/\s+/g, '');
  const native = { skip: !hasNativeGpp() || testToolchain()?.name !== 'mingw' };

  it('SStrCopy @SSTR: (uint32_t)(p + (n - (intptr_t)q)) is the distance p - q plus n', () => {
    const out = transform(`uint32_t f(char *pDstLast, char *szOut, int nOffset) { return (uint32_t)(pDstLast + (nOffset - (intptr_t)szOut) - 3); }`);
    assert.ok(squash(out).includes('return(uint32_t)(pDstLast-szOut+nOffset-3);'), out);
  });

  it('a negative offset term is subtracted', () => {
    const out = transform(`uint32_t f(uint8_t *pbSrcPos, uint8_t *pbMatch) { return (uint32_t)(pbSrcPos + (-1 - (intptr_t)pbMatch)); }`);
    assert.ok(squash(out).includes('(uint32_t)(pbSrcPos-pbMatch-1)'), out);
  });

  it('a subtracted address term that is itself a sum stays one operand', () => {
    const out = transform(`int f(char *pszDst, char *pszSrc) { return (int)(pszDst + (1 - (intptr_t)(pszSrc + 5))); }`);
    assert.ok(squash(out).includes('(int)(pszDst-(pszSrc+5)+1)'), out);
  });

  it('two pointer types meet through char *', () => {
    const out = transform(`int f(uint8_t *pTerm, D2PacketStrc *pPacket) { return (int32_t)(pTerm + (1 - (intptr_t)pPacket)); }`);
    assert.ok(squash(out).includes('(int32_t)((char*)pTerm-(char*)pPacket+1)'), out);
  });

  it('leaves a distance onto a wider pointee alone: its offsets are scaled', () => {
    const out = transform(`int f(int *p, char *q, int n) { return (int)(p + (n - (intptr_t)q)); }`);
    assert.ok(!squash(out).includes('p-q'), out);
  });

  it('leaves a 64-bit target alone: a pointer zero-extends where an int sign-extends', () => {
    const out = transform(`long long f(char *p, char *q, int n) { return (long long)(p + (n - (intptr_t)q)); }`);
    assert.ok(!squash(out).includes('p-q'), out);
  });

  it('(T *)(c ? 0 : (uint32_t)p) is a select between null and the pointer', () => {
    const out = transform(`D2UnitStrc *f(D2UnitStrc *pUnit) { return (D2UnitStrc *)(pUnit->eUnitType != 4 ? 0 : (uint32_t)pUnit); }`,
      { structFields: { D2UnitStrc: { eUnitType: 'int' } } });
    assert.ok(squash(out).includes('returnpUnit->eUnitType!=4?nullptr:pUnit;'), out);
  });

  it('the TSLink sign test keeps its test and converts the other pointer type', () => {
    const out = transform(`Rec *f(Link *pPrev) { return (Rec *)((intptr_t)pPrev <= 0 ? 0 : (uint32_t)pPrev); }`);
    assert.ok(squash(out).includes('return(intptr_t)pPrev<=0?nullptr:(Rec*)pPrev;'), out);
  });

  it('computes what the integer spellings computed', native, () => {
    const prelude = `
      #include <stdint.h>
      #include <stdio.h>
      struct Rec { int a; };
      struct Link { int b; };
      static char gBuf[64];
      static Rec gRec;`;
    const fn = `
      uint32_t d1(char *pDstLast, char *szOut, int nOffset) { return (uint32_t)(pDstLast + (nOffset - (intptr_t)szOut) - 3); }
      int d2(char *pszDst, char *pszSrc) { return (int)(pszDst + (1 - (intptr_t)(pszSrc + 5))); }
      uint32_t d4(uint8_t *p, uint8_t *q, int n) { return (uint32_t)(p + (-n - (intptr_t)q)); }
      int d3(uint8_t *pTerm, Rec *pPacket) { return (int32_t)(pTerm + (1 - (intptr_t)pPacket)); }
      Rec *s1(Link *pPrev) { return (Rec *)((intptr_t)pPrev <= 0 ? 0 : (uint32_t)pPrev); }
      Rec *s2(Rec *p, int c) { return (Rec *)(c != 4 ? 0 : (uint32_t)p); }`;
    const out = transform(fn);
    assert.ok(squash(out).includes('pDstLast-szOut+nOffset-3'), out);
    assert.ok(squash(out).includes('nullptr'), out);
    const call = `
      printf("%u %d %d ", d1(gBuf + 40, gBuf + 3, 7), d2(gBuf + 2, gBuf + 30), d3((uint8_t *)gBuf + 9, &gRec) - (int)((char *)gBuf - (char *)&gRec));
      printf("%u ", d4((uint8_t *)gBuf + 50, (uint8_t *)gBuf + 1, 60));
      printf("%d %d %d %d\\n", s1((Link *)&gRec) == &gRec, s1((Link *)(intptr_t)-8) == 0, s2(&gRec, 4) == &gRec, s2(&gRec, 3) == 0);`;
    assert.strictEqual(compileAndRun(prelude + out, call), compileAndRun(prelude + fn, call));
  });
});
