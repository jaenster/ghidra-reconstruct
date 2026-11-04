import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { hasNativeGpp, compileAndRun } from '../../../testing/native-cpp.js';
import { registerStoreSelectPlugin, type RegisterStoreRow } from '../builtins/register-store-select.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(code: string, rows: RegisterStoreRow[]): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = registerStoreSelectPlugin.createTransformer({
    registerStores: rows, onSite: (e: { kind: string; name: string }) => sites.push(`${e.kind}:${e.name}`),
  } as never);
  return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
}

const r = (name: string, size: number, value: number, register = true): RegisterStoreRow => ({ name, size, value, register });

const PRELUDE = [
  'struct Txt { int a; };',
  'struct Mon { short w; Txt* pTxt; };',
  'struct Unit { int nId; };',
  'Txt gTbl[3] = {{1}, {2}, {3}};',
  'int gSize = 3; int gId = 5;',
  'int Next(int k) { return k > 1; }',
].join('\n');

// MONSTER_SetMonStatsTxtAndType 004ae0a0, as printed.
const monStats = [
  'void f(Mon* pMon, int nClassId) {',
  '  if (nClassId >= 0 && nClassId < gSize) {',
  '    pMon->pTxt = gTbl + nClassId;',
  '    return;',
  '  }',
  '  pMon->pTxt = 0;',
  '}',
].join('\n');

// Q04_SetRescueTrigger 00592f80: the constant arm first.
const rescue = [
  'void g(Mon* pMon, Unit* pUnit) {',
  '  pMon->w = 1;',
  '  if (!pUnit) {',
  '    gId = -1;',
  '    return;',
  '  }',
  '  gId = pUnit->nId;',
  '}',
].join('\n');

// UI_SLIDER_InitAutomapParty 0047d4d0: the second test's value in a local of the inner block.
const slider = [
  'void h(Mon* pItem, int k) {',
  '  int bHasParty = Next(k);',
  '  if (bHasParty) {',
  '    int bNames;',
  '    bNames = Next(k + 1);',
  '    if (bNames) {',
  '      pItem->w = 1;',
  '      return;',
  '    }',
  '  }',
  '  pItem->w = 0;',
  '}',
].join('\n');

