/**
 * An allocation constructed in place and kept null on failure takes a temporary, and the
 * result is assigned after the construction (new-result-temp). SSYSTEM_ListAllocNode
 * 0041c840 is the reference shape; the refusals are the shapes where the rewrite would
 * change a value or is unproven.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createNewResultTempTransformer } from '../builtins/new-result-temp.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const run = (code: string) => emit(createNewResultTempTransformer()(parse(code)) as AnyNode).replace(/\s+/g, ' ').trim();
const same = (code: string) => assert.strictEqual(run(code), emit(parse(code) as AnyNode).replace(/\s+/g, ' ').trim());

const LIST_ALLOC = `int** f(int n) {
  int** pNode = (int**)SMemAlloc(n + 0xc, 0, -2, 8);
  if (pNode) {
    *pNode = 0;
    pNode[1] = 0;
  } else {
    pNode = 0;
  }
  return pNode;
}`;

describe('new-result-temp', () => {
  it('SSYSTEM_ListAllocNode 0041c840: the allocation in a temporary, the result assigned last', () => {
    assert.strictEqual(run(LIST_ALLOC),
      'int** f(int n) { int** pNodeNew = (int**)SMemAlloc(n + 0xc, 0, -2, 8); int** pNode; if (pNodeNew) { *pNodeNew = 0; pNodeNew[1] = 0; pNode = pNodeNew; } else { pNode = 0; } return pNode; }');
  });

  it('the null arm first, an assignment instead of a declaration, members kept by name', () => {
    const out = run(`S* f(int n) {
  S* pNode;
  g();
  pNode = (S*)alloc(n);
  if (pNode == (S*)0x0) {
    pNode = (S*)0x0;
  } else {
    pNode->pNode = 0;
    (pNode->m_link).m_next = 0;
  }
  return pNode;
}`);
    assert.match(out, /S\* pNodeNew = \(S\*\)alloc\(n\); if \(pNodeNew == \(S\*\)0x0\) \{ pNode = \(S\*\)0x0; \} else \{ pNodeNew->pNode = 0; pNodeNew->m_link\.m_next = 0; pNode = pNodeNew; \}/);
  });

  it('refuses what it cannot prove', () => {
    // Not an allocation call.
    same('int** f(int** q) { int** p = q; if (p) { *p = 0; } else { p = 0; } return p; }');
    // The arm reads p.
    same('int** f() { int** p = (int**)alloc(); if (p) { p[1] = (int*)p; } else { p = 0; } return p; }');
    // The arm does more than store through p.
    same('int** f() { int** p = (int**)alloc(); if (p) { *p = 0; g(); } else { p = 0; } return p; }');
    // The arm stores to p itself.
    same('int** f(int** q) { int** p = (int**)alloc(); if (p) { p = q; } else { p = 0; } return p; }');
    // The other arm does not only null p.
    same('int** f() { int** p = (int**)alloc(); if (p) { *p = 0; } else { p = 0; g(); } return p; }');
    // No else: p is already null there, but the shape is not the constructed result.
    same('int** f() { int** p = (int**)alloc(); if (p) { *p = 0; } return p; }');
    // p is addressed.
    same('int** f() { int** p = (int**)alloc(); if (p) { *p = 0; } else { p = 0; } h(&p); return p; }');
    // The test is of something else.
    same('int** f(int c) { int** p = (int**)alloc(); if (c) { *p = 0; } else { p = 0; } return p; }');
    // An index names p.
    same('int* f() { int* p = (int*)alloc(); if (p) { p[(int)p] = 0; } else { p = 0; } return p; }');
  });

  it('computes what the printed form computed', { skip: !hasNativeGpp() }, () => {
    const written = run(LIST_ALLOC.replace('int** f(int n)', 'int** w(int n)'));
    const out = compileAndRun(`static int gFail; static int* gMem[4];
void* SMemAlloc(int, int, int, int) { return gFail ? 0 : (void*)gMem; }
${LIST_ALLOC.replace('int** f(int n)', 'int** p(int n)')}
${written}`, `int bad = 0; for (gFail = 0; gFail < 2; gFail++) { gMem[0] = gMem[1] = (int*)1; int** a = p(1); int* a0 = gMem[0]; int* a1 = gMem[1]; gMem[0] = gMem[1] = (int*)1; int** b = w(1); if (a != b || a0 != gMem[0] || a1 != gMem[1]) bad++; } printf("%d\\n", bad);`);
    assert.strictEqual(out.trim(), '0', written);
  });
});
