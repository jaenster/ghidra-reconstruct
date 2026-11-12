import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite, type Vc8FormTables } from '../builtins/vc8-form.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(source: string, tag: string, tables?: Vc8FormTables) {
  const form = parseVc8Form(tag);
  assert.ok(form, `parse ${tag}`);
  const sites: Vc8FormSite[] = [];
  const output = applyVc8Forms(parse(source) as TranslationUnit, [{ form, tag }], s => sites.push(s), tables);
  return { before: flat(emit(parse(source) as AnyNode)), out: flat(emit(output as AnyNode)), site: sites[0] };
}

describe('vc8form clamp', () => {
  it('parses a unique or indexed local and rejects malformed tags', () => {
    assert.deepEqual(parseVc8Form('clamp(nEndLine)'), { op: 'clamp', name: 'nEndLine', index: 0 });
    assert.deepEqual(parseVc8Form('clamp(nValue,2)'), { op: 'clamp', name: 'nValue', index: 2 });
    for (const tag of ['clamp()', 'clamp(p->n)', 'clamp(n,-1)', 'clamp(n,x)', 'clamp(n,1,2)']) assert.equal(parseVc8Form(tag), undefined);
  });

  it('re-forms the native CHATDLG_UpdateChatRoomList bound-left guard', () => {
    const source = `int CHATDLG_UpdateChatRoomList(int32_t nVisibleLines, int32_t nScrollPos) {
      int32_t nEndLine = nVisibleLines + nScrollPos;
      if (gnLadderListRowCount <= nEndLine) { nEndLine = gnLadderListRowCount; }
      return nEndLine;
    }`;
    const { out, site } = run(source, 'clamp(nEndLine)');
    assert.equal(site.applied, true, site.why);
    assert.match(out, /nEndLine = nVisibleLines \+ nScrollPos < gnLadderListRowCount \? nVisibleLines \+ nScrollPos : gnLadderListRowCount;/);
    assert.doesNotMatch(out, /if \(/);
  });

  it('re-forms the native DAMAGE_ApplyHealingToUnit bound-left guard', () => {
    const source = `int32_t DAMAGE_ApplyHealingToUnit(int32_t nHealAmount, int32_t nCurHp) {
      int32_t nValue = nCurHp + nHealAmount;
      if (nMaxHp <= nValue) { nValue = nMaxHp; }
      return nValue;
    }`;
    const { out, site } = run(source, 'clamp(nValue)');
    assert.equal(site.applied, true, site.why);
    assert.match(out, /nValue = nCurHp \+ nHealAmount < nMaxHp \? nCurHp \+ nHealAmount : nMaxHp;/);
  });

  it('re-forms the native AI_Diablo_SpawnRingAttack lower bound', () => {
    const source = `void AI_Diablo_SpawnRingAttack(D2MissilesTxt *pDVar2) {
      int32_t nMissileRange = pDVar2->Range + -100;
      if (nMissileRange < 100) { nMissileRange = 100; }
      use(nMissileRange);
    }`;
    const { out, site } = run(source, 'clamp(nMissileRange)', { structFields: { D2MissilesTxt: { Range: 'int16_t' } } });
    assert.equal(site.applied, true, site.why);
    assert.match(out, /nMissileRange = pDVar2->Range \+ -100 >= 100 \? pDVar2->Range \+ -100 : 100;/);
  });

  it('accepts a plain store and the opposite comparison direction', () => {
    const { out, site } = run('int f(int e, int l) { int v; v = e; if (v > l) v = l; return v; }', 'clamp(v)');
    assert.equal(site.applied, true, site.why);
    assert.match(out, /v = e <= l \? e : l;/);
  });

  it('requires an explicit index when two clamps share a variable', () => {
    const source = 'int f(int a, int b) { int v = a; if (v > 10) v = 10; v = b; if (v < 2) v = 2; return v; }';
    const ambiguous = run(source, 'clamp(v)');
    assert.equal(ambiguous.site.applied, false);
    assert.equal(ambiguous.out, ambiguous.before);
    const selected = run(source, 'clamp(v,2)');
    assert.equal(selected.site.applied, true, selected.site.why);
    assert.match(selected.out, /v = b >= 2 \? b : 2;/);
  });

  it('refuses effects, self reference, an escaped local, or a changed bound', () => {
    const sources = [
      'int f() { int v = get(); if (v > 10) v = 10; return v; }',
      'int f() { int v = x; if (v > get()) v = get(); return v; }',
      'int f() { int v; v = v + 1; if (v > 10) v = 10; return v; }',
      'int f() { int v = x; escape(&v); if (v > 10) v = 10; return v; }',
      'int f() { int v = x; if (v > 10) v = 11; return v; }',
      'int f() { int v = x; side(); if (v > 10) v = 10; return v; }',
      'int f() { short v = x; if (v > 10) v = 10; return v; }',
      'int f() { float v = x; if (v > 10) v = 10; return v; }',
      'int f() { volatile int x = 7; int v = x; if (v > 10) v = 10; return v; }',
    ];
    for (const source of sources) {
      const { before, out, site } = run(source, 'clamp(v)');
      assert.equal(site.applied, false, source);
      assert.equal(out, before, source);
    }
  });

  it('refuses sources whose conversion into the local changes comparison semantics', () => {
    for (const source of [
      'int f(unsigned u) { int v = u; if (v < 0) v = 0; return v; }',
      'int f(unsigned u) { int v = u - 100; if (v < 0) v = 0; return v; }',
      'int f(long long wide) { int v = wide; if (v < 0) v = 0; return v; }',
      'int f(float x) { int v = x; if (v < 0) v = 0; return v; }',
      'int f(int x) { int v = x + 1U; if (v < 0) v = 0; return v; }',
      'int f() { int v = unknown; if (v < 0) v = 0; return v; }',
      'int f(unsigned x) { int v; { v = x; if (v < 0) v = 0; } { int x = 1; use(x); } return v; }',
    ]) {
      const result = run(source, 'clamp(v)');
      assert.equal(result.site.applied, false, source);
      assert.equal(result.out, result.before, source);
    }
  });

  it('accepts narrow integer promotion and an explicit conversion already in the source', () => {
    for (const source of [
      'int f(short x) { int v = x - 100; if (v < 0) v = 0; return v; }',
      'int f(unsigned short x) { int v = x; if (v < 100) v = 100; return v; }',
      'int f(unsigned x) { int v = (int)x; if (v < 0) v = 0; return v; }',
    ]) assert.equal(run(source, 'clamp(v)').site.applied, true, source);
  });
});
