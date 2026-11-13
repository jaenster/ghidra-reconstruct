import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, ASTNode } from '../../../ast/nodes.js';
import { createTruncatingRoundSiteTransformer, type TruncatingRoundSiteOptions } from '../builtins/truncating-round-site.js';
import { pseudoOpLowerPlugin } from '../builtins/pseudo-op-lower.js';
import { compileAndRun, hasNativeGpp, testToolchain } from '../../../testing/native-cpp.js';
import { readFileSync } from 'node:fs';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
function run(code: string, options: TruncatingRoundSiteOptions = {}): string {
  const rewritten = createTruncatingRoundSiteTransformer(options)(parse(code) as ASTNode);
  return flat(emit(pseudoOpLowerPlugin.createTransformer({})(rewritten) as AnyNode));
}
const fact = { count: 1, sites: [{ ord: 0, width: 4 as const }] };

describe('native-proven truncating ROUND', () => {
  it('preserves the integer cast and evaluates its argument once', () => {
    assert.equal(run('int f() { return (int)ROUND(next()); }', fact),
      'int f() { return (int)next(); }');
    assert.equal(run('char f(double x) { return (char)(int)ROUND(x * 7.0 + 0.5); }', fact),
      'char f(double x) { return (char)(int)(x * 7.0 + 0.5); }');
  });
  it('handles 64-bit FISTP under the matching signed cast', () => {
    const facts = { count: 1, sites: [{ ord: 0, width: 8 as const }] };
    for (const type of ['longlong', 'long long', 'int64_t', '__int64']) {
      const out = run(`int f(double x) { return (int)(${type})ROUND(x); }`, facts);
      assert.doesNotMatch(out, /ROUND|nearbyint/);
      assert.match(out, /\(int\)/);
    }
  });
  it('selects by text order while retaining a genuine current-mode conversion', () => {
    const code = 'void f(double x) { g((int)ROUND(x), (longlong)ROUND(x + 1.5), ROUND(x)); }';
    assert.equal(run(code, { count: 3, sites: [{ ord: 1, width: 8 }] }),
      'void f(double x) { g((int)std::nearbyint(x), (longlong)(x + 1.5), std::nearbyint(x)); }');
  });
  it('retains nearbyint without facts, a matching census or a matching cast width', () => {
    const code = 'int f(double x) { return (int)ROUND(x); }';
    const original = run(code);
    assert.match(original, /nearbyint/);
    for (const facts of [{}, { count: 2, sites: fact.sites }, { count: 1, sites: [] },
      { count: 1, sites: [{ ord: 0, width: 8 as const }] },
      { count: 1, sites: [{ ord: 1, width: 4 as const }] },
      { count: 1, sites: [...fact.sites, ...fact.sites] }]) assert.equal(run(code, facts), original);
  });
  it('refuses floating, unsigned, narrow, pointer and non-immediate cast consumers', () => {
    for (const expr of ['ROUND(x)', '(double)ROUND(x)', '(unsigned int)ROUND(x)',
      '(short)ROUND(x)', '(void*)ROUND(x)', '(int)(ROUND(x) + 1.0)']) {
      const code = `void f(double x) { g(${expr}); }`;
      assert.equal(run(code, fact), run(code), expr);
    }
  });
  it('is idempotent', () => {
    const code = 'int f(double x) { return (int)ROUND(x); }';
    assert.equal(run(run(code, fact), fact), run(code, fact));
  });
  it('agrees with native FISTP in four caller rounding modes', { skip: !hasNativeGpp() }, t => {
    if (testToolchain()?.name === 'host' && !['ia32', 'x64'].includes(process.arch)) {
      t.skip('the native FISTP reference uses x86 inline assembly');
      return;
    }
    const functions = ([['int', 4], ['long long', 8]] as const).flatMap(([type, width]) =>
      [true, false].map(corrected => run(
        `${type} ${corrected ? 'correct' : 'old'}${width * 8}(double x) { return (${type})ROUND(x); }`,
        corrected ? { count: 1, sites: [{ ord: 0, width }] } : {},
      ))).join('\n');
    const template = readFileSync(new URL('./fixtures/truncating-round-native.cpp', import.meta.url), 'utf8');
    const source = template.replace('/*__GENERATED_FUNCTIONS__*/', functions);
    const main = source.indexOf('int main() {');
    const output = compileAndRun(source.slice(0, main), source.slice(main + 'int main() {'.length, source.lastIndexOf('}')), {
      optimize: true, flags: ['-fno-fast-math', '-frounding-math', '-ffp-contract=off'],
    });
    assert.match(output, /cases=524328 corrected_mismatches=0 baseline_mismatches=184334 control_word_changes=0/);
  });
});
