import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { compareBranchFormPlugin } from '../builtins/compare-branch-form.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(code: string, rows: string[]): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = compareBranchFormPlugin.createTransformer({
    compareSites: rows.join('\n'),
    onSite: (e: { kind: string }) => sites.push(e.kind),
  } as never);
  return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
}

/** A row of the compare-sites script: operator, operand fingerprints, then pos/use/arm. */
let nextAt = 0x400000;
const row = (op: string, fp0: string, fp1: string, pos: string, use: string, arm = '-', at = (nextAt += 4).toString(16).padStart(8, '0'),
  more?: { om?: string; f0?: string; f1?: string; ic?: string }) =>
  ['0', op, 'INT_X', '4', '1', '0', fp0, fp1, at, '-', '-', '-', '-', '0', '-', '-', '-', '0', pos, use, arm, arm === '-' ? '0' : '1',
    ...(more ? [more.om ?? 'CMP', '-', more.f0 ?? '-', more.f1 ?? '-', more.ic ?? '-'] : [])].join('\t');
/** A row from the newer script, with the op's instruction, fields and intervening calls. */
const row27 = (op: string, fp0: string, fp1: string, pos: string, use: string, arm: string, more: { om?: string; f0?: string; f1?: string; ic?: string }) =>
  row(op, fp0, fp1, pos, use, arm, undefined, more);
/** A row whose flags reader is the conditional jump `um`. */
const rowJ = (op: string, fp0: string, fp1: string, um: string, arm = 't') =>
  row(op, fp0, fp1, 'v', 'j', arm).split('\t').map((c, i) => (i === 10 ? um : c)).join('\t');

