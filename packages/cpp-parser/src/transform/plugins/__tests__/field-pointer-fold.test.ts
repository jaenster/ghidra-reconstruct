import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { hasNativeGpp, compileAndRun } from '../../../testing/native-cpp.js';
import { fieldPointerFoldPlugin, type FieldPointerFoldOptions } from '../builtins/field-pointer-fold.js';
import type { BranchLayoutEvidence } from '../builtins/branch-layout/evidence.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

const PRELUDE = [
  'struct Sub { int nPad; int nCount; unsigned int dwFlags; short sGuid[4]; };',
  'struct Quest { int nPad; Sub *pSub; Sub aSubs[2]; };',
].join('\n');

const TABLES: Partial<FieldPointerFoldOptions> = {
  functionReturnTypes: { Use: 'int', Touch: 'void' },
  globalTypes: { gnMask: 'unsigned int' },
  structFields: {
    Quest: { nPad: 'int', pSub: 'Sub *', aSubs: 'Sub [2]' },
    Sub: { nPad: 'int', nCount: 'int', dwFlags: 'unsigned int', sGuid: 'short [4]' },
  },
};

function run(lines: string[], opts: Partial<FieldPointerFoldOptions> = {}): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = fieldPointerFoldPlugin.createTransformer({
    onSite: e => sites.push(`${e.rule}:${e.name}${e.why ? `:${e.why}` : ''}`), ...TABLES, ...opts,
  } as FieldPointerFoldOptions);
  return { out: flat(emit(t(parse(lines.join('\n'))) as AnyNode)), sites };
}

