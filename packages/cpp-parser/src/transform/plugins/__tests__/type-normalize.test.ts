/**
 * Tests for Type Normalization Plugin
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { typeNormalizePlugin, type TypeNormalizeOptions } from '../builtins/type-normalize.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

describe('typeNormalizePlugin', () => {
  function transformCode(code: string, options?: TypeNormalizeOptions): string {
    const ast = parse(code);
    const transformer = typeNormalizePlugin.createTransformer(options);
    const result = transformer(ast);
    return emit(result as AnyNode).trim();
  }

  /** Assert full output equality — catches any accidental mangling */
  function assertTransform(input: string, expected: string, options?: TypeNormalizeOptions): void {
    const output = transformCode(input, options);
    assert.strictEqual(output, expected);
  }

  // ============================================
  // SHORTHAND RENAMES
  // ============================================

  describe('shorthand renames', () => {
    it('should convert uint to uint32_t', () => {
      assertTransform('void foo(uint x) {}', 'void foo(uint32_t x) {}');
    });

    it('should convert ulong to uint32_t', () => {
      assertTransform('void foo(ulong x) {}', 'void foo(uint32_t x) {}');
    });

    it('should convert ushort to uint16_t', () => {
      assertTransform('void foo(ushort x) {}', 'void foo(uint16_t x) {}');
    });

    it('should convert longlong to int64_t', () => {
      assertTransform('void foo(longlong x) {}', 'void foo(int64_t x) {}');
    });

    it('should convert ulonglong to uint64_t', () => {
      assertTransform('void foo(ulonglong x) {}', 'void foo(uint64_t x) {}');
    });

    it('should convert sbyte to int8_t', () => {
      assertTransform('void foo(sbyte x) {}', 'void foo(int8_t x) {}');
    });

    it('should convert word to uint16_t', () => {
      assertTransform('void foo(word x) {}', 'void foo(uint16_t x) {}');
    });

    it('should convert sword to int16_t', () => {
      assertTransform('void foo(sword x) {}', 'void foo(int16_t x) {}');
    });

    it('should convert dword to uint32_t', () => {
      assertTransform('void foo(dword x) {}', 'void foo(uint32_t x) {}');
    });

    it('should convert sdword to int32_t', () => {
      assertTransform('void foo(sdword x) {}', 'void foo(int32_t x) {}');
    });

    it('should convert qword to uint64_t', () => {
      assertTransform('void foo(qword x) {}', 'void foo(uint64_t x) {}');
    });

    it('should convert sqword to int64_t', () => {
      assertTransform('void foo(sqword x) {}', 'void foo(int64_t x) {}');
    });
  });

  // ============================================
  // BYTE PRESERVATION
  // ============================================

  describe('byte preservation', () => {
    it('should keep byte as-is by default', () => {
      assertTransform('void foo(byte x) {}', 'void foo(byte x) {}');
    });

    it('should convert byte to uint8_t when keepByte=false', () => {
      assertTransform('void foo(byte x) {}', 'void foo(uint8_t x) {}', { keepByte: false });
    });
  });

  // ============================================
  // UNDEFINED -> AUTO (initialized locals)
  // ============================================

  describe('undefined to auto (initialized locals)', () => {
    it('should convert undefined4 with initializer to auto', () => {
      assertTransform(
        'void foo() { undefined4 x = 42; }',
        'void foo() {\n  auto x = 42;\n}',
      );
    });

    it('should convert undefined with initializer to auto', () => {
      assertTransform(
        'void foo() { undefined x = 1; }',
        'void foo() {\n  auto x = 1;\n}',
      );
    });

    it('should convert undefined1 with initializer to auto', () => {
      assertTransform(
        'void foo() { undefined1 x = ch; }',
        'void foo() {\n  auto x = ch;\n}',
      );
    });

    it('should convert undefined2 with initializer to auto', () => {
      assertTransform(
        'void foo() { undefined2 x = val; }',
        'void foo() {\n  auto x = val;\n}',
      );
    });

    it('should convert undefined8 with initializer to auto', () => {
      assertTransform(
        'void foo() { undefined8 x = big_val; }',
        'void foo() {\n  auto x = big_val;\n}',
      );
    });

    it('should not auto-promote when undefinedToAuto=false', () => {
      assertTransform(
        'void foo() { undefined4 x = 42; }',
        'void foo() {\n  uint32_t x = 42;\n}',
        { undefinedToAuto: false },
      );
    });
  });

  // ============================================
  // UNDEFINED -> SIZED FALLBACK (uninitialized, params, returns)
  // ============================================

  describe('undefined to sized fallback', () => {
    it('should convert uninitialized undefined4 to uint32_t', () => {
      assertTransform(
        'void foo() { undefined4 x; }',
        'void foo() {\n  uint32_t x;\n}',
      );
    });

    it('should convert undefined in params to uint8_t', () => {
      assertTransform('void foo(undefined x) {}', 'void foo(uint8_t x) {}');
    });

    it('should convert undefined1 in params to uint8_t', () => {
      assertTransform('void foo(undefined1 x) {}', 'void foo(uint8_t x) {}');
    });

    it('should convert undefined2 in params to uint16_t', () => {
      assertTransform('void foo(undefined2 x) {}', 'void foo(uint16_t x) {}');
    });

    it('should convert undefined4 in params to uint32_t', () => {
      assertTransform('void foo(undefined4 x) {}', 'void foo(uint32_t x) {}');
    });

    it('should convert undefined8 in params to uint64_t', () => {
      assertTransform('void foo(undefined8 x) {}', 'void foo(uint64_t x) {}');
    });

    it('should convert undefined4 return type to uint32_t', () => {
      assertTransform(
        'undefined4 foo() { return 0; }',
        'uint32_t foo() {\n  return 0;\n}',
      );
    });

    it('should convert undefined8 return type to uint64_t', () => {
      assertTransform(
        'undefined8 foo() { return 0; }',
        'uint64_t foo() {\n  return 0;\n}',
      );
    });
  });

  // ============================================
  // ODD-SIZED UNDEFINED (kept as-is)
  // ============================================

  describe('odd-sized undefined types', () => {
    it('should keep undefined3 as-is', () => {
      assertTransform('void foo(undefined3 x) {}', 'void foo(undefined3 x) {}');
    });

    it('should keep undefined5 as-is', () => {
      assertTransform('void foo(undefined5 x) {}', 'void foo(undefined5 x) {}');
    });

    it('should keep undefined6 as-is', () => {
      assertTransform('void foo(undefined6 x) {}', 'void foo(undefined6 x) {}');
    });

    it('should keep undefined7 as-is', () => {
      assertTransform('void foo(undefined7 x) {}', 'void foo(undefined7 x) {}');
    });
  });

  // ============================================
  // POINTER-TO-UNDEFINED
  // ============================================

  describe('pointer to undefined types', () => {
    it('should convert undefined4* to uint32_t*', () => {
      assertTransform('void foo(undefined4* x) {}', 'void foo(uint32_t* x) {}');
    });

    it('should convert undefined* to uint8_t*', () => {
      assertTransform('void foo(undefined* x) {}', 'void foo(uint8_t* x) {}');
    });

    it('should convert undefined8* to uint64_t*', () => {
      assertTransform('void foo(undefined8* x) {}', 'void foo(uint64_t* x) {}');
    });
  });

  // ============================================
  // OPTIONS
  // ============================================

  describe('options', () => {
    it('should skip shorthands when normalizeShorthands=false', () => {
      assertTransform('void foo(uint x) {}', 'void foo(uint x) {}', { normalizeShorthands: false });
    });

    it('should still convert undefined types when normalizeShorthands=false', () => {
      assertTransform('void foo(undefined4 x) {}', 'void foo(uint32_t x) {}', { normalizeShorthands: false });
    });
  });

  // ============================================
  // EDGE CASES
  // ============================================

  describe('edge cases', () => {
    it('should not affect standard types', () => {
      assertTransform('void foo(int x, char* y) {}', 'void foo(int x, char* y) {}');
    });

    it('should not affect user-defined types', () => {
      assertTransform('void foo(D2UnitStrc* pUnit) {}', 'void foo(D2UnitStrc* pUnit) {}');
    });

    it('should handle multiple params in one function', () => {
      assertTransform(
        'void foo(uint a, undefined4 b, dword c) {}',
        'void foo(uint32_t a, uint32_t b, uint32_t c) {}',
      );
    });

    it('should handle shorthand in return type', () => {
      assertTransform(
        'uint foo() { return 0; }',
        'uint32_t foo() {\n  return 0;\n}',
      );
    });

    it('should handle shorthand in local variable (non-undefined gets renamed, not auto)', () => {
      assertTransform(
        'void foo() { dword x = 0; }',
        'void foo() {\n  uint32_t x = 0;\n}',
      );
    });

    it('should handle void return type unchanged', () => {
      assertTransform('void foo() {}', 'void foo() {}');
    });

    it('should handle mixed shorthand and standard params', () => {
      assertTransform(
        'void foo(int a, uint b, char c, dword d) {}',
        'void foo(int a, uint32_t b, char c, uint32_t d) {}',
      );
    });

    it('should handle undefined in both return and params', () => {
      assertTransform(
        'undefined4 foo(undefined2 x) {}',
        'uint32_t foo(uint16_t x) {}',
      );
    });
  });

  // ============================================
  // PLUGIN METADATA
  // ============================================

  describe('plugin metadata', () => {
    it('should have correct metadata', () => {
      assert.strictEqual(typeNormalizePlugin.id, 'type-normalize');
      assert.strictEqual(typeNormalizePlugin.name, 'Type Normalization');
      assert.strictEqual(typeNormalizePlugin.defaultEnabled, true);
      assert.strictEqual(typeNormalizePlugin.priority, 15);
      assert.strictEqual(typeNormalizePlugin.version, '1.0.0');
      assert.deepStrictEqual(typeNormalizePlugin.tags, ['core', 'cleanup', 'types']);
    });
  });
});

