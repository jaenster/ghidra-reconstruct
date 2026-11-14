/**
 * A running loop variable the decompiler split into a copy and a step from the copy is one
 * variable again (loop-step-merge). The shapes are Ghidra's for the FastCmp RLE decoders
 * (00606e40: `pbSrc = pbSrcStream; ... pbSrcStream = pbSrc + 1; ... pbSrc[7]`) and
 * NET_SID_CLIENT_IDEACrypt 00524540, and the vertex loop of
 * RENDERER_GLIDE_InitGroundTileVertices 0050d540 (`pNext = pVertex + 1; ... pVertex = pNext;`).
 * The refusals are the shapes where a merge would change a value or is unproven.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createLoopStepMergeTransformer } from '../builtins/loop-step-merge.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const run = (code: string) => emit(createLoopStepMergeTransformer()(parse(code)) as AnyNode).replace(/\s+/g, ' ').trim();
const same = (code: string) => assert.strictEqual(run(code), emit(parse(code) as AnyNode).replace(/\s+/g, ' ').trim());

const RLE = (tail = '      pbDst[1] = pbSrc[2];\n      pbDst[0] = *pbSrc;') => `void f(unsigned char* pbSrcStream, unsigned char* pbDst, int n) {
  unsigned char* pbSrc;
  unsigned char byRunToken;
  while (n) {
    pbSrc = pbSrcStream;
    byRunToken = *pbSrc;
    pbSrcStream = pbSrc + 1;
    if (byRunToken & 0x80) {
${tail}
    }
    pbDst = pbDst + 2;
    n = n - 1;
  }
}`;

const VERTEX = (mid = '    pVertex->fT = 1.0;') => `void f(V* pVertex, int nCol) {
  V* pNextVertex;
  do {
    pVertex->fS = 0.0;
    nCol = nCol + 1;
    pNextVertex = pVertex + 1;
${mid}
    pVertex = pNextVertex;
  } while (nCol < 6);
}`;

describe('loop-step-merge: the copy form', () => {
  it('FastCmp 00606e40: the copy goes, its reads after the step read through the stepped pointer', () => {
    const out = run(RLE());
    assert.match(out, /byRunToken = \*pbSrcStream; pbSrcStream = pbSrcStream \+ 1; if \(byRunToken & 0x80\) \{ pbDst\[1\] = pbSrcStream\[1\]; pbDst\[0\] = pbSrcStream\[-1\]; \}/);
    assert.doesNotMatch(out, /pbSrc\b/);
  });

  it('a counter copied and stepped from the copy', () => {
    const out = run(`int f(int nRows) {
  int nLeft;
  int nSum = 0;
  do {
    nLeft = nRows;
    nSum = nSum + g(nLeft);
    nRows = nLeft - 1;
  } while (nRows);
  return nSum;
}`);
    assert.match(out, /do \{ nSum = nSum \+ g\(nRows\); nRows = nRows - 1; \} while \(nRows\);/);
  });

  it('leaves a read of the copy after the step in any other form', () => {
    same(RLE('      g(pbSrc);'));
  });

  it('leaves it when the old variable is written between, or the copy escapes', () => {
    same(RLE().replace('    byRunToken = *pbSrc;\n', '    byRunToken = *pbSrc;\n    pbSrcStream = h();\n'));
    same(RLE('      h(&pbSrc);'));
  });

  it('leaves two variables of different types', () => {
    same(RLE().replace('  unsigned char* pbSrc;', '  char* pbSrc;'));
  });
});

describe('loop-step-merge: the step form', () => {
  it('InitGroundTileVertices 0050d540: the step moves down to the copy back', () => {
    const out = run(VERTEX());
    assert.match(out, /pVertex->fS = 0\.0; nCol = nCol \+ 1; pVertex->fT = 1\.0; pVertex = pVertex \+ 1; \} while/);
    assert.doesNotMatch(out, /pNextVertex/);
  });

  it('leaves it when the stepped copy is read before the copy back', () => {
    same(VERTEX('    pNextVertex->fT = 1.0;'));
  });
});

describe('loop-step-merge: values', () => {
  it('computes what the printed form computed', { skip: !hasNativeGpp() }, () => {
    const before = RLE().replace('void f(', 'void p(');
    const after = emit(createLoopStepMergeTransformer()(parse(RLE())) as AnyNode).replace('void f(', 'void w(');
    const out = compileAndRun(`${before}
${after}`, `unsigned char s[64]; for (int i = 0; i < 64; i++) s[i] = (unsigned char)(i * 37 + 5);
unsigned char a[64] = {}, b[64] = {}; p(s, a, 20); w(s, b, 20);
int same = 1; for (int i = 0; i < 64; i++) if (a[i] != b[i]) same = 0;
int nz = 0; for (int i = 0; i < 64; i++) nz |= a[i];
printf("%d\\n", same && nz ? 0 : 1);`);
    assert.strictEqual(out.trim(), '0', after);
  });
});
