import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { compareValueFormPlugin } from '../builtins/compare-value-form.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(code: string, rows: string[]): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = compareValueFormPlugin.createTransformer({
    compareSites: rows.join('\n'),
    onSite: (e: { kind: string }) => sites.push(e.kind),
  } as never);
  return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
}

let nextAt = 0x400000;
/** A compare-sites row of the newer script: operator, opcode, prints, op address, pos/use, set zeroing, fields. */
const row = (op: string, fp0: string, fp1: string, pos: string, use: string,
  more: { opcode?: string; at?: string; sz?: string; f0?: string; f1?: string } = {}) =>
  ['0', op, more.opcode ?? (op === '!=' ? 'INT_NOTEQUAL' : 'INT_EQUAL'), '4', '1', '0', fp0, fp1,
    more.at ?? (nextAt += 4).toString(16).padStart(8, '0'), '-', '-', '-', '-', '0', '-', '-', '-', '0', pos, use, '-', '0',
    'CMP', more.sz ?? '-', more.f0 ?? '-', more.f1 ?? '-', '-'].join('\t');

describe('compare-value-form', () => {
  // SStrToInt 00413ac0: xor eax, eax; cmp byte ptr [edx], 0x2d; sete al; mov esi, eax; ... test esi, esi
  const STRTOINT = 'int f(char *p) { char c; int n; c = *p; if (c == 0x2d) p++; n = g(p); if (c == 0x2d) n = -n; return n; }';
  const shared = (sz: string) => [
    row('==', 'v:c', 'c:2d', 'b', 's', { at: '00413add', sz }),
    row('==', 'v:c', 'c:2d', 'b', 's', { at: '00413add', sz }),
  ];

  it('holds one compare printed as two tests in an int local (SStrToInt 00413ac0)', () => {
    const { out, sites } = run(STRTOINT, shared('1'));
    assert.deepStrictEqual(sites, ['shared-test']);
    assert.ok(out.includes('c = *p; int nTest = c == 0x2d; if (nTest) p++; n = g(p); if (nTest) n = -n;'), out);
  });

  it('computes the value right after the statement that set its operand (GetCurrentItemOnBodyLocation 0063e490)', () => {
    const code = 'int f(int u, int k) { int h = g(u); if (!k) return 0; int *q = r(); if (k == 4) { if (h == 2) return 1; } else if (k == 5 && h == 2) return 2; return 0; }';
    const rows = [row('==', 'v:h', 'c:2', 'b', 's', { at: '0063e4b7', sz: '1' }), row('==', 'v:h', 'c:2', 'b', 's', { at: '0063e4b7', sz: '1' })];
    const { out } = run(code, rows);
    assert.ok(out.includes('int h = g(u); int nTest = h == 2; if (!k) return 0; int* q = r(); if (k == 4) { if (nTest) return 1; } else if (k == 5 && nTest) return 2;'), out);
  });

  it('uses a bool where the SETcc register was not zeroed, and negates a test printed the other way', () => {
    const { out } = run('int f(char c, int n) { if (c == 0x2d) n++; if (c != 0x2d) n--; return n; }',
      shared('0'));
    assert.ok(out.includes('bool bTest = c == 0x2d; if (bTest) n++; if (!bTest) n--;'), out);
  });

  it('leaves the tests when an operand changes between them, a label sits between, or a third test fits', () => {
    assert.deepStrictEqual(run('int f(char *p) { char c; c = *p; if (c == 0x2d) p++; c = *p; if (c == 0x2d) return 1; return 0; }', shared('1')).sites, []);
    assert.deepStrictEqual(run('int f(char c, int n) { if (c == 0x2d) n++; L: if (c == 0x2d) goto L; return n; }', shared('1')).sites, []);
    assert.deepStrictEqual(run('int f(char c, int n) { if (c == 0x2d) n++; if (c == 0x2d) n--; if (c == 0x2d) n--; return n; }', shared('1')).sites, []);
    // the rows of separate compares are no shared value
    assert.deepStrictEqual(run(STRTOINT, [row('==', 'v:c', 'c:2d', 'b', 's', { sz: '1' }), row('==', 'v:c', 'c:2d', 'b', 's', { sz: '1' })]).sites, []);
    // nor are compares the original branched on
    assert.deepStrictEqual(run(STRTOINT, [row('==', 'v:c', 'c:2d', 'b', 'j', { at: '00413add' }), row('==', 'v:c', 'c:2d', 'b', 'j', { at: '00413add' })]).sites, []);
  });

  it('writes a mask the original computed with SBB as a select (SFILE_EnumFilesInternal 00419180)', () => {
    const rows = [row('!=', 'v:s', 'c:0', 'v', 'c'), row('!=', 'e', 'c:0', 'v', 'c')];
    const { out, sites } = run('int f(char *s, unsigned m) { if (!(m & -(unsigned)(s != 0) & -(unsigned)(*s != 0))) return 0; return 1; }', rows);
    assert.deepStrictEqual(sites, ['mask', 'mask']);
    assert.ok(out.includes('(m & (s != 0 ? (unsigned int)-1 : 0) & (*s != 0 ? (unsigned int)-1 : 0))'), out);
    // SETcc rows: the negation is the original's form
    assert.deepStrictEqual(run('int f(char *s, unsigned m) { return m & -(unsigned)(s != 0); }', [row('!=', 'v:s', 'c:0', 'v', 's')]).sites, []);
  });

  it('writes masks the decompiler folded into a test of && as their AND (SBmpDecodeImage 006c6a80)', () => {
    const rows = [row('!=', 'v:d', 'c:0', 'v', 'c'), row('!=', 'v:n', 'c:0', 'v', 'c')];
    const { out, sites } = run('int f(int *d, unsigned *n, unsigned s, unsigned m) { if (!(d && n ? m : 0)) return 0; return 1; }', rows);
    assert.deepStrictEqual(sites, ['mask-and']);
    assert.ok(out.includes('if (!((d != 0 ? (int)-1 : 0) & (n != 0 ? (int)-1 : 0) & m)) return 0;'), out);
    // a leaf the original branched on keeps the short circuit
    assert.deepStrictEqual(run('int f(int *d, unsigned *n, unsigned s) { if (!(d && n ? (*n < s) - 1 : 0)) return 0; return 1; }',
      [row('!=', 'v:d', 'c:0', 'v', 'c'), row('!=', 'v:n', 'c:0', 'v', 'j')]).sites, []);
    // the selected value reads through a tested pointer: one expression would drop that test
    assert.deepStrictEqual(run('int f(int *d, unsigned *n, unsigned s) { if (!(d && n ? (*n < s) - 1 : 0)) return 0; return 1; }', rows).sites, []);
    // a call in the selected value is left
    assert.deepStrictEqual(run('int f(int *d, unsigned *n) { if (!(d && n ? g() - 1 : 0)) return 0; return 1; }', rows).sites, []);
  });
});
