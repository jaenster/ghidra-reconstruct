/**
 * dead-out-slot-store and cfg/out-param: the PUSH-reg slot store before a call that
 * overwrites the local through its address, proven from the callee's own body.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { NodeKind } from '../../../ast/kinds.js';
import type { AnyNode, CompoundStmt, FunctionDecl, Statement } from '../../../ast/nodes.js';
import { deadOutSlotStorePlugin, type DeadOutSlotStoreOptions } from '../builtins/dead-out-slot-store.js';
import { createFloatPointerBitcastTransformer } from '../builtins/float-pointer-bitcast.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';
import { outParamWidths } from '../../cfg/out-param.js';

const SIZES: Record<string, number> = { int: 4, uint: 4, 'BigData *': 4, BigData: 0x168, short: 2, 'short int': 2, byte: 1 };
const typeSize = (s: string) => (s.trim().endsWith('*') ? 4 : SIZES[s.trim()] ?? null);

/** Out-parameter widths of the one function in `src`, its params typed `T *` with T's size given. */
function widths(src: string, pointee: (number | null)[], callees: Record<string, number[]> = {}) {
  const tu = parse(src) as unknown as { declarations: FunctionDecl[] };
  const fn = tu.declarations.find(d => d.kind === NodeKind.FunctionDecl)!;
  const params = fn.parameters.map(p => (p as unknown as { name: { name: string } }).name.name);
  return outParamWidths((fn.body as CompoundStmt).statements as Statement[], params, {
    pointeeWidth: i => pointee[i] ?? null,
    typeSize,
    calleeOut: (c, i) => (callees[c]?.includes(i) ? 4 : null),
    noreturn: new Set(['_exit', 'ERROR_UnrecoverableInternalError_Halt']),
  });
}

describe('cfg/out-param', () => {
  it('SBigNew 00423950: written on both returning paths', () => {
    const w = widths(`void SBigNew(BigData **pp) { BigData *p; p = SMemAlloc(0x168); if (p != 0) { p = ctor(p); *pp = p; return; } *pp = 0; return; }`, [4]);
    assert.equal(w.get(0), 4);
  });
  it('a read before the write is not an out-parameter (Memory::Free reads *pp)', () => {
    assert.equal(widths(`void Free(void *heap, void **pp) { if (*pp) release(*pp); *pp = 0; }`, [null, 4]).get(1), undefined);
  });
  it('a path that returns without writing is not one (SRegLoadValue fails without writing)', () => {
    assert.equal(widths(`int Load(char *k, int *pOut) { if (k == 0) { err(0x57); return 0; } *pOut = read(k); return 1; }`, [1, 4]).get(1), undefined);
  });
  it('a null test is not a read; a halt path does not return (SFileOpenFileEx, GetShiftedFrameMetrics)', () => {
    assert.equal(widths(`int Open(char *n, void **ph) { int r = -1; if (ph == 0) r = 0; else *ph = 0; if (!n) { ERROR_UnrecoverableInternalError_Halt("", 0, 1); _exit(-1); } return r; }`, [1, 4]).get(1), undefined,
      'the ph == 0 path returns without writing');
    assert.equal(widths(`void M(int *u, int *pF) { if (u == 0) { ERROR_UnrecoverableInternalError_Halt("", 0, 1); _exit(-1); } if (*u) { *pF = 1; return; } *pF = 2; }`, [4, 4]).get(1), 4);
  });
  it('passing it on to an out-parameter writes it (SFileLoadFile -> SFileLoadFileEx2)', () => {
    assert.equal(widths(`int L(char *n, void **pp) { return LoadEx(0, n, pp); }`, [1, 4], { LoadEx: [2] }).get(1), 4);
    assert.equal(widths(`int L(char *n, void **pp) { return Other(0, n, pp); }`, [1, 4]).get(1), undefined);
  });
  it('a narrower store through a cast is reported narrow', () => {
    assert.equal(widths(`void S(int *p) { *(short *)p = 1; }`, [4]).get(0), 2);
  });
});

