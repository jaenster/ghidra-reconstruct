/**
 * `extraout_var` is Ghidra's name for the bytes of EAX a byte-returning callee
 * never defined. The corpus declares it 148 times and assigns it 0 times, so
 * all 482 uses read an uninitialised stack word. These pin that the splice is
 * dropped down to the byte it carries, and that nothing else is.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { extraoutSplicePlugin } from '../builtins/extraout-splice.js';

function run(src: string): string {
  const t = extraoutSplicePlugin.createTransformer();
  return emit(t(parse(src)) as AnyNode).replace(/\s+/g, ' ').trim();
}

describe('extraout-splice', () => {
  it('drops the undefined upper bytes from a value', () => {
    const out = run(
      'void f() { undefined3 extraout_var; uint32_t v ='
      + ' (uint32_t)extraout_var << 8 | (uint32_t)bGemApplyType & 0xffu; }');
    assert.ok(!out.includes('extraout_var <<'), out);
    assert.ok(out.includes('bGemApplyType'), out);
  });

  /**
   * The condition case is the dangerous one: with the splice present the test
   * is true whenever the garbage is non-zero, whatever the byte holds.
   */
  it('drops it from a condition, so the branch follows the byte again', () => {
    const out = run(
      'void f() { undefined3 extraout_var;'
      + ' if ((uint32_t)extraout_var << 8 | (uint32_t)bVar1 & 0xffu) { g(); } }');
    // The declaration may remain (harmless, unused); the SPLICE must not.
    assert.ok(!out.includes('extraout_var <<'), out);
    assert.ok(out.includes('bVar1'), out);
  });

  it('works whichever side of the OR the splice is on', () => {
    const out = run(
      'void f() { undefined3 extraout_var; uint32_t v ='
      + ' (uint32_t)b & 0xffu | (uint32_t)extraout_var << 8; }');
    assert.ok(!out.includes('extraout_var <<'), out);
    assert.ok(out.includes('b'), out);
  });

  it('leaves an extraout the body actually assigns alone', () => {
    const out = run(
      'void f() { undefined3 extraout_var; extraout_var = h();'
      + ' uint32_t v = (uint32_t)extraout_var << 8 | (uint32_t)b & 0xffu; }');
    assert.ok(out.includes('extraout_var <<'), out);
  });

  it('leaves an ordinary shift-or alone', () => {
    const out = run('void f(uint32_t hi, uint32_t lo) { uint32_t v = hi << 8 | lo & 0xffu; }');
    assert.ok(out.includes('hi << 8'), out);
  });

  it('does not touch a bare extraout that is not spliced into a word', () => {
    const out = run('void f() { undefined3 extraout_var; g(extraout_var); }');
    assert.ok(out.includes('extraout_var'), out);
  });
});

/**
 * The synthetic name is only a hint - these get renamed in the database.
 * `D2Net/SRC/Client.cpp` carried a hand fix for one called `dwTmp`, whose
 * splice decided whether the single-player handshake ran at all: taken the
 * wrong way it started the multiplayer connect thread instead and packet 0xAF
 * never arrived. The real test is the shape.
 */
describe('extraout-splice: judged by shape, not by name', () => {
  const run2 = (src: string): string => {
    const t = extraoutSplicePlugin.createTransformer();
    return emit(t(parse(src)) as AnyNode).replace(/\s+/g, ' ').trim();
  };

  it('drops a renamed splice variable the body never assigns', () => {
    const out = run2(
      'void f() { undefined3 dwTmp;'
      + ' if ((uint32_t)dwTmp << 8 | (uint32_t)bIsSinglePlayer & 0xffu) { g(); } }');
    assert.ok(!out.includes('dwTmp <<'), out);
    assert.ok(out.includes('bIsSinglePlayer'), out);
  });

  it('keeps one the body assigns', () => {
    const out = run2(
      'void f() { undefined3 dwTmp; dwTmp = h();'
      + ' if ((uint32_t)dwTmp << 8 | (uint32_t)b & 0xffu) { g(); } }');
    assert.ok(out.includes('dwTmp <<'), out);
  });

  it('keeps one whose address escapes', () => {
    const out = run2(
      'void f() { undefined3 dwTmp; h(&dwTmp);'
      + ' if ((uint32_t)dwTmp << 8 | (uint32_t)b & 0xffu) { g(); } }');
    assert.ok(out.includes('dwTmp <<'), out);
  });

  it('keeps a name the function does not declare at all', () => {
    const out = run2('void f(uint32_t hi, uint32_t lo) { if (hi << 8 | lo & 0xffu) { g(); } }');
    assert.ok(out.includes('hi << 8'), out);
  });
});
