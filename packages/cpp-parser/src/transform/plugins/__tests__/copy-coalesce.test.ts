/**
 * copy-coalesce folds a local that only ever holds a copy of another variable into it, and
 * only on a proof that no value changes. LIGHTMAP_InitFromPlayerAndRooms 00474610 is the
 * shape it is for. The three refusals below are reductions of functions an unsound version
 * of the pass got wrong; each is also run natively before and after, where it folds.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createCopyCoalesceTransformer, type CopyCoalesceOptions } from '../builtins/copy-coalesce.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';
import type { TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite } from '../builtins/vc8-form.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const run = (code: string, o: CopyCoalesceOptions = {}) => flat(emit(createCopyCoalesceTransformer(o)(parse(code)) as AnyNode));
const same = (code: string, o: CopyCoalesceOptions = {}) => assert.strictEqual(run(code, o), flat(emit(parse(code) as AnyNode)));
const raw = (code: string, o: CopyCoalesceOptions = {}) => emit(createCopyCoalesceTransformer(o)(parse(code)) as AnyNode);

/** Run `fn` source before and after the pass with the same driver; the outputs must agree. */
function agrees(prelude: string, fn: string, driver: string) {
  if (!hasNativeGpp()) return;
  const before = compileAndRun(prelude + '\n' + fn, driver);
  const after = compileAndRun(prelude + '\n' + raw(fn), driver);
  assert.strictEqual(after, before);
}

// 00474610, reduced, with the first copy inside the condition as Ghidra prints it.
const LIGHTMAP = `int f(int* pUnit, int bForce) {
  int* pRoom;
  int* pPlayerRoom;
  int n = 0;
  if (!pUnit || (pRoom = GetRoom(pUnit), pPlayerRoom = pRoom, !pRoom) || bForce) {
    return Black();
  }
  n = Count(pRoom);
  int i = 0;
  do {
    if (Adjacent(pRoom, i) != pRoom) {
      Light(Adjacent(pRoom, i));
      pRoom = pPlayerRoom;
      if (Near(pRoom, i)) {
        Mark(pRoom, i);
        pRoom = pPlayerRoom;
      }
    }
    i++;
  } while (i < n);
  return n;
}`;
const LIGHTMAP_PRELUDE = `static int cells[8] = {3, 1, 4, 1, 5, 9, 2, 6}; static int lit = 0;
int* GetRoom(int* u) { return u; } int Black() { return -1; } int Count(int* r) { return 5; }
int* Adjacent(int* r, int i) { return i & 1 ? r : r + i; } void Light(int* r) { lit += *r; }
int Near(int* r, int i) { return i % 3 == 0; } void Mark(int* r, int i) { lit ^= i << 4; }`;

// 0055a6d0 TC_RollTreasureClass, reduced: `nTCStackDepth = nParentDepth + 1` writes the
// source between the copy at the loop head and the reads of nParentDepth below it.
const DROP = `int f(int* pTCStack, int nDropCount) {
  int nTCStackDepth = 0;
  int nParentDepth;
  int nSum = 0;
  nParentDepth = nTCStackDepth;
  while (true) {
    nTCStackDepth = nParentDepth;
    if (!nDropCount) {
      break;
    }
    if (nDropCount & 1) {
      if (nDropCount > 0) {
        nTCStackDepth = nParentDepth + 1;
      }
      nSum += pTCStack[nTCStackDepth] * 3 + pTCStack[nParentDepth];
      pTCStack[nParentDepth] = nSum;
    }
    nParentDepth = nTCStackDepth;
    nDropCount--;
  }
  return nSum + nTCStackDepth * 100;
}`;

// 00668300 DRLGPRESET_FreeDrlgFile, reduced: pCurrent folds into pCacheEntry, and pPrev
// stays the node before it, never the next.
const PRESET = `int f(Node* gpHead, int key) {
  Node* pCacheEntry = gpHead;
  Node* pPrev = 0;
  if (gpHead) {
    Node* pCurrent;
    pPrev = 0;
    do {
      pCurrent = pCacheEntry;
      pCacheEntry = pCurrent;
      if (pCurrent->key == key) {
        break;
      }
      pPrev = pCurrent;
      pCacheEntry = pCurrent->pNext;
    } while (pCacheEntry);
  }
  return (pPrev ? pPrev->key : -1) * 1000 + (pCacheEntry ? pCacheEntry->key : -1);
}`;
const PRESET_PRELUDE = 'struct Node { int key; Node* pNext; };';

