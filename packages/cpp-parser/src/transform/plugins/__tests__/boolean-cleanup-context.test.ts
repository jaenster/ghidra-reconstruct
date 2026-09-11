/**
 * `(x & mask) != 0` is `(x & mask)` only where the result is read for truth.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { booleanCleanupPlugin } from '../builtins/boolean-cleanup.js';

describe('a masked bit test keeps its comparison outside a truth context', () => {
  function transformCode(code: string): string {
    const ast = parse(code);
    const result = booleanCleanupPlugin.createTransformer()(ast);
    return emit(result as AnyNode).trim();
  }

  // The AND is not 0-or-1. BitMaskAnd[8] & w is 0x100, whose truth is 1 and whose
  // low byte is 0 - which is how CODEC_BuildInversePaletteFromBitmask came to mark
  // 24 of every 32 palette entries unused and every sprite failed to decode.
  it('keeps != 0 where the result is STORED into a narrow slot', () => {
    const out = transformCode(`void f(uint *t) { char a[4]; a[0] = (t[0] & t[1]) != 0; }`);
    assert.ok(out.includes('!= 0'), `dropped the normalisation: ${out}`);
  });

  it('keeps != 0 where the result is RETURNED', () => {
    const out = transformCode(`int f(uint *t) { return (t[0] & t[1]) != 0; }`);
    assert.ok(out.includes('!= 0'), out);
  });

  it('keeps != 0 where the result is an ARGUMENT', () => {
    const out = transformCode(`void f(uint *t) { g((t[0] & t[1]) != 0); }`);
    assert.ok(out.includes('!= 0'), out);
  });

  it('still drops != 0 in an if condition', () => {
    const out = transformCode(`void f(uint *t) { if ((t[0] & t[1]) != 0) { g(); } }`);
    assert.ok(!out.includes('!= 0'), `missed the identity case: ${out}`);
  });

  it('still drops != 0 in a while condition, and under && and !', () => {
    assert.ok(!transformCode(`void f(uint *t) { while ((t[0] & t[1]) != 0) { g(); } }`).includes('!= 0'));
    assert.ok(!transformCode(`void f(uint *t) { if (x && (t[0] & t[1]) != 0) { g(); } }`).includes('!= 0'));
    assert.ok(!transformCode(`void f(uint *t) { if (!((t[0] & t[1]) != 0)) { g(); } }`).includes('!= 0'));
  });

  it('== 0 still negates anywhere: !(x & m) is 0-or-1 just as the comparison was', () => {
    const out = transformCode(`void f(uint *t) { char a[4]; a[0] = (t[0] & t[1]) == 0; }`);
    assert.ok(out.includes('!'), out);
  });
});