describe('typeNormalizePlugin: Ghidra float types, compiled and run', () => {
  const lowerExpr = (expr: string, decls = ''): string => {
    const out = emit(typeNormalizePlugin.createTransformer({})(parse(`void f() { ${decls} r = ${expr}; }`)) as AnyNode);
    const at = out.indexOf('r = ');
    return out.slice(at + 4, out.indexOf(';', at));
  };

  it('unkfloat1 is a 1-byte container, and a literal printed through it is its byte', { skip: !hasNativeGpp() }, () => {
    // `(char)(unkfloat1)1.4013e-45` is the byte 1 on the machine; through a float it was 0.
    // `(char)(unkfloat1)bRet` truncates on the machine; through a float it is undefined.
    const out = compileAndRun('', [
      'unsigned bRet = 0x1FF;',
      `int a = (int)(${lowerExpr('(char)(unkfloat1)1.4013e-45')});`,
      `int b = (int)(uint8_t)(${lowerExpr('(char)(unkfloat1)bRet')});`,
      'printf("%d %d\\n", a, b);',
    ].join('\n'));
    assert.strictEqual(out.trim(), '1 255');
    const decl = emit(typeNormalizePlugin.createTransformer({})(parse('void f() { unkfloat1 bVar; }')) as AnyNode);
    assert.ok(decl.includes('uint8_t bVar'), decl);
  });

  it('(bool) of a float constant is settled only where both readings agree', () => {
    assert.strictEqual(lowerExpr('(bool)(unkfloat1)-NAN'), 'true');
    assert.strictEqual(lowerExpr('(bool)(float)1.4013e-45'), 'true');
    assert.strictEqual(lowerExpr('(bool)(float)0.0'), 'false');
    // -0.0: zero value, nonzero bits.
    assert.ok(lowerExpr('(bool)(float)-0.0').includes('0.0'));
  });

  it('a literal whose bits do not fit the byte is left alone', () => {
    assert.ok(lowerExpr('(unkfloat1)3.58732e-43').includes('3.58732e-43'));
  });
});
