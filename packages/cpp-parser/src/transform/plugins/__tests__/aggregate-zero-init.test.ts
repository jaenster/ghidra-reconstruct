import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { aggregateZeroInitPlugin } from '../builtins/aggregate-zero-init.js';

const f = (name: string, offset: number, size: number, type: string, bitSize?: number) =>
  ({ name, offset, size, type, ...(bitSize !== undefined ? { bitSize } : {}) });

// D2WINBUTTON_HandleMouseWheel's message: pControl at 0, the rest zeroed.
const tables = {
  structLayouts: {
    D2ControlMsg: [
      f('pControl', 0, 4, 'D2ControlStrc *'), f('uMsg', 4, 4, 'int'), f('wParam', 8, 4, 'WPARAM'),
      f('uLParam', 0xc, 4, 'D2UIMsgLParamUnion'), f('nCmdCode', 0x10, 4, 'uint32_t'),
      f('dwReserved', 0x14, 4, 'uint32_t'), f('bHandled', 0x18, 4, 'uint32_t'), f('dwResult', 0x1c, 4, 'uint32_t'),
    ],
    D2UIMsgLParamUnion: [f('nLParam', 0, 4, 'LPARAM'), f('sPos', 0, 4, 'D2PosShort')],
    D2PosShort: [f('nX', 0, 2, 'short'), f('nY', 2, 2, 'short')],
    D2Pair: [f('a', 0, 4, 'int'), f('b', 4, 4, 'int')],
    D2Padded: [f('c', 0, 1, 'char'), f('n', 4, 4, 'int')],
    D2Bits: [f('a', 0, 4, 'int'), f('flag', 4, 1, 'int:1', 1)],
    D2Arr: [f('n', 0, 4, 'int'), f('aw', 4, 8, 'int[2]')],
  },
  aggregateSizes: {
    D2ControlMsg: 0x20, D2UIMsgLParamUnion: 4, D2PosShort: 4, D2Pair: 8, D2Padded: 8, D2Bits: 8, D2Arr: 12,
  },
  typedefTargets: { D2PairAlias: 'D2Pair' },
  enumValues: { STATE_none: 0, STATE_poison: 2 },
};

/** The original zeroing every byte of every aggregate local the code declares. */
function zeroedWhole(code: string): Array<{ name: string; size: number; zero: [number, number][] }> {
  const sizes: Record<string, number> = { ...tables.aggregateSizes, D2PairAlias: 8 };
  return [...code.matchAll(/\b(\w+) (\w+);/g)]
    .filter(m => sizes[m[1]] !== undefined)
    .map(m => ({ name: m[2], size: sizes[m[1]], zero: [[0, sizes[m[1]]]] }));
}

function run(code: string, extra: Record<string, unknown> = {}): string {
  const ast = parse(code);
  const transformer = aggregateZeroInitPlugin.createTransformer({ ...tables, zeroStores: zeroedWhole(code), ...extra });
  return emit(transformer(ast) as AnyNode).replace(/\s+/g, ' ');
}

