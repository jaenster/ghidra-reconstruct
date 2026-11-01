import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import type { CompoundStmt, FunctionDecl, Identifier } from '../../../ast/nodes.js';
import { summarizeWriteEffects, type EffectFunction, type WriteEffectOptions } from '../builtins/write-effects.js';

/** Every function of `src`, keyed by its name. */
function summarize(src: string, opts: WriteEffectOptions = {}) {
  const tu = parse(src) as unknown as { declarations: FunctionDecl[] };
  const fns: EffectFunction[] = tu.declarations.filter(d => d.body).map(d => ({
    keys: [(d.name as unknown as Identifier).name],
    params: d.parameters.map(p => (p as unknown as { name?: Identifier }).name?.name ?? ''),
    body: d.body as CompoundStmt,
  }));
  return summarizeWriteEffects(fns, opts);
}

describe('summarizeWriteEffects', () => {
  it('a function that writes only its locals writes nothing', () => {
    const s = summarize('int f(int a) { int x; int buf[4]; x = a + 1; buf[1] = x; a = 0; return x; }');
    assert.deepStrictEqual(s.f, {});
  });

  it('records globals written by name, through a field or an array', () => {
    const s = summarize('void f(int a) { gCount = a; gState.n = 1; gTable[a] = 2; gCount++; }',
      { globalArrays: new Set(['gTable']) });
    assert.deepStrictEqual(s.f, { globals: ['gCount', 'gState', 'gTable'] });
  });

  it('records writes through pointer parameters by index', () => {
    const s = summarize('void f(int a, Unit *pUnit, int *p) { pUnit->n = a; p[2] = 0; *(p + 1) = 3; }');
    assert.deepStrictEqual(s.f, { params: [1, 2] });
  });

  it('a write through a pointer of unknown provenance is memory', () => {
    const s = summarize('void f(Unit *pUnit) { Unit *q; q = pUnit->pNext; q->n = 0; gpUnit->n = 1; }');
    assert.deepStrictEqual(s.f, { memory: true });
  });

  it('translates a callee\'s parameter writes to what the caller passed', () => {
    const s = summarize([
      'void set(int *p) { *p = 1; }',
      'void own() { int x; set(&x); }',
      'void param(int *q) { set(q); }',
      'void global() { set(&gCount); }',
      'void loaded(Unit *u) { set(u->pCount); }',
    ].join('\n'));
    assert.deepStrictEqual(s.set, { params: [0] });
    assert.deepStrictEqual(s.own, {});
    assert.deepStrictEqual(s.param, { params: [0] });
    assert.deepStrictEqual(s.global, { globals: ['gCount'] });
    assert.deepStrictEqual(s.loaded, { memory: true });
  });

  it('carries a callee\'s globals up the call graph', () => {
    const s = summarize('void leaf() { gA = 1; } void mid() { leaf(); } void top() { mid(); gB = 2; }');
    assert.deepStrictEqual(s.top, { globals: ['gA', 'gB'] });
  });

  it('settles recursion to the union of its bodies', () => {
    const s = summarize([
      'void even(int n) { if (n) odd(n - 1); gEven = n; }',
      'void odd(int n) { if (n) even(n - 1); }',
      'void self(int n) { if (n) self(n - 1); }',
    ].join('\n'));
    assert.deepStrictEqual(s.even, { globals: ['gEven'] });
    assert.deepStrictEqual(s.odd, { globals: ['gEven'] });
    assert.deepStrictEqual(s.self, {});
  });

  it('an indirect call is unknown, and so is every caller', () => {
    const s = summarize([
      'void viaLocal(void (*fp)(void)) { fp(); }',
      'void viaField(Obj *o) { o->vtbl->Run(o); }',
      'void caller() { viaLocal(0); }',
    ].join('\n'));
    assert.deepStrictEqual(s.viaLocal, { unknown: true });
    assert.deepStrictEqual(s.viaField, { unknown: true });
    assert.deepStrictEqual(s.caller, { unknown: true });
  });

  it('a callee with no body is unknown unless it has a contract', () => {
    const s = summarize('void a(char *d) { Mystery(); } void b(char *d, char *s) { int n; n = strlen(s); strcpy(d, s); }');
    assert.deepStrictEqual(s.a, { unknown: true });
    assert.deepStrictEqual(s.b, { params: [0] });
  });

  it('a block that ends the process contributes nothing', () => {
    const s = summarize('int f(int n) { if (n < 0) { gErr = n; Log(); exit(-1); } return n; }');
    assert.deepStrictEqual(s.f, {});
  });

  it('keeps a block that may still return before the exit', () => {
    const s = summarize('int f(int n) { if (n < 0) { gErr = n; if (n == -2) { return 0; } exit(-1); } return n; }');
    assert.deepStrictEqual(s.f, { globals: ['gErr'] });
  });

  it('declares an unsettled cycle unknown', () => {
    const s = summarize('void a(int *p) { b(p); gA = 1; } void b(int *p) { a(p); }', { maxRounds: 1 });
    assert.deepStrictEqual(s.a, { unknown: true });
    assert.deepStrictEqual(s.b, { unknown: true });
  });

  it('reads nothing as a write: pseudo-ops and comparisons', () => {
    const s = summarize('int f(int a, int b) { return CONCAT22(a, b) == gX; }');
    assert.deepStrictEqual(s.f, {});
  });
});
