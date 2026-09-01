/**
 * Tests for Global Address Literal Resolution Plugin
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import {
  globalAddressLiteralPlugin,
  type GlobalAddressLiteralOptions,
} from '../builtins/global-address-literal.js';

describe('globalAddressLiteralPlugin', () => {
  function run(code: string, opts: GlobalAddressLiteralOptions): string {
    const ast = parse(code);
    const transformer = globalAddressLiteralPlugin.createTransformer(opts);
    return emit(transformer(ast) as AnyNode).trim();
  }

  // The Storm async-request queue anchors, as 1.14d lays them out: four
  // 12-byte list heads, back to back.
  const STORM: GlobalAddressLiteralOptions = {
    globalAddresses: {
      gSFileAsyncReqFreeList: 0x708354,
      gSFileAsyncReqQueue: 0x708360,
      gSFileAsyncReqActive: 0x70836c,
      gSFileAsyncReqDone: 0x708378,
    },
    globalSizes: {
      gSFileAsyncReqFreeList: 12,
      gSFileAsyncReqQueue: 12,
      gSFileAsyncReqActive: 12,
      gSFileAsyncReqDone: 12,
    },
  };

  const SIMPLE: GlobalAddressLiteralOptions = {
    globalAddresses: { gThing: 0x500100, gOther: 0x600200 },
    globalSizes: { gThing: 12, gOther: 4 },
  };

  describe('the real StaticInit case', () => {
    it('resolves -7373669 to the interior of gSFileAsyncReqQueue', () => {
      const out = run(`void f() { x = (void*)-7373669; }`, STORM);
      assert.ok(
        out.includes('~(uintptr_t)((char*)&gSFileAsyncReqQueue + 4)'),
        `Expected the anchored complement in: ${out}`,
      );
      assert.ok(!out.includes('7373669'), `Literal should be gone from: ${out}`);
    });

    it('resolves all four list anchors to base+4 of their own global', () => {
      const cases: [string, string][] = [
        ['-7373657', 'gSFileAsyncReqFreeList'],
        ['-7373669', 'gSFileAsyncReqQueue'],
        ['-7373681', 'gSFileAsyncReqActive'],
        ['-7373693', 'gSFileAsyncReqDone'],
      ];
      for (const [literal, name] of cases) {
        const out = run(`void f() { x = (void*)${literal}; }`, STORM);
        assert.ok(
          out.includes(`~(uintptr_t)((char*)&${name} + 4)`),
          `${literal} should anchor to ${name} + 4, got: ${out}`,
        );
      }
    });

    it('resolves the same value written as an unsigned hex literal', () => {
      const out = run(`void f() { x = (void*)0xff8f7c9b; }`, STORM);
      assert.ok(
        out.includes('~(uintptr_t)((char*)&gSFileAsyncReqQueue + 4)'),
        `Expected the anchored complement in: ${out}`,
      );
    });
  });

  describe('direct address matches', () => {
    it('replaces a literal equal to a global address with its address-of', () => {
      const out = run(`void f() { p = 0x500100; }`, SIMPLE);
      assert.ok(out.includes('&gThing'), `Expected &gThing in: ${out}`);
      assert.ok(!out.includes('0x500100'), `Literal should be gone from: ${out}`);
    });

    it('replaces an interior literal with a byte-anchored offset', () => {
      const out = run(`void f() { p = 0x500108; }`, SIMPLE);
      // The emitter drops a paren its precedence analysis proves redundant; it
      // keeps it wherever it is load-bearing (see the complement cases above).
      assert.ok(out.includes('(char*)&gThing + 8'), `Expected gThing + 8 in: ${out}`);
    });

    it('anchors a complement of an exact base without an offset', () => {
      // ~0x500100 == 0xffaffeff
      const out = run(`void f() { p = (void*)0xffaffeff; }`, SIMPLE);
      assert.ok(out.includes('~(uintptr_t)&gThing'), `Expected ~(uintptr_t)&gThing in: ${out}`);
      assert.ok(!out.includes('char*'), `An exact base needs no byte cast: ${out}`);
    });
  });

  describe('false positives that must not be rewritten', () => {
    it('leaves a literal that matches no global alone', () => {
      const out = run(`void f() { p = 0x401000; }`, SIMPLE);
      assert.ok(out.includes('0x401000'), `Should keep the literal in: ${out}`);
      assert.ok(!out.includes('gThing'), `Should not invent a symbol in: ${out}`);
    });

    it('leaves -1 alone', () => {
      const out = run(`void f() { p = -1; }`, SIMPLE);
      assert.ok(out.includes('-1'), `Should keep -1 in: ${out}`);
      assert.ok(!out.includes('&g'), `Should not resolve -1 in: ${out}`);
    });

    it('leaves a small negative alone even when its complement matches', () => {
      // A global placed at 0 would make ~(-1) == 0 a "hit"; the high-bit guard
      // is what stops that, so keep an explicit low-value global here.
      const lowGlobals: GlobalAddressLiteralOptions = {
        globalAddresses: { gLow: 0x14 },
        globalSizes: { gLow: 4 },
      };
      // ~0x14 == 0xffffffeb == -21, which HAS the high bit set, so it resolves.
      // The clear-high-bit twin is 0x14 itself, whose complement is 0xffffffeb
      // — a value with the high bit clear must never take the complement path.
      const out = run(`void f() { n = 0x00000014; }`, {
        globalAddresses: { gComplementOf14: 0xffffffeb },
        globalSizes: { gComplementOf14: 4 },
      });
      assert.ok(!out.includes('gComplementOf14'), `High bit clear must not complement: ${out}`);
      assert.ok(out.includes('0x00000014'), `Should keep the literal in: ${out}`);

      // And the low global is not reachable from a small negative either.
      const out2 = run(`void f() { n = -1; }`, lowGlobals);
      assert.ok(!out2.includes('gLow'), `Should not resolve -1 in: ${out2}`);
    });

    it('leaves a loop counter and a size constant alone', () => {
      const out = run(
        `void f() { for (i = 0; i < 12; i = i + 1) { n = 4096; } }`,
        SIMPLE,
      );
      assert.ok(!out.includes('&g'), `Should not touch loop constants in: ${out}`);
    });

    it('leaves an arithmetic operand alone', () => {
      const out = run(`void f() { p = base + 0x500100; }`, SIMPLE);
      assert.ok(out.includes('0x500100'), `Should keep the arithmetic operand in: ${out}`);
      assert.ok(!out.includes('&gThing'), `Should not rewrite an operand in: ${out}`);
    });

    it('leaves an ambiguous literal covered by two globals alone', () => {
      const overlapping: GlobalAddressLiteralOptions = {
        globalAddresses: { gOuter: 0x500100, gInner: 0x500104 },
        globalSizes: { gOuter: 32, gInner: 8 },
      };
      const out = run(`void f() { p = 0x500108; }`, overlapping);
      assert.ok(out.includes('0x500108'), `Should keep the ambiguous literal in: ${out}`);
      assert.ok(!out.includes('gOuter'), `Ambiguous must not resolve: ${out}`);
      assert.ok(!out.includes('gInner'), `Ambiguous must not resolve: ${out}`);
    });

    it('does nothing without the address table', () => {
      const out = run(`void f() { p = 0x500100; }`, {});
      assert.ok(out.includes('0x500100'), `Should be untouched: ${out}`);
    });

    it('does nothing for a global whose size is unknown, beyond its base', () => {
      const noSizes: GlobalAddressLiteralOptions = {
        globalAddresses: { gThing: 0x500100 },
      };
      assert.ok(run(`void f() { p = 0x500100; }`, noSizes).includes('&gThing'));
      assert.ok(run(`void f() { p = 0x500108; }`, noSizes).includes('0x500108'));
    });

    it('leaves the address of a global the body already names by that name alone', () => {
      // A one-byte global at an address equal to its own base is still the base
      // rule; this only checks a zero/negative size cannot open an interior.
      const zeroSize: GlobalAddressLiteralOptions = {
        globalAddresses: { gZero: 0x500100 },
        globalSizes: { gZero: 0 },
      };
      assert.ok(run(`void f() { p = 0x500104; }`, zeroSize).includes('0x500104'));
      assert.ok(run(`void f() { p = 0x500100; }`, zeroSize).includes('&gZero'));
    });

    it('ignores Ghidra placeholder symbols at sub-64KB addresses', () => {
      // Ghidra manufactures a data symbol wherever it cannot resolve a
      // reference, so DAT_00000000/1/4/... sit at single-digit addresses. Taking
      // them as candidates makes every small integer an address: this exact case
      // rewrote `pdwParam[1]` to `pdwParam[&DAT_00000001]` and failed 394 of 505
      // translation units.
      const junk: GlobalAddressLiteralOptions = {
        globalAddresses: { DAT_00000000: 0, DAT_00000001: 1, DAT_00000004: 4, gReal: 0x500100 },
        globalSizes: { DAT_00000000: 1, DAT_00000001: 1, DAT_00000004: 1, gReal: 12 },
      };
      const out = run(`void f(uint32_t* pdwParam) { pdwParam[1] = 0; pdwParam[4] = 2; }`, junk);
      assert.ok(!out.includes('DAT_0000'), `No sub-64KB symbol may resolve: ${out}`);
      assert.ok(out.includes('pdwParam[1]'), `Index must stay numeric: ${out}`);

      // The real global in the same table still resolves.
      assert.ok(run(`void f() { p = 0x500100; }`, junk).includes('&gReal'));
    });

    it('ignores a candidate just below the 64KB floor and takes one just above', () => {
      const edge: GlobalAddressLiteralOptions = {
        globalAddresses: { gLow: 0xffff, gHigh: 0x10000 },
        globalSizes: { gLow: 4, gHigh: 4 },
      };
      assert.ok(run(`void f() { p = 0xffff; }`, edge).includes('0xffff'));
      assert.ok(!run(`void f() { p = 0xffff; }`, edge).includes('gLow'));
      assert.ok(run(`void f() { p = 0x10000; }`, edge).includes('&gHigh'));
    });

    it('ignores placeholder symbols near the top of the word', () => {
      // The same machinery runs at the other end: a small negative offset becomes
      // a symbol like DAT_fffffffb, which turned `pDstExtra[-5]` into
      // `pDstExtra[&DAT_fffffffb]`.
      const junk: GlobalAddressLiteralOptions = {
        globalAddresses: { DAT_fffffffb: 0xfffffffb, hWndInsertAfter_fffffffe: 0xfffffffe, gReal: 0x500100 },
        globalSizes: { DAT_fffffffb: 4, hWndInsertAfter_fffffffe: 4, gReal: 12 },
      };
      const out = run(`void f(uint32_t* pDstExtra) { pDstExtra[-5] = 0; pDstExtra[-2] = 0; }`, junk);
      assert.ok(!out.includes('DAT_ffff'), `No kernel-space symbol may resolve: ${out}`);
      assert.ok(!out.includes('hWndInsertAfter'), `No kernel-space symbol may resolve: ${out}`);
      assert.ok(out.includes('pDstExtra[-5]'), `Index must stay numeric: ${out}`);
    });

    it('still resolves a folded complement, which the ceiling must not block', () => {
      // COMPLEMENT_FLOOR bounds literal VALUES; ADDRESS_CEILING bounds CANDIDATE
      // addresses. A folded ~address is a value above 0xFF000000 pointing at a
      // candidate in the low half, and must survive both.
      const opts: GlobalAddressLiteralOptions = {
        globalAddresses: { gAnchor: 0x708360 },
        globalSizes: { gAnchor: 12 },
      };
      const out = run(`void f() { p = (void*)-7373669; }`, opts);
      assert.ok(out.includes('~(uintptr_t)'), `Complement must resolve: ${out}`);
      assert.ok(out.includes('gAnchor'), `Complement must name the global: ${out}`);
    });
  });
});
