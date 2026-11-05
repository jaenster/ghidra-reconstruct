/**
 * signed-divide-site / arith-idioms: a cast byte or word dividend the original divides with
 * IDIV is divided as the promoted int, with the cast kept on the result.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, ASTNode } from '../../../ast/nodes.js';
import { createSignedDivideSiteTransformer, type SignedDivideOperatorSite } from '../builtins/signed-divide-site.js';
import { arithIdiomsPlugin } from '../builtins/arith-idioms.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(code: string, counts: Record<string, number>, sites: SignedDivideOperatorSite[]): string {
  const tagged = createSignedDivideSiteTransformer({ counts, sites })(parse(code) as ASTNode);
  return flat(emit(arithIdiomsPlugin.createTransformer({})(tagged) as AnyNode));
}
const untouched = (code: string) => flat(emit(arithIdiomsPlugin.createTransformer({})(parse(code)) as AnyNode));

// OpenLogFileWithTimestamp 0040ebd0.
const LOG = 'void f(uint16_t wYear, uint16_t wMonth) { g((uint32_t)wYear % 100, (uint32_t)wMonth); }';

describe('signed-divide-site', () => {
  it('divides the promoted value where the original used IDIV', () => {
    assert.strictEqual(run(LOG, { '/': 0, '%': 1 }, [{ operator: '%', ord: 0 }]),
      'void f(uint16_t wYear, uint16_t wMonth) { g((uint32_t)(wYear % 100), (uint32_t)wMonth); }');
    const b = 'uint32_t f(uint8_t c) { return (uint32_t)c / 0x18; }';
    assert.strictEqual(run(b, { '/': 1, '%': 0 }, [{ operator: '/', ord: 0 }]), 'uint32_t f(uint8_t c) { return (uint32_t)(c / 0x18); }');
  });

  it('leaves it without a fact, with a count that does not zip, or outside the shape', () => {
    assert.strictEqual(run(LOG, { '/': 0, '%': 1 }, []), untouched(LOG));
    assert.strictEqual(run(LOG, { '/': 0, '%': 2 }, [{ operator: '%', ord: 0 }]), untouched(LOG));
    // A dword dividend, an unsigned or variable divisor, a product of casts.
    for (const code of [
      'void f(uint32_t n) { g((uint32_t)n % 100); }',
      'void f(int16_t n) { g((uint32_t)n % 100); }',
      'void f(uint16_t w) { g((uint32_t)w % 100U); }',
      'void f(uint16_t w, int d) { g((uint32_t)w % d); }',
      'void f(uint8_t r) { g((uint32_t)r * (uint32_t)r / 0xff); }',
    ]) {
      const ops = (code.match(/ [/%] /g) ?? []).map(s => s.trim());
      const counts = { '/': ops.filter(o => o === '/').length, '%': ops.filter(o => o === '%').length };
      assert.strictEqual(run(code, counts, [{ operator: ops[0], ord: 0 }]), untouched(code), code);
    }
  });

  it('has the value of the unsigned division', { skip: !hasNativeGpp() }, () => {
    const prelude =
      'static uint32_t a(uint16_t w) { return (uint32_t)w % 100; }\n'
      + 'static uint32_t b(uint16_t w) { return (uint32_t)(w % 100); }\n'
      + 'static uint32_t c(uint16_t w) { return (uint32_t)w / 7; }\n'
      + 'static uint32_t d(uint16_t w) { return (uint32_t)(w / 7); }\n';
    const body = 'for (unsigned i = 0; i <= 0xffff; i++) if (a((uint16_t)i) != b((uint16_t)i) || c((uint16_t)i) != d((uint16_t)i)) printf("%u\\n", i);\n';
    assert.strictEqual(compileAndRun(prelude, body, {}), '');
  });
});
