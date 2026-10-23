/**
 * alias-reach: a local pointer aliasing a stack local, walked outside it. The positive cases
 * are the FOG_ParseBinField shape (v1698) and its variants; the negatives are the walks a
 * correct frame makes every day - a string scan, a stride inside the array, a pointer
 * re-aimed somewhere else, a pointer into a parameter.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ALL_CHECKS, buildSnapshot, parseSource, runChecks, spelledSize, treeFromFiles, type Finding } from '../lint/index.js';

function lint(src: string, types: any[] = []): Finding[] {
  const f = parseSource('a.cpp', src);
  assert.deepStrictEqual(f.parseErrors, [], 'a.cpp did not parse');
  const tree = treeFromFiles('/nonexistent', [f]);
  const c = ALL_CHECKS.find(x => x.id === 'alias-reach')!;
  const r = runChecks(tree, buildSnapshot('', [], types), [c]);
  assert.deepStrictEqual(r.errors, []);
  return r.findings;
}

describe('defect lint: alias-reach', () => {
  it('reports the split hash-node array: a 12-byte stride through an 8-byte head, and [-1] into the tail', () => {
    const fs = lint(`int f(int n) {
    int* pSlot;
    int aNodes[838];
    int aBuckets[256];
    if (n) {
      int aNodesHead[2];
      pSlot = aNodesHead;
      do {
        pSlot[1] = n;
        pSlot[2] = n;
        *pSlot = aBuckets[n & 0xff];
        aBuckets[n & 0xff] = (int)pSlot;
        pSlot += 3;
        n--;
      } while (n);
    }
    pSlot = aNodes;
    do {
      if (pSlot[-1]) { n++; }
      pSlot += 3;
    } while (n);
    return n;
}`);
    assert.deepStrictEqual(fs.map(f => f.subject).sort(), ['aNodes', 'aNodesHead']);
    const head = fs.find(f => f.subject === 'aNodesHead')!;
    assert.match(head.detail, /reaches \[0, 24\) of aNodesHead \(int\[2\] = 8 bytes\), stepping 12 bytes/);
    const tail = fs.find(f => f.subject === 'aNodes')!;
    assert.match(tail.detail, /reaches \[-4, /);
  });

  it('reports a constant offset past a scalar and a struct, through casts and &x', () => {
    const fs = lint(`void f() {
    int nCount;
    int* p = &nCount;
    p[1] = 0;
    Pair tPair;
    char* q;
    q = (char*)&tPair + 4;
    *(int*)(q + 4) = 1;
}`, [{ name: 'Pair', kind: 'STRUCTURE', size: 8, fields: [] }]);
    assert.deepStrictEqual(fs.map(f => [f.subject, f.detail.split(' (')[0]]).sort(), [
      ['nCount', 'p = &nCount reaches [4, 8) of nCount'],
      ['tPair', 'q = &tPair + 4 reaches [8, 12) of tPair'],
    ]);
  });

  it('counts a step taken before the use in straight-line code, and a memset through the alias', () => {
    const fs = lint(`void f() {
    short aw[4];
    short* p = aw;
    p += 3;
    p[1] = 0;
    char ab[8];
    char* q = &ab[4];
    memset(q, 0, 8);
}`);
    assert.deepStrictEqual(fs.map(f => [f.subject, f.detail.split(' (')[0]]).sort(), [
      ['ab', 'q = &ab + 4 reaches [4, 12) of ab'],
      ['aw', 'p = &aw reaches [8, 10) of aw'],
    ]);
  });

  it('ignores walks that stay inside, pointers re-aimed elsewhere, parameters and variable indexes', () => {
    const fs = lint(`int f(int* pArg, char* sz, int i) {
    char szBuf[16];
    char* p = szBuf;
    while (*p) p++;
    int an[8];
    int* q = an;
    q[7] = 0;
    q = pArg;
    q[20] = 0;
    int* r = &pArg[0];
    r[5] = 1;
    int am[4];
    int* s = am;
    s[i] = 2;
    int ak[6];
    int* t = ak;
    do { t[1] = 0; t += 2; } while (t < ak + 6);
    return 0;
}`);
    // t: one step of 8 bytes on top of t[1] reaches [12, 16) of 24 bytes - inside.
    assert.deepStrictEqual(fs, []);
  });

  it('does not take a step from a loop that re-assigns the pointer every iteration', () => {
    const fs = lint(`void f(int n) {
    int a[2];
    int* p;
    while (n--) {
      p = a;
      p[1] = n;
      p += 2;
    }
}`);
    assert.deepStrictEqual(fs, []);
  });

  it('sizes the spellings casts and Ghidra fields use', () => {
    const snap = buildSnapshot('', [], [{ name: 'D2UnitStrc', kind: 'STRUCTURE', size: 0xf4, fields: [] }]);
    assert.strictEqual(spelledSize('short int', snap), 2);
    assert.strictEqual(spelledSize('unsigned long int', snap), 4);
    assert.strictEqual(spelledSize('::D2::D2UnitStrc', snap), 0xf4);
    assert.strictEqual(spelledSize('struct D2UnitStrc *', snap), 4);
    assert.strictEqual(spelledSize('Unknown', snap), null);
  });
});
