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

describe('branchlessSelectPlugin: enum-typed selects (round 13)', () => {
  const OPTS = {
    enumValues: { SKILL_Kick: 1, QUALITY_SET: 5, QUALITY_RARE: 6, DRAW_LESSTRANSPARENT: 2, DRAW_TRANSPARENT: 1, finish_started: 2, finish_done: 3 },
    enumMemberValues: {
      eD2Skills: { SKILL_Attack: 0, SKILL_Kick: 1 },
      eD2ItemQuality: { QUALITY_MAGIC: 4, QUALITY_SET: 5, QUALITY_RARE: 6, QUALITY_UNIQUE: 7 },
      DRAWMODE: { DRAW_VERYTRANSPARENT: 0, DRAW_TRANSPARENT: 1, DRAW_LESSTRANSPARENT: 2 },
      block_state: { need_more: 0, block_done: 1, finish_started: 2, finish_done: 3 },
      eTwoAtSix: { TWO_A: 5, TWO_B: 6, TWO_C: 6 },
    },
    ambiguousConstants: [] as string[],
  };
  function tx(code: string, o: Record<string, unknown> = OPTS): string {
    return emit(branchlessSelectPlugin.createTransformer(o)(parse(code)) as AnyNode).replace(/\s+/g, ' ').trim();
  }

  it('a 1 Ghidra named after the enum is a 1: clamp to 0 (Missile.cpp:138)', () => {
    const out = tx(`void f(eD2Skills eSkill) { eD2Skills e = eSkill & ((int)eSkill < 1) - SKILL_Kick; use(e); }`);
    assert.match(out, /e = \(int\)eSkill < 1 \? 0 : eSkill;/);
    assert.doesNotMatch(out, /SKILL_Kick/);
  });
  it('the compound form of the clamp (SkillMonst.cpp:1356)', () => {
    const out = tx(`void f(eD2Skills n) { n &= ((int)n < 1) - SKILL_Kick; use(n); }`);
    assert.match(out, /n = \(int\)n < 1 \? 0 : n;/);
  });
  it('a mask with a side effect stays', () => {
    const out = tx(`void f(int n) { int e = g() & (n < 1) - 1; use(e); }`);
    assert.doesNotMatch(out, /\?/);
  });
  it('SETcc + ADD over an enum is a select between two members (GAMBLE 00578790)', () => {
    const out = tx(`void f(int a, int b) { eD2ItemQuality q = (a <= b) + QUALITY_SET; use(q); }`);
    assert.match(out, /q = a <= b \? QUALITY_RARE : QUALITY_SET;/);
  });
  it('K - (C) selects the member below (EscMenu.cpp:967)', () => {
    const out = tx(`void f(int b) { g(DRAW_LESSTRANSPARENT - (b != 0)); }`);
    assert.match(out, /g\(b != 0 \? DRAW_TRANSPARENT : DRAW_LESSTRANSPARENT\)/);
  });
  it('zlib FLUSH_BLOCK: (avail_out != 0) + finish_started', () => {
    const out = tx(`block_state f(int avail_out) { return (avail_out != 0) + finish_started; }`);
    assert.match(out, /return avail_out != 0 \? finish_done : finish_started;/);
  });
  it('declines without exactly one neighbouring member, a non-boolean, or a plain integer', () => {
    assert.doesNotMatch(tx(`void f(int a) { int q = (a < 2) + TWO_A; use(q); }`), /\?/);
    assert.doesNotMatch(tx(`void f(int a) { int q = a + QUALITY_SET; use(q); }`), /\?/);
    assert.doesNotMatch(tx(`void f(int a) { int q = (a < 2) + 5; use(q); }`), /\?/);
    assert.doesNotMatch(tx(`void f(int a) { int q = (a < 2) + QUALITY_UNIQUE; use(q); }`), /\?/);
  });
  it('without the enum tables nothing changes', () => {
    assert.doesNotMatch(tx(`void f(int a, int b) { int q = (a <= b) + QUALITY_SET; use(q); }`, {}), /\?/);
  });
});