describe('aggregateZeroInitPlugin', () => {
  it('restores the initialiser when the run plus a later store write the whole message', () => {
    const out = run(`int f(D2Button *pButton) { D2ControlMsg sMsg;
      if (!pButton) { return 0; }
      sMsg.uMsg = 0; sMsg.wParam = 0; sMsg.uLParam.nLParam = 0; sMsg.nCmdCode = 0;
      sMsg.dwReserved = 0; sMsg.bHandled = 0; sMsg.dwResult = 0;
      if (!pButton->fpOnPress) { return 0; }
      gnCount++;
      sMsg.pControl = &pButton->sControl;
      pButton->fpOnPress(&sMsg);
      return 0; }`);
    assert.match(out, /D2ControlMsg sMsg = \{ ?0 ?\};/);
    assert.ok(!/sMsg\.uMsg = 0/.test(out), out);
    assert.ok(!/D2ControlMsg sMsg;/.test(out), out);
    assert.match(out, /sMsg\.pControl = &pButton->sControl; pButton->fpOnPress\(&sMsg\);/);
    // The guard before the run stays before the declaration.
    assert.ok(out.indexOf('if (!pButton)') < out.indexOf('sMsg = {'), out);
  });

  it('counts an enum constant of value zero and a cast zero', () => {
    const out = run('void f(int x) { D2Pair s; s.a = STATE_none; s.b = (int)0; g(&s); }');
    assert.match(out, /D2Pair s = \{ ?0 ?\}; g\(&s\);/);
  });

  it('resolves the aggregate through a typedef', () => {
    const out = run('void f() { D2PairAlias s; s.a = 0; s.b = 0; g(&s); }');
    assert.match(out, /D2PairAlias s = \{ ?0 ?\};/);
  });

  it('does not need padding written', () => {
    const out = run('void f() { D2Padded s; s.c = 0; s.n = 0; g(&s); }');
    assert.match(out, /D2Padded s = \{ ?0 ?\};/);
  });

  it('accepts constant-index stores into an array member', () => {
    const out = run('void f() { D2Arr s; s.n = 0; s.aw[0] = 0; s.aw[1] = 0; g(&s); }');
    assert.match(out, /D2Arr s = \{ ?0 ?\};/);
  });

  it('refuses when a member is never written before the address escapes', () => {
    const out = run('void f() { D2ControlMsg sMsg; sMsg.uMsg = 0; sMsg.wParam = 0; g(&sMsg); sMsg.pControl = 0; }');
    assert.match(out, /D2ControlMsg sMsg;/);
    assert.match(out, /sMsg\.uMsg = 0;/);
  });

  it('refuses when a union is written only through its narrower member', () => {
    const out = run(`void f() { D2ControlMsg m; m.pControl = 0; m.uMsg = 0; m.wParam = 0; m.uLParam.sPos.nX = 0;
      m.nCmdCode = 0; m.dwReserved = 0; m.bHandled = 0; m.dwResult = 0; g(&m); }`);
    assert.match(out, /D2ControlMsg m;/);
  });

  it('refuses a run that is not in ascending offset order', () => {
    // Hand-written clearing, as in MAINMENU_Unused16's frame group: the original matches as is.
    const out = run('void f() { D2Pair s; s.b = 0; s.a = 0; g(&s); }');
    assert.match(out, /D2Pair s; s\.b = 0; s\.a = 0;/);
  });

  it('refuses when the first store is not zero', () => {
    const out = run('void f(int x) { D2Pair s; s.a = x; s.b = 0; g(&s); }');
    assert.match(out, /D2Pair s;/);
  });

  it('refuses a single zero store', () => {
    const out = run('void f(int x) { D2Pair s; s.a = 0; s.b = x; g(&s); }');
    assert.match(out, /D2Pair s;/);
  });

  it('refuses a non-zero enum constant as zero', () => {
    const out = run('void f() { D2Pair s; s.a = 0; s.b = STATE_poison; g(&s); }');
    assert.ok(!/= \{/.test(out), out);
  });

  it('refuses when the local is read before the run', () => {
    const out = run('void f() { D2Pair s; g(&s); s.a = 0; s.b = 0; h(&s); }');
    assert.match(out, /D2Pair s;/);
  });

  it('refuses when a store reads the local itself', () => {
    const out = run('void f() { D2ControlMsg m; m.uMsg = 0; m.wParam = 0; m.uLParam.nLParam = 0; m.nCmdCode = 0;'
      + ' m.dwReserved = 0; m.bHandled = 0; m.dwResult = 0; m.pControl = (D2ControlStrc *)m.uMsg; g(&m); }');
    assert.match(out, /D2ControlMsg m;/);
  });

  it('refuses when a use lies outside the block of the run', () => {
    const out = run('void f(int c) { D2Pair s; if (c) { s.a = 0; s.b = 0; g(&s); } h(s.a); }');
    assert.match(out, /D2Pair s;/);
  });

  it('refuses when a label follows the run in its block', () => {
    const out = run('void f(int c) { D2Pair s; if (c) goto L; s.a = 0; s.b = 0; L: g(&s); }');
    assert.match(out, /D2Pair s;/);
  });

  it('refuses when a case label of the enclosing switch follows', () => {
    const out = run('void f(int c) { D2Pair s; switch (c) { case 1: g(0); s.a = 0; s.b = 0; g(&s); break; case 2: break; } }');
    assert.match(out, /D2Pair s;/);
  });

  it('allows a whole switch after the run', () => {
    const out = run('void f(int c) { D2Pair s; s.a = 0; s.b = 0; switch (c) { case 1: g(&s); break; } }');
    assert.match(out, /D2Pair s = \{ ?0 ?\};/);
  });

  it('refuses an aggregate with a bitfield or a converting constructor', () => {
    assert.match(run('void f() { D2Bits s; s.a = 0; s.flag = 0; g(&s); }'), /D2Bits s;/);
    assert.match(run('void f() { D2Pair s; s.a = 0; s.b = 0; g(&s); }', { convertingAggregates: ['D2Pair'] }), /D2Pair s;/);
  });

  it('leaves pointers, arrays and unknown types alone', () => {
    assert.match(run('void f() { D2Pair *p; p->a = 0; p->b = 0; g(p); }'), /D2Pair ?\* ?p;/);
    assert.match(run('void f() { D2Unknown s; s.a = 0; s.b = 0; g(&s); }'), /D2Unknown s;/);
  });

  it('does not take a member spelled like the local for a read of it', () => {
    const out = run('void f(D2Pair *p) { D2Pair a; a.a = 0; a.b = 0; p->a = 1; g(&a); }');
    assert.match(out, /D2Pair a = \{ ?0 ?\};/);
  });

  it('declares the initialiser with `=`, which C++03 needs', () => {
    const out = run('void f() { D2Pair s; s.a = 0; s.b = 0; g(&s); }');
    assert.ok(!/s\{/.test(out), out);
  });
  // ClearScreen 006b7f70: the original zeroes left and top only; right and bottom take
  // their values directly, so the source cleared members one by one.
  const viewport = `void f(int w, int h) { D2Rect r;
      r.left = 0; r.top = 0; r.right = w; r.bottom = h;
      clear(&r); }`;
  const rectTables = {
    structLayouts: { D2Rect: [f('left', 0, 4, 'int'), f('top', 4, 4, 'int'), f('right', 8, 4, 'int'), f('bottom', 0xc, 4, 'int')] },
    aggregateSizes: { D2Rect: 16 },
  };

  it('restores the initialiser where the original zeroes every member byte', () => {
    const out = run(viewport, { ...rectTables, zeroStores: [{ name: 'r', size: 16, zero: [[0, 16]] }] });
    assert.match(out, /D2Rect r = \{ ?0 ?\}; r\.right = w; r\.bottom = h;/);
  });

  it('leaves members cleared one by one where the original zeroes only some of them', () => {
    const out = run(viewport, { ...rectTables, zeroStores: [{ name: 'r', size: 16, zero: [[0, 8]] }] });
    assert.match(out, /D2Rect r; r\.left = 0; r\.top = 0;/);
  });

  it('changes nothing without the instructions behind the local', () => {
    for (const zeroStores of [undefined, [], [{ name: 'q', size: 16, zero: [[0, 16]] }], [{ name: 'r', size: 12, zero: [[0, 16]] }]]) {
      const out = run(viewport, { ...rectTables, zeroStores });
      assert.match(out, /D2Rect r; r\.left = 0;/, JSON.stringify(zeroStores));
    }
  });
});
