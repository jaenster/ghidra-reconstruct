import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite, type Vc8FormTables } from '../builtins/vc8-form.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
function run(source: string, tags: string[], tables?: Vc8FormTables) {
  const forms = tags.map(tag => { const form = parseVc8Form(tag); assert.ok(form, tag); return { form: form!, tag }; });
  const sites: Vc8FormSite[] = [];
  const output = applyVc8Forms(parse(source) as TranslationUnit, forms, s => sites.push(s), tables);
  return { before: flat(emit(parse(source) as AnyNode)), out: flat(emit(output as AnyNode)), raw: emit(output as AnyNode), sites };
}
function refused(source: string, tag: string, tables?: Vc8FormTables) {
  const { before, out, sites } = run(source, [tag], tables);
  assert.equal(sites[0]!.applied, false, source);
  assert.equal(out, before, source);
  return sites[0]!.why;
}

// RENDERER_GLIDE_SetDrawMode 0050abf0 as the generator prints it.
const SET_DRAW_MODE = `static void RENDERER_GLIDE_SetDrawMode(int32_t nDrawMode) {
    int32_t nBlendModeArg;
    if (false) {
      default_case:
      RENDERER_GLIDE_SetAlphaBlendMode(4);
      (*GLIDEDLL_grDitherMode_4)(0);
      if (!nDrawMode) {
        (*GLIDEDLL_grConstantColorValue_4)(0x40);
        return;
      }
      if (nDrawMode == 1) {
        (*GLIDEDLL_grConstantColorValue_4)(0x80);
        return;
      }
      if (nDrawMode != 2) {
        return;
      }
      (*GLIDEDLL_grConstantColorValue_4)(0xc0);
      return;
    }
    switch (nDrawMode) {
      case 5:
      case 7:
        RENDERER_GLIDE_SetAlphaBlendMode(1);
      return;
      default:
        goto default_case;
      case 3:
        nBlendModeArg = 2;
      break;
      case 4:
        nBlendModeArg = 3;
      break;
    }
    RENDERER_GLIDE_SetAlphaBlendMode(nBlendModeArg);
    (*GLIDEDLL_grConstantColorValue_4)(0xff);
    (*GLIDEDLL_grDitherMode_4)(0);
}`;