describe('field-pointer-fold', () => {
  // Q28_PlayerCompleteForgeInAct4, 005b5b00.
  it('folds a pointer temporary into the field it increments', () => {
    const r = run([
      'void f(Quest* pQuest) {',
      '  int* pCount = &pQuest->pSub->nCount;',
      '  (*pCount)++;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['single:pCount']);
    assert.strictEqual(r.out, 'void f(Quest* pQuest) { pQuest->pSub->nCount++; }');
  });

  it('folds a compound update with a pure right side, and the assigned form', () => {
    const r = run([
      'void f(Quest* pQuest, int i) {',
      '  unsigned int* pFlags;',
      '  Use(1);',
      '  pFlags = &pQuest->aSubs[i].dwFlags;',
      '  *pFlags |= gnMask;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['single:pFlags']);
    assert.strictEqual(r.out, 'void f(Quest* pQuest, int i) { Use(1); pQuest->aSubs[i].dwFlags |= gnMask; }');
  });

  // AnimateTile, 0066d3b0: one declaration, two assigned uses.
  it('folds every assigned use of one declaration and drops it', () => {
    const r = run([
      'void f(Quest* pQuest, int i) {',
      '  unsigned int* pFlags;',
      '  if (i) {',
      '    pFlags = &pQuest->aSubs[i].dwFlags;',
      '    *pFlags |= 8;',
      '  }',
      '  pFlags = &pQuest->pSub->dwFlags;',
      '  *pFlags &= gnMask;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['single:pFlags', 'single:pFlags']);
    assert.strictEqual(r.out, 'void f(Quest* pQuest, int i) { if (i) { pQuest->aSubs[i].dwFlags |= 8; } pQuest->pSub->dwFlags &= gnMask; }');
  });

  it('keeps the declaration while an assigned use is left', () => {
    const r = run([
      'void f(Quest* pQuest, int i) {',
      '  unsigned int* pFlags;',
      '  pFlags = &pQuest->aSubs[Use(i)].dwFlags;',
      '  *pFlags |= 8;',
      '  pFlags = &pQuest->pSub->dwFlags;',
      '  *pFlags &= gnMask;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['single:pFlags:not a pure place', 'single:pFlags']);
    assert.strictEqual(r.out, 'void f(Quest* pQuest, int i) { unsigned int* pFlags; pFlags = &pQuest->aSubs[Use(i)].dwFlags; *pFlags |= 8; pQuest->pSub->dwFlags &= gnMask; }');
  });

  it('refuses a right side that calls', () => {
    const r = run([
      'void f(Quest* pQuest) {',
      '  int* pCount = &pQuest->pSub->nCount;',
      '  *pCount += Use(2);',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, []);
    assert.ok(r.out.includes('*pCount += Use(2);'), r.out);
  });

  it('holds the record, not a single fold, for a pointer named again later', () => {
    const r = run([
      'int f(Quest* pQuest) {',
      '  int* pCount = &pQuest->pSub->nCount;',
      '  (*pCount)--;',
      '  return *pCount;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['single:pCount:named elsewhere', 'multi:pCount']);
    assert.strictEqual(r.out, 'int f(Quest* pQuest) { Sub* pSub = pQuest->pSub; pSub->nCount--; return pSub->nCount; }');
  });

  it('refuses a statement between the pointer and the update', () => {
    const r = run([
      'void f(Quest* pQuest) {',
      '  int* pCount = &pQuest->pSub->nCount;',
      '  Touch();',
      '  (*pCount)++;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, []);
    assert.ok(r.out.includes('int* pCount = &pQuest->pSub->nCount; Touch(); (*pCount)++;'), r.out);
  });

  it('refuses a pointer whose type is not the field\'s', () => {
    const r = run([
      'void f(Quest* pQuest) {',
      '  int* pFlags = &pQuest->pSub->dwFlags;',
      '  *pFlags >>= 1;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['single:pFlags:type of the place unknown or different']);
  });

  it('refuses a place with a call in it', () => {
    const r = run([
      'void f(Quest* pQuest) {',
      '  int* pCount = &pQuest->aSubs[Use(0)].nCount;',
      '  (*pCount)++;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['single:pCount:not a pure place']);
  });

  // Q05_SetRewardForPlayersInTower, 00594dd0.
  it('holds the record for a field pointer used across calls', () => {
    const r = run([
      'void f(Quest* pQuest, int n) {',
      '  short* pList = &pQuest->pSub->sGuid;',
      '  if (!Use(pList, n)) {',
      '    Use(pList, n);',
      '  }',
      '}',
    ], { structFields: { ...TABLES.structFields, Sub: { ...TABLES.structFields!.Sub, sGuid: 'short' } } });
    assert.deepStrictEqual(r.sites, ['multi:pList']);
    assert.ok(r.out.includes('Sub* pSub = pQuest->pSub; if (!Use(&pSub->sGuid, n)) { Use(&pSub->sGuid, n); }'), r.out);
  });

  it('refuses a field pointer that is advanced', () => {
    const r = run([
      'void f(Quest* pQuest) {',
      '  short* pList = &pQuest->pSub->sGuid;',
      '  Use(pList);',
      '  pList++;',
      '  Use(pList);',
      '}',
    ], { structFields: { ...TABLES.structFields, Sub: { ...TABLES.structFields!.Sub, sGuid: 'short' } } });
    assert.deepStrictEqual(r.sites, ['multi:pList:pointer written or addressed']);
  });

  // ARENA_ClearUpdateFlag 0053fae0: the record is tested right above the update.
  it('refuses a fold through a record the function reads again', () => {
    const r = run([
      'void f(Quest* pQuest) {',
      '  if (pQuest->pSub) {',
      '    int* pCount = &pQuest->pSub->nCount;',
      '    (*pCount)++;',
      '  }',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['single:pCount:record read elsewhere']);
    const named = run([
      'void f(Sub* pSub) {',
      '  if (pSub) {',
      '    int* pCount = &pSub->nCount;',
      '    (*pCount)++;',
      '  }',
      '}',
    ]);
    assert.deepStrictEqual(named.sites, ['single:pCount']);
  });

  it('leaves a field pointer named again through a plain name', () => {
    const r = run([
      'int f(Sub* pSub) {',
      '  int* p = &pSub->nCount;',
      '  (*p)--;',
      '  Touch();',
      '  return *p;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['single:p:named elsewhere']);
  });

  it('computes what the temporaries computed', { skip: !hasNativeGpp() }, () => {
    const body = [
      'int f(Quest* pQuest, int i) {',
      '  int* pCount = &pQuest->aSubs[i].nCount;',
      '  (*pCount)++;',
      '  unsigned int* pFlags = &pQuest->aSubs[0].dwFlags;',
      '  *pFlags |= gnMask;',
      '  int* pN = &pQuest->pSub->nCount;',
      '  Use(pN);',
      '  pQuest->pSub = &pQuest->aSubs[1];',
      '  Use(pN);',
      '  return pQuest->aSubs[i].nCount * 100 + (int)pQuest->aSubs[0].dwFlags;',
      '}',
    ];
    const r = run(body);
    assert.deepStrictEqual(r.sites, ['single:pCount', 'single:pFlags', 'multi:pN']);
    const prelude = (fn: string) => [
      PRELUDE, '#include <cstdio>', 'unsigned int gnMask = 6;',
      'int Use(int* p) { return ++*p; }', fn,
    ].join('\n');
    const main = [
      'Quest q = {0, 0, {{0, 1, 1, {0}}, {0, 5, 8, {0}}}};',
      'q.pSub = &q.aSubs[0];',
      'printf("%d ", f(&q, 1));',
      'printf("%d %d", q.aSubs[0].nCount, q.aSubs[1].nCount);',
    ].join('\n');
    const before = compileAndRun(prelude(body.join('\n')), main);
    const after = compileAndRun(prelude(r.out), main);
    assert.ok(before.length > 0);
    assert.strictEqual(after, before);
  });

  // Q35_OnPlayerDeath 0058cf00: `mov ecx, [eax + 0x18]` (1e) shared by the test and the
  // update `add dword ptr [ecx + 0xc], 1` (27), then `mov ecx, [eax + 0x18]` (2b) again for
  // the store after it (2e).
  describe('a record the original reloads after the update', () => {
    const Q35 = [
      'void f(Quest* pQuest) {',
      '  if (pQuest->pSub->nPad) {',
      '    return;',
      '  }',
      '  int* pCount = &pQuest->pSub->nCount;',
      '  (*pCount)++;',
      '  pQuest->pSub->dwFlags = 0;',
      '}',
    ];
    const ev = (after: number[]): BranchLayoutEvidence => ({
      lines: new Map([[2, [0x1e, 0x23, 0x25]], [5, [0x1e, 0x27]], [6, [0x27]], [7, after]]),
      ifs: new Map([[2, 0x25]]),
    });

    it('folds the update when the next read of the record is a fresh load', () => {
      const r = run(Q35, { branchLayout: ev([0x2b, 0x2e]) });
      assert.deepStrictEqual(r.sites, ['single:pCount']);
      assert.ok(r.out.includes('pQuest->pSub->nCount++; pQuest->pSub->dwFlags = 0;'), r.out);
    });

    it('keeps the pointer when the next read prints the earlier load (the record held)', () => {
      const r = run(Q35, { branchLayout: ev([0x1e, 0x2e]) });
      assert.deepStrictEqual(r.sites, ['single:pCount:record read elsewhere']);
    });

    it('keeps the pointer without the facts or without a read after the update', () => {
      assert.deepStrictEqual(run(Q35).sites, ['single:pCount:record read elsewhere']);
      const r = run(Q35.filter((_, i) => i !== 6), { branchLayout: ev([0x2b, 0x2e]) });
      assert.deepStrictEqual(r.sites, ['single:pCount:record read elsewhere']);
    });
  });
});
