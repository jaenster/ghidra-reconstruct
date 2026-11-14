import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createShiftCountMaskTransformer } from '../builtins/shift-count-mask.js';
import { transformGhidraCode } from '../../../ghidra.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const lower = (source: string, macro: boolean, full = false) => {
  const options = {
    countMacro: macro ? 'D2_SHIFT_COUNT' : undefined,
    functionReturnTypes: { next: 'int' },
  };
  return full ? transformGhidraCode(source, {
    preset: 'full', usePluginRegistry: true, tolerateErrors: false,
    pluginOptions: { pluginOptions: { 'shift-count-mask': options } },
  }).code.trim() : emit(createShiftCountMaskTransformer(options)(parse(source)) as AnyNode).trim();
};

const CASES = [
  'uint32_t f(int a, int b) { return (uint32_t)b << ((uint8_t)a + 4 & 31); }',
  'uint32_t f(int a, int b) { return (uint32_t)b >> ((uint8_t)a - 4 & 31); }',
  'uint32_t f(int a, int b) { return (uint32_t)b << ((char)a + (uint8_t)b - 3 & 31); }',
  'uint32_t f(int a, int b) { return (uint32_t)b >> ((uint16_t)a - (int16_t)b & 31); }',
  'uint32_t f(int a, int b) { return (uint32_t)b << ((uint8_t)a - ((uint8_t)b + (uint16_t)a) & 31); }',
  'uint32_t f(int a, int b) { uint32_t v = b; v <<= ((uint8_t)a + 4 & 31); return v; }',
  'uint32_t f(int a, int b) { return (uint32_t)b << ((uint8_t)a + 4U & 31); }',
];

describe('shift-count casts preserve arithmetic and overload selection', () => {
  for (const macro of [false, true]) {
    it(`keeps unknown or overloaded arithmetic operands (${macro ? 'macro' : 'mask'})`, () => {
      const source = 'uint32_t f(int a, Bias b) { return 1u << ((uint8_t)a + b & 31); }';
      assert.match(lower(source, macro), /\(uint8_t\)a \+ b/);
      assert.match(lower('uint32_t f(int a, long long b) { return 1u << ((uint8_t)a + b & 31); }', macro), /\(uint8_t\)a/);
    });

    it(`uses word arithmetic when a removed cast can expose signed overflow (${macro ? 'macro' : 'mask'})`, () => {
      assert.match(lower(CASES[0], macro), /\(uint32_t\)\(?a\b/);
      assert.doesNotMatch(lower(CASES[0], macro), /\(uint8_t\)/);
      assert.match(lower(CASES[1], macro), /\(uint32_t\)\(?a\b/);
      assert.doesNotMatch(lower(CASES[1], macro), /\(uint8_t\)/);
      // Already-unsigned arithmetic needs no additional word cast on a.
      assert.match(lower(CASES[6], macro), /a \+ 4U/);
    });
  }

  it('the complete transform pipeline keeps the count arithmetic unsigned', () => {
    for (const macro of [false, true]) {
      assert.match(lower(CASES[0], macro, true), /\(uint32_t\)\(?a\b/);
      assert.match(lower(CASES[1], macro, true), /\(uint32_t\)\(?a\b/);
    }
  });

  it('preserves values and evaluation counts at word edges without signed overflow', { skip: !hasNativeGpp() }, () => {
    const prelude = ['#define D2_SHIFT_COUNT(n) ((n) & 31)'];
    const functions: string[] = [];
    for (const full of [false, true]) for (const macro of [false, true]) for (const source of CASES) {
      const i = functions.length;
      prelude.push(`namespace ref${i} { ${source} }`, `namespace low${i} { ${lower(source, macro, full)} }`);
      functions.push(`if (ref${i}::f(a, b) != low${i}::f(a, b)) return ${i + 1}; ++cases;`);
    }
    const overload = 'uint32_t f(int a, Bias b) { return 1u << ((uint8_t)a + b & 31); }';
    prelude.push('struct Bias {};',
      'unsigned operator+(uint8_t, Bias) { return 3; }',
      'unsigned operator+(int, Bias) { return 7; }',
      `namespace overloadRef { ${overload} }`,
      `namespace overloadMask { ${lower(overload, false)} }`,
      `namespace overloadMacro { ${lower(overload, true)} }`);
    const effects = 'uint32_t f(int a) { return 1u << ((uint8_t)next(a) + (uint16_t)next(a) & 31); }';
    prelude.push('static int calls;', 'static int next(int a) { ++calls; return a; }',
      `namespace effectsRef { ${effects} }`,
      `namespace effectsMask { ${lower(effects, false)} }`,
      `namespace effectsMacro { ${lower(effects, true)} }`);
    const body = `
      const int V[] = {(-2147483647-1), -2147483647, -65537, -65536, -32769, -32768,
        -257, -256, -129, -128, -33, -32, -1, 0, 1, 7, 15, 31, 32, 33, 127, 128,
        255, 256, 32767, 32768, 65535, 65536, 2147483646, 2147483647};
      unsigned cases = 0;
      for (int a : V) for (int b : V) { ${functions.join('\n')} }
      for (int a : V) {
        if (overloadRef::f(a, Bias{}) != overloadMask::f(a, Bias{}) ||
            overloadRef::f(a, Bias{}) != overloadMacro::f(a, Bias{})) return 50;
        calls = 0; uint32_t ref = effectsRef::f(a); if (calls != 2) return 51;
        calls = 0; if (effectsMask::f(a) != ref || calls != 2) return 52;
        calls = 0; if (effectsMacro::f(a) != ref || calls != 2) return 53;
        cases += 3;
      }
      printf("%u\\n", cases);`;
    // A value-only run on x86 hides overflowing additions because the hardware wraps.
    // Both GCC and Clang implement -ftrapv; neither reference nor candidate may trap.
    assert.equal(compileAndRun(prelude.join('\n'), body, { optimize: true, flags: ['-ftrapv'] }).trim(), '25290');
  });
});
