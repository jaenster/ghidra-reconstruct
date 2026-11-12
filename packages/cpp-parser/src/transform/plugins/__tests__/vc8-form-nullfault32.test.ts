import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite } from '../builtins/vc8-form.js';

function run(source: string): { output: string; site: Vc8FormSite } {
  let site: Vc8FormSite | undefined;
  const form = parseVc8Form('nullfault32()');
  assert.deepEqual(form, { op: 'nullfault32' });
  const tu = applyVc8Forms(parse(source) as TranslationUnit, [{ form: form!, tag: 'nullfault32()' }], s => { site = s; });
  assert.ok(site);
  return { output: emit(tu as AnyNode), site };
}

describe('vc8-form nullfault32', () => {
  it('rejects arguments and anchors', () => {
    assert.equal(parseVc8Form('nullfault32(x)'), undefined);
    assert.equal(parseVc8Form('nullfault32(@call)'), undefined);
  });

  it('rewrites the sole volatile byte null fault', () => {
    const result = run('void __stdcall CrashGame() { *(volatile uint8_t*)0x0 = 0; }');
    assert.equal(result.site.applied, true);
    assert.match(result.output, /volatile uint32_t\s*\*\s*pNull = 0;/);
    assert.match(result.output, /\*pNull = \(uint32_t\)\(uintptr_t\)pNull;/);
  });

  it('accepts Ghidra’s final bare return and removes it with the fault statement', () => {
    const result = run('void f() { *(volatile uint8_t*)0x0 = 0; return; }');
    assert.equal(result.site.applied, true);
    assert.doesNotMatch(result.output, /return;/);
  });

  for (const [name, source] of [
    ['other address', 'void f() { *(volatile uint8_t*)0x4 = 0; }'],
    ['other width', 'void f() { *(volatile uint32_t*)0 = 0; }'],
    ['nonvolatile', 'void f() { *(uint8_t*)0 = 0; }'],
    ['nonzero value', 'void f() { *(volatile uint8_t*)0 = 1; }'],
    ['side effect in value', 'void f() { *(volatile uint8_t*)0 = g(); }'],
    ['side effect in address', 'void f() { *(volatile uint8_t*)g() = 0; }'],
    ['extra side effect', 'void f() { g(); *(volatile uint8_t*)0 = 0; }'],
    ['parameterized function', 'void f(int x) { *(volatile uint8_t*)0 = 0; }'],
    ['nonvoid function', 'int f() { *(volatile uint8_t*)0 = 0; }'],
  ] as const) {
    it(`refuses ${name}`, () => {
      const result = run(source);
      assert.equal(result.site.applied, false);
      assert.equal(result.output.replace(/\s+/g, ''), emit(parse(source) as AnyNode).replace(/\s+/g, ''));
    });
  }
});
