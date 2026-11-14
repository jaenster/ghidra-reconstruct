import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { hasNativeGpp, compileAndRun } from '../../../testing/native-cpp.js';
import { selectArgumentPlugin, selectPairedArguments, SelectRefused, type SelectArgumentOptions } from '../builtins/select-argument.js';
import { NodeKind } from '../../../ast/kinds.js';
import type { FunctionDecl } from '../../../ast/nodes.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(code: string): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = selectArgumentPlugin.createTransformer({ onSite: (e: { variable: string }) => sites.push(e.variable) });
  return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
}

describe('selectArgumentPlugin', () => {
  // WriteCrashReportProcessInfo 00407a80.
  it('writes a negated test as the select on its operand, the first store first', () => {
    const { out, sites } = run([
      'void f(Report *pReport, int bIsAdmin) {',
      '  const char *sz;',
      '  sz = "TRUE";',
      '  if (!bIsAdmin) {',
      '    sz = "FALSE";',
      '  }',
      '  Printf(pReport, "%s", sz);',
      '}',
    ].join('\n'));
    assert.deepStrictEqual(sites, ['sz']);
    assert.ok(out.includes('Printf(pReport, "%s", bIsAdmin ? "TRUE" : "FALSE");'), out);
    assert.ok(!out.includes('const char *sz'), out);
  });

  it('takes any other test as printed, the guarded store first, and casts a literal for a char *', () => {
    const { out } = run([
      'void f(int n) {',
      '  char *sz;',
      '  sz = gszPath;',
      '  if (n < 5) {',
      '    sz = "Unknown";',
      '  }',
      '  Log(sz);',
      '}',
    ].join('\n'));
    assert.ok(out.includes('Log(n < 5 ? (char*)"Unknown" : gszPath);'), out);
  });

  it('leaves a local read again, a constant outside its type, a call in the statement, or a store in the test', () => {
    const base = (decl: string, a: string, b: string, use: string, cond = '!c', after = '') => run([
      'void f(int c, int *p) {', `  ${decl};`, `  v = ${a};`, `  if (${cond}) {`, `    v = ${b};`, '  }', `  ${use};`, after, '}',
    ].join('\n')).sites;
    assert.deepStrictEqual(base('int v', '1', '2', 'g(p[0], v)'), ['v']);
    assert.deepStrictEqual(base('int v', '1', '2', 'g(p[0], v)', '!c', 'h(v);'), []);
    assert.deepStrictEqual(base('uint8_t v', '1', '-1', 'g(p[0], v)'), []);
    assert.deepStrictEqual(base('int v', '1', '2', 'g(k(), v)'), []);
    assert.deepStrictEqual(base('int v', '1', '2', 'g(p[0], v)', '!(c = 3)'), []);
    assert.deepStrictEqual(base('int v', '1', '2', 'g(p[0], v + 1)'), []);
    assert.deepStrictEqual(base('int v', 'c', '2', 'g(p[0], v)'), []);
  });

  it('leaves a local still live on a loop path', () => {
    const { sites } = run([
      'void f(int c, int n) {',
      '  int v;',
      '  v = 0;',
      '  do {',
      '    g(v);',
      '    v = 1;',
      '    if (!c) {',
      '      v = 2;',
      '    }',
      '    g(v);',
      '  } while (--n);',
      '}',
    ].join('\n'));
    assert.deepStrictEqual(sites, []);
  });

  // ITEMMODE_CheckAutoStack 0055d370: a unit's GUID and type, a sentinel each without one.
  const tables = {
    structFields: { D2UnitStrc: { nUnitGUID: 'int', eUnitType: 'eD2UnitType', nOther: 'short' } },
    typedefTargets: { eD2UnitType: 'uint32_t' },
    enumValues: { UNIT_COUNT: 6 },
  };
  const tagged = (code: string, cond = '!pUnit', index = 1, t: SelectArgumentOptions = tables): string => {
    const tu = parse(code);
    const fn = tu.declarations.find(d => d.kind === NodeKind.FunctionDecl) as FunctionDecl;
    selectPairedArguments(fn, cond, index, t);
    return flat(emit(tu as AnyNode));
  };
  const refusal = (code: string, cond = '!pUnit'): string => {
    try { tagged(code, cond); return ''; } catch (e) { assert.ok(e instanceof SelectRefused, String(e)); return (e as Error).message; }
  };
  const paired = (opts: { decl?: string; elseGuid?: string; use?: string; after?: string } = {}) => [
    'void f(D2UnitStrc *pUnit, void *pPool) {',
    `  ${opts.decl ?? 'int nGuid'};`,
    '  eD2UnitType eType;',
    '  if (!pUnit) {',
    '    nGuid = -1;',
    '    eType = UNIT_COUNT;',
    '  } else {',
    `    nGuid = ${opts.elseGuid ?? 'pUnit->nUnitGUID'};`,
    '    eType = pUnit->eUnitType;',
    '  }',
    `  ${opts.use ?? 'Alloc(pPool, 2, eType, nGuid)'};`,
    opts.after ?? '',
    '}',
  ].join('\n');

  it('writes a tagged if/else storing the same locals on both paths as one select per argument', () => {
    const out = tagged(paired());
    assert.ok(out.includes('Alloc(pPool, 2, !pUnit ? UNIT_COUNT : pUnit->eUnitType, !pUnit ? -1 : pUnit->nUnitGUID);'), out);
    assert.ok(!out.includes('if (!pUnit)') && !out.includes('int nGuid') && !out.includes('eType;'), out);
    const decl = tagged(paired({ use: 'int *pStats = (int *)Alloc(pPool, 2, eType, nGuid)' }));
    assert.ok(decl.includes('int* pStats = (int*)Alloc(pPool, 2, !pUnit ? UNIT_COUNT : pUnit->eUnitType, !pUnit ? -1 : pUnit->nUnitGUID);'), decl);
  });

  it('leaves the plugin itself alone on the if/else: the shape alone does not decide', () => {
    assert.ok(run(paired()).out.includes('if (!pUnit)'));
  });

  it('refuses when a local is read again, a value is untyped or impure, or the call reads more', () => {
    assert.match(refusal(paired({ after: 'g(nGuid);' })), /nGuid is read elsewhere/);
    assert.match(refusal(paired({ elseGuid: 'pUnit->nOther' })), /not of its type/);
    assert.match(refusal(paired({ elseGuid: 'k()' })), /not pure/);
    assert.match(refusal(paired({ decl: 'short nGuid' })), /not of its type/);
    assert.match(refusal(paired({ use: 'Alloc(Room(pUnit), 2, eType, nGuid)' })), /another argument is not pure/);
    assert.match(refusal(paired({ use: 'Alloc(pPool, 2, eType, nGuid + 1)' })), /not a whole argument/);
    assert.match(refusal(paired({ use: 'Alloc(pPool, nGuid, eType, nGuid)' })), /read 2 times/);
    assert.match(refusal(paired(), 'pUnit'), /no if\/else #1/);
  });

  // Unreferenced_005454e0, ITEMMODE_GetItemPageForUnit 0055c9a0: the original pushes the
  // selects, then calls UNITS_GetRoom, which writes nothing.
  it('takes an argument whose calls write only their own locals, and only those', () => {
    const effects = (room: object): SelectArgumentOptions => ({ ...tables, writeEffects: { Room: room } });
    const use = 'Alloc(Room(pUnit), 2, eType, nGuid)';
    const out = tagged(paired({ use }), '!pUnit', 1, effects({}));
    assert.ok(out.includes('Alloc(Room(pUnit), 2, !pUnit ? UNIT_COUNT : pUnit->eUnitType, !pUnit ? -1 : pUnit->nUnitGUID);'), out);
    const refused = (t: SelectArgumentOptions, u = use): string => {
      try { tagged(paired({ use: u }), '!pUnit', 1, t); return ''; } catch (e) { return (e as Error).message; }
    };
    assert.match(refused(effects({ memory: true })), /another argument is not pure/);
    assert.match(refused(effects({ params: [0] })), /another argument is not pure/);
    assert.match(refused(effects({ globals: ['g'] })), /another argument is not pure/);
    assert.match(refused(effects({ unknown: true })), /another argument is not pure/);
    assert.match(refused(effects({}), 'Alloc(Other(pUnit), 2, eType, nGuid)'), /another argument is not pure/);
    assert.match(refused(effects({}), 'Alloc(Room(n = 1), 2, eType, nGuid)'), /another argument is not pure/);
  });

  it('computes what the printed if/else computed', { skip: !hasNativeGpp() }, () => {
    const printed = [
      'struct U { int id; int type; };',
      'int g(int a, int t, int id) { return a * 1000000 + t * 1000 + id; }',
      'void p(U *u, int *r) { int id; int t; if (!u) { id = -1; t = 6; } else { id = u->id; t = u->type; } *r = g(7, t, id); }',
    ].join('\n');
    const out = tagged('void q(U *u, int *r) { int id; int t; if (!u) { id = -1; t = 6; } else { id = u->id; t = u->type; } *r = g(7, t, id); }',
      '!u', 1, { structFields: { U: { id: 'int', type: 'int' } } });
    assert.ok(out.includes('*r = g(7, !u ? 6 : u->type, !u ? -1 : u->id);'), out);
    const res = compileAndRun(`#include <cstdio>\n${printed}\n${out}`,
      'int bad = 0; U a = {12, 3}; int r1, r2; q(&a, &r1); p(&a, &r2); if (r1 != r2) bad++; q(0, &r1); p(0, &r2); if (r1 != r2) bad++; printf("%d\\n", bad);');
    assert.strictEqual(res.trim(), '0');
  });

  it('computes what the printed form computed', { skip: !hasNativeGpp() }, () => {
    const printed = [
      'int g(int a, int b) { return a * 1000 + b; }',
      'int p(int c, int k) { int v; v = 7; if (!c) { v = -3; } return g(k, v); }',
    ].join('\n');
    const { out } = run('int q(int c, int k) { int v; v = 7; if (!c) { v = -3; } return g(k, v); }');
    // A return is no call statement: the pass leaves it, so test the call statement form.
    assert.ok(out.includes('v = 7'), out);
    const call = run('void q(int c, int k, int *r) { int v; v = 7; if (!c) { v = -3; } *r = g(k, v); }').out;
    assert.ok(call.includes('*r = g(k, c ? 7 : -3);'), call);
    const res = compileAndRun(`#include <cstdio>\n${printed}\n${call}`,
      'int bad = 0; for (int c = -2; c <= 2; c++) { int r; q(c, 5, &r); if (r != p(c, 5)) bad++; } printf("%d\\n", bad);');
    assert.strictEqual(res.trim(), '0');
  });
});
