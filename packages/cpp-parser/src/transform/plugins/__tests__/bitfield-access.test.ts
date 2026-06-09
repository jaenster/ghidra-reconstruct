/**
 * Tests for Bitfield Access Transform Plugin
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { bitfieldAccessPlugin, type BitfieldCatalog } from '../builtins/bitfield-access.js';

function buildCatalog(entries: Array<[string, number, string]>): BitfieldCatalog {
  const catalog = new Map<string, string>();
  for (const [field, mask, name] of entries) {
    catalog.set(`${field}:${mask}`, name);
  }
  return catalog;
}

const D2_MONSTATS_CATALOG = buildCatalog([
  ['field_0xc', 1, 'isSpawn'],
  ['field_0xc', 2, 'isMelee'],
  ['field_0xc', 4, 'noRatio'],
  ['field_0xc', 8, 'openDoors'],
  ['field_0xd', 1, 'npc'],
  ['field_0xd', 2, 'interact'],
  ['field_0xd', 4, 'inTown'],
  ['field_0xd', 8, 'lUndead'],
]);

function transformCode(code: string, catalog: BitfieldCatalog = D2_MONSTATS_CATALOG): string {
  const ast = parse(code);
  const transformer = bitfieldAccessPlugin.createTransformer({ bitfieldCatalog: catalog });
  const result = transformer(ast);
  return emit(result as AnyNode).trim();
}

describe('bitfieldAccessPlugin', () => {
  describe('read test (& mask)', () => {
    it('transforms field_0xd & 2 → interact', () => {
      const input = `void f() { if (pMonStats->field_0xd & 2) {} }`;
      const output = transformCode(input);
      assert.ok(output.includes('pMonStats->interact'), `Expected interact in: ${output}`);
      assert.ok(!output.includes('field_0xd'), `Should not contain field_0xd: ${output}`);
    });

    it('transforms field_0xc & 1 → isSpawn', () => {
      const input = `void f() { if (pMonStats->field_0xc & 1) {} }`;
      const output = transformCode(input);
      assert.ok(output.includes('pMonStats->isSpawn'), `Expected isSpawn in: ${output}`);
    });

    it('transforms field_0xc & 8 → openDoors', () => {
      const input = `void f() { int x = pMonStats->field_0xc & 8; }`;
      const output = transformCode(input);
      assert.ok(output.includes('pMonStats->openDoors'), `Expected openDoors in: ${output}`);
    });

    it('handles mask on left side', () => {
      const input = `void f() { if (2 & pMonStats->field_0xd) {} }`;
      const output = transformCode(input);
      assert.ok(output.includes('pMonStats->interact'), `Expected interact in: ${output}`);
    });

    it('leaves non-power-of-2 masks unchanged', () => {
      const input = `void f() { if (pMonStats->field_0xd & 3) {} }`;
      const output = transformCode(input);
      assert.ok(output.includes('field_0xd'), `Should keep field_0xd for multi-bit mask: ${output}`);
    });

    it('leaves unknown fields unchanged', () => {
      const input = `void f() { if (pMonStats->field_0xff & 2) {} }`;
      const output = transformCode(input);
      assert.ok(output.includes('field_0xff'), `Should keep unknown field: ${output}`);
    });

    it('unwraps (byte) casts on the mask literal', () => {
      const input = `void f() { if (pMonStats->field_0xd & (byte)2) {} }`;
      const output = transformCode(input);
      assert.ok(output.includes('pMonStats->interact'), `Expected interact in: ${output}`);
      assert.ok(!output.includes('field_0xd'), `Should not contain field_0xd: ${output}`);
    });

    it('does not transform non-field members', () => {
      const input = `void f() { if (pMonStats->flags & 2) {} }`;
      const output = transformCode(input);
      assert.ok(output.includes('flags'), `Should keep named member: ${output}`);
    });
  });

  describe('set bit (|= mask)', () => {
    it('transforms field_0xd |= 2 → interact = 1', () => {
      const input = `void f() { pMonStats->field_0xd |= 2; }`;
      const output = transformCode(input);
      assert.ok(output.includes('pMonStats->interact = 1'), `Expected interact = 1 in: ${output}`);
      assert.ok(!output.includes('|='), `Should not contain |=: ${output}`);
    });

    it('transforms field_0xc |= 4 → noRatio = 1', () => {
      const input = `void f() { pMonStats->field_0xc |= 4; }`;
      const output = transformCode(input);
      assert.ok(output.includes('pMonStats->noRatio = 1'), `Expected noRatio = 1 in: ${output}`);
    });

    it('leaves non-power-of-2 |= unchanged', () => {
      const input = `void f() { pMonStats->field_0xd |= 5; }`;
      const output = transformCode(input);
      assert.ok(output.includes('|= 5'), `Should keep multi-bit |=: ${output}`);
    });
  });

  describe('clear bit (&= ~mask)', () => {
    it('transforms field_0xd &= ~2 → interact = 0', () => {
      const input = `void f() { pMonStats->field_0xd &= ~2; }`;
      const output = transformCode(input);
      assert.ok(output.includes('pMonStats->interact = 0'), `Expected interact = 0 in: ${output}`);
      assert.ok(!output.includes('&='), `Should not contain &=: ${output}`);
    });

    it('transforms field_0xc &= ~1 → isSpawn = 0', () => {
      const input = `void f() { pMonStats->field_0xc &= ~1; }`;
      const output = transformCode(input);
      assert.ok(output.includes('pMonStats->isSpawn = 0'), `Expected isSpawn = 0 in: ${output}`);
    });
  });

  describe('no catalog', () => {
    it('does nothing without a catalog', () => {
      const input = `void f() { if (pMonStats->field_0xd & 2) {} }`;
      const output = transformCode(input, new Map());
      assert.ok(output.includes('field_0xd & 2'), `Should be unchanged: ${output}`);
    });
  });

  describe('dot access', () => {
    it('works with dot access too', () => {
      const input = `void f() { if (monStats.field_0xd & 2) {} }`;
      const output = transformCode(input);
      assert.ok(output.includes('monStats.interact'), `Expected dot access: ${output}`);
    });
  });
});
