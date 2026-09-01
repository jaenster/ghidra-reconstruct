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
    // `uint32_t SFILE_GetGlobalPointer() { return gbInit ? &gbInit : 0; }` —
    // the direct forms are pointer-typed and do not convert to the return type.
    const RET: GlobalAddressLiteralOptions = { ...SIMPLE, enclosingReturnsNonPointer: true };

    it('reverts a direct match returned from a non-pointer function', () => {
      const out = run(`void f() { return 0x500100; }`, RET);
      assert.ok(out.includes('0x500100'), `Should keep the literal in: ${out}`);
      assert.ok(!out.includes('&gThing'), `A pointer cannot be returned as an int: ${out}`);
    });

    it('reverts through the branches of a returned ternary', () => {
      const out = run(`void f() { return gFlag ? 0x500100 : 0; }`, RET);
      assert.ok(out.includes('0x500100'), `Should keep the literal in: ${out}`);
      assert.ok(!out.includes('&gThing'), `A ternary branch is the return value: ${out}`);
    });

    it('reverts an interior form the same way', () => {
      const out = run(`void f() { return 0x500108; }`, RET);
      assert.ok(out.includes('0x500108'), `Should keep the literal in: ${out}`);
      assert.ok(!out.includes('gThing'), `Should not name a global in: ${out}`);
    });

    it('keeps the complement form, which is already integer-typed', () => {
      // The Storm anchors assign into an int32_t field; `~(uintptr_t)...` is an
      // integer expression and MUST survive an integral context.
      const out = run(`void f() { return -7373669; }`, {
        ...STORM,
        enclosingReturnsNonPointer: true,
      });
      assert.ok(
        out.includes('~(uintptr_t)((char*)&gSFileAsyncReqQueue + 4)'),
        `The complement form must survive an integer return: ${out}`,
      );
    });

    it('leaves a return through a cast alone — the cast is the conversion', () => {
      const out = run(`void f() { return (uint32_t)0x500100; }`, RET);
      assert.ok(out.includes('&gThing'), `A cast makes the pointer form legal: ${out}`);
    });

    it('resolves the same return when the enclosing function returns a pointer', () => {
      const out = run(`void f() { return 0x500100; }`, SIMPLE);
      assert.ok(out.includes('&gThing'), `A pointer return is the wanted case: ${out}`);
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
});
