import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { CompoundStmt, FunctionDecl, Identifier } from '../../../ast/nodes.js';
import { summarizeWriteEffects, writeEffectAnalyser, type EffectFunction, type WriteEffectOptions } from '../builtins/write-effects.js';
import type { AggregateModel } from '../builtins/memory-regions.js';

/** Every function of `src`, keyed by its name. */
function summarize(src: string, opts: WriteEffectOptions = {}) {
  const tu = parse(src) as unknown as { declarations: FunctionDecl[] };
  const fns: EffectFunction[] = tu.declarations.filter(d => d.body).map(d => ({
    keys: [(d.name as unknown as Identifier).name],
    params: d.parameters.map(p => (p as unknown as { name?: Identifier }).name?.name ?? ''),
    paramTypes: d.parameters.map(p => emit((p as unknown as { type: never }).type)),
    body: d.body as CompoundStmt,
  }));
  const direct = summarizeWriteEffects(fns, opts);
  // Every case again from each function's own part, kept as JSON and read back the way
  // the generator's cache reads it: the summary must not tell the two apart.
  const analyse = writeEffectAnalyser(opts);
  const kept = fns.map(f => ({ ...f, body: null, analysis: JSON.parse(JSON.stringify(analyse(f))) }));
  assert.deepStrictEqual(summarizeWriteEffects(kept, opts), direct);
  return direct;
}

/** The writes of each function, without the reads. */
function summarizeWrites(src: string, opts: WriteEffectOptions = {}) {
  const out: Record<string, object> = {};
  for (const [k, { reads: _r, ...w }] of Object.entries(summarize(src, opts))) out[k] = w;
  return out;
}

/** The reads of each function. */
function summarizeReads(src: string, opts: WriteEffectOptions = {}) {
  const out: Record<string, object | undefined> = {};
  for (const [k, e] of Object.entries(summarize(src, opts))) out[k] = e.reads;
  return out;
}