const unionFacts: DeadOutSlotStoreOptions = {
  outParamWidth: () => null,
  typeSize: s => ({ U: 4, float: 4, int: 4, unsigned: 4, 'unsigned int': 4, 'void *': 4 }[s] ?? null),
  unionNames: ['U'], aggregateSizes: { U: 4 }, aggregateMembers: { U: ['f', 'i'] },
  structLayouts: { U: [{ name: 'f', offset: 0, size: 4, type: 'float' }, { name: 'i', offset: 0, size: 4, type: 'unsigned int' }] },
  pushSlotInits: [{ local: 'u', value: 'p' }],
};
const unionSource = (body: string, param = 'unsigned p') => `unsigned f(${param}, int mode) { U u; ${body} }`;
function runUnion(src: string, facts: DeadOutSlotStoreOptions = unionFacts) {
  return emit(deadOutSlotStorePlugin.createTransformer(facts)(parse(src, { recover: false })) as AnyNode);
}

describe('PUSH copy killed by a full-width union member', () => {
  it('drops only the initial copy in the sound shape, retaining RHS effects and later address uses', () => {
    const src = unionSource('if (mode == 1) { u = (U)p; u.f = Clamp(mode); Set(&u); Set(&u); } else { u.i = 32; Set(&u); } return 0;');
    const drops: string[][] = [];
    const out = runUnion(src, { ...unionFacts, onDrop: (x, why) => drops.push([x, why]) });
    assert.doesNotMatch(out, /u = \(U\)p/);
    assert.match(out, /u\.f = Clamp\(mode\);\s*Set\(&u\);\s*Set\(&u\);/);
    assert.deepEqual(drops, [['u', 'union-member-overwrite']]);
  });
  it('requires native PUSH evidence and a real parameter with no shadow or conversion effects', () => {
    const src = unionSource('u = (U)p; u.f = Clamp(mode); return Read(&u);');
    for (const facts of [{ ...unionFacts, pushSlotInits: [] }, { ...unionFacts, pushSlotInits: [{ local: 'u', value: 'q' }] }]) {
      assert.match(runUnion(src, facts), /u = \(U\)p;/);
    }
    for (const s of [
      unionSource('{ unsigned p = 9; u = (U)p; u.f = Clamp(mode); } return Read(&u);'),
      unionSource('u = (U)(float)p; u.f = Clamp(mode); return Read(&u);'),
      unionSource('u = (U)p; u.f = Clamp(mode); return Read(&u);', 'volatile unsigned p'),
      unionSource('u = (U)p; u.f = Clamp(mode); return Read(&u);', 'unsigned &p'),
    ]) assert.match(runUnion(s), /u = /);
  });
  it('does not share the enclosing function native slots with other definitions', () => {
    const src = unionSource('u = (U)p; u.f = Clamp(mode); return Read(&u);');
    const out = runUnion(src + src.replace('unsigned f(', 'unsigned g('));
    assert.equal(out.split('u = (U)p;').length, 3);
  });
  it('requires a complete plain union layout and a store covering every byte', () => {
    const src = unionSource('u = (U)p; u.f = Clamp(mode); return Read(&u);');
    const fields = unionFacts.structLayouts!.U;
    for (const facts of [
      { ...unionFacts, unionNames: [] }, { ...unionFacts, aggregateSizes: {} },
      { ...unionFacts, aggregateMembers: {} }, { ...unionFacts, structLayouts: {} },
      { ...unionFacts, aggregateMembers: { U: ['f', 'i', 'missing'] } },
      { ...unionFacts, convertingAggregates: ['U'] },
      ...[{ size: 2 }, { offset: 1 }, { bitSize: 32 }, { type: 'volatile float' }, { type: 'Unknown' }]
        .map(change => ({ ...unionFacts, structLayouts: { U: [{ ...fields[0], ...change }, fields[1]] } })),
      { ...unionFacts, structLayouts: { U: [fields[0], { ...fields[1], type: 'volatile unsigned int' }] } },
      { ...unionFacts, structLayouts: { U: [fields[0], fields[0]] } },
    ]) assert.match(runUnion(src, facts), /u = \(U\)p;/);
    // A valid layout can still be partial: float writes four of an eight-byte
    // union's bytes, and the remaining bits of the PUSH copy must survive.
    assert.match(runUnion(unionSource('u = (U)p; u.f = Clamp(mode); return Read(&u);', 'unsigned long long p'), {
      ...unionFacts, typeSize: s => ({ U: 8, float: 4, double: 8, 'unsigned long long': 8 }[s] ?? null),
      aggregateSizes: { U: 8 }, structLayouts: { U: [
        { name: 'f', offset: 0, size: 4, type: 'float' }, { name: 'i', offset: 0, size: 8, type: 'double' },
      ] },
    }), /u = \(U\)p;/);
  });
  it('keeps the copy for a prior read/escape, self-reading RHS, nonadjacent or compound store', () => {
    for (const body of [
      'Capture(&u); u = (U)p; u.i = ReadCaptured(); return u.i;',
      'Use(u); u = (U)p; u.f = Clamp(mode); return Read(&u);',
      'u = (U)p; u.i = u.i + 1; return u.i;',
      'u = (U)p; u.i = Inspect(&u); return u.i;',
      'u = (U)p; Other(); u.f = Clamp(mode); return Read(&u);',
      'u = (U)p; u.i += mode; return u.i;',
      'u = (U)p; if (mode) u.f = Clamp(mode); return Read(&u);',
    ]) assert.match(runUnion(unionSource(body)), /u = \(U\)p;/);
  });
  it('keeps copies across loops, labels, nested bindings, initializers and static storage', () => {
    for (const s of [
      unionSource('while (mode--) { u = (U)p; u.i = ReadCaptured(); Capture(&u); } return 0;'),
      unionSource('do { u = (U)p; u.i = ReadCaptured(); Capture(&u); } while (--mode); return 0;'),
      unionSource('for (int i = 0; i < mode; ++i) { u = (U)p; u.i = ReadCaptured(); Capture(&u); } return 0;'),
      unionSource('L: u = (U)p; u.f = Clamp(mode); if (mode--) goto L; return Read(&u);'),
      unionSource('u = (U)p; u.f = Clamp(mode); { U u; Use(u); } return Read(&u);'),
      unionSource('u = (U)p; u.f = Clamp(mode); u = (U)p; return Read(&u);'),
      unionSource('u = (U)p; u.f = Clamp(mode); return Read(&u);').replace('U u;', 'U u = {};'),
      unionSource('u = (U)p; u.f = Clamp(mode); return Read(&u);').replace('U u;', 'static U u;'),
      unionSource('u = (U)p; u.f = Clamp(mode); return Read(&u);').replace('U u;', 'volatile U u;'),
    ]) assert.match(runUnion(s), /u = \(U\)p;/);
  });
  it('preserves optimized values, call order and alias reads', { skip: !hasNativeGpp() }, () => {
    // Use the normal bitcast lowering for the decompiler's C union cast in BOTH
    // programs; there is no custom C++ conversion constructor in these unions.
    const lower = (src: string, transform: boolean) => {
      let ast = parse(src, { recover: false });
      if (transform) ast = deadOutSlotStorePlugin.createTransformer(unionFacts)(ast) as typeof ast;
      return emit(createFloatPointerBitcastTransformer({
        structFields: { U: { f: 'float', i: 'unsigned int' } }, aggregateSizes: { U: 4 },
      })(ast) as AnyNode);
    };
    const bodies = [
      'if (mode) { u = (U)p; u.f = Clamp(mode); return Set(&u); } u.i = p; return Set(&u);',
      'Capture(&u); u = (U)p; u.i = ReadCaptured(); return Set(&u);',
      'u = (U)p; u.i = u.i + 1; return Set(&u);',
      'if (!mode) return p; for (int i = 0; i < mode; ++i) { u = (U)p; u.i = ReadCaptured(); Capture(&u); } return Set(&u);',
    ];
    let prelude = `union U { float f; unsigned int i; };
      template<class T, class S> T d2_bits_as(S value) { T r; static_assert(sizeof(T)==sizeof(S), "width"); std::memcpy(&r,&value,sizeof(r)); return r; }
      static U *captured; static unsigned trace;
      void Capture(U *p) { captured = p; trace = trace * 7 + 1; }
      unsigned ReadCaptured() { trace = trace * 7 + 2; return captured ? captured->i : 9; }
      float Clamp(int mode) { trace = trace * 7 + 3; return (float)(mode * 3) / 4; }
      unsigned Set(U *p) { unsigned bits; trace = trace * 7 + 4; std::memcpy(&bits,p,4); return bits; }
    `;
    let main = 'unsigned checks = 0;';
    bodies.forEach((body, i) => {
      const src = unionSource(body);
      const before = lower(src, false), after = lower(src, true);
      if (i === 0) assert.doesNotMatch(after, /u = d2_bits_as/);
      else assert.match(after, /u = d2_bits_as/);
      prelude += `namespace Before${i} { ${before} } namespace After${i} { ${after} }`;
      main += `for (unsigned p=0; p<4096; ++p) for(int mode=0; mode<4; ++mode) {
        captured=0; trace=0; unsigned a=Before${i}::f(p*1048573u,mode), t=trace;
        captured=0; trace=0; unsigned b=After${i}::f(p*1048573u,mode);
        if(a!=b || trace!=t) return ${i + 1}; ++checks;
      }`;
    });
    assert.equal(compileAndRun(prelude, main + 'std::printf("checks=%u\\n",checks);', { optimize: true }), 'checks=65536\n');
  });
});