describe('register-store-select', () => {
  it('joins a guard store and the final store into a select', () => {
    const { out, sites } = run(monStats, [r('pTxt', 4, 0)]);
    assert.deepStrictEqual(sites, ['guard:pTxt']);
    assert.ok(out.includes('pMon->pTxt = nClassId >= 0 && nClassId < gSize ? gTbl + nClassId : 0; }'), out);
  });

  it('keeps the condition as printed, constant arm first', () => {
    const { out, sites } = run(rescue, [r('gId', 4, 0xffffffff)]);
    assert.deepStrictEqual(sites, ['guard:gId']);
    assert.ok(out.includes('gId = !pUnit ? -1 : pUnit->nId; }'), out);
  });

  it('folds the inner local into the condition (nested)', () => {
    const { out, sites } = run(slider, [r('w', 2, 1), r('w', 2, 0)]);
    assert.deepStrictEqual(sites, ['nested:w']);
    assert.ok(out.includes('pItem->w = bHasParty && Next(k + 1) ? 1 : 0; }'), out);
  });

  it('joins an if/else of two stores', () => {
    const code = 'void e(Mon* p, int c) { if (c > 2) { p->w = 7; } else { p->w = c; } c++; }';
    const { out, sites } = run(code, [r('w', 2, 7)]);
    assert.deepStrictEqual(sites, ['else:w']);
    assert.ok(out.includes('p->w = c > 2 ? 7 : c; c++;'), out);
  });

  it('does nothing without a register row, or when one store of the value is immediate', () => {
    assert.deepStrictEqual(run(monStats, []).sites, []);
    assert.deepStrictEqual(run(monStats, [r('pTxt', 4, 0, false)]).sites, []);
    assert.deepStrictEqual(run(monStats, [r('pTxt', 4, 0), r('pTxt', 4, 0, false), r('w', 2, 1)]).sites, []);
    assert.deepStrictEqual(run(monStats, [r('pTxt', 4, 1)]).sites, []);
    // Both arms constant: each needs its own register row.
    assert.deepStrictEqual(run(slider, [r('w', 2, 1)]).sites, []);
  });

  // SBIG_BigBuffer_GetFirstWord 00421510: the same name and value stored as an immediate first.
  it('ties a name and value stored both ways by order', () => {
    const code = [
      'void w(int* pOut, Mon* pMon, int c) {',
      '  *pOut = 0;',
      '  if (c < gSize) {',
      '    *pOut = gTbl[c].a;',
      '    return;',
      '  }',
      '  *pOut = 0;',
      '}',
    ].join('\n');
    const { out, sites } = run(code, [r('pOut', 4, 0, false), r('pOut', 4, 0)]);
    assert.deepStrictEqual(sites, ['guard:pOut']);
    assert.ok(out.includes('*pOut = 0; *pOut = c < gSize ? gTbl[c].a : 0; }'), out);
    // Rows in the other order: the tail store is the immediate one.
    assert.deepStrictEqual(run(code, [r('pOut', 4, 0), r('pOut', 4, 0, false)]).sites, []);
    // A count that differs from the body's: all rows must agree.
    assert.deepStrictEqual(run(code, [r('pOut', 4, 0, false), r('pOut', 4, 0), r('pOut', 4, 0)]).sites, []);
  });

  it('matches a negative constant to its row masked to the store size', () => {
    const code = monStats.replace('pMon->pTxt = 0;', 'pMon->w = -0x8000;').replace('pMon->pTxt = gTbl + nClassId;', 'pMon->w = (short)nClassId;');
    assert.deepStrictEqual(run(code, [r('w', 2, 0x8000)]).sites, ['guard:w']);
  });

  it('leaves a guard store that is not in tail position', () => {
    const code = monStats.replace('  pMon->pTxt = 0;\n}', '  pMon->pTxt = 0;\n  pMon->w = 3;\n}');
    assert.deepStrictEqual(run(code, [r('pTxt', 4, 0)]).sites, []);
  });

  it('leaves a non-void function, different lvalues, and a subscript', () => {
    assert.deepStrictEqual(run(monStats.replace('void f(', 'int f(').replace('    return;', '    return 1;'), [r('pTxt', 4, 0)]).sites, []);
    const other = monStats.replace('  pMon->pTxt = 0;', '  gTbl[0].a = 0;');
    assert.deepStrictEqual(run(other, [r('a', 4, 0)]).sites, []);
    const sub = 'void s(int* p, int c) { if (c) { p[c] = 0; } else { p[c] = 1; } }';
    assert.deepStrictEqual(run(sub, [r('c', 4, 0), r('c', 4, 1)]).sites, []);
  });

  it('leaves the nested form when the local is read elsewhere or narrower than 32 bits', () => {
    assert.deepStrictEqual(run(slider.replace('      pItem->w = 1;', '      pItem->w = bNames;'), [r('w', 2, 1), r('w', 2, 0)]).sites, []);
    assert.deepStrictEqual(run(slider.replace('    int bNames;', '    char bNames;'), [r('w', 2, 1), r('w', 2, 0)]).sites, []);
  });

  it('computes what the printed form computes (compiled)', { skip: !hasNativeGpp() }, () => {
    const a = run(monStats, [r('pTxt', 4, 0)]).out, b = run(rescue, [r('gId', 4, 0xffffffff)]).out;
    const c = run(slider, [r('w', 2, 1), r('w', 2, 0)]).out;
    const prelude = [
      PRELUDE,
      monStats.replace('void f(', 'void f0('), a.replace('void f(', 'void f1('),
      rescue.replace('void g(', 'void g0('), b.replace('void g(', 'void g1('),
      slider.replace('void h(', 'void h0('), c.replace('void h(', 'void h1('),
    ].join('\n');
    const res = compileAndRun(prelude, [
      'Unit u = {9}; Mon m0 = {0, nullptr}, m1 = {0, nullptr};',
      'for (int k = -2; k < 5; k++) { f0(&m0, k); f1(&m1, k); printf("%d/%d\\n", (int)(m0.pTxt - gTbl), (int)(m1.pTxt - gTbl)); }',
      'for (int k = 0; k < 2; k++) { g0(&m0, k ? &u : nullptr); int x = gId; gId = 5; g1(&m1, k ? &u : nullptr); printf("%d/%d\\n", x, gId); }',
      'for (int k = -1; k < 4; k++) { h0(&m0, k); h1(&m1, k); printf("%d/%d\\n", m0.w, m1.w); }',
    ].join('\n'));
    for (const line of res.trim().split('\n')) {
      const [x, y] = line.split('/');
      assert.strictEqual(x, y, res);
    }
  });
});