// 0051fab0 NET_BNFTP_CLIENT_ProcessFile, reduced: &dwStackPad5 goes out and the callee reads
// the next slots by offset. dwStackPad4 only ever holds pModTime, and nothing in the body
// reads it, but the callee does.
const BNFTP = `void f(uint32_t eFileType, uint32_t pModTime) {
  uint32_t dwStackPad5;
  uint32_t dwStackPad4;
  dwStackPad5 = eFileType;
  dwStackPad4 = pModTime;
  Enqueue(3, (char*)&dwStackPad5, 8);
}`;
const BNFTP_SLOTS: CopyCoalesceOptions = {
  slots: [
    { name: 'dwStackPad5', offset: -0x10, size: 4 },
    { name: 'dwStackPad4', offset: -0xc, size: 4 },
    { name: 'eFileType', offset: 4, size: 4, isParameter: true },
    { name: 'pModTime', offset: 8, size: 4, isParameter: true },
  ],
};

describe('copy-coalesce', () => {
  it('LIGHTMAP_InitFromPlayerAndRooms 00474610: the copy in the condition goes, the reads read the source', () => {
    const out = run(LIGHTMAP, { slots: [] });
    assert.doesNotMatch(out, /pPlayerRoom/);
    assert.match(out, /\(pRoom = GetRoom\(pUnit\) ?, !pRoom\)/);
    assert.match(out, /Light\(Adjacent\(pRoom, i\)\); if \(Near\(pRoom, i\)\) \{ Mark\(pRoom, i\); \} \}/);
    agrees(LIGHTMAP_PRELUDE, LIGHTMAP, 'int u[8]; for (int i = 0; i < 8; i++) u[i] = i * 7; printf("%d %d %d\\n", f(u, 0), f(0, 0), lit);');
  });

  it('a declaration copy and a parameter source', () => {
    assert.strictEqual(run('int f(int n) { int m = n; g(m); return m + 1; }'), 'int f(int n) { g(n); return n + 1; }');
    assert.strictEqual(run('void f(N* p) { N* q; q = p; g(q); h(p); }'), 'void f(N* p) { g(p); h(p); }');
  });

  it('Drop.cpp 0055a6d0: a write of the source after a back copy refuses', () => {
    same(DROP);
    same(DROP, { slots: [] });
  });

  it('Preset.cpp 00668300: the fold keeps pPrev the node before the match', () => {
    const out = run(PRESET, { slots: [] });
    assert.match(out, /pPrev = pCacheEntry; pCacheEntry = pCacheEntry->pNext;/);
    const drive = `Node n[4] = {{1, &n[1]}, {2, &n[2]}, {3, &n[3]}, {4, 0}};
      printf("%d %d %d %d\\n", f(n, 1), f(n, 3), f(n, 9), f(0, 1));`;
    agrees(PRESET_PRELUDE, PRESET, drive);
  });

  it('BnDownload.cpp 0051fab0: a copy into a slot a callee reaches by offset stays', () => {
    same(BNFTP, BNFTP_SLOTS);
    // Without the frame, a function whose locals escape is left alone.
    same(BNFTP);
  });

  it('Monsters.cpp 005a4f50: a run started by a callee reaching past its local extends to every neighbour', () => {
    const src = `void f(Unit* pUnit) { int nMin; int nMax; Unit* pUnitSaved; pUnitSaved = pUnit; Calc(pUnit, &nMin); g(pUnitSaved, nMin + nMax); }`;
    const slots = [{ name: 'nMin', offset: -12, size: 4 }, { name: 'nMax', offset: -8, size: 4 }, { name: 'pUnitSaved', offset: -4, size: 4 }];
    // Calc writes nMin and nMax: the run is the whole frame, though the callee stops at 8.
    same(src, { slots, argReach: () => ({ lo: 0, hi: 8 }) });
  });

  it('a neighbour handed to a callee that reaches only its own word does not hold the fold', () => {
    const src = `int f(int* p) { int n; int* q; q = p; Get(&n); return *q + n; }`;
    const slots = [{ name: 'n', offset: -8, size: 4 }, { name: 'q', offset: -4, size: 4 }];
    // The reach unknown: q may be read through &n.
    same(src, { slots });
    // Get stores one word through its pointer.
    assert.strictEqual(run(src, { slots, argReach: () => ({ lo: 0, hi: 4 }) }), 'int f(int* p) { int n; Get(&n); return *p + n; }');
  });

  it('ItemMode.cpp 00563350: a slot after an address stored in a pointer stays, whatever the pointer reaches', () => {
    const src = `int f(Game* pGame, Unit* pUnit) { int32_t nPutItemResult; Unit* pUnitAsPool; int32_t* pResultOut; pUnitAsPool = pUnit; pResultOut = &nPutItemResult; return Put(pGame, pUnitAsPool, pResultOut); }`;
    const slots = [{ name: 'nPutItemResult', offset: -12, size: 4 }, { name: 'pUnitAsPool', offset: -8, size: 4 }];
    same(src, { slots, argReach: () => ({ lo: 0, hi: 4 }) });
  });

  it('refuses a source written between the copy and a read', () => {
    same('int f(int n) { int m; m = n; n = n + 1; return m + n; }');
    same('int f(int n) { int m; m = n; n++; return m; }');
    same('int f(int n, int k) { int m; m = n; if (k) n = 3; return m; }');
  });

  it('refuses a copy target written any other way', () => {
    same('int f(int n) { int m; m = n; m += 1; return m; }');
    same('int f(int n, int k) { int m; m = n; if (k) m = g(); return m; }');
  });

  it('refuses a read the copy does not reach on every path', () => {
    same('int f(int n, int k) { int m; if (k) m = n; return m; }');
    same('int f(int n, int k) { int m = 0; if (k) m = n; return m; }');
  });

  it('refuses around a loop where the source moves on', () => {
    same('int f(int* p) { int* q = p; int s = 0; do { s += *q; p = p + 1; } while (*p); return s; }');
    same('int f(int n) { int m; int s = 0; while (n) { m = n; n--; s += m; } return s; }');
  });

  it('refuses a goto into the span between the copy and the read', () => {
    same('int f(int n, int k) { int m; if (k) goto L; m = n; n = 5; L: m = n; n = 2; return m; }');
    same('int f(int n, int k) { int m; m = n; if (k) goto L; return m; L: n = 1; return m; }');
  });

  it('refuses an address taken, a reference, a volatile, a static', () => {
    same('int f(int n) { int m; m = n; g(&n); return m; }');
    same('int f(int n) { int m; m = n; g(&m); return m; }');
    same('int f(int& n) { int m; m = n; g(); return m; }');
    same('int f(int n) { volatile int m; m = n; return m; }');
    same('int f(int n) { static int m; m = n; return m; }');
  });

  it('refuses a global source: a call may write it', () => {
    same('int f() { int m; m = gCount; g(); return m; }');
  });

  it('refuses a struct member store into either', () => {
    same('int f(S s) { S t; t = s; s.x = 1; return t.x; }');
  });

  it('refuses a read in a statement that writes the source first', () => {
    same('int f(int n) { int m; m = n; g(n = 4, m); return m; }');
  });

  it('refuses a different type: the copy converts', () => {
    same('int f(short n) { int m; m = n; return m; }');
  });

  it('refuses a function that installs an SEH frame by hand', () => {
    same('int f(int n) { int m; m = n; ExceptionList = &local_10; g(); return m; }');
  });

  it('a back copy `b = a` the fold proves goes with the copy', () => {
    assert.strictEqual(
      run('int f(int n) { int m; m = n; g(m); n = m; return n; }'),
      'int f(int n) { g(n); return n; }');
  });

  it('a read in `b = e(a)` is read before the store', () => {
    assert.strictEqual(run('int f(int n) { int m; m = n; n = m + 1; return n; }'), 'int f(int n) { n = n + 1; return n; }');
    agrees('', 'int f(int n) { int m; m = n; n = m + 1; return n; }', 'printf("%d\\n", f(41));');
  });

  it('the vc8form coalesce form: the same fold, per function', () => {
    const form = (tag: string, code: string) => {
      const sites: Vc8FormSite[] = [];
      const tu = applyVc8Forms(parse(code) as TranslationUnit, [{ form: parseVc8Form(tag)!, tag }], x => sites.push(x));
      return { out: flat(emit(tu as AnyNode)), site: sites[0] };
    };
    assert.deepStrictEqual(parseVc8Form('coalesce(pUnitSaved,pUnit)'), { op: 'coalesce', name: 'pUnitSaved', from: 'pUnit' });
    assert.deepStrictEqual(parseVc8Form('coalesce(m)'), { op: 'coalesce', name: 'm' });
    const ok = form('coalesce(m)', 'int f(int n) { int m = n; g(m); return m + 1; }');
    assert.strictEqual(ok.site.applied, true);
    assert.strictEqual(ok.out, 'int f(int n) { g(n); return n + 1; }');
    const drop = form('coalesce(nParentDepth)', DROP);
    assert.strictEqual(drop.site.applied, false);
    assert.strictEqual(drop.out, flat(emit(parse(DROP) as AnyNode)));
    assert.strictEqual(form('coalesce(m,k)', 'int f(int n, int k) { int m = n; return m; }').site.applied, false);
  });
});
