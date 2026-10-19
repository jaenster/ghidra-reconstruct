/**
 * Tests for SUBPIECE Access Transform Plugin
 *
 * Ghidra emits `expr._N_M_` member accesses (read M bytes at byte-offset N).
 * The plugin rewrites them into valid C++ byte-range lvalues:
 *   p->_16_4_  →  *(uint32_t *)((char *)p + 16)
 *   v._4_2_    →  *(uint16_t *)((char *)&v + 4)
 *
 * Spacing below reflects the project's DEFAULT emit style (left pointer
 * alignment, so `uint32_t*` not `uint32_t *`). Trivial identifiers do not get
 * wrapped in parens because ParenExpr is transparent in the emitter.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { subpieceAccessPlugin } from '../builtins/subpiece-access.js';
import { ARTIFACT_SUPPORT_LINES } from '../builtins/artifact-support.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

function transformCode(code: string): string {
  const ast = parse(code);
  const transformer = subpieceAccessPlugin.createTransformer({});
  const result = transformer(ast);
  return emit(result as AnyNode).trim();
}

describe('subpieceAccessPlugin', () => {
  it('rewrites p->_16_4_ → *(uint32_t*)((char*)p + 16) (arrow, pointer)', () => {
    const output = transformCode('void f() { int x = p->_16_4_; }');
    assert.strictEqual(output, 'void f() {\n  int x = *(uint32_t*)((char*)p + 16);\n}');
  });

  it('rewrites v._4_2_ → *(uint16_t*)((char*)&v + 4) (dot, value, uses &)', () => {
    const output = transformCode('void f() { int x = v._4_2_; }');
    assert.strictEqual(output, 'void f() {\n  int x = *(uint16_t*)((char*)&v + 4);\n}');
  });

  it('reads _9_3_ as exactly three bytes', () => {
    const output = transformCode('void f() { int x = p->_9_3_; }');
    assert.strictEqual(output, 'void f() {\n  int x = d2_load24((char*)p + 9);\n}');
  });

  it('stores _1_3_ as exactly three bytes and drops the 3-byte cast', () => {
    const output = transformCode('void f() { v._1_3_ = (undefined3)n; }');
    assert.strictEqual(output, 'void f() {\n  d2_store24((char*)&v + 1, n);\n}');
  });

  it('keeps the lvalue form where a 3-byte piece is incremented', () => {
    const output = transformCode('void f() { v._1_3_++; }');
    assert.strictEqual(output, 'void f() {\n  (*(uint32_t*)((char*)&v + 1))++;\n}');
  });

  it('maps _0_8_ → uint64_t and omits "+ 0" at offset 0', () => {
    const output = transformCode('void f() { int x = p->_0_8_; }');
    assert.strictEqual(output, 'void f() {\n  int x = *(uint64_t*)(char*)p;\n}');
  });

  it('maps _N_1_ → uint8_t', () => {
    const output = transformCode('void f() { int x = p->_3_1_; }');
    assert.strictEqual(output, 'void f() {\n  int x = *(uint8_t*)((char*)p + 3);\n}');
  });

  it('produces an lvalue usable as an assignment target', () => {
    const output = transformCode('void f() { p->_16_4_ = 5; }');
    assert.strictEqual(output, 'void f() {\n  *(uint32_t*)((char*)p + 16) = 5;\n}');
  });

  it('works on the register/XMM subfield form (in_XMM0._0_8_)', () => {
    const output = transformCode('void f() { int x = in_XMM0._0_8_; }');
    assert.strictEqual(output, 'void f() {\n  int x = *(uint64_t*)(char*)&in_XMM0;\n}');
  });

  it('leaves a normal member access untouched', () => {
    const output = transformCode('void f() { int x = p->realField; }');
    assert.strictEqual(output, 'void f() {\n  int x = p->realField;\n}');
  });

  it('leaves unsupported byte-sizes (M=5) unchanged', () => {
    const output = transformCode('void f() { int x = p->_16_5_; }');
    assert.strictEqual(output, 'void f() {\n  int x = p->_16_5_;\n}');
  });
});

describe('subpieceAccessPlugin: 3-byte pieces, compiled and run', { skip: !hasNativeGpp() }, () => {
  // `undefined3` is the platform header's 1-byte typedef; the packet senders store
  // `(undefined3)nMonsterGUID` into `uStack_14._1_3_`.
  const prelude = ['typedef uint8_t undefined3;', ...ARTIFACT_SUPPORT_LINES,
    'struct Frame { uint32_t uStack_14; uint8_t bNext; };'].join('\n');
  const body = (stmt: string) => {
    const out = transformCode(`void f() { ${stmt} }`);
    return out.slice(out.indexOf('{') + 1, out.lastIndexOf('}'));
  };

  it('a _1_3_ store writes bytes 1..3 of the value and leaves the next byte alone', () => {
    const out = compileAndRun(prelude, [
      'Frame s; s.uStack_14 = 0x000000AAu; s.bNext = 0x77; uint32_t n = 0x00332211u;',
      body('s.uStack_14._1_3_ = (undefined3)n;'),
      'printf("%08x %02x\\n", (unsigned)s.uStack_14, (unsigned)s.bNext);',
    ].join('\n'));
    assert.strictEqual(out.trim(), '332211aa 77');
  });

  it('a _0_3_ read sees three bytes only', () => {
    const out = compileAndRun(prelude, [
      'uint32_t v = 0xAABBCCDDu; uint32_t r = 0;',
      body('r = v._0_3_;'),
      'printf("%08x\\n", (unsigned)r);',
    ].join('\n'));
    assert.strictEqual(out.trim(), '00bbccdd');
  });

  it('a _1_3_ compound store is a read-modify-write of the same three bytes', () => {
    const out = compileAndRun(prelude, [
      'Frame s; s.uStack_14 = 0x010203AAu; s.bNext = 0x77;',
      body('s.uStack_14._1_3_ |= 0x100000u;'),
      'printf("%08x %02x\\n", (unsigned)s.uStack_14, (unsigned)s.bNext);',
    ].join('\n'));
    assert.strictEqual(out.trim(), '110203aa 77');
  });
});