describe('vc8form swtail', () => {
  it('parses a selector and optional index', () => {
    assert.deepEqual(parseVc8Form('swtail(nDrawMode)'), { op: 'swtail', expr: 'nDrawMode', index: 1 });
    assert.deepEqual(parseVc8Form('swtail(p->n,2)'), { op: 'swtail', expr: 'p->n', index: 2 });
    for (const bad of ['swtail()', 'swtail(x,0)', 'swtail(x,1,2)', 'swtail(x,@1)']) assert.equal(parseVc8Form(bad), undefined);
  });

  it('copies the tail into each breaking case of 0050abf0 and folds the merged argument', () => {
    const { out, sites } = run(SET_DRAW_MODE, ['swtail(nDrawMode)']);
    assert.equal(sites[0]!.applied, true, sites[0]!.why);
    assert.doesNotMatch(out, /nBlendModeArg/);
    assert.match(out, /case 3: RENDERER_GLIDE_SetAlphaBlendMode\(2\); \(\*GLIDEDLL_grConstantColorValue_4\)\(0xff\); \(\*GLIDEDLL_grDitherMode_4\)\(0\); return;/);
    assert.match(out, /case 4: RENDERER_GLIDE_SetAlphaBlendMode\(3\); \(\*GLIDEDLL_grConstantColorValue_4\)\(0xff\); \(\*GLIDEDLL_grDitherMode_4\)\(0\); return; \} \}$/);
    assert.match(out, /case 5: case 7: RENDERER_GLIDE_SetAlphaBlendMode\(1\); return; default: goto default_case;/);
  });

  it('copies without folding a local that is not one literal per case', () => {
    const { out, sites } = run('void f(int s, int k) { int a; switch (s) { case 1: a = k; break; case 2: a = 3; break; default: return; } g(a); h(); }', ['swtail(s)']);
    assert.equal(sites[0]!.applied, true, sites[0]!.why);
    assert.equal(out, flat('void f(int s, int k) { int a; switch (s) { case 1: a = k; g(a); h(); return; case 2: a = 3; g(a); h(); return; default: return; } }'));
  });

  it('keeps a non-void tail return and a case whose label sits on the break', () => {
    const { out, sites } = run('int f(int s) { int a; switch (s) { case 1: a = 4; break; case 2: case 3: break; default: return 0; } return g(); }', ['swtail(s)']);
    assert.equal(sites[0]!.applied, true, sites[0]!.why);
    assert.equal(out, flat('int f(int s) { int a; switch (s) { case 1: a = 4; return g(); case 2: case 3: return g(); default: return 0; } }'));
  });

  it('does not fold a store a later label skips, or a narrow local', () => {
    let r = run('void f(int s) { int a; switch (s) { case 1: a = 2; case 2: break; default: return; } g(a); }', ['swtail(s)']);
    assert.equal(r.sites[0]!.applied, true, r.sites[0]!.why);
    assert.match(r.out, /g\(a\); return;/);
    r = run('void f(int s) { short a; switch (s) { case 1: a = 2; break; default: return; } g(a); }', ['swtail(s)']);
    assert.match(r.out, /a = 2; g\(a\); return;/);
  });

  it('refuses what would change the paths into the tail', () => {
    // No default: an unmatched value reaches the tail.
    refused('void f(int s) { switch (s) { case 1: a(); break; case 2: return; } t(); }', 'swtail(s)');
    // The last case falls out of the switch.
    refused('void f(int s) { switch (s) { case 1: a(); break; default: b(); } t(); }', 'swtail(s)');
    // A break inside a statement of a case.
    refused('void f(int s) { switch (s) { case 1: if (a()) break; return; default: return; } t(); }', 'swtail(s)');
    // A label, a declaration and a break in the tail.
    refused('void f(int s) { switch (s) { case 1: break; default: return; } L: t(); }', 'swtail(s)');
    refused('void f(int s) { switch (s) { case 1: break; default: return; } int x = t(); u(x); }', 'swtail(s)');
    refused('void f(int s) { while (s) { switch (s) { case 1: break; default: return; } t(); if (s) break; return; } }', 'swtail(s)');
    // No break, no tail, not the end of a void function.
    refused('void f(int s) { switch (s) { case 1: return; default: return; } t(); }', 'swtail(s)');
    refused('void f(int s) { switch (s) { case 1: break; default: return; } }', 'swtail(s)');
    refused('void f(int s) { if (s) { switch (s) { case 1: break; default: return; } t(); } u(); }', 'swtail(s)');
    refused(SET_DRAW_MODE, 'swtail(nDrawMode,2)');
  });

  it('makes the same calls with the same values for every selector value', { skip: !hasNativeGpp() }, () => {
    const { raw, sites } = run(SET_DRAW_MODE, ['swtail(nDrawMode)']);
    assert.equal(sites[0]!.applied, true);
    const prelude = `#include <cstdint>
      static int logv[64], logn;
      static void put(int tag, int v) { logv[logn++] = tag * 1000 + v; }
      static void RENDERER_GLIDE_SetAlphaBlendMode(int v) { put(1, v); }
      static void cc(int v) { put(2, v); }
      static void dm(int v) { put(3, v); }
      static void (*GLIDEDLL_grConstantColorValue_4)(int) = cc;
      static void (*GLIDEDLL_grDitherMode_4)(int) = dm;
      namespace Before { ${SET_DRAW_MODE} }
      namespace After { ${raw} }`;
    const body = `
      int bad = 0;
      for (int m = -2; m < 10; m++) {
        logn = 0; Before::RENDERER_GLIDE_SetDrawMode(m); int a[64], n = logn; for (int i = 0; i < n; i++) a[i] = logv[i];
        logn = 0; After::RENDERER_GLIDE_SetDrawMode(m);
        if (n != logn) bad++; else for (int i = 0; i < n; i++) if (a[i] != logv[i]) bad++;
      }
      std::printf("bad=%d\\n", bad);`;
    assert.equal(compileAndRun(prelude, body), 'bad=0\n');
  });
});

// UI_FormatPlayerNameAndStatus 00452af0, its first unit test as the generator prints it.
const FORMAT_NAME = `static void __stdcall UI_FormatPlayerNameAndStatus(D2UnitStrc * pUnit, uint16_t * wszText, int32_t nFormatMode, BOOL * pbIsPartied, int * pnHpBarValue) {
    uint32_t nLangCode;
    int nUnitGUID;
    char* pRosterName = GetPlayerRosterName(pUnit);
    if (pUnit) {
      uint16_t wszDeadName[128];
      if (pUnit->eAnimMode.ePlayerMode == eD2PlayerAnimMode_ns::Dead) {
        *pnHpBarValue = 0;
        for (nUnitGUID = 0; nUnitGUID < 0x80; nUnitGUID++) {
          wszDeadName[nUnitGUID] = L'\\0';
        }
        CopyName(wszDeadName, pRosterName, 0x80);
        nLangCode = GetLanguageCode();
        FormatPossessiveName(wszText, wszDeadName, nFormatMode, nLangCode);
        *pbIsPartied = 1;
        return;
      }
      nUnitGUID = pUnit->nUnitGUID;
    } else {
      nUnitGUID = -1;
    }
    int32_t nHpPercent = GetRosterPlayerHpPercent(nUnitGUID);
    *pnHpBarValue = (nHpPercent << 7) / 100;
    *pbIsPartied = 0;
    if (!pUnit) {
      nUnitGUID = -1;
    } else {
      nUnitGUID = pUnit->nUnitGUID;
    }
    CopyName(wszText, pRosterName, 0x80);
    Party(nUnitGUID);
}`;
const UNIT_TABLES: Vc8FormTables = { structFields: { D2UnitStrc: { nUnitGUID: 'uint32_t' } } };
const UNIT_TAGS = ['andguard(pUnit->eAnimMode.ePlayerMode == eD2PlayerAnimMode_ns::Dead)', 'sel(nUnitGUID,1)', 'tarms(pUnit)'];

