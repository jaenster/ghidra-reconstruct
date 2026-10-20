/**
 * ZLIB_InflateTable (0042e120): `base = lbase; base -= 257;` is MOV EAX,0x6d38a8; SUB EAX,0x202,
 * which the decompiler folds into 0x6d36a6 and names by the object containing it,
 * gdwCrc32Table5 + 0x2de. The instruction's DATA reference says it is lbase - 257.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createFoldedAddressRebaseTransformer, type FoldedAddress } from '../builtins/folded-address-rebase.js';

const TABLES = {
  globalAddresses: { gdwCrc32Table5: 0x6d33c8, nZlibInflateTable_MaxCodes: 0x6d38a8, nZlibInflateTable_MaxCodeWords: 0x6d38e8, gScalar: 0x6d4000, gNs: 0x6d5000 },
  globalSizes: { gdwCrc32Table5: 1024, nZlibInflateTable_MaxCodes: 62, nZlibInflateTable_MaxCodeWords: 62, gScalar: 4, gNs: 16 },
  globalElementSizes: { gdwCrc32Table5: 4, nZlibInflateTable_MaxCodes: 2, nZlibInflateTable_MaxCodeWords: 2, gNs: 4 },
  globalNamespaces: { gNs: ['Storm', 'Zlib'] },
};
const ZLIB: FoldedAddress[] = [
  { value: 0x6d36a6, base: 0x6d38a8, ins: '0042e2e8' },
  { value: 0x6d36e6, base: 0x6d38e8, ins: '0042e2f5' },
];

function run(code: string, rebases: FoldedAddress[], extra: Record<string, unknown> = {}) {
  const refusals: string[] = [];
  const rewrites: string[] = [];
  const out = emit(createFoldedAddressRebaseTransformer({
    ...TABLES, rebases, ...extra,
    onRefusal: (r: string) => refusals.push(r),
    onRewrite: (r: { from: string; to: string }) => rewrites.push(`${r.from} -> ${r.to}`),
  })(parse(code)) as AnyNode).trim();
  return { out, refusals, rewrites };
}

describe('folded-address-rebase', () => {
  it('respells the two LENS bases against lbase/lext, in elements', () => {
    const { out, rewrites } = run(`void f(ushort **pb, ushort **pe) {
      *pb = (ushort *)((int)gdwCrc32Table5 + 0x2de);
      *pe = (ushort *)((int)gdwCrc32Table5 + 0x31e); }`, ZLIB);
    assert.match(out, /\*pb = \(ushort ?\*\)\(nZlibInflateTable_MaxCodes - 257\);/, out);
    assert.match(out, /\*pe = \(ushort ?\*\)\(nZlibInflateTable_MaxCodeWords - 257\);/, out);
    assert.ok(!out.includes('gdwCrc32Table5'), out);
    assert.strictEqual(rewrites.length, 2);
  });

  it('is the same address in the image: X - n*sizeof(T) == Y + k', () => {
    assert.strictEqual(0x6d38a8 - 257 * 2, 0x6d33c8 + 0x2de);
    assert.strictEqual(0x6d38e8 - 257 * 2, 0x6d33c8 + 0x31e);
  });

  it('reads the lengths the reference zlib reads (inftrees.c lbase) for every length symbol', () => {
    // The image: gdwCrc32Table5 (1024 bytes) ... lbase at +0x4e0. Folded and rebased spellings
    // index one flat image identically; only the rebased one survives the objects moving apart.
    const lbase = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258, 0, 0];
    const image = new Uint16Array((0x6d38a8 + 62 - 0x6d33c8) / 2);
    image.set(lbase, (0x6d38a8 - 0x6d33c8) / 2);
    for (let sym = 257; sym < 286; sym++) {
      const folded = image[(0x2de + 2 * sym) / 2];          // ((int)gdwCrc32Table5 + 0x2de)[sym]
      const rebased = lbase[sym - 257];                     // (lbase - 257)[sym]
      assert.strictEqual(rebased, folded, `sym ${sym}`);
    }
  });

  it('a literal, a decayed array and &Y spellings of the same address are rebased too', () => {
    for (const src of [
      'void f(ushort **p) { *p = (ushort *)0x6d36a6; }',
      'void f(ushort **p) { *p = (ushort *)((char *)&gdwCrc32Table5 + 0x2de); }',
      'void f(ushort **p) { *p = (ushort *)((uint)&gdwCrc32Table5 + 0x2de); }',
      'void f(ushort **p) { *p = (ushort *)((int)(gdwCrc32Table5 + 0xb8) - 2); }',
    ]) {
      const { out } = run(src, ZLIB);
      assert.match(out, /nZlibInflateTable_MaxCodes - 257/, `${src}\n${out}`);
    }
  });

  it('a distance that is not whole elements is spelled in bytes', () => {
    const { out } = run('void f(int **p) { *p = (int *)((int)gdwCrc32Table5 + 0x2df); }', [{ value: 0x6d36a7, base: 0x6d38a8 }]);
    assert.match(out, /\(int ?\*\)\(\(char ?\*\)nZlibInflateTable_MaxCodes - 513\)/, out);
  });

  it('qualifies X with its namespace', () => {
    const { out } = run('void f(int **p) { *p = (int *)((int)gdwCrc32Table5 + 0x10); }', [{ value: 0x6d33d8, base: 0x6d5000 }]);
    assert.match(out, /\(int ?\*\)\(Storm::Zlib::gNs - \d+\)/, out);
  });

  it('leaves alone: X already named, no derived value, a non-pointer cast, an unknown base', () => {
    for (const [src, rebases] of [
      ['void f(ushort **p) { *p = (ushort *)(nZlibInflateTable_MaxCodes - 0x101); }', ZLIB],
      ['void f(ushort **p) { *p = (ushort *)((int)gdwCrc32Table5 + 0x2de); }', []],
      ['void f(ushort **p) { *p = (ushort *)((int)gdwCrc32Table5 + 0x2e0); }', ZLIB],
      ['int f() { return (int)((int)gdwCrc32Table5 + 0x2de); }', ZLIB],
      ['void f(ushort **p) { *p = (ushort *)((int)gdwCrc32Table5 + 0x2de); }', [{ value: 0x6d36a6, base: 0x6d0000 }]],
    ] as Array<[string, FoldedAddress[]]>) {
      const { out } = run(src, rebases);
      assert.strictEqual(out, emit(parse(src) as AnyNode).trim(), src);
    }
  });

  it('two bases for one value are refused', () => {
    const { out, refusals } = run('void f(ushort **p) { *p = (ushort *)((int)gdwCrc32Table5 + 0x2de); }',
      [ZLIB[0], { value: 0x6d36a6, base: 0x6d38e8 }]);
    assert.ok(out.includes('gdwCrc32Table5'), out);
    assert.ok(refusals.some(r => r.includes('two bases')), refusals.join('\n'));
  });

  it('a cross-object value the body never spells as a pointer-cast address is reported', () => {
    const { refusals } = run('void f(ushort **p) { *p = 0; }', ZLIB);
    assert.strictEqual(refusals.length, 2, refusals.join('\n'));
  });
});