describe('compare-branch-form', () => {
  it('writes a branched-on value store to a local as one arm (0044cca0)', () => {
    const { out, sites } = run('int f(int fps) { int n; n = fps < 7; return n * 2; }', [row('<', 'v:fps', 'c:7', 'v', 'j', 't')]);
    assert.deepStrictEqual(sites, ['local']);
    assert.ok(out.includes('n = 0; if (fps < 7) n = 1; return n * 2;'), out);
  });

  it('uses bool literals for a bool local joined into a later test (00480d20)', () => {
    const { out } = run('void f(int m, int p) { bool b; if (p == 1) { b = m == 0x13; } else { b = m == 0xd; } if (!b) return; g(); }',
      [row('==', 'v:p', 'c:1', 'b', 'j', 't'), row('==', 'v:m', 'c:13', 'v', 'j', 'r'), row('==', 'v:m', 'c:d', 'v', 'j', 'r')]);
    assert.ok(out.includes('b = false; if (m == 0x13) b = true;'), out);
    assert.ok(out.includes('b = false; if (m == 0xd) b = true;'), out);
  });

  it('splits a declaration with a test initializer', () => {
    const { out } = run('int f(int a) { int b = a == 5; return b; }', [row('==', 'v:a', 'c:5', 'v', 'j', 't')]);
    assert.ok(out.includes('int b = 0; if (a == 5) b = 1;'), out);
  });

  it('writes a branched-on return through a zeroed local', () => {
    const { out, sites } = run('int f(int a) { return a == 5; }', [row('==', 'v:a', 'c:5', 'v', 'j', 't')]);
    assert.deepStrictEqual(sites, ['return']);
    assert.ok(out.includes('int nResult = 0; if (a == 5) nResult = 1; return nResult;'), out);
  });

  it('hoists a branched-on call argument into a local (0047f130)', () => {
    const { out, sites } = run('void f(int g) { h(3, (unsigned)!g); }', [row('==', 'v:g', 'c:0', 'v', 'j', 't')]);
    assert.deepStrictEqual(sites, ['arg-local']);
    assert.ok(out.includes('unsigned int nTest = 0; if (!g) nTest = 1; h(3, nTest);'), out);
  });

  it('splits the call when the original jumped over a second arm (004e9940)', () => {
    const { out, sites } = run('void f(int x) { h(x < 1000); }', [row('<', 'v:x', 'c:3e8', 'v', 'j', 'd')]);
    assert.deepStrictEqual(sites, ['arg-split']);
    assert.ok(out.includes('if (x < 1000) h(1); else h(0);'), out);
  });

  it('leaves a test the original materialised with setcc or sbb', () => {
    for (const use of ['s', 'c']) {
      const { sites } = run('int f(int a) { int b; b = a == 5; return b; }', [row('==', 'v:a', 'c:5', 'v', use)]);
      assert.deepStrictEqual(sites, []);
    }
  });

  it('leaves a test whose value rows disagree', () => {
    const { sites } = run('int f(int a) { int b; b = a == 5; int c; c = a == 5; return b + c; }',
      [row('==', 'v:a', 'c:5', 'v', 'j', 't'), row('==', 'v:a', 'c:5', 'v', 's')]);
    assert.deepStrictEqual(sites, []);
  });

  it('ties a test to its rows by its literal as well', () => {
    const { out } = run('int f(int a) { int b; b = a == 5; int c; c = a != 7; return b + c; }',
      [row('==', 'v:a', 'c:5', 'v', 'j', 't'), row('!=', 'v:a', 'c:7', 'v', 's')]);
    assert.ok(out.includes('b = 0; if (a == 5) b = 1;'), out);
    assert.ok(out.includes('c = a != 7;'), out);
  });

  it('rewrites a joined local in every arm or in none (INPUT_DialogMouseUp 004b72e0)', () => {
    const code = 'struct D { int m; }; void f(int r, D *p) { bool b; if (r) { b = !r; } else { b = p->m == 1; } if (!b) return; g(); }';
    assert.deepStrictEqual(run(code, [row('==', 'v:r', 'c:0', 'v', 'j', 't'), row('==', 'e', 'c:1', 'v', 'j', 't')]).sites, []);
    const both = 'void f(int r, int m) { bool b; if (r) { b = !r; } else { b = m == 1; } if (!b) return; g(); }';
    assert.deepStrictEqual(run(both, [row('==', 'v:r', 'c:0', 'v', 'j', 't'), row('==', 'v:m', 'c:1', 'v', 'j', 't')]).sites, ['local', 'local']);
  });

  it('ignores branch-position rows and rows of an older script', () => {
    const { sites } = run('int f(int a) { int b; b = a == 5; return b; }', [row('==', 'v:a', 'c:5', 'b', 'j', 't')]);
    assert.deepStrictEqual(sites, []);
    const old = row('==', 'v:a', 'c:5', 'v', 'j', 't').split('\t').slice(0, 18).join('\t');
    assert.deepStrictEqual(run('int f(int a) { int b; b = a == 5; return b; }', [old]).sites, []);
  });

  it('leaves a store whose test reads the local, an address-taken local, a call in the test', () => {
    const rows = [row('==', 'v:a', 'c:5', 'v', 'j', 't')];
    assert.deepStrictEqual(run('int f(int a) { a = a == 5; return a; }', rows).sites, []);
    assert.deepStrictEqual(run('int f(int a) { int b; int *p = &b; b = a == 5; return *p; }', rows).sites, []);
    assert.deepStrictEqual(run('int f(int a) { int b; b = a == k(); return b; }', [row('==', 'v:a', 'e', 'v', 'j', 't')]).sites, []);
  });

  it('leaves a call whose other arguments call, and a test with no identifier operand', () => {
    const rows = [row('==', 'v:a', 'c:5', 'v', 'j', 't'), row('==', 'e', 'c:5', 'v', 'j', 't')];
    assert.deepStrictEqual(run('void f(int a) { h(a == 5, k()); }', rows).sites, []);
    assert.deepStrictEqual(run('struct S { int n; }; int f(S *p) { int b; b = p->n == 5; return b; }', rows).sites, []);
  });

  it('rewrites a store a case label or a lone if arm holds (Q40_Callback11_ScrollMessage 0058e990)', () => {
    const rows = [row('==', 'v:m', 'c:4e23', 'v', 'j'), row('==', 'v:m', 'c:4e2e', 'v', 'j')];
    const { out } = run('void f(int k, int m) { bool b; switch (k) { case 1: b = m == 0x4e23; break; default: return; } if (k == 2) b = m == 0x4e2e; if (!b) return; g(); }', rows);
    assert.ok(out.includes('case 1: b = false; if (m == 0x4e23) b = true; break;'), out);
    assert.ok(out.includes('if (k == 2) { b = false; if (m == 0x4e2e) b = true; }'), out);
  });

  it('leaves two tests the decompiler split off one compare (zlib inflate_table 0042e120)', () => {
    const { sites } = run('int f(unsigned n) { bool a; bool b; a = n < 0x354; b = n == 0x354; if (!a && !b) return 1; return 0; }',
      [row('<', 'v:n', 'c:354', 'v', 'j', '-', '0042e2f0'), row('==', 'v:n', 'c:354', 'v', 'j', '-', '0042e2f0')]);
    assert.deepStrictEqual(sites, []);
    // the JBE's op and the CMP's op, one setter (UNICODE_CompareWideStringsNNoCase 00526610)
    const sameSetter = (op: string, a: string, b: string, pos: string, at: string) =>
      row(op, a, b, pos, 'j', 'r', at).split('\t').map((c, i) => (i === 11 ? '005266a0' : c)).join('\t');
    assert.deepStrictEqual(run('int f(unsigned short a, unsigned short b) { if (a < b) return -1; return b < a; }',
      [sameSetter('<', 'v:a', 'v:b', 'b', '005266a3'), sameSetter('<', 'v:b', 'v:a', 'v', '005266a0')]).sites, []);
  });

  it('leaves a pointer-returning function', () => {
    assert.deepStrictEqual(run('int *f(int a) { return (int *)(a == 5); }', [row('==', 'v:a', 'c:5', 'v', 'j', 't')]).sites, []);
  });

  it('ties a test of a field by the field the newer rows name, and not without them', () => {
    const code = 'struct Q { int nStateFlag; }; int f(Q *q) { bool b; b = q->nStateFlag == 6; return b ? 3 : 4; }';
    const { out, sites } = run(code, [row27('==', 'e', 'c:6', 'v', 'j', 't', { f0: 'nStateFlag' })]);
    assert.deepStrictEqual(sites, ['local']);
    assert.ok(out.includes('b = false; if (q->nStateFlag == 6) b = true;'), out);
    assert.deepStrictEqual(run(code, [row('==', 'e', 'c:6', 'v', 'j', 't')]).sites, []);
    assert.deepStrictEqual(run(code, [row27('==', 'e', 'c:6', 'v', 'j', 't', { f0: 'nOther' })]).sites, []);
  });

  it('leaves a case test of a switch the decompiler joined into a value (SUNITNPC_ResurrectMerc 00579c00)', () => {
    const rows = [row27('==', 'v:n', 'c:c6', 'v', 'j', '-', { om: 'SUB' }), row27('==', 'v:n', 'c:203', 'v', 'j', '-', { om: 'CMP' })];
    const { sites } = run('void f(unsigned n) { bool b; if (n < 0xfc) { b = n == 0xc6; } else { b = n == 0x203; } if (!b) return; g(); }', rows);
    assert.deepStrictEqual(sites, []);
  });

  it('writes only the one arm where the local already holds zero (AI_BAAL_ChooseCombatAction 005e9750)', () => {
    const rows = [row('<', 'c:55', 'v:d', 'v', 'j', 't')];
    const { out } = run('void f(int c) { bool b; int d; b = false; bool e; e = false; if (c) { d = g(); b = 0x55 < d; } if (b) h(); }', rows);
    assert.ok(out.includes('if (c) { d = g(); if (0x55 < d) b = true; }'), out);
    // a label joins other paths in: the zero store stays
    const { out: labelled } = run('void f(int c) { bool b; int d; b = false; L: d = g(); b = 0x55 < d; if (b) goto L; }', rows);
    assert.ok(labelled.includes('d = g(); b = false; if (0x55 < d) b = true;'), labelled);
    // a store of the local in between: the zero store stays
    const { out: stored } = run('void f(int c) { bool b; int d; b = false; d = g(); b = k(c); b = 0x55 < d; if (b) h(); }', rows);
    assert.ok(stored.includes('b = k(c); b = false; if (0x55 < d) b = true;'), stored);
  });

  it('stores a branched-on test to a field or a global through a local', () => {
    const rows = [row('!=', 'v:a', 'c:0', 'v', 'j', 't')];
    const { out, sites } = run('struct S { unsigned f; }; void f(S *s, int a) { s->f = (unsigned)(a != 0); }', rows);
    assert.deepStrictEqual(sites, ['store']);
    assert.ok(out.includes('unsigned int nTest = 0; if (a != 0) nTest = 1; s->f = nTest;'), out);
    const { out: g } = run('extern bool gb; void f(int a) { gb = a != 0; }', rows);
    assert.ok(g.includes('bool bTest = false; if (a != 0) bTest = true; gb = bTest;'), g);
    // a store whose address computation calls is left
    assert.deepStrictEqual(run('struct S { unsigned f; }; void f(int a) { k()->f = (unsigned)(a != 0); }', rows).sites, []);
  });

  it('tests a call argument where its operand was set when the original read it before other calls (DRAW_WORLD_Unit 004dc7b0)', () => {
    const rows = [row27('!=', 'v:x', 'c:0', 'v', 'j', 't', { ic: '1' })];
    const { out, sites } = run('void f() { int x; x = g(); k(); h(1, (unsigned)(x != 0)); }', rows);
    assert.deepStrictEqual(sites, ['arg-hoist']);
    assert.ok(out.includes('x = g(); unsigned int nTest = 0; if (x != 0) nTest = 1; k(); h(1, nTest);'), out);
    // a typedef in the cast names no operand
    const { out: typed } = run('typedef unsigned int uint32_t; void f() { int x; x = g(); k(); h(1, (uint32_t)(x != 0)); }', rows);
    assert.ok(typed.includes('x = g(); uint32_t nTest = 0; if (x != 0) nTest = 1; k(); h(1, nTest);'), typed);
    // no statement of the block sets it: left
    assert.deepStrictEqual(run('void f(int x) { k(); h(1, (unsigned)(x != 0)); }', rows).sites, []);
    // tested next to the call: the local goes right before it
    const { out: near } = run('void f() { int x; x = g(); k(); h(1, (unsigned)(x != 0)); }', [row27('!=', 'v:x', 'c:0', 'v', 'j', 't', { ic: '0' })]);
    assert.ok(near.includes('k(); unsigned int nTest = 0; if (x != 0) nTest = 1; h(1, nTest);'), near);
  });

  it('presets the 1 where the jump is taken when the test holds (MAINMENU_DetectDoubleClick 00431a60)', () => {
    // cmp [ecx+4], 0x201; mov esi, 1; je L; xor esi, esi; L:
    const { out } = run('struct M { unsigned uMsg; }; int f(M *m) { unsigned b = (unsigned)(m->uMsg == 0x201); return g(b); }',
      [rowJ('==', 'e', 'c:201', 'JZ').replace(/\t-\t-\t-\t-\t-$/, '')].map((r) => [...r.split('\t').slice(0, 22), 'CMP', '-', 'uMsg', '-', '-'].join('\t')));
    assert.ok(out.includes('unsigned int b = 1; if (m->uMsg != 0x201) b = 0;'), out);
    // the same jump read with != holds the 0
    const { out: ne } = run('int f(int a) { int b; b = a != 5; return b; }', [rowJ('!=', 'v:a', 'c:5', 'JZ')]);
    assert.ok(ne.includes('b = 0; if (a != 5) b = 1;'), ne);
    const { out: eq } = run('int f(int a) { int b; b = a == 5; return b; }', [rowJ('==', 'v:a', 'c:5', 'JZ')]);
    assert.ok(eq.includes('b = 1; if (a != 5) b = 0;'), eq);
    // an ordered test, or a jump past no single arm, keeps the 0
    const { out: lt } = run('int f(int a) { int b; b = a < 5; return b; }', [rowJ('<', 'v:a', 'c:5', 'JL')]);
    assert.ok(lt.includes('b = 0; if (a < 5) b = 1;'), lt);
  });

  it('stores the 1 straight into a field of a local the code just cleared (NET_D2GS_CLIENT_Send_0x5D 00478740)', () => {
    const code = 'struct P { char id; char on; }; void f(int t) { P s; memset(&s, 0, sizeof(s)); s.on = t != 0; send(&s); }';
    const { out } = run(code, [row('!=', 'v:t', 'c:0', 'v', 'j', 't')]);
    assert.ok(out.includes('memset(&s, 0, sizeof(s)); if (t != 0) s.on = true; send(&s);'), out);
    // a call between: through a local
    const { out: called } = run(code.replace('s.on = t', 'g(); s.on = t'), [row('!=', 'v:t', 'c:0', 'v', 'j', 't')]);
    assert.ok(called.includes('bool bTest = false; if (t != 0) bTest = true; s.on = bTest;'), called);
  });
});
