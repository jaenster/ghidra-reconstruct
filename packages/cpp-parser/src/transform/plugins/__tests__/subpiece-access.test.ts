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

describe('subpieceAccessPlugin: a zero high piece and a value low piece are one dword store', () => {
  // AllocObjectData 004bc720: movzx eax, byte ptr [ebp + 0x14]; mov dword ptr [esi + 0x10], eax.
  it('merges `_1_3_ = 0` and `_0_1_ = v` into a zero-extended dword store', () => {
    const out = transformCode('void f(int n) { u.eMode._1_3_ = 0; u.eMode._0_1_ = n; g(); }');
    assert.strictEqual(out, 'void f(int n) {\n  *(uint32_t*)(char*)&u.eMode = (uint8_t)n;\n  g();\n}');
  });

  it('takes either order, a word value and a non-zero offset', () => {
    const out = transformCode('void f(short n) { p->_6_2_ = n; p->_8_2_ = 0; }');
    assert.strictEqual(out, 'void f(short int n) {\n  *(uint32_t*)((char*)p + 6) = (uint16_t)n;\n}');
  });

  it('leaves pieces that do not tile one dword, a non-zero high piece, or a value reading the object', () => {
    for (const code of [
      'void f(int n) { u._2_2_ = 0; u._0_1_ = n; }',
      'void f(int n) { u._1_3_ = 1; u._0_1_ = n; }',
      'void f(int n) { u._1_3_ = 0; v._0_1_ = n; }',
      'void f() { u._1_3_ = 0; u._0_1_ = u._2_1_; }',
      'void f(int n) { u._1_3_ = 0; g(); u._0_1_ = n; }',
      'void f() { u._0_2_ = 0; u._2_2_ = 0; }',
    ]) {
      assert.ok(!transformCode(code).includes('*(uint32_t*)'), code);
    }
  });

  it('writes what the two pieces wrote', { skip: !hasNativeGpp() }, () => {
    const prelude = [...ARTIFACT_SUPPORT_LINES, 'struct M { uint32_t eMode; uint8_t bNext; };'].join('\n');
    const body = (stmt: string) => {
      const out = transformCode(`void f() { ${stmt} }`);
      return out.slice(out.indexOf('{') + 1, out.lastIndexOf('}'));
    };
    const run = (stmts: string) => compileAndRun(prelude, [
      'M u; u.eMode = 0xAABBCCDDu; u.bNext = 0x77; int n = 0x1234F5;',
      stmts,
      'printf("%08x %02x\\n", (unsigned)u.eMode, (unsigned)u.bNext);',
    ].join('\n')).trim();
    const merged = body('u.eMode._1_3_ = 0; u.eMode._0_1_ = n;');
    assert.ok(merged.includes('(uint8_t)n'), merged);
    assert.strictEqual(run(merged), '000000f5 77');
    assert.strictEqual(run('d2_store24((char*)&u.eMode + 1, 0); *(uint8_t*)((char*)&u.eMode) = (uint8_t)n;'), '000000f5 77');
  });
});
