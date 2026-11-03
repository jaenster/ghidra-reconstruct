/**
 * zext-site / arith-idioms: a 64-bit cast the decompiler printed for an INT_ZEXT of a signed
 * operation keeps the zero extension, and the 32-bit division then narrows.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, ASTNode } from '../../../ast/nodes.js';
import { createZextSiteTransformer, type ZextOperatorSite } from '../builtins/zext-site.js';
import { arithIdiomsPlugin } from '../builtins/arith-idioms.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

function run(code: string, counts: Record<string, number>, sites: ZextOperatorSite[]): string {
  const tagged = createZextSiteTransformer({ counts, sites })(parse(code) as ASTNode);
  return emit(arithIdiomsPlugin.createTransformer({})(tagged) as AnyNode).replace(/\s+/g, ' ').trim();
}

// MISSILE_CreateRandomSubInRadius 004cea00, D2Win Draw 005005b0.
const MISSILE = 'uint32_t f(int nRadius, uint32_t s) { return (uint32_t)((uint64_t)s % (uint64_t)(nRadius * 2 + 1)); }';
const DRAW = 'int f(uint32_t t, uint32_t n, int c) { return (int)((uint64_t)(t / n) % (uint64_t)(c - 1)); }';

describe('zext-site', () => {
  it('writes the zero extension of a tagged signed operation, then narrows the division', () => {
    assert.strictEqual(run(MISSILE, { '+': 1, '*': 1 }, [{ operator: '+', ord: 0 }]),
      'uint32_t f(int nRadius, uint32_t s) { return (uint32_t)(s % (uint32_t)(nRadius * 2 + 1)); }');
    assert.strictEqual(run(DRAW, { '/': 1, '-': 1 }, [{ operator: '-', ord: 0 }]),
      'int f(uint32_t t, uint32_t n, int c) { return (int)(t / n % (uint32_t)(c - 1)); }');
  });

  it('leaves the cast without a fact, with a count that does not zip, or of an unsigned dword', () => {
    const untouched = (code: string) => emit(arithIdiomsPlugin.createTransformer({})(parse(code)) as AnyNode).replace(/\s+/g, ' ').trim();
    assert.strictEqual(run(MISSILE, { '+': 1 }, []), untouched(MISSILE));
    assert.strictEqual(run(MISSILE, { '+': 2 }, [{ operator: '+', ord: 0 }]), untouched(MISSILE));
    const u = 'uint32_t f(uint32_t r, uint32_t s) { return (uint32_t)((uint64_t)s % (uint64_t)(r * 2 + 1)); }';
    assert.strictEqual(run(u, { '+': 1, '*': 1 }, [{ operator: '+', ord: 0 }]), untouched(u));
    assert.ok(!run(u, { '+': 1, '*': 1 }, [{ operator: '+', ord: 0 }]).includes('(uint32_t)(r'));
  });

  it('has the value of the p-code zero extension', { skip: !hasNativeGpp() }, () => {
    const folded = run(MISSILE, { '+': 1, '*': 1 }, [{ operator: '+', ord: 0 }]).replace(' f(', ' b(');
    const prelude =
      // INT_ZEXT of the 32-bit sum, then the 64-bit INT_REM, as the p-code computes it.
      'static uint32_t a(int nRadius, uint32_t s) { uint64_t z = (uint64_t)(uint32_t)(nRadius * 2 + 1); return (uint32_t)((uint64_t)s % z); }\n'
      + `static ${folded}\n`;
    const body = 'int r[] = { 0, 1, -1, 7, -7, 0x3fffffff, -0x40000000, -2, 1000 }; uint32_t s[] = { 0u, 1u, 5u, 0x7fffffffu, 0x80000000u, 0xffffffffu };\n'
      + 'for (unsigned i = 0; i < sizeof r / sizeof r[0]; i++) for (unsigned j = 0; j < sizeof s / sizeof s[0]; j++) {\n'
      + '  if ((uint32_t)(r[i] * 2 + 1) == 0) continue; if (a(r[i], s[j]) != b(r[i], s[j])) printf("%d %u\\n", r[i], s[j]); }\n';
    assert.strictEqual(compileAndRun(prelude, body, { flags: ['-fwrapv'] }), '');
  });
});
