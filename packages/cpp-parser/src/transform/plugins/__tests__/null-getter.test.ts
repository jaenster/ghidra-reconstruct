/**
 * A null-guarded field read compared with a constant goes back to the getter the source
 * called (`compare-form` with `null-getter.ts`): `p && p->f == K` -> `(p ? p->f : D) == K`
 * where the instructions load the field into a register, D the default the original's own
 * getters return for null. The refusals are the cases where the rewrite would be wrong or
 * unproven: no load, no default, a default equal to K, a test of another pointer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, FunctionDecl, TranslationUnit } from '../../../ast/nodes.js';
import { NodeKind } from '../../../ast/kinds.js';
import { createCompareFormTransformer, type CompareFormDecision, type CompareFormOptions } from '../builtins/compare-form.js';
import { nullGetterEvidence, nullGetterTable, type NullGetterTable } from '../builtins/null-getter.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const ENUMS: Record<string, number> = { Death: 0, Neutral: 1, UNIT_PLAYER: 0, UNIT_MONSTER: 1, UNIT_COUNT: 6 };
const enumValue = (n: string) => ENUMS[n];

function fnOf(code: string): FunctionDecl {
  return (parse(code) as TranslationUnit).declarations.find(d => d.kind === NodeKind.FunctionDecl) as FunctionDecl;
}

function evidence(code: string) {
  return nullGetterEvidence(fnOf(code), enumValue).map(e => `${e.key}=${e.value}${e.name ? `(${e.name})` : ''}:${e.form}`);
}

describe('null-getter evidence', () => {
  it('reads an out-of-line getter (GetAnimMode 00451f70, GetClassId 00451f60)', () => {
    assert.deepStrictEqual(evidence(`eD2PlayerAnimMode GetAnimMode(D2UnitStrc *pUnit) {
  if (pUnit == (D2UnitStrc *)0x0) {
    return Death;
  }
  return (pUnit->eAnimMode).ePlayerMode;
}`), ['D2UnitStrc|eAnimMode.ePlayerMode=0(Death):getter']);
    assert.deepStrictEqual(evidence('int GetClassId(D2UnitStrc *pUnit) { if (pUnit != (D2UnitStrc *)0x0) { return pUnit->nClassId; } return -1; }'),
      ['D2UnitStrc|nClassId=-1:getter']);
    assert.deepStrictEqual(evidence('int g(D2UnitStrc *pUnit) { return pUnit == (D2UnitStrc *)0x0 ? -1 : pUnit->nUnitGUID; }'),
      ['D2UnitStrc|nUnitGUID=-1:getter']);
  });

  it('reads inlined copies: a default then a guarded read, and the two arms of one test', () => {
    assert.deepStrictEqual(evidence(`void f(D2UnitStrc *pUnit, D2TimerStrc *pTimer) {
  eD2UnitType eUnitType;
  eUnitType = UNIT_COUNT;
  if (pUnit != (D2UnitStrc *)0x0) {
    eUnitType = pUnit->eUnitType;
  }
  pTimer->eUnitType = eUnitType;
}`), ['D2UnitStrc|eUnitType=6(UNIT_COUNT):inline']);
    assert.deepStrictEqual(evidence(`void f(D2UnitStrc *pUnit) {
  int nGUID;
  eD2UnitType eType;
  if (pUnit == (D2UnitStrc *)0x0) {
    nGUID = -1;
    eType = UNIT_COUNT;
  }
  else {
    nGUID = pUnit->nUnitGUID;
    eType = pUnit->eUnitType;
  }
  g(eType, nGUID);
}`).sort(), ['D2UnitStrc|eUnitType=6(UNIT_COUNT):inline', 'D2UnitStrc|nUnitGUID=-1:inline']);
  });

  it('takes nothing that is not that shape', () => {
    // Not a constant default.
    assert.deepStrictEqual(evidence('int f(D2UnitStrc *pUnit, int n) { int v; v = n; if (pUnit != (D2UnitStrc *)0x0) { v = pUnit->nClassId; } return v; }'), []);
    // The guarded store is not the defaulted variable.
    assert.deepStrictEqual(evidence('int f(D2UnitStrc *pUnit) { int v; int w; v = 3; if (pUnit != (D2UnitStrc *)0x0) { w = pUnit->nClassId; } return v; }'), []);
    // The read is through another pointer than the tested one.
    assert.deepStrictEqual(evidence('int f(D2UnitStrc *pUnit, D2UnitStrc *pOther) { int v; v = 3; if (pUnit != (D2UnitStrc *)0x0) { v = pOther->nClassId; } return v; }'), []);
    // An arm that does more than assign.
    assert.deepStrictEqual(evidence('void f(D2UnitStrc *pUnit) { int v; if (pUnit == (D2UnitStrc *)0x0) { v = 3; h(); } else { v = pUnit->nClassId; } g(v); }'), []);
  });

  it('a field whose evidence disagrees gets no default', () => {
    const { table, conflicts } = nullGetterTable([
      { key: 'D2UnitStrc|nUnitGUID', value: -1, form: 'getter' },
      { key: 'D2UnitStrc|nUnitGUID', value: 0, form: 'inline' },
      { key: 'D2UnitStrc|eUnitType', value: 6, form: 'inline' },
      { key: 'D2UnitStrc|eUnitType', value: 6, name: 'UNIT_COUNT', form: 'inline' },
    ]);
    assert.deepStrictEqual(table, { 'D2UnitStrc|eUnitType': { value: 6, name: 'UNIT_COUNT' } });
    assert.deepStrictEqual(conflicts, ['D2UnitStrc|nUnitGUID']);
  });
});

const TABLE: NullGetterTable = {
  'D2UnitStrc|eAnimMode.ePlayerMode': { value: 0, name: 'Death' },
  'D2UnitStrc|eUnitType': { value: 6, name: 'UNIT_COUNT' },
  'D2UnitStrc|nClassId': { value: -1 },
};

type Site = { text: string; fp: [string, string] };
const dec = (d: Partial<CompareFormDecision> & { ord: number; text: string; fp: [string, string] }): CompareFormDecision =>
  ({ width: 4, address: '0046d324', ...d });

/** The comparisons of `cond` as the extraction prints them: the null test, then the field compare. */
function run(cond: string, field: Partial<CompareFormDecision>, opts: { table?: NullGetterTable; nullOp?: string; cmpOp?: string } = {}): string {
  const sites: Site[] = [
    { text: opts.nullOp ?? '!=', fp: ['v:pUnit', 'c:0'] },
    { text: opts.cmpOp ?? '==', fp: ['e', 'c:1'] },
  ];
  const decisions = [
    dec({ ord: 0, ...sites[0], keep: true, k: 0 }),
    dec({ ord: 1, ...sites[1], keep: true, k: 1, load: true, ...field }),
  ];
  const code = `void f(D2UnitStrc *pUnit) { if (${cond}) { g(); } }`;
  const o: CompareFormOptions = { sites, decisions, nullGetters: opts.table ?? TABLE };
  return emit(createCompareFormTransformer(o)(parse(code)) as AnyNode).replace(/\s+/g, ' ').trim();
}

