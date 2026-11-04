/**
 * Tests for the Offset Induction Index plugin: every rewrite, and every loop that must stay.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { offsetInductionIndexPlugin } from '../builtins/offset-induction-index.js';

const OPTIONS = {
  structLayouts: {
    D2StatesDataTbls: [{ name: 'nStateBitmask', offset: 0, size: 160, type: 'uint32_t[40]' }],
    Rec: [{ name: 'a', offset: 0, size: 4, type: 'int' }, { name: 'b', offset: 4, size: 4, type: 'int' }],
  },
  aggregateSizes: { D2StatesDataTbls: 160, Rec: 8 },
};

function tx(code: string, options: Record<string, unknown> = OPTIONS): string {
  return emit(offsetInductionIndexPlugin.createTransformer(options)(parse(code)) as AnyNode).trim();
}

function same(code: string, options: Record<string, unknown> = OPTIONS): void {
  const before = emit(parse(code) as AnyNode).trim();
  assert.strictEqual(tx(code, options), before);
}

describe('offsetInductionIndexPlugin', () => {
  it('writes the two-array loop back as the indexed for loop (STATES_HasMatchingStateFlag)', () => {
    const out = tx(`bool f(D2UnitStrc* pUnit, D2StatesDataTbls* pStatesData) {
  int32_t nStateFlags;
  int nDwordCount;
  int i;
  int nStateOffset;
  nStateFlags = GetStateFlags(pUnit);
  if (nStateFlags == 0) {
    return false;
  }
  nDwordCount = sgptDataTable->nTxtStatesSize + 0x1f;
  nDwordCount = (int)(nDwordCount + (nDwordCount >> 0x1f & 0x1fU)) >> 5;
  i = 0;
  if (0 < nDwordCount) {
    nStateOffset = nStateFlags - (int)pStatesData;
    do {
      if ((pStatesData->nStateBitmask[0] & *(uint32_t*)(nStateOffset + (int)pStatesData)) != 0) {
        return true;
      }
      i = i + 1;
      pStatesData = (D2StatesDataTbls*)((int)pStatesData + 4);
    } while (i < nDwordCount);
  }
  return false;
}`);
    assert.strictEqual(out, `bool f(D2UnitStrc* pUnit, D2StatesDataTbls* pStatesData) {
  int32_t nStateFlags;
  int i;
  nStateFlags = GetStateFlags(pUnit);
  if (nStateFlags == 0) {
    return false;
  }
  for (i = 0; i < (int)(sgptDataTable->nTxtStatesSize + 0x1f + (sgptDataTable->nTxtStatesSize + 0x1f >> 0x1f & 0x1fU)) >> 5; i = i + 1) {
    if ((pStatesData->nStateBitmask[i] & ((uint32_t*)nStateFlags)[i]) != 0) {
      return true;
    }
  }
  return false;
}`);
  });

  it('turns a count-down from a constant into the count-up index (gf2_matrix_square)', () => {
    const out = tx(`void gf2_matrix_square(uint32_t* square, uint32_t* mat) {
  int off;
  int n;
  uint32_t* col;
  uint32_t sum;
  uint32_t vec;
  off = (int)mat - (int)square;
  n = 0x20;
  do {
    sum = 0;
    col = mat;
    for (vec = *(uint32_t*)(off + (int)square); vec != 0; vec = vec >> 1) {
      if ((vec & 1) != 0) {
        sum = sum ^ *col;
      }
      col = col + 1;
    }
    *square = sum;
    square = square + 1;
    n = n + -1;
  } while (n != 0);
}`);
    assert.ok(out.includes('for (n = 0; n < 0x20; n++) {'), out);
    assert.ok(out.includes('for (vec = mat[n]; vec != 0; vec = vec >> 1) {'), out);
    assert.ok(out.includes('square[n] = sum;'), out);
    assert.ok(!/\boff\b/.test(out), out);
    assert.ok(!out.includes('square = square + 1'), out);
  });

  it('keeps off -= (int)P as the base, moves the leading step, and inlines a bound recomputed in the body (STATES_MoveToGfxFlags)', () => {
    const out = tx(`void f(D2UnitStrc* pUnit, uint32_t* pMaskWords) {
  int nTxtStatesSize;
  int nGfxOffset;
  int i;
  uint32_t* pGfxWord;
  int32_t pGfxFlags = GetGfxFlags(pUnit);
  int nStateOffset = GetStateFlags(pUnit);
  if (pGfxFlags == 0 || nStateOffset == 0) {
    return;
  }
  nGfxOffset = sgptDataTable->nTxtStatesSize + 0x1f;
  i = 0;
  if (0 < nGfxOffset / 32) {
    nGfxOffset = pGfxFlags - (int)pMaskWords;
    nStateOffset -= (int)pMaskWords;
    do {
      i = i + 1;
      pGfxWord = (uint32_t*)(nGfxOffset + (int)pMaskWords);
      *pGfxWord = *pGfxWord | *pMaskWords & *(uint32_t*)(nStateOffset + (int)pMaskWords);
      pGfxWord = (uint32_t*)(nStateOffset + (int)pMaskWords);
      *pGfxWord = *pGfxWord & ~*pMaskWords;
      nTxtStatesSize = sgptDataTable->nTxtStatesSize + 0x1f;
      pMaskWords = pMaskWords + 1;
    } while (i < nTxtStatesSize / 32);
  }
  Link(pUnit);
}`);
    assert.ok(out.includes('for (i = 0; i < (sgptDataTable->nTxtStatesSize + 0x1f) / 32; i = i + 1) {'), out);
    assert.ok(out.includes('pGfxWord = &((uint32_t*)pGfxFlags)[i];'), out);
    assert.ok(out.includes('*pGfxWord = *pGfxWord | pMaskWords[i] & ((uint32_t*)nStateOffset)[i];'), out);
    assert.ok(out.includes('pGfxWord = &((uint32_t*)nStateOffset)[i];'), out);
    assert.ok(!out.includes('-= (int)pMaskWords'), out);
    assert.ok(!out.includes('nTxtStatesSize ='), out);
    assert.ok(!out.includes('pMaskWords = pMaskWords + 1'), out);
  });

  it('indexes a struct pointer whose stride is its size, and keeps an unguarded loop a do-while', () => {
    const out = tx(`void f(Rec* p, int* q, int n) {
  int off;
  int i;
  i = 0;
  off = (int)q - (int)p;
  do {
    p->b = *(int*)(off + (int)p);
    use(p);
    i = i + 1;
    p = p + 1;
  } while (i < n);
}`);
    // An 8-byte stride over an int base is two ints per iteration.
    assert.ok(out.includes('p[i].b = q[i * 2];'), out);
    assert.ok(out.includes('use(p + i);'), out);
    assert.ok(out.includes('} while (i < n);'), out);
  });

  it('indexes a use after the pointer step one ahead', () => {
    const out = tx(`void f(int* p, int* q) {
  int off;
  int i;
  off = (int)q - (int)p;
  i = 0;
  do {
    p = p + 1;
    g(*(int*)(off + (int)p));
    i = i + 1;
  } while (i < 8);
}`);
    assert.ok(out.includes('g(q[i + 1]);'), out);
    assert.ok(out.includes('for (i = 0; i < 8; i = i + 1) {'), out);
  });

  it('leaves the loop when the offset is read after it', () => {
    same(`void f(int* p, int* q) {
  int off;
  int i;
  off = (int)q - (int)p;
  i = 0;
  do {
    g(*(int*)(off + (int)p));
    i = i + 1;
    p = p + 1;
  } while (i < 8);
  h(off);
}`);
  });

  it('leaves the loop when the stepped pointer is read after it', () => {
    same(`void f(int* p, int* q) {
  int off;
  int i;
  off = (int)q - (int)p;
  i = 0;
  do {
    g(*(int*)(off + (int)p));
    i = i + 1;
    p = p + 1;
  } while (i < 8);
  h(p);
}`);
  });

  it('leaves the loop when the pointer is written elsewhere in it', () => {
    same(`void f(int* p, int* q, int c) {
  int off;
  int i;
  off = (int)q - (int)p;
  i = 0;
  do {
    g(*(int*)(off + (int)p));
    if (c) {
      p = p + 1;
    }
    i = i + 1;
    p = p + 1;
  } while (i < 8);
}`);
  });

  it('leaves the loop when the base is written in it', () => {
    same(`void f(int* p, int* q) {
  int off;
  int i;
  off = (int)q - (int)p;
  i = 0;
  do {
    g(*(int*)(off + (int)p));
    q = q + 2;
    i = i + 1;
    p = p + 1;
  } while (i < 8);
}`);
  });

  it('leaves the loop with a continue', () => {
    same(`void f(int* p, int* q) {
  int off;
  int i;
  off = (int)q - (int)p;
  i = 0;
  do {
    if (*p == 0) {
      continue;
    }
    g(*(int*)(off + (int)p));
    i = i + 1;
    p = p + 1;
  } while (i < 8);
}`);
  });

  it('leaves a string copy alone: it has no counter', () => {
    same(`void f(char* dst, char* src) {
  int off;
  char c;
  off = (int)dst - (int)src;
  do {
    c = *src;
    *(char*)(off + (int)src) = c;
    src = src + 1;
  } while (c != 0);
}`);
  });

  it('leaves the loop when the access size does not divide the stride', () => {
    same(`void f(char* p, int* q) {
  int off;
  int i;
  off = (int)q - (int)p;
  i = 0;
  do {
    g(*(int*)(off + (int)p));
    i = i + 1;
    p = p + 3;
  } while (i < 8);
}`);
  });

  it('keeps a bound that reads memory the loop stores to', () => {
    const out = tx(`void f(int* p, int* q, S* s) {
  int off;
  int n;
  int i;
  n = s->count;
  i = 0;
  if (0 < n) {
    off = (int)q - (int)p;
    do {
      *(int*)(off + (int)p) = *p;
      i = i + 1;
      p = p + 1;
    } while (i < n);
  }
}`);
    assert.ok(out.includes('q[i] = p[i];'), out);
    assert.ok(out.includes('n = s->count;'), out);
    assert.ok(out.includes('for (i = 0; i < n; i = i + 1) {'), out);
  });

  it('keeps the count-down counter when the body reads it', () => {
    same(`void f(int* p, int* q) {
  int off;
  int n;
  off = (int)q - (int)p;
  n = 8;
  do {
    g(*(int*)(off + (int)p), n);
    p = p + 1;
    n = n + -1;
  } while (n != 0);
}`);
  });
});

describe('offsetInductionIndexPlugin: a single pointer', () => {
  const L = {
    structLayouts: {
      DataTbl: [{ name: 'pTxtLvlPrest', offset: 0, size: 4, type: 'LvlPrest *' }, { name: 'nSize', offset: 4, size: 4, type: 'int' }],
      LvlPrest: [{ name: 'nDef', offset: 0, size: 4, type: 'int' }, { name: 'LevelId', offset: 4, size: 4, type: 'int' }],
      Quest: [{ name: 'nCount', offset: 0, size: 2, type: 'uint16_t' }, { name: 'aGUID', offset: 4, size: 32, type: 'int[8]' }],
    },
    aggregateSizes: { DataTbl: 8, LvlPrest: 0x1b0, Quest: 36 },
    globalTypes: { gTbl: 'DataTbl' },
  };
  /** Lines of the parsed text: `if` on 3, `while` on 11 (the code below), edges per the original. */
  const ev = (ifTarget: number, whileFall: number, ifLine = 4, whileLine = 11) => ({
    lines: new Map(), ifs: new Map(),
    edges: [
      { line: ifLine, ord: 0, keyword: 'if', jcc: 18, target: ifTarget, fall: 20, fallLines: [], takenLines: [] },
      { line: whileLine, ord: 0, keyword: 'while', jcc: 47, target: 32, fall: whileFall, fallLines: [], takenLines: [] },
    ],
  });
  // TXT_LvlPrest_FindLineByLevelId 0061f0e0: `test esi, esi; jle 0x31` and the loop's `jl 0x20` falls to 0x31.
  const lvlPrest = `LvlPrest* f(int eLevel) {
  int i; int* pLevelIdField;
  i = 0;
  if (0 < gTbl.nSize) {
    pLevelIdField = &gTbl.pTxtLvlPrest->LevelId;
    do {
      if (*pLevelIdField == eLevel) {
        return gTbl.pTxtLvlPrest + i;
      }
      i = i + 1;
      pLevelIdField = pLevelIdField + 0x6c; } while (i < gTbl.nSize);
  }
  return 0;
}`;

  it('indexes the record table the pointer walks, as a for loop', () => {
    const out = tx(lvlPrest, { ...L, branchLayout: ev(49, 49) });
    assert.match(out, /for \(i = 0; i < gTbl\.nSize; i = i \+ 1\)/);
    assert.match(out, /if \(gTbl\.pTxtLvlPrest\[i\]\.LevelId == eLevel\)/);
    assert.doesNotMatch(out, /pLevelIdField =/);
  });

  it('keeps the pointer loop when the guard jumps elsewhere than the loop exit', () => {
    same(lvlPrest, { ...L, branchLayout: ev(60, 49) });
  });

  it('keeps the pointer loop without branch facts', () => {
    same(lvlPrest, L);
  });

  it('keeps it when the stride is not the record size', () => {
    same(lvlPrest.replace('+ 0x6c', '+ 0x6b'), { ...L, branchLayout: ev(49, 49) });
  });

  // QUEST_HasPlayerParticipated 005452c0: the bound is a zero-extended count, tested `!= 0`.
  const quest = `int f(Quest* pQ, int nGUID) {
  int n; int i; int* p;
  n = (int)pQ->nCount; i = 0;
  if (n != 0) {
    p = pQ->aGUID;
    do {
      if (*p == nGUID) {
        return 1;
      }
      i = i + 1;
      p = p + 1; } while (i < n);
  }
  return 0;
}`;
  it('indexes an array field, and reads `n != 0` of a narrow unsigned count as the for test', () => {
    const out = tx(quest, { ...L, branchLayout: ev(31, 31) });
    assert.match(out, /for \(i = 0; i < \(?\(int\)pQ->nCount\)?; i = i \+ 1\)/);
    assert.match(out, /if \(pQ->aGUID\[i\] == nGUID\)/);
  });

  it('keeps `n != 0` of a value that may be negative', () => {
    same(quest.replace('(int)pQ->nCount', 'pQ->nSigned'), { ...L, branchLayout: ev(31, 31) });
  });
});
