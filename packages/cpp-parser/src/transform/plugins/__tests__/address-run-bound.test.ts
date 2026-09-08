/**
 * Tests for the Address-Run Loop-Bound Plugin
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import {
  addressRunBoundPlugin,
  type AddressRunBoundOptions,
} from '../builtins/address-run-bound.js';

describe('addressRunBoundPlugin', () => {
  function run(code: string, opts: AddressRunBoundOptions): string {
    const ast = parse(code);
    const transformer = addressRunBoundPlugin.createTransformer(opts);
    return emit(transformer(ast) as AnyNode).trim();
  }

  // D2COMP_InitEmblemColorTables, as 1.14d lays it out: two 10-entry RGB
  // tables, each bounded by the label 31 bytes past its own base.
  const EMBLEM: AddressRunBoundOptions = {
    globalAddresses: {
      gbD2CompColorInitR: 0x72e19c,
      gbCompItemEmblemColorTableTemp4: 0x72e1bb,
      gbCompItemEmblemColorTableTemp3: 0x72e1bc,
      gbCompItemEmblemColorTableEnable: 0x72e1db,
    },
  };

  it('respells the bound as a distance from the table being walked', () => {
    const out = run(`
      void f() {
        byte* p = gbD2CompColorInitR + 1;
        do {
          p += 3;
        } while ((int)p < (uintptr_t)&gbCompItemEmblemColorTableTemp4);
      }
    `, EMBLEM);
    assert.ok(
      out.includes('(uintptr_t)&gbD2CompColorInitR + 31'),
      `expected a distance from the walked table, got:\n${out}`,
    );
    assert.ok(!out.includes('gbCompItemEmblemColorTableTemp4'), out);
  });

  it('picks each loop\'s own anchor when one variable walks two tables', () => {
    const out = run(`
      void f() {
        byte* p = gbD2CompColorInitR + 1;
        do {
          p += 3;
        } while ((int)p < (uintptr_t)&gbCompItemEmblemColorTableTemp4);
        p = gbCompItemEmblemColorTableTemp3 + 1;
        do {
          p += 3;
        } while ((int)p < (uintptr_t)&gbCompItemEmblemColorTableEnable);
      }
    `, EMBLEM);
    assert.ok(out.includes('(uintptr_t)&gbD2CompColorInitR + 31'), out);
    assert.ok(out.includes('(uintptr_t)&gbCompItemEmblemColorTableTemp3 + 31'), out);
  });

  it('leaves a bound alone when nothing in the walk names a global below it', () => {
    const out = run(`
      void f(byte* p) {
        while ((int)p < (uintptr_t)&gbCompItemEmblemColorTableTemp4) {
          p += 3;
        }
      }
    `, EMBLEM);
    assert.ok(out.includes('&gbCompItemEmblemColorTableTemp4'), out);
  });

  it('leaves an equality test alone - it is a sentinel, not a bound', () => {
    const out = run(`
      void f() {
        byte* p = gbD2CompColorInitR + 1;
        while ((int)p != (uintptr_t)&gbCompItemEmblemColorTableTemp4) p += 3;
      }
    `, EMBLEM);
    assert.ok(out.includes('&gbCompItemEmblemColorTableTemp4'), out);
  });

  it('declines a distance too wide to be one object', () => {
    const out = run(`
      void f() {
        byte* p = gNear + 1;
        do { p += 3; } while ((int)p < (uintptr_t)&gFar);
      }
    `, { globalAddresses: { gNear: 0x500000, gFar: 0x600000 } });
    assert.ok(out.includes('&gFar'), out);
  });

  it('does nothing without an address table', () => {
    const src = `
      void f() {
        byte* p = gbD2CompColorInitR + 1;
        do { p += 3; } while ((int)p < (uintptr_t)&gbCompItemEmblemColorTableTemp4);
      }
    `;
    assert.ok(run(src, {}).includes('&gbCompItemEmblemColorTableTemp4'));
  });
});

describe('addressRunBoundPlugin - raw address literals', () => {
  function run(code: string, opts: AddressRunBoundOptions): string {
    const ast = parse(code);
    const transformer = addressRunBoundPlugin.createTransformer(opts);
    return emit(transformer(ast) as AnyNode).trim();
  }

  // CMD_RebuildDerivedBindings @004694a0. g_KeyBindingsTable is 114 ten-byte
  // entries at 0x7a6f90, so its last byte is 0x7a7403 - which is exactly what the
  // machine compares. Ghidra had a label at 0x7a6f94 (element 0's wKeyCode, a
  // folded field offset); once that artifact is dropped the bound survives as the
  // bare integer.
  const KEYBIND: AddressRunBoundOptions = {
    globalAddresses: { g_KeyBindingsTable: 0x7a6f90 },
  };

  it('respells a raw address bound as a distance from the walked table', () => {
    const out = run(
      'void f(void) { D2KeyBindStrc *p = g_KeyBindingsTable;'
      + ' do { p++; } while ((int)p <= 0x7a7403); }', KEYBIND);
    assert.match(out, /\(uintptr_t\)&g_KeyBindingsTable \+ 1139/);
    assert.ok(!out.includes('0x7a7403'), `absolute address must be gone, got: ${out}`);
  });

  it('leaves a small constant alone - that is a count, not a location', () => {
    const out = run(
      'void f(void) { D2KeyBindStrc *p = g_KeyBindingsTable;'
      + ' do { p++; } while ((int)p <= 114); }', KEYBIND);
    assert.ok(out.includes('114'), `count must survive, got: ${out}`);
    assert.ok(!out.includes('uintptr_t'), 'must not respell a count');
  });

  it('leaves a literal alone when no global flows into the walker', () => {
    const out = run(
      'void f(void) { D2KeyBindStrc *p = pSomethingElse;'
      + ' do { p++; } while ((int)p <= 0x7a7403); }', KEYBIND);
    assert.ok(out.includes('0x7a7403'), `no anchor, so no rewrite: ${out}`);
  });
});
