import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createCompareFormTransformer } from '../builtins/compare-form.js';
import { createCompareSignednessTransformer, type CompareSignednessOptions } from '../builtins/compare-signedness.js';
import { compileAndRun, hasNativeGpp, testToolchain } from '../../../testing/native-cpp.js';
import { readFileSync } from 'node:fs';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
function run(code: string, width?: number, options: CompareSignednessOptions = {}): string {
  let ast = parse(code);
  const text = code.includes(' != ') ? '!=' : '==';
  if (width !== undefined) ast = createCompareFormTransformer({
    sites: [{ text, fp: ['e', 'e'], size: width }],
    decisions: [{ ord: 0, text, fp: ['e', 'e'], width, address: '0044ac38', keep: true }],
  })(ast) as typeof ast;
  return flat(emit(createCompareSignednessTransformer(options)(ast) as AnyNode));
}
describe('native narrow equality bit patterns', () => {
  it('casts only the signed operand, in either order', () => {
    assert.equal(run('bool f(int16_t s, uint16_t u) { return s == u; }', 2),
      'bool f(int16_t s, uint16_t u) { return (uint16_t)s == u; }');
    assert.equal(run('bool f(uint8_t u, int8_t s) { return u == s; }', 1),
      'bool f(uint8_t u, int8_t s) { return u == (uint8_t)s; }');
    assert.equal(run('bool f(uint16_t u, int16_t s) { return u != s; }', 2),
      'bool f(uint16_t u, int16_t s) { return u != (uint16_t)s; }');
  });
  it('reads the final field and global types, including aliases', () => {
    const code = 'bool f(Packet *p) { return p->id == sequence; }';
    assert.equal(run(code, 2, { structFields: { Packet: { id: 'SHORT' } },
      globalTypes: { sequence: 'WORD' }, typedefTargets: { SHORT: 'short', WORD: 'unsigned short' } }),
      'bool f(Packet* p) { return (uint16_t)p->id == sequence; }');
  });
  it('retains an explicit signed extension into a native word equality', () => {
    assert.equal(run('bool f(int8_t s, uint16_t u) { return (int16_t)s == u; }', 2),
      'bool f(int8_t s, uint16_t u) { return (uint16_t)(int16_t)s == u; }');
  });
  it('leaves the comparison without a native fact or outside its bit domain', () => {
    for (const [code, width] of [
      ['bool f(int16_t s, uint16_t u) { return s == u; }', undefined],
      ['bool f(int16_t s, uint16_t u) { return s == u; }', 4],
      ['bool f(int16_t s, uint16_t u) { return s == u; }', 1],
      ['bool f(int16_t s, uint8_t u) { return s == u; }', 2],
      ['bool f(int8_t s, uint16_t u) { return s == u; }', 2],
      ['bool f(int32_t s, uint16_t u) { return s == u; }', 2],
      ['bool f(int16_t s, int16_t u) { return s == u; }', 2],
      ['bool f(uint16_t s, uint16_t u) { return s == u; }', 2],
      ['bool f(float s, uint16_t u) { return s == u; }', 2],
      ['bool f(void *s, void *u) { return s == u; }', 2],
      ['bool f(Unknown s, uint16_t u) { return s == u; }', 2],
      ['bool f(int16_t s, uint16_t u) { return s + 1 == u; }', 2],
    ] as const) assert.equal(run(code, width), run(code), code);
  });
  it('does not change an enum through its underlying integer type', () => {
    const code = 'bool f(Mode s, uint16_t u) { return s == u; }';
    assert.equal(run(code, 2, { enumTypes: ['Mode'], typedefTargets: { Mode: 'short' } }), run(code));
  });
  it('is idempotent', () => {
    const once = run('bool f(int16_t s, uint16_t u) { return s == u; }', 2);
    assert.equal(run(once, 2), once);
  });
  it('evaluates each call once with known narrow return types', () => {
    assert.equal(run('bool f() { return nextSigned() == nextUnsigned(); }', 2,
      { functionReturnTypes: { nextSigned: 'int16_t', nextUnsigned: 'uint16_t' } }),
      'bool f() { return (uint16_t)nextSigned() == nextUnsigned(); }');
  });
  it('agrees with native byte/word equality over the value domains', {
    skip: !hasNativeGpp() || (testToolchain()?.name === 'host' && !['ia32', 'x64'].includes(process.arch)),
  }, () => {
    const definitions = [
      ['eq8', 'int8_t s, uint8_t u', 's == u', 1],
      ['ne8', 'uint8_t u, int8_t s', 'u != s', 1],
      ['eq16', 'int16_t s, uint16_t u', 's == u', 2],
      ['ne16', 'uint16_t u, int16_t s', 'u != s', 2],
      ['eqByteWord', 'int8_t s, uint16_t u', '(int16_t)s == u', 2],
      ['oldEq8', 'int8_t s, uint8_t u', 's == u', undefined],
      ['oldEq16', 'int16_t s, uint16_t u', 's == u', undefined],
    ] as const;
    const functions = definitions.map(([name, args, expr, width]) => run(`bool ${name}(${args}) { return ${expr}; }`, width)).join('\n');
    const template = readFileSync(new URL('./fixtures/narrow-equality-native.cpp', import.meta.url), 'utf8');
    const source = template.replace('/*__GENERATED_FUNCTIONS__*/', functions);
    const main = source.indexOf('int main() {');
    const output = compileAndRun(source.slice(0, main), source.slice(main + 'int main() {'.length, source.lastIndexOf('}')), { optimize: true });
    assert.match(output, /checks=1181952 corrected_mismatches=0 baseline_mismatches=32898/);
  });
});
