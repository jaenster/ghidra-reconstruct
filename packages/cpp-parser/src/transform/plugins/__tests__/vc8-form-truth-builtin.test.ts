import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite, type Vc8FormTables } from '../builtins/vc8-form.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

// redivivus#472: bool(E), nonzero(E) and zero(E) rewrite the operators around E. They keep
// the meaning only where every operator involved is builtin, so each needs E, and the other
// side of an && / || / == / != E stands in, proven a scalar by the type tables.

const TABLES: Vc8FormTables = {
  structFields: { Unit: { eType: 'eUnitType', pNext: 'Unit *', nFlags: 'uint32_t', marker: 'Marker' } },
  typedefTargets: { eUnitType: 'int' },
  enumValues: { UNIT_PLAYER: 0, UNIT_MONSTER: 1 },
  globalTypes: { gnCount: 'int', gMarker: 'Marker' },
  functionReturnTypes: { GetUnit: 'Unit *', GetMarker: 'Marker' },
};

function apply(source: string, tag: string, tables: Vc8FormTables | undefined = TABLES): { out: string; site: Vc8FormSite; before: string } {
  const form = parseVc8Form(tag);
  assert.ok(form, tag);
  const sites: Vc8FormSite[] = [];
  const before = emit(parse(source) as AnyNode);
  const out = emit(applyVc8Forms(parse(source) as TranslationUnit, [{ form: form!, tag }], s => sites.push(s), tables) as AnyNode);
  return { out, site: sites[0], before };
}

function refused(source: string, tag: string, tables?: Vc8FormTables): void {
  const r = apply(source, tag, tables);
  assert.equal(r.site.applied, false, `${tag} should refuse: ${r.out}`);
  assert.equal(r.out, r.before);
}

function applied(source: string, tag: string, spelled: RegExp): void {
  const r = apply(source, tag);
  assert.ok(r.site.applied, r.site.why);
  assert.match(r.out.replace(/\s+/g, ' '), spelled);
}

