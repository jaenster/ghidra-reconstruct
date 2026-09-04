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
