/**
 * Underscore Storage-Alias Plugin Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { underscoreStorageAliasPlugin } from '../builtins/underscore-storage-alias.js';

describe('underscoreStorageAliasPlugin', () => {
  const transform = (code: string, options: Record<string, unknown> = {}): string =>
    emit(underscoreStorageAliasPlugin.createTransformer({
      globalNames: ['gnLastLevelId'],
      crtFunctionNames: ['memmove', 'isspace'],
      ...options,
    })(parse(code)) as AnyNode).replace(/\s+/g, ' ').trim();

  it('binds `_<global>` to the global it aliases', () => {
    const out = transform(`void f() { use(_gnLastLevelId); }`);
    assert.ok(out.includes('use(gnLastLevelId)'), out);
    assert.ok(!out.includes('_gnLastLevelId'), out);
  });

  it('leaves a name that is not a known global alone', () => {
    const out = transform(`void f() { use(_gnSomethingElse); }`);
    assert.ok(out.includes('_gnSomethingElse'), `an unknown alias must stay loud: ${out}`);
  });

  it('leaves `_<base>` alone when `_<base>` is itself declared', () => {
    // `underscore-slot-local` owns the declared-slot case; this pass must not
    // rename a variable that has a declaration of its own.
    const out = transform(`void f() { int _gnLastLevelId; use(_gnLastLevelId); }`);
    assert.ok(out.includes('int _gnLastLevelId'), out);
    assert.ok(out.includes('use(_gnLastLevelId)'), out);
  });

  it('does not touch a struct FIELD that happens to wear the same spelling', () => {
    const out = transform(`void f(S* p) { use(p->_gnLastLevelId); }`);
    assert.ok(out.includes('p->_gnLastLevelId'), `a member is not a storage alias: ${out}`);
  });

  it('does not touch the same characters inside a string literal', () => {
    // The text pass this replaces ran `body.replace(/\\b_(\\w+)\\b/g, ...)` over
    // the finished body, so it rewrote the contents of string literals too.
    const out = transform(`void f() { log("_gnLastLevelId = %d", _gnLastLevelId); }`);
    assert.ok(out.includes('"_gnLastLevelId = %d"'), `string literal must be untouched: ${out}`);
    assert.ok(/,\s*gnLastLevelId\)/.test(out), `the argument must still be rewritten: ${out}`);
  });

  it('strips MSVC decoration off a CRT call', () => {
    const out = transform(`void f(void* a, void* b) { _memmove(a, b, 4); }`);
    assert.ok(out.includes('memmove(a, b, 4)'), out);
    assert.ok(!out.includes('_memmove'), out);
  });

  it('leaves a decorated call whose base is not a CRT function', () => {
    const out = transform(`void f() { _D2CheckExpansion(); }`);
    assert.ok(out.includes('_D2CheckExpansion()'), out);
  });

  it('leaves a declared `_name` call alone', () => {
    const out = transform(`void f() { CallbackFn _memmove; _memmove(); }`);
    assert.ok(out.includes('_memmove()'), `a declared local shadows the CRT name: ${out}`);
  });

  it('does nothing when it is given neither globals nor CRT names', () => {
    const out = transform(`void f() { use(_gnLastLevelId); }`, { globalNames: [], crtFunctionNames: [] });
    assert.ok(out.includes('_gnLastLevelId'), out);
  });
});
