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
import { enclosingNamespaceStripPlugin } from '../builtins/enclosing-namespace-strip.js';

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

    it('still resolves with the real image base in play', () => {
      // The floor moved from a platform constant to the mapped base; the anchor
      // the whole pass exists for has to survive that.
      const out = run(`void f() { x = (void*)-7373669; }`, { ...STORM, imageBase: '0x400000' });
      assert.ok(
        out.includes('~(uintptr_t)((char*)&gSFileAsyncReqQueue + 4)'),
        `Expected the anchored complement in: ${out}`,
      );
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

  describe('string constants', () => {
    // 1.14d's application-mode names, as Ghidra types them: `string` data with a
    // label naming its own address. `s_modstate0_006cc928` is 9 bytes plus the
    // terminator, so the object the closure defines is `char[10]`.
    const MODES: GlobalAddressLiteralOptions = {
      globalAddresses: {
        s_modstate0_006cc928: 0x6cc928,
        s_modstate1_006cc920: 0x6cc920,
        gThing: 0x500100,
      },
      globalSizes: {
        s_modstate0_006cc928: 10,
        s_modstate1_006cc920: 8,
        gThing: 12,
      },
      stringConstantNames: ['s_modstate0_006cc928', 's_modstate1_006cc920'],
      imageBase: '0x400000',
    };

    it('spells an exact string base as the BARE NAME, never &name', () => {
      const out = run(`void f() { p = (char*)0x6cc928; }`, MODES);
      assert.ok(out.includes('s_modstate0_006cc928'), `Expected the label in: ${out}`);
      // `&s_modstate0_006cc928` is `char(*)[10]`, which converts to nothing.
      assert.ok(!out.includes('&s_modstate0'), `The & would be the wrong type: ${out}`);
      assert.ok(!out.includes('0x6cc928'), `Literal should be gone from: ${out}`);
    });

    it('spells an interior offset as (name + n), with no byte cast', () => {
      const out = run(`void f() { p = (char*)0x6cc92b; }`, MODES);
      assert.ok(out.includes('s_modstate0_006cc928 + 3'), `Expected name + 3 in: ${out}`);
      assert.ok(!out.includes('char*)s_modstate0'), `char[] needs no byte cast: ${out}`);
      assert.ok(!out.includes('&s_modstate0'), `Still no address-of: ${out}`);
    });

    it('leaves a literal near a string but outside every extent alone', () => {
      // 0x6cc932 is past the end of the 10-byte object at 0x6cc928 and before
      // any other. A wrong resolution here is worse than no resolution.
      const out = run(`void f() { p = (char*)0x6cc932; }`, MODES);
      assert.ok(out.includes('0x6cc932'), `Should keep the literal in: ${out}`);
      assert.ok(!out.includes('s_modstate'), `Nothing owns it: ${out}`);
    });

    it('still spells an ordinary global with the address-of it needs', () => {
      // The classification changes the SPELLING of string entries only; a
      // non-string candidate in the same table is untouched.
      const out = run(`void f() { p = 0x500100; }`, MODES);
      assert.ok(out.includes('&gThing'), `Expected &gThing in: ${out}`);
    });

    it('complements a string base through the same rule', () => {
      // ~0x6cc928 == 0xff9336d7
      const out = run(`void f() { p = (void*)0xff9336d7; }`, MODES);
      assert.ok(
        out.includes('~(uintptr_t)s_modstate0_006cc928'),
        `Expected the complemented label in: ${out}`,
      );
    });

    it('withdraws a string reference from an ordinary call argument', () => {
      // Same evidence as any other pointer form in an argument slot: a
      // parameter's type is not visible from a body parsed on its own.
      const out = run(`void f() { g(a, 0x6cc928); }`, MODES);
      assert.ok(out.includes('0x6cc928'), `Argument literal must stand: ${out}`);
      assert.ok(!out.includes('s_modstate0'), `No resolution in an argument: ${out}`);
    });

    it('is not a string when the table does not say so', () => {
      // Without the classification the same entry is an ordinary global and
      // keeps the address-of — the option is the only signal.
      const out = run(`void f() { p = (char*)0x6cc928; }`, {
        ...MODES,
        stringConstantNames: [],
      });
      assert.ok(out.includes('&s_modstate0_006cc928'), `Expected &name in: ${out}`);
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

  describe('compound assignment is arithmetic too', () => {
    // `dwParam2->eRoomExFlags |= 0x800000` — a flag bit that collides with a
    // real global's base. `|=` is an AssignExpr, not a BinaryExpr, so the
    // arithmetic revert never saw it and 14 sites in the tree came out as
    // `|= &D2PoolManagerStrc_00800000`.
    const FLAGS: GlobalAddressLiteralOptions = {
      globalAddresses: { D2PoolManagerStrc_00800000: 0x800000, gThing: 0x500100 },
      globalSizes: { D2PoolManagerStrc_00800000: 4, gThing: 12 },
    };

    it('reverts a match under |=', () => {
      const out = run(`void f(S* p) { p->eRoomExFlags |= 0x800000; }`, FLAGS);
      assert.ok(out.includes('0x800000'), `Flag bit must stay a literal: ${out}`);
      assert.ok(!out.includes('D2PoolManagerStrc'), `Must not name a global: ${out}`);
    });

    it('reverts a match under every compound operator', () => {
      for (const op of ['|=', '&=', '^=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=']) {
        const out = run(`void f() { n ${op} 0x500100; }`, FLAGS);
        assert.ok(out.includes('0x500100'), `${op} must keep the literal: ${out}`);
        assert.ok(!out.includes('&gThing'), `${op} must not resolve: ${out}`);
      }
    });

    it('reverts the folded complement under a compound operator too', () => {
      const out = run(`void f() { n |= -7373669; }`, STORM);
      assert.ok(out.includes('7373669'), `Must keep the folded word: ${out}`);
      assert.ok(!out.includes('gSFileAsyncReqQueue'), `Must not name a global: ${out}`);
    });

    it('still resolves a plain assignment, which is the wanted case', () => {
      const out = run(`void f() { p = 0x500100; }`, FLAGS);
      assert.ok(out.includes('&gThing'), `Plain = must still resolve: ${out}`);
    });
  });

  describe('the floor is the mapped image base', () => {
    // `memcpy(&gPaletteAct1, ..., 0x30000)` is a byte count. It clears the 64KB
    // platform reserve, but it sits far below where this image is mapped — and
    // Ghidra has a placeholder `DAT_00030000` sitting exactly there.
    const BELOW_BASE: GlobalAddressLiteralOptions = {
      globalAddresses: { DAT_00030000: 0x30000, gReal: 0x500100 },
      globalSizes: { DAT_00030000: 4, gReal: 12 },
      imageBase: '00400000',
    };

    it('ignores a candidate below the mapped base', () => {
      const out = run(`void f() { memcpy(a, b, 0x30000); }`, BELOW_BASE);
      assert.ok(out.includes('0x30000'), `Byte count must stay a literal: ${out}`);
      assert.ok(!out.includes('DAT_00030000'), `Must not name a placeholder: ${out}`);
    });

    it('still resolves a candidate above the mapped base', () => {
      assert.ok(run(`void f() { p = 0x500100; }`, BELOW_BASE).includes('&gReal'));
    });

    it('reads the base whether or not it carries an 0x prefix', () => {
      for (const spelling of ['00400000', '0x400000', '0X400000', ' 400000 ']) {
        const out = run(`void f() { n = 0x30000; }`, { ...BELOW_BASE, imageBase: spelling });
        assert.ok(!out.includes('DAT_00030000'), `${spelling} must raise the floor: ${out}`);
        assert.ok(
          run(`void f() { p = 0x500100; }`, { ...BELOW_BASE, imageBase: spelling }).includes('&gReal'),
          `${spelling} must not block a real global`,
        );
      }
    });

    it('accepts a numeric base as well as a spelled one', () => {
      const out = run(`void f() { n = 0x30000; }`, { ...BELOW_BASE, imageBase: 0x400000 });
      assert.ok(!out.includes('DAT_00030000'), `A numeric base must raise the floor: ${out}`);
    });

    it('falls back to the 64KB floor when the base is missing or unparseable', () => {
      // Degrade, do not die: the pass still runs, just with the old bound.
      for (const base of [undefined, '', 'nonsense', '0x0', 'zzzz'] as (string | undefined)[]) {
        const out = run(`void f() { n = 0x30000; }`, { ...BELOW_BASE, imageBase: base });
        assert.ok(out.includes('DAT_00030000'), `base ${base} should fall back: ${out}`);
      }
    });

    it('never drops the floor below the platform 64KB reserve', () => {
      const tiny: GlobalAddressLiteralOptions = {
        globalAddresses: { DAT_00000001: 1, gHigh: 0x10000 },
        globalSizes: { DAT_00000001: 1, gHigh: 4 },
        imageBase: '0x100',
      };
      const out = run(`void f(uint32_t* p) { p[1] = 0; }`, tiny);
      assert.ok(!out.includes('DAT_00000001'), `Sub-64KB must stay excluded: ${out}`);
      assert.ok(run(`void f() { p = 0x10000; }`, tiny).includes('&gHigh'));
    });
  });

  describe('a pointer form where an integer is required', () => {
    // `uint32_t __stdcall SFILE_GetGlobalPointer() { return gbInit ? 0x74d88c : 0; }`
    // — the function really does return a pointer carried in an integer, and
    // `GFX_InitCelDataCache` reads `*(int*)(SFILE_GetGlobalPointer() + 0xc)`
    // through it. Withdrawing the match restored the absolute `0x74d88c`, which
    // the linker does not move, and that read faulted at 0x0074D898. The symbol
    // stays; only its width is spelled.
    const RET: GlobalAddressLiteralOptions = { ...SIMPLE, enclosingReturnType: 'uint32_t' };

    it('casts a direct match returned from a non-pointer function', () => {
      const out = run(`void f() { return 0x500100; }`, RET);
      assert.ok(
        out.includes('(uint32_t)(uintptr_t)&gThing'),
        `Expected the width-exact cast in: ${out}`,
      );
      assert.ok(!out.includes('0x500100'), `The literal must be gone from: ${out}`);
    });

    it('casts through the branches of a returned ternary, keeping the null branch', () => {
      const out = run(`void f() { return gThing ? 0x500100 : 0; }`, RET);
      assert.ok(
        out.includes('(uint32_t)(uintptr_t)&gThing'),
        `A ternary branch is the return value: ${out}`,
      );
      assert.ok(/:\s*0/.test(out), `The null branch must stay 0: ${out}`);
      assert.ok(!out.includes('0x500100'), `The literal must be gone from: ${out}`);
    });

    it('casts an interior form the same way', () => {
      const out = run(`void f() { return 0x500108; }`, RET);
      assert.ok(
        out.includes('(uint32_t)(uintptr_t)((char*)&gThing + 8)'),
        `Expected the anchored interior, cast: ${out}`,
      );
      assert.ok(!out.includes('0x500108'), `The literal must be gone from: ${out}`);
    });

    it('spells the cast with the return type it was given', () => {
      const out = run(`void f() { return 0x500100; }`, { ...SIMPLE, enclosingReturnType: 'DWORD' });
      assert.ok(out.includes('(DWORD)(uintptr_t)&gThing'), `Expected a DWORD cast: ${out}`);
    });

    it('keeps the complement form untouched, which is already integer-typed', () => {
      // The Storm anchors assign into an int32_t field; `~(uintptr_t)...` is an
      // integer expression and must not collect a second cast.
      const out = run(`void f() { return -7373669; }`, {
        ...STORM,
        enclosingReturnType: 'int32_t',
      });
      assert.ok(
        out.includes('~(uintptr_t)((char*)&gSFileAsyncReqQueue + 4)'),
        `The complement form must survive an integer return: ${out}`,
      );
      assert.ok(!out.includes('(int32_t)'), `It needs no cast of its own: ${out}`);
    });

    it('leaves a return through a cast alone — the cast is the conversion', () => {
      const out = run(`void f() { return (uint32_t)0x500100; }`, RET);
      assert.ok(out.includes('(uint32_t)&gThing'), `A cast makes the pointer form legal: ${out}`);
      assert.ok(!out.includes('uintptr_t'), `No second cast is needed: ${out}`);
    });

    it('emits the bare form when the enclosing function returns a pointer', () => {
      for (const spelling of ['uint32_t*', 'void *', 'D2UnitStrc*']) {
        const out = run(`void f() { return 0x500100; }`, {
          ...SIMPLE,
          enclosingReturnType: spelling,
        });
        assert.ok(out.includes('&gThing'), `${spelling} is the wanted case: ${out}`);
        assert.ok(!out.includes('uintptr_t'), `${spelling} needs no cast: ${out}`);
      }
    });

    it('emits the bare form when no return type is supplied, judging nothing', () => {
      const out = run(`void f() { return 0x500100; }`, SIMPLE);
      assert.ok(out.includes('&gThing'), `Should still resolve: ${out}`);
      assert.ok(!out.includes('uintptr_t'), `Nothing to cast to: ${out}`);
    });

    it('leaves a void return and an unspellable type alone', () => {
      for (const spelling of ['void', '', '   ', 'std::vector<int>', 'int&']) {
        const out = run(`void f() { return 0x500100; }`, {
          ...SIMPLE,
          enclosingReturnType: spelling,
        });
        assert.ok(out.includes('&gThing'), `"${spelling}": should still resolve: ${out}`);
        assert.ok(!out.includes('uintptr_t'), `"${spelling}": must not cast: ${out}`);
      }
    });

    it('never puts the absolute address back', () => {
      // The regression this replaced: withdrawing the symbol restored
      // `0x74d88c`, which the linker does not move, and the caller faulted.
      for (const type of ['uint32_t', 'int', 'DWORD', 'void', 'uint32_t*', undefined]) {
        const out = run(`void f() { return gThing ? 0x500100 : 0; }`, {
          ...SIMPLE,
          enclosingReturnType: type,
        });
        assert.ok(!out.includes('0x500100'), `${type}: the address must not come back: ${out}`);
        assert.ok(out.includes('&gThing'), `${type}: the symbol must stay: ${out}`);
      }
    });

    it('leaves a pointer form outside a return untouched', () => {
      const out = run(`void f() { p = 0x500100; }`, RET);
      assert.ok(out.includes('&gThing'), `Should resolve: ${out}`);
      assert.ok(!out.includes('uintptr_t'), `Only a return is judged: ${out}`);
    });

    it('still withdraws a pointer form in a call argument, return type or not', () => {
      // The argument rule is a different rule for a different reason — a
      // parameter's type is invisible from the body — and the return type says
      // nothing about it.
      const out = run(`void f() { g(0x500100); }`, RET);
      assert.ok(out.includes('0x500100'), `The argument literal must stand: ${out}`);
      assert.ok(!out.includes('&gThing'), `No pointer form in an argument: ${out}`);
    });
  });
  describe('the namespace the global is defined in', () => {
    // Same reasoning as `func-ptr-literal`: a global's address is taken from
    // anywhere, and a bare name only resolves where the definition is in scope.
    const NS: GlobalAddressLiteralOptions = {
      ...SIMPLE,
      globalNamespaces: {
        gThing: ['D2Client', 'Cursor'],
      },
    };

    it('qualifies a direct match with the namespace the global is defined in', () => {
      const out = run(`void f() { p = 0x500100; }`, NS);
      assert.ok(
        out.includes('&D2Client::Cursor::gThing'),
        `Expected the qualified reference in: ${out}`,
      );
    });

    it('qualifies an interior match the same way', () => {
      const out = run(`void f() { p = 0x500104; }`, NS);
      assert.ok(
        out.includes('(char*)&D2Client::Cursor::gThing + 4'),
        `Expected the qualified interior form in: ${out}`,
      );
    });

    it('qualifies the folded complement form too', () => {
      const out = run(`void f() { x = (void*)-5243141; }`, NS);
      assert.ok(
        out.includes('~(uintptr_t)((char*)&D2Client::Cursor::gThing + 4)'),
        `Expected the qualified complement in: ${out}`,
      );
    });

    it('leaves a global with no namespace entry as a bare name', () => {
      const out = run(`void f() { p = 0x600200; }`, NS);
      assert.ok(out.includes('&gOther'), `Root-scope globals stay bare: ${out}`);
      assert.ok(!out.includes('::gOther'), `Nothing to qualify with: ${out}`);
    });

    it('treats an empty segment list as root scope', () => {
      const out = run(`void f() { p = 0x500100; }`, {
        ...SIMPLE,
        globalNamespaces: { gThing: [] },
      });
      assert.ok(out.includes('&gThing'), `Empty segments mean root scope: ${out}`);
      assert.ok(!out.includes('::gThing'), `No qualifier should be written: ${out}`);
    });
  });

  describe('a pointer form in a call argument', () => {
    // `__allmul(nUnixTime + 0xb6109100, ..., 0x989680, 0)` is the FILETIME
    // conversion's 10,000,000 — a genuine numeric constant that happens to be
    // where `gnCurrentTimestamp` sits. A parameter's type is not visible from
    // the body, so a call argument carries no evidence either way and the
    // literal stands, exactly as it does under an arithmetic operator.
    it('reverts a direct match passed as a call argument', () => {
      const out = run(`void f() { g(0x500100); }`, SIMPLE);
      assert.ok(out.includes('0x500100'), `The literal must stand: ${out}`);
      assert.ok(!out.includes('&gThing'), `No pointer form in an argument: ${out}`);
    });

    it('reverts an interior match passed as a call argument', () => {
      const out = run(`void f() { g(1, 0x500104, 2); }`, SIMPLE);
      assert.ok(out.includes('0x500104'), `The literal must stand: ${out}`);
      assert.ok(!out.includes('gThing'), `No pointer form in an argument: ${out}`);
    });

    it('reverts through a parenthesised argument', () => {
      const out = run(`void f() { g((0x500100)); }`, SIMPLE);
      assert.ok(!out.includes('&gThing'), `A paren is not a conversion: ${out}`);
    });

    it('keeps the complement form, which is already integer-typed', () => {
      const out = run(`void f() { g(-7373669); }`, STORM);
      assert.ok(
        out.includes('~(uintptr_t)((char*)&gSFileAsyncReqQueue + 4)'),
        `The complement form must survive an argument: ${out}`,
      );
    });

    it('leaves an argument written through a cast alone', () => {
      const out = run(`void f() { g((void*)0x500100); }`, SIMPLE);
      assert.ok(out.includes('&gThing'), `A cast is the conversion: ${out}`);
    });
  });
  // The qualifier this pass writes is the DEFINITION's scope, whatever unit the
  // reference lands in. `enclosing-namespace-strip` (priority 900) runs after and
  // drops whatever prefix the enclosing block already opens, so a same-namespace
  // reference is not left over-qualified. Both halves are checked here rather
  // than asserted, because the second pass is the one that has to see a
  // QualifiedId at all.
  describe('handing the qualifier to enclosing-namespace-strip', () => {
    function runThenStrip(
      code: string,
      opts: GlobalAddressLiteralOptions,
      enclosingSegments: string[],
    ): string {
      const resolved = globalAddressLiteralPlugin.createTransformer(opts)(parse(code));
      const stripper = enclosingNamespaceStripPlugin.createTransformer({ enclosingSegments });
      return emit(stripper(resolved) as AnyNode).trim();
    }

    const NS: GlobalAddressLiteralOptions = {
      globalAddresses: { gThing: 0x500100 },
      globalSizes: { gThing: 12 },
      globalNamespaces: { gThing: ['D2Client', 'Cursor'] },
    };

    it('strips back to the bare name inside the global\'s own namespace', () => {
      const out = runThenStrip(`void f() { p = 0x500100; }`, NS, ['D2Client', 'Cursor']);
      assert.ok(out.includes('&gThing'), `Expected the bare name in: ${out}`);
      assert.ok(!out.includes('::'), `Nothing should stay qualified: ${out}`);
    });

    it('keeps the segments a sibling namespace does not open', () => {
      const out = runThenStrip(`void f() { p = 0x500100; }`, NS, ['D2Client', 'UI', 'NpcMenu']);
      assert.ok(
        out.includes('&Cursor::gThing'),
        `Only the shared prefix comes off: ${out}`,
      );
    });

    it('keeps the whole qualifier in an unrelated module', () => {
      const out = runThenStrip(`void f() { p = 0x500100; }`, NS, ['D2Game', 'Items']);
      assert.ok(
        out.includes('&D2Client::Cursor::gThing'),
        `Nothing is shared, nothing comes off: ${out}`,
      );
    });

    it('resolves through GuardStack, whose argument is a return value', () => {
      // GuardStack is the /GS epilogue: it passes EAX through, so its argument is
      // typed by the CALLER's return type, not by a parameter. Withdrawing pointer
      // forms there put an absolute image address back into NET_GetLocalIp, whose
      // caller printed it as %s and faulted reading 0x0075D040.
      const opts: GlobalAddressLiteralOptions = {
        globalAddresses: { cp_0075d040: 0x75d040 },
        globalSizes: { cp_0075d040: 256 },
        imageBase: '0x400000',
      };
      const out = run(`void f() { p = (char*)GuardStack(0x75d040); }`, opts);
      assert.ok(out.includes('cp_0075d040'), `Must resolve through GuardStack: ${out}`);
      assert.ok(!out.includes('0x75d040'), `Literal must be gone: ${out}`);

      // Qualified spelling reaches the same rule.
      const q = run(`void f() { p = (char*)Fog::Debug::GuardStack(0x75d040); }`, opts);
      assert.ok(q.includes('cp_0075d040'), `Qualified callee too: ${q}`);
    });

    it('still withdraws a pointer form in an ordinary call argument', () => {
      // __allmul's 0x989680 is FILETIME's 10,000,000 colliding with a global.
      const opts: GlobalAddressLiteralOptions = {
        globalAddresses: { gnCurrentTimestamp: 0x989680 },
        globalSizes: { gnCurrentTimestamp: 4 },
        imageBase: '0x400000',
      };
      const out = run(`void f() { q = __allmul(a, b, 0x989680, 0); }`, opts);
      assert.ok(!out.includes('gnCurrentTimestamp'), `Ordinary call must not resolve: ${out}`);
    });
  });

  // ============================================
  // ONE-PAST-THE-END vs THE NEXT OBJECT'S BASE
  // ============================================

  describe('the end of one global is the base of the next', () => {
    // 1.14d's Y-buffer table and the tile-clip word that follows it:
    // 0x7c97a8 + 732*4 == 0x7ca318 == &gnTileClipLeft. In the image the two
    // readings are the same byte; after relinking they are different objects.
    const YBUFFER: GlobalAddressLiteralOptions = {
      globalAddresses: {
        gaYBufferRowOffsets: 0x7c97a8,
        gnTileClipLeft: 0x7ca318,
        gUnrelated: 0x700000,
      },
      globalSizes: {
        gaYBufferRowOffsets: 2928,
        gnTileClipLeft: 4,
        gUnrelated: 16,
      },
      imageBase: '0x400000',
    };

    const CLEAR_Y_BUFFER = `
      void f() {
        uint32_t* pRow;
        pRow = (uint32_t*)gaYBufferRowOffsets;
        do {
          *pRow = nRowOffset;
          pRow = pRow + 1;
        } while ((int)pRow < 0x7ca318);
      }`;

    it('resolves the D2GFX_ClearYBuffer bound to the end of the array it walks', () => {
      const out = run(CLEAR_Y_BUFFER, YBUFFER);
      assert.ok(
        out.includes('(char*)&gaYBufferRowOffsets + sizeof(gaYBufferRowOffsets)'),
        `Expected the end of the array in: ${out}`,
      );
      assert.ok(!out.includes('gnTileClipLeft'), `The next object must not appear: ${out}`);
      assert.ok(!out.includes('0x7ca318'), `The literal must be gone: ${out}`);
    });

    it('reaches the same answer through the post-transform spelling', () => {
      // By the time later passes have run the base reads `&name` and the
      // advance is a postfix `++`; the evidence is the same either way.
      const out = run(`
        void f() {
          uint32_t* pRow = &gaYBufferRowOffsets;
          do {
            *pRow = nRowOffset;
            pRow++;
          } while ((int)pRow < 0x7ca318);
        }`, YBUFFER);
      assert.ok(
        out.includes('(char*)&gaYBufferRowOffsets + sizeof(gaYBufferRowOffsets)'),
        `Expected the end of the array in: ${out}`,
      );
    });

    it('reads the base through the literal this pass would resolve itself', () => {
      const out = run(`
        void f() {
          uint32_t* pRow;
          pRow = (uint32_t*)0x7c97a8;
          do { pRow = pRow + 1; } while ((int)pRow < 0x7ca318);
        }`, YBUFFER);
      assert.ok(
        out.includes('(char*)&gaYBufferRowOffsets + sizeof(gaYBufferRowOffsets)'),
        `Expected the end of the array in: ${out}`,
      );
    });

    it('resolves the same bound written with the operands the other way round', () => {
      const out = run(`
        void f() {
          uint32_t* pRow = &gaYBufferRowOffsets;
          do { pRow = pRow + 1; } while (0x7ca318 > (int)pRow);
        }`, YBUFFER);
      assert.ok(
        out.includes('(char*)&gaYBufferRowOffsets + sizeof(gaYBufferRowOffsets)'),
        `Expected the end of the array in: ${out}`,
      );
    });

    it('resolves an end-of-array bound no global claims as a base', () => {
      // Same evidence, no ambiguity to break: nothing lives at 0x7ca318, so
      // today the literal survives as an absolute image address.
      const out = run(CLEAR_Y_BUFFER, {
        ...YBUFFER,
        globalAddresses: { gaYBufferRowOffsets: 0x7c97a8, gUnrelated: 0x700000 },
        globalSizes: { gaYBufferRowOffsets: 2928, gUnrelated: 16 },
      });
      assert.ok(
        out.includes('(char*)&gaYBufferRowOffsets + sizeof(gaYBufferRowOffsets)'),
        `Expected the end of the array in: ${out}`,
      );
    });

    it('keeps &B where the same literal is not in a comparison', () => {
      const out = run(`void f() { p = 0x7ca318; }`, YBUFFER);
      assert.ok(out.includes('&gnTileClipLeft'), `Expected &gnTileClipLeft in: ${out}`);
      assert.ok(!out.includes('sizeof'), `No end form outside a comparison: ${out}`);
    });

    it('keeps &B where the compared pointer comes from somewhere else', () => {
      const out = run(`
        void f() {
          uint32_t* q;
          q = (uint32_t*)gUnrelated;
          while ((int)q < 0x7ca318) { q = q + 1; }
        }`, YBUFFER);
      assert.ok(out.includes('&gnTileClipLeft'), `Expected &gnTileClipLeft in: ${out}`);
      assert.ok(!out.includes('sizeof'), `Unrelated base is no evidence: ${out}`);
    });

    it('keeps &B where the compared pointer has no traceable origin', () => {
      const out = run(`
        void f() {
          uint32_t* pRow = GetRows();
          do { pRow = pRow + 1; } while ((int)pRow < 0x7ca318);
        }`, YBUFFER);
      assert.ok(out.includes('&gnTileClipLeft'), `Expected &gnTileClipLeft in: ${out}`);
      assert.ok(!out.includes('sizeof'), `An untraced pointer is no evidence: ${out}`);
    });

    it('keeps &B where the pointer is assigned from two different globals', () => {
      const out = run(`
        void f() {
          uint32_t* pRow = &gaYBufferRowOffsets;
          if (c) { pRow = (uint32_t*)gUnrelated; }
          do { pRow = pRow + 1; } while ((int)pRow < 0x7ca318);
        }`, YBUFFER);
      assert.ok(out.includes('&gnTileClipLeft'), `Two origins are no evidence: ${out}`);
    });

    it('keeps &B where the pointer had its address taken', () => {
      const out = run(`
        void f() {
          uint32_t* pRow = &gaYBufferRowOffsets;
          Init(&pRow);
          do { pRow = pRow + 1; } while ((int)pRow < 0x7ca318);
        }`, YBUFFER);
      assert.ok(out.includes('&gnTileClipLeft'), `An aliased pointer is no evidence: ${out}`);
    });

    it('skips an ambiguity whose base global has no known size', () => {
      const out = run(CLEAR_Y_BUFFER, {
        ...YBUFFER,
        globalSizes: { gnTileClipLeft: 4, gUnrelated: 16 },
      });
      assert.ok(out.includes('&gnTileClipLeft'), `No extent, no end: ${out}`);
      assert.ok(!out.includes('sizeof'), `No extent, no end form: ${out}`);
    });

    it('keeps &B where the literal is the base of the very global walked', () => {
      // p walks gnTileClipLeft and the bound is gnTileClipLeft's own base: that
      // is not one-past-the-end of anything, and the base reading stands.
      const out = run(`
        void f() {
          uint32_t* p = &gnTileClipLeft;
          while ((int)p < 0x7ca318) { p = p + 1; }
        }`, YBUFFER);
      assert.ok(out.includes('&gnTileClipLeft'), `Expected &gnTileClipLeft in: ${out}`);
      assert.ok(!out.includes('sizeof'), `Not an end: ${out}`);
    });

    it('leaves an equality comparison alone', () => {
      // `==` is not a bound; a pointer tested against an object's address is
      // the ordinary reading and the ambiguity rule has no business there.
      const out = run(`
        void f() {
          uint32_t* pRow = &gaYBufferRowOffsets;
          if ((int)pRow == 0x7ca318) { g(); }
        }`, YBUFFER);
      assert.ok(out.includes('&gnTileClipLeft'), `Expected &gnTileClipLeft in: ${out}`);
      assert.ok(!out.includes('sizeof'), `Equality is not a bound: ${out}`);
    });

    it('does not fire on a bound that is merely inside the array', () => {
      const out = run(`
        void f() {
          uint32_t* pRow = &gaYBufferRowOffsets;
          do { pRow = pRow + 1; } while ((int)pRow < 0x7c9800);
        }`, YBUFFER);
      assert.ok(!out.includes('sizeof'), `An interior bound is not the end: ${out}`);
      assert.ok(out.includes('(char*)&gaYBufferRowOffsets + 88'), `Interior form: ${out}`);
    });
  });

  // ============================================
  // THE EDGE OF A, NOT ONLY ITS END
  // ============================================

  describe('a bound at the edge of the object the walk covers', () => {
    // D2WINFONT_FreeFontCache walks a FIELD of each entry: the cursor starts at
    // `&gaFontCache[0].pFontTable` — four bytes into the first entry — and the
    // bound is the array's end plus that same four. 0x841da8 + 280 + 4.
    const FONT: GlobalAddressLiteralOptions = {
      globalAddresses: { gaFontCache: 0x841da8, gcTooltipBarColor: 0x841ec4 },
      globalSizes: { gaFontCache: 280, gcTooltipBarColor: 4 },
      globalElementSizes: { gaFontCache: 20 },
      imageBase: '0x400000',
    };

    const FREE_FONT_CACHE = `
      void f() {
        void** ppFontTable;
        ppFontTable = &gaFontCache[0].pFontTable;
        do {
          *ppFontTable = 0;
          ppFontTable = ppFontTable + 5;
        } while ((int)ppFontTable < 0x841ec4);
      }`;

    it('resolves the FreeFontCache bound to the array end plus the field offset', () => {
      const out = run(FREE_FONT_CACHE, FONT);
      assert.ok(
        out.includes('(char*)&gaFontCache + sizeof(gaFontCache) + 4'),
        `Expected the end of the array plus the field offset in: ${out}`,
      );
      assert.ok(!out.includes('gcTooltipBarColor'), `A live variable must not be named: ${out}`);
      assert.ok(!out.includes('0x841ec4'), `The literal must be gone: ${out}`);
    });

    // SCompDecompress walks the codec table backwards from
    // `&paSCompDecompressCodecTable[4].pfnCodec` and stops just below the first
    // entry's field: base + 3, where the field sits at base + 4.
    const CODEC: GlobalAddressLiteralOptions = {
      globalAddresses: { paSCompDecompressCodecTable: 0x6cfec4 },
      globalSizes: { paSCompDecompressCodecTable: 40 },
      globalElementSizes: { paSCompDecompressCodecTable: 8 },
      imageBase: '0x400000',
    };

    it('resolves the SCompDecompress descending bound relative to the table', () => {
      const out = run(`
        void f() {
          void** ppMethodEntry;
          ppMethodEntry = &paSCompDecompressCodecTable[4].pfnCodec;
          do {
            ppMethodEntry = ppMethodEntry + -2;
          } while (0x6cfec7 < (int)ppMethodEntry);
        }`, CODEC);
      assert.ok(
        out.includes('(char*)&paSCompDecompressCodecTable + 3'),
        `Expected a bound relative to the table in: ${out}`,
      );
      assert.ok(!out.includes('0x6cfec7'), `The literal must be gone: ${out}`);
    });

    it('resolves a descending bound one byte BELOW the table base', () => {
      // The same fold where the walked field sits at offset 0: `p >= base`
      // comes out of the decompiler as `base - 1 < p`, and nothing else in the
      // pass can reach a literal below every symbol.
      const out = run(`
        void f() {
          void** ppMethodEntry;
          ppMethodEntry = &paSCompDecompressCodecTable[4].pfnCodec;
          do {
            ppMethodEntry = ppMethodEntry + -2;
          } while (0x6cfec3 < (int)ppMethodEntry);
        }`, CODEC);
      assert.ok(
        out.includes('(char*)&paSCompDecompressCodecTable - 1'),
        `Expected a bound just below the table in: ${out}`,
      );
    });

    it('declines a bound past the end by more than one element', () => {
      // 0x841da8 + 280 + 20 is a whole element past the array: no field of an
      // entry sits there, so this is not the shape and the literal stands.
      const out = run(`
        void f() {
          void** ppFontTable;
          ppFontTable = &gaFontCache[0].pFontTable;
          do { ppFontTable = ppFontTable + 5; } while ((int)ppFontTable < 0x841ed8);
        }`, FONT);
      assert.ok(!out.includes('sizeof'), `Too far past the end to be an edge: ${out}`);
      assert.ok(out.includes('0x841ed8'), `The literal stands: ${out}`);
    });

    it('declines a bound below the base by more than one element', () => {
      const out = run(`
        void f() {
          void** ppMethodEntry;
          ppMethodEntry = &paSCompDecompressCodecTable[4].pfnCodec;
          do {
            ppMethodEntry = ppMethodEntry + -2;
          } while (0x6cfeb4 < (int)ppMethodEntry);
        }`, CODEC);
      assert.ok(
        !out.includes('paSCompDecompressCodecTable -'),
        `Too far below the base to be an edge: ${out}`,
      );
    });

    it('keeps &B at a global’s exact base where no walk is proven', () => {
      const out = run(`
        void f() {
          void** p = GetTable();
          do { p = p + 5; } while ((int)p < 0x841ec4);
        }`, FONT);
      assert.ok(out.includes('&gcTooltipBarColor'), `Expected &gcTooltipBarColor in: ${out}`);
      assert.ok(!out.includes('sizeof'), `No walk, no edge reading: ${out}`);
    });

    it('does not trace a subscript through a global that is not an array', () => {
      // `pTable[4]` on a POINTER global reaches the pointee, which is not the
      // pointer's own storage; a bound at the pointer's edge would be nonsense.
      const out = run(`
        void f() {
          void** p;
          p = &pSomeTable[4].pfnCodec;
          do { p = p + -2; } while (0x6cfec8 < (int)p);
        }`, {
        globalAddresses: { pSomeTable: 0x6cfec4 },
        // A pointer slot: four bytes. The bound sits one word past it, which the
        // fallback slack WOULD admit had the walk been traceable — so what the
        // literal surviving proves is that the subscript was refused.
        globalSizes: { pSomeTable: 4 },
        imageBase: '0x400000',
      });
      assert.ok(out.includes('0x6cfec8'), `A pointer is not an array: ${out}`);
    });

    it('does not trace a subscript through an arrow member access', () => {
      const out = run(`
        void f() {
          void** p;
          p = &gaFontCache[0].pEntry->pFontTable;
          do { p = p + 5; } while ((int)p < 0x841ec4);
        }`, FONT);
      assert.ok(out.includes('&gcTooltipBarColor'), `An arrow leaves the object: ${out}`);
    });

    it('falls back to a small slack where the element size is unknown', () => {
      // No array type means no element size, and no subscript trace either — so
      // the walk has to name its start the other way the decompiler spells it,
      // as the interior address itself. The window then shrinks to a platform
      // stride rather than opening up.
      const near = run(`
        void f() {
          void** ppFontTable;
          ppFontTable = (void**)0x841dac;
          do { ppFontTable = ppFontTable + 5; } while ((int)ppFontTable < 0x841ec4);
        }`, { ...FONT, globalElementSizes: {} });
      assert.ok(
        near.includes('(char*)&gaFontCache + sizeof(gaFontCache) + 4'),
        `Four past the end is inside the fallback slack: ${near}`,
      );

      const far = run(`
        void f() {
          void** ppFontTable;
          ppFontTable = (void**)0x841dac;
          do { ppFontTable = ppFontTable + 5; } while ((int)ppFontTable < 0x841ec8);
        }`, { ...FONT, globalElementSizes: {} });
      assert.ok(!far.includes('sizeof'), `Eight past the end is outside it: ${far}`);
    });
  });
});