describe('compare-form writes the getter back', () => {
  it('CLIENT_MonsterSeekCorpse 0046d310: the anim-mode test with GetAnimMode\'s Death', () => {
    const out = run('(pUnit != (D2UnitStrc *)0x0) && ((pUnit->eAnimMode).ePlayerMode == Neutral)', {});
    assert.match(out, /\(pUnit \? pUnit->eAnimMode\.ePlayerMode : Death\) == Neutral/);
    assert.ok(!out.includes('&&'), out);
  });

  it('ClearAISub 00573180: the type test inside a longer chain keeps the other tests', () => {
    const out = run('(pUnit != (D2UnitStrc *)0x0) && (pUnit->eUnitType == UNIT_MONSTER) && (pUnit->pMonsterData != 0)', {});
    assert.match(out, /\(pUnit \? pUnit->eUnitType : UNIT_COUNT\) == UNIT_MONSTER && pUnit->pMonsterData != 0/);
  });

  it('the negated form: `!p || p->f != K`', () => {
    const out = run('(pUnit == (D2UnitStrc *)0x0) || (pUnit->eUnitType != UNIT_MONSTER)', { text: '!=' }, { nullOp: '==', cmpOp: '!=' });
    assert.match(out, /\(pUnit \? pUnit->eUnitType : UNIT_COUNT\) != UNIT_MONSTER/);
  });

  it('a negative default is written as a literal', () => {
    const out = run('(pUnit != (D2UnitStrc *)0x0) && (pUnit->nClassId == 1)', {});
    assert.match(out, /\(pUnit \? pUnit->nClassId : -1\) == 1/);
  });

  it('refuses: compared in memory, no default, a default equal to K, another pointer, the wrong operator', () => {
    const anim = '(pUnit != (D2UnitStrc *)0x0) && ((pUnit->eAnimMode).ePlayerMode == Neutral)';
    // `CMP [p+d],K`: the decompile's own form.
    assert.ok(run(anim, { load: undefined }).includes('&&'));
    // No getter for the field.
    assert.ok(run(anim, {}, { table: {} }).includes('&&'));
    // D == K: `(p ? f : K) == K` is true for null, `p && f == K` is not.
    assert.ok(run('(pUnit != (D2UnitStrc *)0x0) && (pUnit->eUnitType == UNIT_COUNT)', { k: 6 }).includes('&&'));
    // The field is read through another pointer.
    assert.ok(run('(pUnit != (D2UnitStrc *)0x0) && (pOther->eUnitType == UNIT_MONSTER)', {}).includes('&&'));
    // `p && f != K` is not a getter compare: `(p ? f : D) != K` is true for null.
    assert.ok(run('(pUnit != (D2UnitStrc *)0x0) && (pUnit->eUnitType != UNIT_MONSTER)', { text: '!=' }, { cmpOp: '!=' }).includes('&&'));
    // A null test that is not the one guarding the read (`p == 0 && ...`).
    assert.ok(run('(pUnit == (D2UnitStrc *)0x0) && (pUnit->eUnitType == UNIT_MONSTER)', {}, { nullOp: '==' }).includes('&&'));
  });

  it('computes what the printed form computed', { skip: !hasNativeGpp() }, () => {
    const prelude = `enum eD2UnitType { UNIT_PLAYER, UNIT_MONSTER, UNIT_OBJECT, UNIT_MISSILE, UNIT_ITEM, UNIT_TILE, UNIT_COUNT };
struct D2UnitStrc { eD2UnitType eUnitType; int nClassId; };`;
    const cases: Array<[string, string]> = [
      ['(pUnit != (D2UnitStrc *)0x0) && (pUnit->eUnitType == UNIT_MONSTER)', 'UNIT_MONSTER'],
      ['(pUnit != (D2UnitStrc *)0x0) && (pUnit->nClassId == 1)', '1'],
    ];
    for (const [cond] of cases) {
      const written = run(cond, {}).replace('void f(', 'int w(').replace('{ g(); }', '{ return 1; } return 0;');
      const out = compileAndRun(`${prelude}\nint p(D2UnitStrc *pUnit) { if (${cond}) { return 1; } return 0; }\n${written}`,
        'int bad = 0; D2UnitStrc u; for (int t = 0; t <= 6; t++) for (int c = -2; c <= 7; c++) { u.eUnitType = (eD2UnitType)t; u.nClassId = c; if (p(&u) != w(&u)) bad++; } if (p(0) != w(0)) bad++; printf("%d\\n", bad);');
      assert.strictEqual(out.trim(), '0', written);
    }
  });
});