describe('summarizeWriteEffects', () => {
  it('a function that writes only its locals writes nothing', () => {
    const s = summarizeWrites('int f(int a) { int x; int buf[4]; x = a + 1; buf[1] = x; a = 0; return x; }');
    assert.deepStrictEqual(s.f, {});
  });

  it('records globals written by name, through a field or an array', () => {
    const s = summarizeWrites('void f(int a) { gCount = a; gState.n = 1; gTable[a] = 2; gCount++; }',
      { globalArrays: new Set(['gTable']) });
    assert.deepStrictEqual(s.f, { globals: ['gCount', 'gState', 'gTable'] });
  });

  it('records writes through pointer parameters by index', () => {
    const s = summarizeWrites('void f(int a, Unit *pUnit, int *p) { pUnit->n = a; p[2] = 0; *(p + 1) = 3; }');
    assert.deepStrictEqual(s.f, { params: [1, 2] });
  });

  it('a write through a pointer of unknown provenance is memory', () => {
    const s = summarizeWrites('void f(Unit *pUnit) { Unit *q; q = pUnit->pNext; q->n = 0; gpUnit->n = 1; }');
    assert.deepStrictEqual(s.f, { memory: true });
  });

  it('translates a callee\'s parameter writes to what the caller passed', () => {
    const s = summarizeWrites([
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
    const s = summarizeWrites('void leaf() { gA = 1; } void mid() { leaf(); } void top() { mid(); gB = 2; }');
    assert.deepStrictEqual(s.top, { globals: ['gA', 'gB'] });
  });

  it('settles recursion to the union of its bodies', () => {
    const s = summarizeWrites([
      'void even(int n) { if (n) odd(n - 1); gEven = n; }',
      'void odd(int n) { if (n) even(n - 1); }',
      'void self(int n) { if (n) self(n - 1); }',
    ].join('\n'));
    assert.deepStrictEqual(s.even, { globals: ['gEven'] });
    assert.deepStrictEqual(s.odd, { globals: ['gEven'] });
    assert.deepStrictEqual(s.self, {});
  });

  it('an indirect call is unknown, and so is every caller', () => {
    const s = summarizeWrites([
      'void viaLocal(void (*fp)(void)) { fp(); }',
      'void viaField(Obj *o) { o->vtbl->Run(o); }',
      'void caller() { viaLocal(0); }',
    ].join('\n'));
    assert.deepStrictEqual(s.viaLocal, { unknown: true });
    assert.deepStrictEqual(s.viaField, { unknown: true });
    assert.deepStrictEqual(s.caller, { unknown: true });
  });

  it('a callee with no body is unknown unless it has a contract', () => {
    const s = summarizeWrites('void a(char *d) { Mystery(); } void b(char *d, char *s) { int n; n = strlen(s); strcpy(d, s); }');
    assert.deepStrictEqual(s.a, { unknown: true });
    assert.deepStrictEqual(s.b, { params: [0] });
  });

  it('a block that ends the process contributes nothing', () => {
    const s = summarizeWrites('int f(int n) { if (n < 0) { gErr = n; Log(); exit(-1); } return n; }');
    assert.deepStrictEqual(s.f, {});
  });

  it('keeps a block that may still return before the exit', () => {
    const s = summarizeWrites('int f(int n) { if (n < 0) { gErr = n; if (n == -2) { return 0; } exit(-1); } return n; }');
    assert.deepStrictEqual(s.f, { globals: ['gErr'] });
  });

  // GetLocaleString, 00524a30: early returns, then the halt and exit at the function's end.
  it('drops the halt at the end of a body that returned earlier', () => {
    const s = summarizeWrites('int f(int n) { if (n) { return Lookup(n); } nLine = 0x246; Halt(nLine); exit(-1); } int Lookup(int n) { return n; }');
    assert.deepStrictEqual(s.f, {});
  });

  it('declares an unsettled cycle unknown', () => {
    const s = summarizeWrites('void a(int *p) { b(p); gA = 1; } void b(int *p) { a(p); }', { maxRounds: 1 });
    assert.deepStrictEqual(s.a, { unknown: true });
    assert.deepStrictEqual(s.b, { unknown: true });
  });

  it('reads nothing as a write: pseudo-ops and comparisons', () => {
    const s = summarizeWrites('int f(int a, int b) { return CONCAT22(a, b) == gX; }');
    assert.deepStrictEqual(s.f, {});
  });
});

describe('summarizeWriteEffects reads', () => {
  const G = { globalNames: new Set(['gA', 'gB', 'gTable']), globalArrays: new Set(['gTable']) };

  it('a getter reads through its parameter and what it loads', () => {
    const r = summarizeReads('int GetX(Unit *pUnit) { return pUnit->pPath->nX; }', G);
    assert.deepStrictEqual(r.GetX, { memory: true, params: [0] });
  });

  it('records globals read by name, not fields or locals', () => {
    const r = summarizeReads('int f(int a) { int x; x = gA + gTable[a]; return x + a; }', G);
    assert.deepStrictEqual(r.f, { globals: ['gA', 'gTable'] });
  });

  it('carries a callee\'s reads, its parameter reads translated', () => {
    const r = summarizeReads('int get(int *p) { return *p; } int own() { int x; x = 1; return get(&x); } int glob() { return get(&gB); }', G);
    assert.deepStrictEqual(r.get, { params: [0] });
    assert.deepStrictEqual(r.own, {});
    assert.deepStrictEqual(r.glob, { globals: ['gB'] });
  });

  it('an indirect call reads anything', () => {
    const r = summarizeReads('int f(int (*fp)(void)) { return fp(); }', G);
    assert.deepStrictEqual(r.f, { unknown: true });
  });
});

const AGG: AggregateModel = {
  layouts: {
    Unit: [
      { name: 'nId', offset: 0, size: 4, type: 'int' },
      { name: 'pSeed', offset: 4, size: 4, type: 'Seed *' },
      { name: 'tSeed', offset: 8, size: 8, type: 'Seed' },
    ],
    Seed: [{ name: 'nLow', offset: 0, size: 4, type: 'uint' }, { name: 'nHigh', offset: 4, size: 4, type: 'uint' }],
  },
  sizes: { Unit: 16, Seed: 8 },
};

describe('summarizeWriteEffects regions', () => {
  const R = { aggregates: AGG };

  it('records the region a write through a typed pointer reaches', () => {
    const s = summarizeWrites([
      'void field(Seed *p) { p->nLow = 1; }',
      'void whole(Seed *p, Seed v) { *p = v; }',
      'void nested(Unit *u) { u->tSeed.nHigh = 2; }',
      'void local(Unit *u) { Seed *s; s = &u->tSeed; s->nLow = 0; }',
    ].join('\n'), R);
    assert.deepStrictEqual(s.field, { params: [0], paramRegions: { 0: ['Seed.nLow'] } });
    assert.deepStrictEqual(s.whole, { params: [0], paramRegions: { 0: ['Seed'] } });
    assert.deepStrictEqual(s.nested, { params: [0], paramRegions: { 0: ['Unit.tSeed'] } });
    assert.deepStrictEqual(s.local, { memory: true, regions: ['Seed.nLow'] });
  });

  it('a write through a cast, a scalar pointer or an untrusted local is untyped', () => {
    const s = summarizeWrites([
      'void cast(Unit *u) { *(int *)((int)u + 4) = 0; }',
      'void scalar(int *p) { *p = 0; }',
      'void converted(int a) { Seed *s; s = (Seed *)a; s->nLow = 0; }',
      'void addressed(Unit *u) { Seed *s; s = u->pSeed; Load(&s); s->nLow = 0; }',
      'void Load(Seed **pp) { }',
      'void mixed(Unit *u, int *p) { u->nId = 1; *(int *)u->pSeed = 2; }',
    ].join('\n'), R);
    assert.deepStrictEqual(s.cast, { params: [0] });
    assert.deepStrictEqual(s.scalar, { params: [0] });
    assert.deepStrictEqual(s.converted, { memory: true });
    assert.deepStrictEqual(s.addressed, { memory: true });
    assert.deepStrictEqual(s.mixed, { memory: true, params: [0], paramRegions: { 0: ['Unit.nId'] } });
  });

  it('carries a callee\'s regions to what the caller passed', () => {
    const s = summarizeWrites([
      'void set(Seed *p) { p->nLow = 1; }',
      'void viaField(Unit *u) { set(u->pSeed); }',
      'void viaParam(Seed *q) { set(q); }',
      'void viaOwn() { Seed t; set(&t); }',
    ].join('\n'), R);
    assert.deepStrictEqual(s.viaField, { memory: true, regions: ['Seed.nLow'] });
    assert.deepStrictEqual(s.viaParam, { params: [0], paramRegions: { 0: ['Seed.nLow'] } });
    assert.deepStrictEqual(s.viaOwn, {});
  });

  it('records no regions without the aggregates', () => {
    const s = summarizeWrites('void field(Seed *p) { p->nLow = 1; }');
    assert.deepStrictEqual(s.field, { params: [0] });
  });

  it('types reads the same way', () => {
    const r = summarizeReads('int get(Unit *u) { return u->nId; }', R);
    assert.deepStrictEqual(r.get, { params: [0], paramRegions: { 0: ['Unit.nId'] } });
  });
});

describe('summarizeWriteEffects through a global function pointer', () => {
  const src = [
    'void cbA() { }',
    'void cbB() { gX = 1; }',
    'void init(int k) { gpfn = cbA; if (k) { gpfn = &cbB; } gpfn = 0; }',
    'void use() { (*gpfn)(); }',
    'void bare() { gpfn(); }',
  ];

  it('is a call to each function it can hold', () => {
    const s = summarizeWrites(src.join('\n'), { globalInitialTargets: { gpfn: [] } });
    assert.deepStrictEqual(s.use, { globals: ['gX'] });
    assert.deepStrictEqual(s.bare, { globals: ['gX'] });
  });

  it('counts the initial value', () => {
    const s = summarizeWrites([...src, 'void cbC() { gY = 1; }'].join('\n'), { globalInitialTargets: { gpfn: ['cbC'] } });
    assert.deepStrictEqual(s.use, { globals: ['gX', 'gY'] });
  });

  it('is unknown when the pointer may hold anything else', () => {
    const unknown = { unknown: true };
    // No initial value known.
    assert.deepStrictEqual(summarizeWrites(src.join('\n')).use, unknown);
    assert.deepStrictEqual(summarizeWrites(src.join('\n'), { globalInitialTargets: { gpfn: null } }).use, unknown);
    // An initial value that is not a function of the model.
    assert.deepStrictEqual(summarizeWrites(src.join('\n'), { globalInitialTargets: { gpfn: ['Elsewhere'] } }).use, unknown);
    const with_ = (line: string, opts: WriteEffectOptions = {}) =>
      summarizeWrites([...src, line].join('\n'), { globalInitialTargets: { gpfn: [] }, ...opts }).use;
    // A value that is not a function, its address taken, a compound store.
    assert.deepStrictEqual(with_('void other(int a) { gpfn = a; }'), unknown);
    assert.deepStrictEqual(with_('void other() { Set(&gpfn); }'), unknown);
    assert.deepStrictEqual(with_('void other() { gpfn += 4; }'), unknown);
    assert.deepStrictEqual(with_('void other() { gpfn++; }'), unknown);
    // A table is written by element, not by name.
    assert.deepStrictEqual(with_('', { globalArrays: new Set(['gpfn']) }), unknown);
    // A target with an unknown effect.
    assert.deepStrictEqual(with_('void cbD() { Mystery(); } void more() { gpfn = cbD; }'), unknown);
  });
});
