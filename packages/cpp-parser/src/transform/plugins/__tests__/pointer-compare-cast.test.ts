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
});
