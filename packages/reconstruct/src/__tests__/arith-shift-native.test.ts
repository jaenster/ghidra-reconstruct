import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse, emit, shiftMultiplyPlugin } from '@ghidra-mcp/cpp-parser';
import type { AnyNode } from '@ghidra-mcp/cpp-parser';
import { compileAndRun, hasNativeGpp } from '../../../cpp-parser/src/testing/native-cpp.js';
import { generatePlatformHeader } from '../codegen/platform-types.js';

const header = generatePlatformHeader();
const support = header.split('\n').filter(line => /^template <class T, class S>.*d2_bits_as\(/.test(line)
  || /^static inline .* d2_shift_left\(/.test(line)).join('\n');

function transformed(name: string, type: string): string {
  const ast = parse(`int ${name}(${type} value) {\nreturn value * 256;\n}`);
  const after = shiftMultiplyPlugin.createTransformer({
    arith: new Map([[2, [{ kind: 'mul', log2: 8, evidence: 'shift' }]]]),
  })(ast);
  // The parser targets the decompiler's explicit types. Let the native test's
  // C++17 compiler deduce the expression type instead of converting it to int.
  return emit(after as AnyNode).replace(/^int /, 'auto ');
}

const types = ['bool', 'char', 'signed char', 'unsigned char', 'short', 'unsigned short', 'int', 'unsigned int',
  'long', 'unsigned long', 'long long', 'unsigned long long', 'int32_t', 'uint32_t', 'int64_t', 'uint64_t',
  'intptr_t', 'uintptr_t', 'wchar_t', 'char16_t', 'char32_t', 'const volatile int&'];
const functions = types.map((type, i) => `auto before${i}(${type} value) { return value * 256; }
${transformed(`after${i}`, type)}
static_assert(std::is_same<decltype(before${i}(std::declval<${type}>())), decltype(after${i}(std::declval<${type}>()))>::value, "promoted result ${i}");
static_assert(std::is_same<decltype(std::declval<${type}>() * 256), decltype(d2_shift_left(std::declval<${type}>(), 8))>::value, "helper result ${i}");`).join('\n');
const onceInput = 'int once(int *count) {\nint d2_shift_left = 0;\nreturn (*count)++ * 256;\n}';
const once = emit(shiftMultiplyPlugin.createTransformer({
  arith: new Map([[3, [{ kind: 'mul', log2: 8, evidence: 'shift' }]]]),
})(parse(onceInput)) as AnyNode);

describe('arithmetic shift support emitted by the platform header', () => {
  it('places the primitive overloads after the representation-copy helper', () => {
    assert.equal((support.match(/static inline .* d2_shift_left\(/g) ?? []).length, 6);
    assert.ok(header.indexOf('static inline int d2_shift_left') > header.indexOf('static inline T d2_bits_as'));
    assert.match(transformed('signedResult', 'int32_t'), /::d2_shift_left\(value, 8\)/);
    assert.match(transformed('unsignedResult', 'uint32_t'), /value << 8/);
    assert.match(once, /::d2_shift_left\(/);
  });

  for (const optimize of [false, true]) {
    it(`preserves defined products, signed comparisons and exact promoted types; optimized=${optimize}`, { skip: !hasNativeGpp() }, () => {
      const prelude = `#include <utility>
#include <type_traits>
#include <limits>
${support}
${functions}
${once}
template<class T> unsigned verifyTypes() {
  typedef decltype(std::declval<T>() * 256) R;
  unsigned checks = 0;
  for (unsigned k = 0; k <= 30; ++k) {
    R factor = (R)1 << k;
    R lo = (R)std::numeric_limits<T>::min(), hi = (R)std::numeric_limits<T>::max();
    if (lo < std::numeric_limits<R>::min() / factor) lo = std::numeric_limits<R>::min() / factor;
    if (hi > std::numeric_limits<R>::max() / factor) hi = std::numeric_limits<R>::max() / factor;
    R values[] = { lo, lo + 1, lo / 2, 0, 1, hi / 2, hi - 1, hi };
    for (unsigned i = 0; i < 8; ++i) {
      T value = (T)values[i];
      R expected = value * (1 << k), actual = d2_shift_left(value, k);
      if (actual != expected || (actual < 0) != (expected < 0) || actual / factor != expected / factor) return 0;
      ++checks;
    }
  }
  return checks;
}`;
      const result = compileAndRun(prelude, `
unsigned checks = 0;
int counter = -1000;
if (once(&counter) != -256000 || counter != -999) return 3;
for (unsigned i = 0; i < 65543; ++i) {
  int32_t value = (int32_t)(((int64_t)i * 65537) % 16777216 - 8388608);
  if (i == 65536) value = -1;
  if (i == 65537) value = -1000;
  if (i == 65538) value = -8388608;
  if (i == 65539) value = 8388607;
  if (i == 65540) value = 0;
  if (i == 65541) value = 1;
  if (i == 65542) value = 1000;
  int32_t expected = before12(value), actual = after12(value);
  if (actual != expected || (actual < 0) != (expected < 0) || actual / 256 != expected / 256) return 1;
  ++checks;
}
${types.slice(0, -1).map(type => `if (verifyTypes<${type}>() != 248) return 2; checks += 248;`).join('\n')}
printf("%u\\n", checks);`, { optimize });
      assert.equal(result.trim(), String(65543 + 248 * (types.length - 1)));
    });
  }
});
