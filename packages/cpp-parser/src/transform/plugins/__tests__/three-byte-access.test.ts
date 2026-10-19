/**
 * A load/store through a pointer to Ghidra's 3-byte integer touches exactly three bytes.
 *
 * Real 1.14d cases: TILECMP_ApplyFunctionToPixels @0060a520 `(uint)*(uint3 *)pPixelData`
 * and SSTR_JenkinsHash @00413f30 `(uint)*(uint3 *)((int)pData + 5) * 0x100`, which
 * type-normalize used to turn into a 4-byte `*(uint32_t *)` read.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { threeByteAccessPlugin } from '../builtins/three-byte-access.js';
import { typeNormalizePlugin } from '../builtins/type-normalize.js';
import { ARTIFACT_SUPPORT_LINES } from '../builtins/artifact-support.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

/** three-byte-access, then type-normalize, in pipeline order. */
function transform(code: string): string {
  let ast = parse(code) as unknown as AnyNode;
  ast = threeByteAccessPlugin.createTransformer({})(ast as never) as unknown as AnyNode;
  ast = typeNormalizePlugin.createTransformer({})(ast as never) as unknown as AnyNode;
  return emit(ast).trim();
}

describe('three-byte-access', () => {
  it('a load through a cast pointer is three bytes at the same address', () => {
    const out = transform('uint f(int pData) { return (uint)*(uint3 *)(pData + 5) * 0x100; }');
    assert.match(out, /d2_load24\(\(uint8_t\*\)\(pData \+ 5\)\)/);
    assert.ok(!/uint32_t\*/.test(out), out);
  });

  it('a load through a parameter declared uint3 *', () => {
    const out = transform('void f(uint3 *pPixelData, void (*cb)(uint)) { (*cb)((uint)*pPixelData); }');
    assert.match(out, /d2_load24\(pPixelData\)/);
  });

  it('int3 is sign-extended', () => {
    const out = transform('int f(byte *p) { return *(int3 *)p; }');
    assert.match(out, /d2_load24s\(\(uint8_t\*\)p\)/);
  });

  it('a store writes three bytes and drops the 3-byte value cast', () => {
    const out = transform('void f(byte *p, uint v) { *(uint3 *)(p + 1) = (uint3)v; }');
    assert.match(out, /d2_store24\(\(uint8_t\*\)\(p \+ 1\), v\)/);
  });

  it('an address-of keeps the dereference', () => {
    const out = transform('void *f(byte *p) { return &*(uint3 *)p; }');
    assert.ok(!out.includes('d2_load24'), out);
  });
});

describe('three-byte-access, compiled and run', { skip: !hasNativeGpp() }, () => {
  const prelude = ['typedef unsigned int uint;', 'typedef uint8_t byte;', ...ARTIFACT_SUPPORT_LINES].join('\n');
  const body = (fn: string) => transform(fn);

  it('SSTR_JenkinsHash shape: the fourth byte does not reach the value', () => {
    const fn = body('uint mix(byte *pData) { return (uint)*(uint3 *)(pData + 5) * 0x100; }');
    const out = compileAndRun(`${prelude}\n${fn}`, [
      'uint8_t b[12] = {0,1,2,3,4, 0x11,0x22,0x33, 0xEE, 9,10,11};',
      'printf("%08x\\n", mix(b));',
    ].join('\n'));
    assert.strictEqual(out.trim(), '33221100');
  });

  it('int3 load and uint3 store', () => {
    const fn = body('int ld(byte *p) { return *(int3 *)p; }\nvoid st(byte *p, uint v) { *(uint3 *)p = (uint3)v; }');
    const out = compileAndRun(`${prelude}\n${fn}`, [
      'uint8_t b[4] = {0xFE, 0xFF, 0xFF, 0x55};',
      'printf("%d ", ld(b));',
      'st(b, 0xAABBCCDDu);',
      'printf("%02x%02x%02x%02x\\n", b[3], b[2], b[1], b[0]);',
    ].join('\n'));
    assert.strictEqual(out.trim(), '-2 55bbccdd');
  });
});