describe('vc8form andguard and sel', () => {
  it('parses', () => {
    assert.deepEqual(parseVc8Form('andguard(p->m == 3)'), { op: 'andguard', cond: 'p->m == 3', index: 1 });
    assert.deepEqual(parseVc8Form('andguard(q,2)'), { op: 'andguard', cond: 'q', index: 2 });
    assert.deepEqual(parseVc8Form('sel(nUnitGUID)'), { op: 'sel', name: 'nUnitGUID', index: 0 });
    assert.deepEqual(parseVc8Form('sel(n,2)'), { op: 'sel', name: 'n', index: 2 });
    for (const bad of ['andguard()', 'andguard(q,0)', 'sel()', 'sel(p->n)', 'sel(n,x)', 'sel(int)']) assert.equal(parseVc8Form(bad), undefined);
  });

  it('writes 00452af0 as the flat dead guard and the -1-first select', () => {
    const { out, sites } = run(FORMAT_NAME, UNIT_TAGS, UNIT_TABLES);
    for (const s of sites) assert.equal(s.applied, true, `${s.tag}: ${s.why}`);
    assert.match(out, /char\* pRosterName = GetPlayerRosterName\(pUnit\); if \(pUnit && pUnit->eAnimMode\.ePlayerMode == eD2PlayerAnimMode_ns::Dead\) \{ uint16_t wszDeadName\[128\]; \*pnHpBarValue = 0;/);
    assert.match(out, /\*pbIsPartied = 1; return; \} nUnitGUID = !pUnit \? -1 : pUnit->nUnitGUID; int32_t nHpPercent/);
    // The second GUID read, after the roster call, stays an if/else.
    assert.match(out, /if \(!pUnit\) \{ nUnitGUID = -1; \} else \{ nUnitGUID = pUnit->nUnitGUID; \} CopyName\(wszText/);
  });

  it('keeps the rest of the outer arm under a second test of P', () => {
    const { out, sites } = run('void f(int* p) { if (p) { int a[4]; if (*p == 2) { a[0] = 1; g(a); return; } h(*p); } else { k(); } m(); }', ['andguard(*p == 2)']);
    assert.equal(sites[0]!.applied, true, sites[0]!.why);
    assert.equal(out, flat('void f(int* p) { if (p && *p == 2) { int a[4]; a[0] = 1; g(a); return; } if (p) { h(*p); } else { k(); } m(); }'));
    const r = run('void f(int* p) { if (p) { if (*p == 2) { return; } } else { k(); } m(); }', ['andguard(*p == 2)']);
    assert.equal(r.out, flat('void f(int* p) { if (p && *p == 2) { return; } if (!p) { k(); } m(); }'));
    const q = run('void f(int* p, int b) { if (p || b) { if (q(p)) { return; } } m(); }', ['andguard(q(p))']);
    assert.equal(q.sites[0]!.applied, false);
    const w = run('void f(int a, int b, int* p) { if (a || b) { if (*p) { return; } } m(); }', ['andguard(*p)']);
    assert.equal(w.out, flat('void f(int a, int b, int* p) { if ((a || b) && *p) { return; } m(); }'));
  });

  it('refuses an impure or non-local P, an arm that does not leave, and a declaration used outside it', () => {
    refused('void f(int* p) { if (g()) { if (*p) { return; } h(); } }', 'andguard(*p)');
    refused('void f(int* p) { if (gp) { if (*p) { return; } h(); } }', 'andguard(*p)');
    refused('void f(int* p) { if (p) { if (*p == 1) { g(); } h(); } }', 'andguard(*p == 1)');
    refused('void f(int* p) { if (p) { int a; if (*p == 1) { a = 1; g(a); return; } a = 2; h(a); } }', 'andguard(*p == 1)');
    refused('void f(int* p) { if (p) { h(); if (*p == 1) { return; } } }', 'andguard(*p == 1)');
    refused('void f(int* p) { if (p) { if (*p == 1) { return; } h(); } }', 'andguard(*p == 2)');
    refused('void f(int* p) { if (*p == 1) { return; } }', 'andguard(*p == 1)');
    refused('void f(int* p) { if (p) { if (g(p)) { return; } } }', 'andguard(g(p))');
    refused('void f(int* p) { if (p) { if (*p) { L: return; } } }', 'andguard(*p)');
  });

  it('refuses sel on unknown or wide types, ambiguity, and arms that are not one store', () => {
    refused('void f(int c, int x) { int v; if (c) { v = x; } else { v = 1; } g(v); if (x) { v = 2; } else { v = c; } g(v); }', 'sel(v)');
    refused('void f(int c, int x) { int v; if (c) { v = x; } else { v = 1; } g(v); }', 'sel(v,2)');
    refused('void f(int c, float x) { int v; if (c) { v = x; } else { v = 1; } g(v); }', 'sel(v)');
    refused('void f(int c, int64_t x) { int v; if (c) { v = x; } else { v = 1; } g(v); }', 'sel(v)');
    refused('void f(int c, int x) { double v; if (c) { v = x; } else { v = 1; } g(v); }', 'sel(v)');
    refused('void f(int c, int x) { int v; if (c) { v = x; h(); } else { v = 1; } g(v); }', 'sel(v)');
    refused('void f(int c, int x) { int v; if (c) { v = x; } else if (x) { v = 1; } g(v); }', 'sel(v)');
    const { out, sites } = run('void f(int c, uint16_t x) { int v; if (c) { v = x; } else { v = -1; } g(v); }', ['sel(v)']);
    assert.equal(sites[0]!.applied, true, sites[0]!.why);
    assert.match(out, /v = c \? x : -1; g\(v\);/);
  });

  it('keeps every path of 00452af0: null, dead and alive', { skip: !hasNativeGpp() }, () => {
    const { raw, sites } = run(FORMAT_NAME, UNIT_TAGS, UNIT_TABLES);
    for (const s of sites) assert.equal(s.applied, true, `${s.tag}: ${s.why}`);
    const prelude = `#include <cstdint>
      typedef int BOOL;
      namespace eD2PlayerAnimMode_ns { enum E { Alive = 1, Dead = 17 }; }
      struct Anim { int ePlayerMode; };
      struct D2UnitStrc { Anim eAnimMode; uint32_t nUnitGUID; };
      static int logv[64], logn;
      static void put(int tag, int v) { logv[logn++] = tag * 100000 + v; }
      static char name[] = "ab";
      static char* GetPlayerRosterName(D2UnitStrc* p) { put(1, p ? 1 : 0); return name; }
      static void CopyName(uint16_t* d, const char* s, int n) { put(2, d[0] + n); }
      static uint32_t GetLanguageCode() { put(3, 0); return 7; }
      static void FormatPossessiveName(uint16_t*, uint16_t* n, int m, uint32_t l) { put(4, n[5] + m + (int)l); }
      static D2UnitStrc* g_unit;
      static int GetRosterPlayerHpPercent(int g) { put(5, g); if (g_unit) g_unit->nUnitGUID = 99; return 50; }
      static void Party(int g) { put(6, g); }
      namespace Before { ${FORMAT_NAME.replace('static void __stdcall', 'static void')} }
      namespace After { ${raw.replace('static void __stdcall', 'static void')} }`;
    const body = `
      int bad = 0;
      for (int c = 0; c < 4; c++) {
        D2UnitStrc u = { { c == 1 ? eD2PlayerAnimMode_ns::Dead : eD2PlayerAnimMode_ns::Alive }, c == 3 ? 0xffffffffu : 12345u };
        D2UnitStrc* p = c == 0 ? nullptr : &u;
        uint16_t t1[4] = {0}, t2[4] = {0}; BOOL b1 = 5, b2 = 5; int h1 = 9, h2 = 9;
        g_unit = p; logn = 0; Before::UI_FormatPlayerNameAndStatus(p, t1, 3, &b1, &h1);
        int a[64], n = logn; for (int i = 0; i < n; i++) a[i] = logv[i];
        if (p) p->nUnitGUID = c == 3 ? 0xffffffffu : 12345u;
        g_unit = p; logn = 0; After::UI_FormatPlayerNameAndStatus(p, t2, 3, &b2, &h2);
        if (n != logn || b1 != b2 || h1 != h2) bad++; else for (int i = 0; i < n; i++) if (a[i] != logv[i]) bad++;
      }
      std::printf("bad=%d\\n", bad);`;
    assert.equal(compileAndRun(prelude, body), 'bad=0\n');
  });
});