describe('truth forms prove builtin operators', () => {
  it('refuses a class operand of !, == 0 and a truth test (unknown type)', () => {
    refused('int f(const A& x) { return !x; }', 'bool(x)');
    refused('int f(const A& x) { return !x; }', 'zero(x)');
    refused('int f(const A& x) { return x == 0; }', 'bool(x)');
    refused('int f(const A& x) { if (x) { return 1; } return 0; }', 'nonzero(x)');
  });

  it('refuses an integral E whose && / || partner is a class (overload chosen by the pair)', () => {
    const src = 'int f(int x, const Marker& marker) { if (x && marker) { return 7; } return 0; }';
    refused(src, 'bool(x)');
    refused(src, 'nonzero(x)');
    refused('int f(int x) { if (gMarker || x) { return 7; } return 0; }', 'nonzero(x)');
    refused('int f(Unit* p, int x) { if (x && p->marker) { return 7; } return 0; }', 'bool(x)');
    refused('int f(int x) { if (x && GetMarker()) { return 7; } return 0; }', 'nonzero(x)');
  });

  it('refuses without type tables when a member or call cannot be typed', () => {
    refused('int f(Unit* p) { if (p && p->eType == UNIT_PLAYER) { return 1; } return 0; }', 'nonzero(p && p->eType == UNIT_PLAYER)', {});
    refused('int f(int n) { if (Get(n)) { return 1; } return 0; }', 'nonzero(Get(n))');
  });

  it('applies to scalars: locals, pointers, typed fields, enum constants, globals and calls', () => {
    applied('int f(Unit* p) { if (!(p && p->eType == UNIT_PLAYER)) { return 1; } return 0; }',
      'zero(p && p->eType == UNIT_PLAYER)', /\(\(p && p->eType == UNIT_PLAYER\) == 0\)/);
    applied('int f(Unit* p) { if (!p || p->eType != UNIT_MONSTER) { return 1; } return 0; }',
      'nonzero(!p || p->eType != UNIT_MONSTER)', /\(\(!p \|\| p->eType != UNIT_MONSTER\) != 0\)/);
    applied('int f(Unit* p) { if (p && p->nFlags >> 3 & 1) { return 1; } return 0; }',
      'bool(p->nFlags >> 3 & 1)', /p && \(bool\)\(p->nFlags >> 3 & 1\)/);
    applied('int f(int n) { if (n < gnCount && GetUnit()) { return 1; } return 0; }',
      'nonzero(GetUnit())', /n < gnCount && GetUnit\(\) != 0/);
    // SERVER_IsItemOnCursor 005490e0: a union member compared with an E_ns-qualified constant
    // whose bare name several enums declare (so enumValues withholds it).
    const unionTables: Vc8FormTables = {
      structFields: { Item: { eAnimMode: 'uMode' }, uMode: { ePlayerMode: 'ePlayerMode' } },
      typedefTargets: { ePlayerMode: 'int' },
    };
    const r = apply('int f(Item* pItem) { if (pItem && pItem->eAnimMode.ePlayerMode == ePlayerMode_ns::GetHit) { return 1; } return 0; }',
      'nonzero(pItem && pItem->eAnimMode.ePlayerMode == ePlayerMode_ns::GetHit)', unionTables);
    assert.ok(r.site.applied, r.site.why);
    refused('int f(Item* pItem) { if (pItem && pItem->eAnimMode.ePlayerMode == Other_ns::GetHit) { return 1; } return 0; }',
      'nonzero(pItem && pItem->eAnimMode.ePlayerMode == Other_ns::GetHit)', unionTables);
    applied('int f(int n, char* s) { if (n && (s = 0, s != 0)) { return 1; } return 0; }',
      'nonzero(n)', /n != 0 && \(s = 0 ?, s != 0\)/);
  });

  it('reproduces the issue: the overloads keep their results because the forms refuse', { skip: !hasNativeGpp() }, () => {
    const cases: Array<[string, string, string]> = [
      ['struct A { operator bool() const { return true; } }; bool operator!(const A&) { return true; }',
        'int f(const A& x) { return !x; }', 'bool(x)'],
      ['struct A { operator bool() const { return true; } }; bool operator!(const A&) { return true; } bool operator==(const A&, int) { return false; }',
        'int f(const A& x) { return !x; }', 'zero(x)'],
      ['struct A { operator bool() const { return false; } }; bool operator==(const A&, int) { return true; }',
        'int f(const A& x) { return x == 0; }', 'bool(x)'],
      ['struct Marker {}; bool operator&&(int, const Marker&) { return true; } bool operator&&(bool, const Marker&) { return false; }',
        'int f(int x, const Marker& marker) { if (x && marker) return 7; return 0; }', 'bool(x)'],
      ['struct Marker {}; bool operator&&(int, const Marker&) { return true; } bool operator&&(bool, const Marker&) { return false; }',
        'int f(int x, const Marker& marker) { if (x && marker) return 7; return 0; }', 'nonzero(x)'],
    ];
    let prelude = '', body = 'int n = 0;';
    cases.forEach(([decls, fn, tag], i) => {
      const r = apply(fn, tag);
      assert.equal(r.site.applied, false, tag);
      prelude += `namespace ref${i} { ${decls} ${fn} } namespace out${i} { ${decls} ${r.out} }\n`;
      const call = (ns: string) => i < 3 ? `${ns}::f(${ns}::A{})` : `${ns}::f(5, ${ns}::Marker{})`;
      body += `if (${call(`ref${i}`)} != ${call(`out${i}`)}) return ${i + 1}; ++n;`;
    });
    body += 'std::printf("%d\\n", n);';
    assert.equal(compileAndRun(prelude, body, { optimize: true }).trim(), String(cases.length));
  });

  it('keeps values and short-circuit evaluation on scalar sites', { skip: !hasNativeGpp() }, () => {
    const fns: Array<[string, string]> = [
      ['int f(Unit* p, int n) { if (!(p && p->eType == UNIT_PLAYER)) { return 1 + n; } return 0; }', 'zero(p && p->eType == UNIT_PLAYER)'],
      ['int f(Unit* p, int n) { if (!p || p->eType != UNIT_MONSTER) { return 1 + n; } return 0; }', 'nonzero(!p || p->eType != UNIT_MONSTER)'],
      ['int f(Unit* p, int n) { if (p && p->nFlags >> 3 & 1) { return 1; } return !(n & 4); }', 'bool(p->nFlags >> 3 & 1)'],
      ['int f(Unit* p, int n) { if (n < gnCount && GetUnit()) { return 1; } return (p != 0) + n; }', 'nonzero(GetUnit())'],
    ];
    let prelude = `typedef int eUnitType; enum { UNIT_PLAYER = 0, UNIT_MONSTER = 1 };
      struct Unit { eUnitType eType; Unit* pNext; uint32_t nFlags; };
      static int calls; static Unit* gUnit; int gnCount;
      Unit* GetUnit() { ++calls; return gUnit; }\n`;
    let body = 'int n = 0; Unit u = {};';
    fns.forEach(([fn, tag], i) => {
      const r = apply(fn, tag);
      assert.ok(r.site.applied, r.site.why);
      prelude += `namespace ref${i} { ${fn} } namespace out${i} { ${r.out} }\n`;
      body += `for (int t = 0; t < 2; ++t) for (int k = 0; k < 2; ++k) for (uint32_t fl = 0; fl < 32; ++fl) for (int v = 0; v < 8; ++v) {
        u.eType = t; u.nFlags = fl; gnCount = k * 4; gUnit = (v & 1) ? &u : 0; Unit* p = (v & 2) ? &u : 0;
        calls = 0; int a = ref${i}::f(p, v); int ca = calls;
        calls = 0; int b = out${i}::f(p, v); if (a != b || ca != calls) return ${i + 1}; ++n; }`;
    });
    body += 'std::printf("%d\\n", n);';
    assert.equal(compileAndRun(prelude, body, { optimize: true }).trim(), String(fns.length * 2 * 2 * 32 * 8));
  });
});
