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

  it('rewrites _9_3_ to a 4-byte uint32_t access (3-byte over-read accepted)', () => {
    const output = transformCode('void f() { int x = p->_9_3_; }');
    assert.strictEqual(output, 'void f() {\n  int x = *(uint32_t*)((char*)p + 9);\n}');
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