const PUSHED = [{ local: 'pNewBigInt', value: 'pData' }, { local: 'q', value: 'p' }, { local: 'n', value: 'pGame' }];
function run(src: string, out: Record<string, number> = { 'Storm::Source::SBig::SBigNew': 4, GetFrames: 4 }, pushSlotInits = PUSHED) {
  const t = deadOutSlotStorePlugin.createTransformer({ outParamWidth: (c: string, i: number) => (i === 0 || c === 'GetFrames') && c in out ? out[c] : null, typeSize, pushSlotInits });
  return emit(t(parse(src)) as AnyNode).replace(/\s+/g, ' ').trim();
}

describe('dead-out-slot-store', () => {
  it('SHA1_FromBigIntBytes 0052a270: the PUSH ECX store before SBigNew(&p) goes', () => {
    const out = run(`BigData * f(void *pData, uint n) { BigData *pNewBigInt; pNewBigInt = pData; Storm::Source::SBig::SBigNew(&pNewBigInt); SBigFromBinary(pNewBigInt, pData, n); return pNewBigInt; }`);
    assert.doesNotMatch(out, /pNewBigInt = pData/);
    assert.match(out, /BigData\* pNewBigInt; Storm::Source::SBig::SBigNew\(&pNewBigInt\);/);
  });
  it('keeps the store when the callee is not proven to write first, or writes too little', () => {
    assert.match(run(`void f(void *p) { BigData *q; q = p; Unknown(&q); use(q); }`), /q = p;/);
    assert.match(run(`void f(void *p) { double q; q = 1.0; Storm::Source::SBig::SBigNew((BigData**)&q); use(q); }`), /q = 1\.0;/);
  });
  it('keeps the store when the next statement reads it, or its address was taken elsewhere', () => {
    assert.match(run(`void f(void *p) { BigData *q; q = p; Storm::Source::SBig::SBigNew(q ? &q : 0); use(q); }`), /q = p;/);
    assert.match(run(`void f(void *p) { BigData *q; g(&q); q = p; Storm::Source::SBig::SBigNew(&q); use(q); }`), /q = p;/);
  });
  it('only the PUSH-reg store: not a store the source made, nor a slot the prologue did not push', () => {
    // `n = 0` is a MOV the source wrote; and a local outside a pushed slot is never a candidate.
    assert.match(run(`void f(D2GameStrc *pGame) { int n; n = 0; GetFrames(0, 0, &n); use(n); }`), /n = 0;/);
    assert.match(run(`BigData * f(void *pData) { BigData *pNewBigInt; pNewBigInt = pData; Storm::Source::SBig::SBigNew(&pNewBigInt); return pNewBigInt; }`, undefined, []),
      /pNewBigInt = pData;/);
  });
  it('OBJOP_A3Q2_KhalimsRelicPortalDrop1 005b8860: a later out-call in a loop, and nothing else reads the slot', () => {
    const out = run(`int f(D2GameStrc *pGame) { int n; int k; n = (int)pGame; k = Spawn(pGame); if (k) { do { GetFrames(pGame, 0, (int *)&n); k--; } while (k); } return 0; }`);
    assert.doesNotMatch(out, /n = \(int\)pGame/);
    assert.match(out, /int n; int k; k = Spawn\(pGame\);/);
  });
  it('several out-calls: dropped only when every one writes first', () => {
    assert.doesNotMatch(run(`void f(D2GameStrc *pGame) { int n; n = (int)pGame; g(pGame); GetFrames(pGame, 0, &n); GetFrames(pGame, 1, &n); }`), /n = \(int\)pGame/);
    assert.match(run(`void f(D2GameStrc *pGame) { int n; n = (int)pGame; g(pGame); GetFrames(pGame, 0, &n); Unknown(&n); }`), /n = \(int\)pGame;/);
  });
  it('a later out-call keeps the store when x is read anywhere, or an argument calls something', () => {
    // NET_SID_CLIENT_Send_0x41 0051abb0 shape: the slot is the parameter's home and is sent.
    assert.match(run(`void f(D2GameStrc *pGame) { int n; n = (int)pGame; g(pGame); GetFrames(pGame, 0, &n); use(n); }`), /n = \(int\)pGame;/);
    assert.match(run(`void f(D2GameStrc *pGame) { int n; n = (int)pGame; g(n); GetFrames(pGame, 0, &n); }`), /n = \(int\)pGame;/);
    assert.match(run(`void f(D2GameStrc *pGame) { int n; n = (int)pGame; g(pGame); GetFrames(h(), 0, &n); }`), /n = \(int\)pGame;/);
    assert.match(run(`void f(D2GameStrc *pGame) { int n; int *p; n = (int)pGame; p = &n; GetFrames(pGame, 0, &n); }`), /n = \(int\)pGame;/);
  });
  // UI_SLIDER_InitContrast 0047d2f0: PUSH ECX, the slot then given its default by a store.
  it('drops the store when a later plain store overwrites x before anything names it', () => {
    const out = run(`void f(D2GameStrc *pGame) { int n; int m; n = (int)pGame; m = Mode(); n = m != 1 ? 100 : 0; Load(&n); Use(pGame, n); }`);
    assert.doesNotMatch(out, /n = \(int\)pGame/);
    assert.match(out, /int n; int m; m = Mode\(\); n = m != 1 \? 100 : 0; Load\(&n\);/);
  });
  it('keeps the store when x is named before the overwrite, the overwrite reads x, or a label lies between', () => {
    assert.match(run(`void f(D2GameStrc *pGame) { int n; n = (int)pGame; Use(n); n = 0; Load(&n); }`), /n = \(int\)pGame;/);
    assert.match(run(`void f(D2GameStrc *pGame) { int n; n = (int)pGame; Mode(); n = n + 1; Load(&n); }`), /n = \(int\)pGame;/);
    assert.match(run(`void f(D2GameStrc *pGame) { int n; n = (int)pGame; L: Mode(); n = 0; Load(&n); if (pGame) goto L; }`), /n = \(int\)pGame;/);
    assert.match(run(`void f(D2GameStrc *pGame) { int n; if (pGame) { n = (int)pGame; Mode(); n = 0; Load(&n); } }`), /n = \(int\)pGame;/);
  });
  it('the call may be the value of an assignment or an initializer', () => {
    const out = run(`void f(D2UnitStrc *pUnit, D2GameStrc *pGame) { int n; int r; n = (int)pGame; r = GetFrames(pUnit, 0, &n); use(n, r); }`);
    assert.doesNotMatch(out, /n = \(int\)pGame/);
  });
});
