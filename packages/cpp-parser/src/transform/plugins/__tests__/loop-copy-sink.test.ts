/**
 * A loop-carried copy the decompiler placed right after the old value's last read moves
 * to the end of the loop body (loop-copy-sink). ITEMMODE_RecalcAllEquippedStats 0055f500
 * and PLRMODES_CleanupInvalidCorpses 0057f690 are the reference shapes, as Ghidra prints
 * them; both MATCH the original under VC8 once the copy sits at the end. The refusals are
 * the shapes where the move would change a value or is unproven.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createLoopCopySinkTransformer } from '../builtins/loop-copy-sink.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const run = (code: string) => emit(createLoopCopySinkTransformer()(parse(code)) as AnyNode).replace(/\s+/g, ' ').trim();
const same = (code: string) => assert.strictEqual(run(code), emit(parse(code) as AnyNode).replace(/\s+/g, ' ').trim());

// 0055f500, the source the generator emitted before this pass.
const RECALC = `void f(U* pUnit, I* pInventory) {
  U* pCarriedItem;
  unsigned nStatOwnerFlags;
  U* pCurItem = GetFirstItem(pInventory);
  while (pCurItem) {
    U* pNextItem;
    pNextItem = GetNextItem(pCurItem);
    pCarriedItem = GetCarriedItem(pCurItem);
    nStatOwnerFlags = 0;
    pCurItem = pNextItem;
    if (pCarriedItem && pCarriedItem->eUnitType == 4) {
      pNextItem = GetOwner(pCarriedItem, &nStatOwnerFlags);
      if (pNextItem) {
        Remove(pUnit, pCarriedItem);
        SetActive(pUnit, pCarriedItem, nStatOwnerFlags);
      }
    }
  }
}`;

// 0057f690.
const CORPSES = `int f(G* pGame, I* pInventory) {
  unsigned dwFindGUID;
  U* pFoundUnit;
  int nCorpseCount = 0;
  C* pCorpseEntry = GetCorpse(pInventory);
  while (pCorpseEntry) {
    C* pNextCorpse;
    pNextCorpse = GetNextCorpse(pCorpseEntry);
    dwFindGUID = GetGUID(pCorpseEntry);
    pFoundUnit = FindUnit(pGame, 0, dwFindGUID);
    pCorpseEntry = pNextCorpse;
    if (!pFoundUnit) {
      RemoveCorpse(pInventory, dwFindGUID, 1);
    } else {
      nCorpseCount++;
    }
  }
  return nCorpseCount;
}`;

describe('loop-copy-sink', () => {
  it('PLRMODES_CleanupInvalidCorpses 0057f690: the step moves to the end of the body', () => {
    assert.match(run(CORPSES),
      /pFoundUnit = FindUnit\(pGame, 0, dwFindGUID\); if \(!pFoundUnit\) \{ RemoveCorpse\(pInventory, dwFindGUID, 1\); \} else \{ nCorpseCount\+\+; \} pCorpseEntry = pNextCorpse; \} return nCorpseCount;/);
  });

  it('ITEMMODE_RecalcAllEquippedStats 0055f500: a later value of the source gets its own variable', () => {
    assert.match(run(RECALC),
      /nStatOwnerFlags = 0; U\* pNextItem2; if \(pCarriedItem && pCarriedItem->eUnitType == 4\) \{ pNextItem2 = GetOwner\(pCarriedItem, &nStatOwnerFlags\); if \(pNextItem2\) \{ Remove\(pUnit, pCarriedItem\); SetActive\(pUnit, pCarriedItem, nStatOwnerFlags\); \} \} pCurItem = pNextItem; \} \}$/);
  });

  it('a do-while and a for loop step at the end as well', () => {
    assert.match(run('void f(N* p) { N* q; do { q = p->next; g(p); p = q; h(); } while (p); }'),
      /do \{ q = p->next; g\(p\); h\(\); p = q; \} while \(p\);/);
    assert.match(run('void f(N* p) { N* q; for (; p; ) { q = p->next; g(p); p = q; h(); } }'),
      /g\(p\); h\(\); p = q; \}/);
  });

  it('refuses what it cannot prove', () => {
    // The rest of the body reads the copy's target.
    same('void f(N* p) { N* q; while (p) { q = p->next; p = q; g(p); } }');
    // The condition does not read it: not a loop step.
    same('void f(N* p, int c) { N* q; N* r; while (c) { q = p->next; r = q; g(p); } h(r); }');
    // A continue would skip the end of the body.
    same('void f(N* p) { N* q; while (p) { q = p->next; p = q; if (g()) continue; h(); } }');
    // A break leaves with the new value already in p.
    same('void f(N* p) { N* q; while (p) { q = p->next; p = q; if (g()) break; h(); } k(p); }');
    // A goto or a label in the rest.
    same('void f(N* p) { N* q; while (p) { q = p->next; p = q; if (g()) goto out; h(); } out: k(); }');
    // The source is written and the end of the body reads that value.
    same('void f(N* p) { N* q; while (p) { q = p->next; p = q; q = g(); h(q); } k(q); }');
    // The source is written by a read-modify-write: the new value derives from the copied one.
    same('void f(int i, int n) { int j; while (i) { j = i - 1; i = j; j += n; h(j); } }');
    // Types differ.
    same('void f(N* p, M* q) { while (p) { q = g(p); p = (N*)q; h(); } }');
    same('void f(int p) { short q; while (p) { q = g(p); p = q; h(); } }');
    // An address is taken.
    same('void f(N* p) { N* q; while (p) { q = p->next; p = q; h(&q); } }');
    // Nothing after it.
    same('void f(N* p) { N* q; while (p) { q = p->next; g(p); p = q; } }');
  });

  it('computes what the printed form computed', { skip: !hasNativeGpp() }, () => {
    const prelude = `struct U { int eUnitType; U* next; U* carried; U* owner; int on; };
static U* GetFirstItem(U* inv) { return inv; }
static U* GetNextItem(U* p) { return p->next; }
static U* GetCarriedItem(U* p) { return p->carried; }
static U* GetOwner(U* p, unsigned* f) { *f = p->eUnitType + 1; return p->owner; }
static int gLog;
static void Remove(U* u, U* c) { gLog = gLog * 31 + (int)(c - u); }
static void SetActive(U* u, U* c, unsigned f) { gLog = gLog * 7 + (int)f + (int)(c - u); c->on++; }
typedef U I;`;
    const before = RECALC.replace('void f(', 'void p(');
    const after = run(RECALC).replace('void f(', 'void w(');
    const out = compileAndRun(`${prelude}
${before}
${after}`, `U u[8] = {}; for (int i = 0; i < 7; i++) { u[i].next = i < 6 ? &u[i + 1] : 0; u[i].carried = i % 2 ? &u[(i + 3) % 8] : 0; u[i].eUnitType = 4; u[i].owner = i % 3 ? u : 0; }
gLog = 0; p(u, u); int a = gLog; gLog = 0; w(u, u); printf("%d\\n", a == gLog && a != 0 ? 0 : 1);`);
    assert.strictEqual(out.trim(), '0', after);
  });
});
