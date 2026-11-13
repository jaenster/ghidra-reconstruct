/**
 * vc8form index forms: `ptrwalk` (an index loop walks a pointer) and `rowptr` (a row read through
 * a pointer local). The bodies are the generator's for NPCSHOP_GetActiveTabIndex 004c0450,
 * Shrines_CombatBoostFunction 005839b0 and UNITS_GetAnimFrameSkip 00621630.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite } from '../builtins/vc8-form.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const TABLES = { globalTypes: { gaNpcCashTabs: 'D2NpcCashTabStrc[2]', OBJECTSHRINEFUNCTION: 'D2ShrinesTableEntryStrc[24]', gaAnimTableClassic: 'int[80]', gpAnimTable: 'int*' } };

function run(code: string, form: string, tables: object | undefined = TABLES): { out: string; site: Vc8FormSite } {
  const f = parseVc8Form(form);
  assert.ok(f, `parses: ${form}`);
  let site: Vc8FormSite | undefined;
  const tu = applyVc8Forms(parse(code) as TranslationUnit, [{ form: f!, tag: form }], s => { site = s; }, tables as never);
  return { out: flat(emit(tu as AnyNode)), site: site! };
}

const NPCSHOP = (body = '      if (gaNpcCashTabs[nTabIdx].bVisible && nMouseX >= gaNpcCashTabs[nTabIdx].nHitBoxX1 && nMouseX <= gaNpcCashTabs[nTabIdx].nHitBoxX2) {\n        bHandled = 1;\n      }') => `static BOOL NPCSHOP_GetActiveTabIndex(int32_t nMouseY, int32_t nMouseX) {
    int nTabIdx;
    BOOL bHandled = 0;
    for (nTabIdx = 0; nTabIdx < UseItem::nCashDisplayItemCount; nTabIdx++) {
${body}
    }
    return bHandled;
}`;

describe('vc8-form index: parsing', () => {
  it('ptrwalk and rowptr', () => {
    assert.deepStrictEqual(parseVc8Form('ptrwalk(i,gaTabs,t2_p0,D2Tab)'), { op: 'ptrwalk', counter: 'i', array: 'gaTabs', name: 't2_p0', type: 'D2Tab', index: 0 });
    assert.deepStrictEqual(parseVc8Form('ptrwalk(i,gaTabs,t2_p0,D2Tab,2)'), { op: 'ptrwalk', counter: 'i', array: 'gaTabs', name: 't2_p0', type: 'D2Tab', index: 2 });
    assert.deepStrictEqual(parseVc8Form('rowptr(tbl[n * 5],t2_r0,int,@nLine)'), { op: 'rowptr', expr: 'tbl[n * 5]', name: 't2_r0', type: 'int', anchor: 'nLine' });
    assert.strictEqual(parseVc8Form('rowptr(tbl,t2_r0,int)'), undefined);
    assert.strictEqual(parseVc8Form('ptrwalk(i,gaTabs,t2_p0)'), undefined);
  });
});

describe('vc8-form index: ptrwalk', () => {
  it('NPCSHOP_GetActiveTabIndex 004c0450: the tab loop walks a D2NpcCashTabStrc pointer beside its counter', () => {
    const { out, site } = run(NPCSHOP(), 'ptrwalk(nTabIdx,gaNpcCashTabs,t2_p0,D2NpcCashTabStrc)');
    assert.ok(site.applied, site.why);
    assert.match(out, /D2NpcCashTabStrc\* t2_p0 = &gaNpcCashTabs\[0\]; for \(nTabIdx = 0; nTabIdx < UseItem::nCashDisplayItemCount; nTabIdx\+\+ ?, t2_p0\+\+\) \{ if \(t2_p0->bVisible && nMouseX >= t2_p0->nHitBoxX1 && nMouseX <= t2_p0->nHitBoxX2\)/);
    assert.doesNotMatch(out, /gaNpcCashTabs\[nTabIdx\]/);
  });

  it('refuses when the loop stores the counter, the table is a pointer global, or the start is computed', () => {
    assert.strictEqual(run(NPCSHOP('      nTabIdx = g(gaNpcCashTabs[nTabIdx].bVisible);'), 'ptrwalk(nTabIdx,gaNpcCashTabs,t2_p0,D2NpcCashTabStrc)').site.applied, false);
    assert.strictEqual(run(NPCSHOP(), 'ptrwalk(nTabIdx,gaNpcCashTabs,t2_p0,D2NpcCashTabStrc)', {}).site.applied, false);
    const computed = NPCSHOP().replace('nTabIdx = 0;', 'nTabIdx = h();');
    assert.strictEqual(run(computed, 'ptrwalk(nTabIdx,gaNpcCashTabs,t2_p0,D2NpcCashTabStrc)').site.applied, false);
  });

  it('a local pointer reassigned in the loop does not stay put', () => {
    const code = `void f(int* pVals, int n) {
  int i;
  int nSum = 0;
  for (i = 0; i < n; i++) {
    nSum += pVals[i];
    pVals = g(pVals);
  }
}`;
    assert.strictEqual(run(code, 'ptrwalk(i,pVals,t2_p0,int)').site.applied, false);
    const ok = run(code.replace('    pVals = g(pVals);\n', ''), 'ptrwalk(i,pVals,t2_p0,int)');
    assert.ok(ok.site.applied, ok.site.why);
    assert.match(ok.out, /int\* t2_p0 = &pVals\[0\]; for \(i = 0; i < n; i\+\+ ?, t2_p0\+\+\) \{ nSum \+= \*t2_p0; \}/);
  });
});

describe('vc8-form index: rowptr', () => {
  const SHRINE = `void __fastcall Shrines_CombatBoostFunction(D2ObjectOperateFnArg * pArguments, D2ShrinesTxt * pTxtShrines) {
    int32_t nLine;
    uint8_t byShrineCode = pTxtShrines->nCode;
    if ((int)(uint32_t)byShrineCode >= SHRINESCOUNT) {
      ERROR_UnrecoverableInternalError_Halt("", GetInstructionPointer(), 0x9c1);
      exit(-1);
    }
    nLine = OBJMODE_GetModifiedStatValueFromShrine(UNITSTAT_tohit, pTxtShrines->dwArg0, pArguments->pAttacker);
    D2StatListExStrc* pStatEx = ApplyShrineBonus(pArguments->sArg.pVictim, pArguments->pAttacker, pTxtShrines->dwDurationInFrames, pTxtShrines->dwArg1, UNITSTAT_damagepercent, OBJECTSHRINEFUNCTION[byShrineCode].nState, nullptr);
    STATLIST_SetStatValue(pStatEx, UNITSTAT_tohit, nLine, 0);
}`;

  it('Shrines_CombatBoostFunction 005839b0: the shrine row is taken before the bonus call, read as t2_r0->nState', () => {
    const { out, site } = run(SHRINE, 'rowptr(OBJECTSHRINEFUNCTION[byShrineCode],t2_r0,D2ShrinesTableEntryStrc,@nLine)');
    assert.ok(site.applied, site.why);
    assert.match(out, /D2ShrinesTableEntryStrc\* t2_r0 = &OBJECTSHRINEFUNCTION\[byShrineCode\]; nLine = OBJMODE_GetModifiedStatValueFromShrine/);
    assert.match(out, /UNITSTAT_damagepercent, t2_r0->nState, nullptr\)/);
  });

  it('refuses a row of a global the tables do not show as an array, and one whose index changes', () => {
    assert.strictEqual(run(SHRINE, 'rowptr(OBJECTSHRINEFUNCTION[byShrineCode],t2_r0,D2ShrinesTableEntryStrc,@nLine)', {}).site.applied, false);
    const moved = SHRINE.replace('    D2StatListExStrc* pStatEx', '    byShrineCode = 3;\n    D2StatListExStrc* pStatEx');
    assert.strictEqual(run(moved, 'rowptr(OBJECTSHRINEFUNCTION[byShrineCode],t2_r0,D2ShrinesTableEntryStrc,@nLine)').site.applied, false);
  });

  it('UNITS_GetAnimFrameSkip 00621630: a flat table read at nAnimMode * 5 + 4 is the row pointer\'s [4]', () => {
    const code = `static int __stdcall UNITS_GetAnimFrameSkip(int32_t nAnimMode, int32_t nClassId) {
    if (nClassId < 0x19a) {
      return gaAnimTableClassic[nAnimMode * 5 + 4] + gaAnimTableClassic[nAnimMode * 5];
    }
    return 0;
}`;
    const { out, site } = run(code, 'rowptr(gaAnimTableClassic[nAnimMode * 5],t2_r0,int)');
    assert.ok(site.applied, site.why);
    assert.match(out, /int\* t2_r0 = &gaAnimTableClassic\[nAnimMode \* 5\]; return t2_r0\[4\] \+ \*t2_r0;/);
    assert.strictEqual(run(code.replace(/gaAnimTableClassic/g, 'gpAnimTable'), 'rowptr(gpAnimTable[nAnimMode * 5],t2_r0,int)').site.applied, false);
  });
});
