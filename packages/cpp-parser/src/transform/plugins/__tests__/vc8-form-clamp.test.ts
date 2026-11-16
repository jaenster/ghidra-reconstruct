import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../ast/nodes.js';
import { NodeKind } from '../../../ast/kinds.js';
import { traverseAST } from '../../../ast/visitor.js';
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
    const source = `int CHATDLG_UpdateChatRoomList() {
      int32_t nScrollPos = scroll();
      int32_t nVisibleLines = visible();
      int32_t nEndLine = nVisibleLines + nScrollPos;
      if (gnLadderListRowCount <= nEndLine) { nEndLine = gnLadderListRowCount; }
      return nEndLine;
    }`;
    const { out, site } = run(source, 'clamp(nEndLine)', { globalTypes: { gnLadderListRowCount: 'int32_t' } });
    assert.equal(site.applied, true, site.why);
    assert.match(out, /nEndLine = nVisibleLines \+ nScrollPos < gnLadderListRowCount \? nVisibleLines \+ nScrollPos : gnLadderListRowCount;/);
    assert.doesNotMatch(out, /if \(/);
  });

  it('re-forms the native DAMAGE_ApplyHealingToUnit bound-left guard', () => {
    const source = `int32_t DAMAGE_ApplyHealingToUnit(int32_t nHealAmount) {
      int32_t nMaxHp = maxHp();
      int nCurHp = curHp();
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
    const { out, site } = run(source, 'clamp(nMissileRange)', { structFields: { D2MissilesTxt: { Range: 'short' } } });
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

  it('refuses a source that is not known to be an int, or a bound not known to be a 32-bit integer', () => {
    const sources = [
      // An unsigned source makes the moved test unsigned: `u >= 0` is always true.
      'int f(unsigned int u) { int v = u; if (v < 0) v = 0; return v; }',
      // `u - 100` is unsigned: u = 50 stores -50 into v, which the moved test no longer clamps.
      'int f(uint32_t u) { int v = u - 100; if (v < 0) v = 0; return v; }',
      'int f(DWORD u) { int v; v = u; if (v > 10) v = 10; return v; }',
      'int f(int a) { int v = a + 0x80000000; if (v < 0) v = 0; return v; }',
      'int f(int a) { int v = a + 1u; if (v < 0) v = 0; return v; }',
      // A 64-bit source would be compared before it is truncated to 32 bits.
      'int f(long long q) { int v = q; if (v > 10) v = 10; return v; }',
      'int f(int a) { int v = (__int64)a * 3; if (v > 10) v = 10; return v; }',
      'int f(float x) { int v = x; if (v > 10) v = 10; return v; }',
      // Undeclared: nothing proves its type.
      'int f() { int v = gnCount; if (v > 10) v = 10; return v; }',
      'int f(Unit *p) { int v = p->n; if (v > 10) v = 10; return v; }',
      // A floating bound would round E in the select's common type.
      'int f(int a, float l) { int v = a; if (v > l) v = l; return v; }',
      'int f(int a, long long l) { int v = a; if (v > l) v = l; return v; }',
      'int f(int a) { int v = a; if (v > gnLimit) v = gnLimit; return v; }',
    ];
    for (const source of sources) {
      const { before, out, site } = run(source, 'clamp(v)');
      assert.equal(site.applied, false, source);
      assert.equal(out, before, source);
    }
  });

  it('accepts a narrower source that promotes to int and an unsigned 32-bit bound', () => {
    let r = run('int f(short s, unsigned char c) { int v = s + c; if (v < 0) v = 0; return v; }', 'clamp(v)');
    assert.equal(r.site.applied, true, r.site.why);
    assert.match(r.out, /v = s \+ c >= 0 \? s \+ c : 0;/);
    r = run('int f(int a, unsigned int l) { int v = a; if (v > l) v = l; return v; }', 'clamp(v)');
    assert.equal(r.site.applied, true, r.site.why);
    assert.match(r.out, /v = a <= l \? a : l;/);
    r = run('int f(Unit *p) { int v = p->n - 100; if (v < 100) v = 100; return v; }', 'clamp(v)', { fieldTypes: { n: 'WORD' } });
    assert.equal(r.site.applied, true, r.site.why);
    r = run('int f(Unit *p) { int v = p->n - 100; if (v < 100) v = 100; return v; }', 'clamp(v)', { fieldTypes: { n: 'DWORD' } });
    assert.equal(r.site.applied, false);
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

  for (const [condition, expected] of [['a >= 1', 'a >= 1'], ['1 <= a', 'a >= 1'],
    ['a < 1', 'a < 1'], ['1 > a', 'a < 1'], ['0 < a', 'a >= 1'], ['a > 0', 'a >= 1']]) {
    it(`supports a bound-first literal guard: ${condition}`, () => {
      const r = run(`int f(int a) { int v = 1; if (${condition}) v = a; return v; }`, 'clamp(v)');
      assert.equal(r.site.applied, true, r.site.why);
      assert.ok(r.out.includes(`v = ${expected} ? a : 1;`), r.out);
    });
  }

  it('recognizes the symmetric adjacent threshold for an integer upper bound', () => {
    const r = run('int f(int a) { int v = 10; if (a < 11) v = a; return v; }', 'clamp(v)');
    assert.equal(r.site.applied, true, r.site.why);
    assert.match(r.out, /v = a <= 10 \? a : 10;/);
  });

  it('keeps existing unindexed and indexed tags on their original value-first sites', () => {
    const source = 'int f(int a) { int v = 1; if (a > 1) v = a; v = a; if (v > 10) v = 10; return v; }';
    for (const tag of ['clamp(v)', 'clamp(v,1)']) {
      const r = run(source, tag);
      assert.equal(r.site.applied, true, r.site.why);
      assert.match(r.out, /v = a <= 10 \? a : 10;/);
      assert.match(r.out, /if \(a > 1\)/);
    }
    const added = run(source, 'clamp(v,2)');
    assert.equal(added.site.applied, true, added.site.why);
    assert.match(added.out, /v = a > 1 \? a : 1;/);
    assert.match(added.out, /if \(v > 10\)/);
  });

  it('refuses an earlier reference-capable call even after another pass removes its location', () => {
    const source = 'int f(int a) { int v; capture(v); v = 1; if (a >= 1) v = a; return v; }';
    const ast = parse(source);
    for (const n of traverseAST(ast)) if (n.kind === NodeKind.CallExpr) delete n.location;
    const form = parseVc8Form('clamp(v)')!, sites: Vc8FormSite[] = [];
    const after = applyVc8Forms(ast, [{ form }], s => sites.push(s));
    assert.equal(sites[0].applied, false);
    assert.equal(flat(emit(after as AnyNode)), flat(emit(parse(source) as AnyNode)));
  });

  it('uses an exact nonvolatile integer field, including its alias chain', () => {
    const source = 'int f(Missile *p) { int v; v = 1; if (p->Param1 >= 1) v = p->Param1; return v; }';
    const r = run(source, 'clamp(v)', { structFields: { Missile: { Param1: 'SignedWord' } }, typedefTargets: { SignedWord: 'int' } });
    assert.equal(r.site.applied, true, r.site.why);
    assert.match(r.out, /v = p->Param1 >= 1 \? p->Param1 : 1;/);
    for (const type of ['volatile int', 'VolatileWord', 'unsigned int', 'long long', 'float', 'int&']) {
      const refused = run(source, 'clamp(v)', { structFields: { Missile: { Param1: type } }, typedefTargets: { VolatileWord: 'volatile int' } });
      assert.equal(refused.site.applied, false, type);
      assert.equal(refused.out, refused.before, type);
    }
    const missing = run(source, 'clamp(v)', { fieldTypes: { Param1: 'int' } });
    assert.equal(missing.site.applied, false, 'an unscoped field-name fallback is not exact');
    assert.equal(missing.out, missing.before);
    const volatileObject = run(source.replace('Missile *p', 'volatile Missile *p'), 'clamp(v)', { structFields: { Missile: { Param1: 'int' } } });
    assert.equal(volatileObject.site.applied, false);
    assert.equal(volatileObject.out, volatileObject.before);
  });

  for (const source of [
    'int f(unsigned a) { int v = 1; if (a >= 1) v = a; return v; }',
    'int f(long long a) { int v = 1; if (a >= 1) v = a; return v; }',
    'int f(float a) { int v = 1; if (a >= 1) v = a; return v; }',
    'int f(int a, int l) { int v = l; if (a >= l) v = a; return v; }',
    'int f(int a) { int v = 1; if (a >= 1) v = a + 1; return v; }',
    'int f(int a) { int v = 1; if (a >= 2) v = a; return v; }',
    'int f(int a) { int v = 1; if (a >= 1) { v = a; side(); } return v; }',
    'int f(int a) { int v = 1; if (a >= 1) v = a; else v = 0; return v; }',
    'int f(int a) { int v; int &r = v; v = 1; if (a >= 1) v = a; return v; }',
    'int f(int a) { int v; capture(v); v = 1; if (a >= 1) v = a; return v; }',
    'int f(int a) { int v; Ref r(v); v = 1; if (a >= 1) v = a; return v; }',
    'int f(int a, Ref r) { int v; r = v; v = 1; if (a >= 1) v = a; return v; }',
    'int f(int a, Ref r) { int v; (v, r); v = 1; if (a >= 1) v = a; return v; }',
    'int f(int a, Ref r) { int v; r[v]; v = 1; if (a >= 1) v = a; return v; }',
    'int f(int a) { extern int v; v = 1; if (a >= 1) v = a; return v; }',
    'int f(int a) { int v; while(a) { v = 1; if (a >= 1) v = a; --a; } return v; }',
  ]) {
    it(`refuses an unproved bound-first clamp atomically: ${source}`, () => {
      const r = run(source, 'clamp(v)');
      assert.equal(r.site.applied, false);
      assert.equal(r.out, r.before);
    });
  }
});
