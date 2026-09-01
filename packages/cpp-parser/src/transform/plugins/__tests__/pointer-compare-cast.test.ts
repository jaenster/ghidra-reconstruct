/**
 * Pointer Comparison Cast-Insertion Plugin Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { pointerCompareCastPlugin } from '../builtins/pointer-compare-cast.js';
import type { PointerCompareCastOptions } from '../builtins/pointer-compare-cast.js';

describe('pointerCompareCastPlugin', () => {
  const transform = (code: string, options?: PointerCompareCastOptions): string => {
    const transformer = pointerCompareCastPlugin.createTransformer(options);
    return emit(transformer(parse(code)) as AnyNode).replace(/\s+/g, ' ').trim();
  };

  it('casts a short* compared against a differently-typed global', () => {
    const out = transform(`void f() {
      short* psVar8;
      psVar8 = 0;
      do {
        psVar8++;
      } while (psVar8 < s_PKWARE_Data_Compression_Library_f_0074be60);
    }`, { globalTypes: { s_PKWARE_Data_Compression_Library_f_0074be60: 'char[74]' } });
    assert.ok(/psVar8 < \(short\s*(int)?\*\)s_PKWARE_Data_Compression_Library_f_0074be60/.test(out), out);
  });

  // `s_PKWARE_Data_Compression_Library_f_0074be60` never became a `globals`
  // model record — it exists only through the declaration closure's
  // last-resort `extern char NAME[];` for a Ghidra string-label name, so no
  // `globalTypes` entry names it at all. This is the actual compiler.cpp defect:
  // the bound is genuinely `char*` (declared, just not through the model), and
  // reproducing the bug means NOT supplying a globalTypes entry either.
  it('casts a short* compared against an unmodeled string-label global (compiler.cpp regression)', () => {
    const out = transform(`void f() {
      short* psVar8;
      psVar8 = 0;
      do {
        psVar8++;
      } while (psVar8 < s_PKWARE_Data_Compression_Library_f_0074be60);
    }`);
    assert.ok(/psVar8 < \(short\s*(int)?\*\)s_PKWARE_Data_Compression_Library_f_0074be60/.test(out), out);
  });

  it('leaves a same-type pointer comparison untouched', () => {
    const out = transform(`void f() { short* x; short* y; if (x < y) {} }`);
    assert.ok(!out.includes('(short'), out);
  });

  it('leaves a null-pointer comparison untouched', () => {
    const out = transform(`void f() { short* x; if (x == 0) {} }`);
    assert.ok(!out.includes('(short'), out);
  });
  // LightMap.cpp: `pCollisionCell` walks `gaLightmapInterpBuffer` and stops at
  // the address of the global that follows it. Both are file-local statics, so
  // no table this pass reads carries either type — but `&anything` is a pointer
  // by construction, and the comparison against `(int)pCollisionCell` is the
  // machine's own `cmp` of two words.
  it('casts an address-of bound compared against a machine-word integer', () => {
    const out = transform(`void f() {
      int32_t* pCollisionCell;
      do {
        pCollisionCell++;
      } while ((int)pCollisionCell < &gnLightmapInterpDirX);
    }`);
    assert.ok(
      out.includes('(uintptr_t)&gnLightmapInterpDirX'),
      `The address-of side goes through uintptr_t: ${out}`,
    );
  });

  it('casts an anchored interior address the same way, on either side', () => {
    const out = transform(`void f() {
      int nVar;
      if (((char*)&gAnchor + 3) < (int)nVar) {}
    }`);
    assert.ok(
      out.includes('(uintptr_t)((char*)&gAnchor + 3)'),
      `The address expression goes through uintptr_t: ${out}`,
    );
  });

  it('leaves an address-of compared against something of unknown type alone', () => {
    const out = transform(`void f() { if (&gAnchor < pSomething) {} }`);
    assert.ok(!out.includes('uintptr_t'), `No evidence of a word comparison: ${out}`);
  });

  it('leaves an address-of null comparison alone', () => {
    const out = transform(`void f() { if (&gAnchor == 0) {} }`);
    assert.ok(!out.includes('uintptr_t'), `A null comparison is already legal: ${out}`);
  });
  // The same gap one shape further along. A folded interior address now resolves
  // to a STRING CONSTANT's interior — `s_label + 8` — and the pass declined it
  // for exactly the reason it declined a bare `&static`: `expr-shape` walks into
  // the `+`, asks for the base's type, and no table names a Ghidra string label.
  // The label's ONE knowable shape has to be reachable at every level of the
  // walk, not only at the top.
  describe('a string label with an offset on it', () => {
    it('casts the interior of a string constant compared against a machine word', () => {
      const out = transform(`void f() {
        int32_t* pElemStatTable;
        do {
          pElemStatTable++;
        } while ((int)pElemStatTable < s___UI_SkillDesc_cpp_006dbf24 + 8);
      }`);
      assert.ok(
        out.includes('(uintptr_t)(s___UI_SkillDesc_cpp_006dbf24 + 8)'),
        `The offset stays inside the cast: ${out}`,
      );
    });

    it('casts the same shape with the label on the left', () => {
      const out = transform(`void f() {
        int nVar;
        if (s___not_xlated_call_ken_w_00730520 + 4 < (int)nVar) {}
      }`);
      assert.ok(
        out.includes('(uintptr_t)(s___not_xlated_call_ken_w_00730520 + 4)'),
        `The label side goes through uintptr_t: ${out}`,
      );
    });

    it('casts a parenthesised offset too', () => {
      const out = transform(`void f() {
        int nVar;
        if ((int)nVar < (s___UI_SkillDesc_cpp_006dbf24 + 8)) {}
      }`);
      assert.ok(out.includes('uintptr_t'), `A paren is not a conversion: ${out}`);
    });

    it('still casts the bare label with no offset', () => {
      const out = transform(`void f() {
        int nVar;
        if ((int)nVar < s___UI_SkillDesc_cpp_006dbf24) {}
      }`);
      assert.ok(
        out.includes('(uintptr_t)s___UI_SkillDesc_cpp_006dbf24'),
        `The bare form must keep working: ${out}`,
      );
    });

    it('casts an offset onto a MODELED array the same way', () => {
      // Nothing convention-based about this one: the table says `char[74]`, and
      // an array name plus an integer has always been a pointer.
      const out = transform(`void f() {
        int nVar;
        if ((int)nVar < gaTable + 8) {}
      }`, { globalTypes: { gaTable: 'char[74]' } });
      assert.ok(out.includes('(uintptr_t)(gaTable + 8)'), `A modeled array decays: ${out}`);
    });

    it('leaves an offset onto something no table and no convention names alone', () => {
      const out = transform(`void f() { int nVar; if ((int)nVar < nSomething + 8) {} }`);
      assert.ok(!out.includes('uintptr_t'), `No evidence of a pointer: ${out}`);
    });

    // The shape is admitted in the two-pointer branch as well, not only the
    // pointer-vs-word one. `char` is a spellable base — it is the same base the
    // bare label has always been given there (the compiler.cpp regression above)
    // — and the shape it replaces is `null`, which today means "no cast" and so
    // means "comparison between distinct pointer types". Nothing that compiles
    // now can change.
    it('reaches the distinct-pointer branch too, where the base is spellable', () => {
      const out = transform(`void f() {
        short* psVar8;
        if (psVar8 < s___UI_SkillDesc_cpp_006dbf24 + 8) {}
      }`);
      assert.ok(/\(short\s*(int)?\*\)\(s___UI_SkillDesc_cpp_006dbf24 \+ 8\)/.test(out), out);
    });

    it('leaves a subtraction of two labels alone — that is a distance', () => {
      const out = transform(`void f() {
        int nVar;
        if ((int)nVar < s_a_006dbf24 - s_b_00730520) {}
      }`);
      assert.ok(!out.includes('uintptr_t'), `A pointer difference is an integer: ${out}`);
    });
  });
});
