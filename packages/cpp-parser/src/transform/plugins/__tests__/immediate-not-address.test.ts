/**
 * DecodeCpuModelName (0040e300): `MOV dword ptr [EDI],0x6d5847` @0040e386 stores "GXm\0".
 * The instruction holds the immediate with no reference, nothing is at 006d5847, and the
 * decompiler prints `*(undefined **)pOutName = &UNK_006d5847`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createImmediateNotAddressTransformer } from '../builtins/immediate-not-address.js';

const GXM = [{ value: 0x6d5847, ins: '0040e386' }];
const EXTENTS: Array<[number, number, string]> = [[0x6d5800, 0x6d5810, 'gTable'], [0x6d6000, 0x6d6004, 'DAT_006d6000']];
const dataAt = (v: number) => EXTENTS.find(([a, e]) => v >= a && v < e)?.[2] ?? null;

function run(code: string, constants = GXM, extra: Record<string, unknown> = {}) {
  const rewrites: string[] = [];
  const refusals: string[] = [];
  const out = emit(createImmediateNotAddressTransformer({
    constants, dataAt, globalNames: ['gTable', 'DAT_006d6000'], ...extra,
    onRewrite: (r: { name: string; form: string }) => rewrites.push(`${r.name}: ${r.form}`),
    onRefusal: (r: string) => refusals.push(r),
  })(parse(code)) as AnyNode).trim();
  return { out, rewrites, refusals };
}

describe('immediate-not-address', () => {
  it('a dword store of three characters and a NUL into a char buffer is the literal copy', () => {
    const { out, rewrites } = run(`void f(char *pOutName) { *(undefined **)pOutName = &UNK_006d5847; return; }`);
    assert.match(out, /memcpy\(pOutName, "GXm", 4\);/);
    assert.doesNotMatch(out, /UNK_/);
    assert.deepStrictEqual(rewrites, ['UNK_006d5847: memcpy("GXm", 4)']);
  });

  it('the same store into a buffer that is not char is the integer, at the same width', () => {
    const { out } = run(`void f(int *p) { *(undefined **)p = &UNK_006d5847; }`);
    assert.match(out, /\*\(uint32_t\*\)p = 0x6d5847;/);
  });

  it('bytes that are not a short string are stored as the integer', () => {
    const { out } = run(`void f(char *p) { *(undefined **)p = &DAT_006d0a01; }`, [{ value: 0x6d0a01, ins: '00401000' }]);
    assert.match(out, /\*\(uint32_t\*\)p = 0x6d0a01;/);
  });

  it('elsewhere the constant keeps the expression type', () => {
    const { out } = run(`void f(void) { g(&UNK_006d5847); }`);
    assert.match(out, /g\(\(undefined\*\)0x6d5847\);/);
  });

  it('without the instruction fact nothing changes', () => {
    const { out, rewrites } = run(`void f(char *p) { *(undefined **)p = &UNK_006d5847; }`, []);
    assert.match(out, /&UNK_006d5847/);
    assert.strictEqual(rewrites.length, 0);
  });

  it('without the data table nothing changes', () => {
    const { out } = run(`void f(char *p) { *(undefined **)p = &UNK_006d5847; }`, GXM, { dataAt: undefined });
    assert.match(out, /&UNK_006d5847/);
  });

  it('a name that is not the default label of the fact value is left alone', () => {
    const { out } = run(`void f(char *p) { *(undefined **)p = &UNK_006d5848; *(undefined **)p = &gName; }`);
    assert.match(out, /&UNK_006d5848/);
    assert.match(out, /&gName/);
  });

  it('an address something occupies is refused, and so is a default label Ghidra defines', () => {
    const inTable = run(`void f(char *p) { *(undefined **)p = &UNK_006d5804; }`, [{ value: 0x6d5804, ins: '00401000' }]);
    assert.match(inTable.out, /&UNK_006d5804/);
    assert.match(inTable.refusals[0], /lies in gTable/);
    const named = run(`void f(char *p) { *(undefined **)p = &DAT_006d6000; }`, [{ value: 0x6d6000, ins: '00401000' }]);
    assert.match(named.out, /&DAT_006d6000/);
    assert.match(named.refusals[0], /a global of that name exists/);
  });
});
