/**
 * Tests for Branchless Select Plugin
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { branchlessSelectPlugin } from '../builtins/branchless-select.js';

describe('branchlessSelectPlugin', () => {
  function tx(code: string): string {
    const ast = parse(code);
    const transformer = branchlessSelectPlugin.createTransformer({});
    return emit(transformer(ast) as AnyNode).trim();
  }

  it('core: (C) - 1 & M → C ? 0 : M', () => {
    const out = tx(`int f(int n) { return (0x14 < n) - 1 & 0x1f; }`);
    assert.ok(out.includes('0x14 < n ? 0 : 0x1f'), out);
    assert.ok(!out.includes('- 1 &'), out);
  });

  it('offset fold: ((C) - 1 & -21) + 0x14 → C ? 0x14 : -1 (the MONSTER_ValidateSpawnForLevel case)', () => {
    const out = tx(`int f(int n) { return ((0x14 < n) - 1 & -21) + 0x14; }`);
    assert.ok(out.includes('? 0x14 : -1'), out);
    assert.ok(!out.includes('- 1 &'), out);
  });

  it('handles the 1U variant and != comparison', () => {
    const out = tx(`int f(int x) { return ((x != 0xb) - 1U & 6) + 0x6c; }`);
    // 0x6c + 6 = 0x72
    assert.ok(out.includes('? 0x6c : 0x72'), out);
  });

  it('does NOT rewrite a genuine bitmask on a non-boolean', () => {
    const out = tx(`int f(int x) { return (x - 1 & 0x1f); }`);
    assert.ok(out.includes('x - 1 & 0x1f'), out);
    assert.ok(!out.includes('?'), out);
  });
});
