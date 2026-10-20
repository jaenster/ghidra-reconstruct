/**
 * An indirect call through an untyped pointer takes the type of Ghidra's call-site
 * override. Real case: TXT_ParseDataAndPutIntoStructure 006be01a calls the `void *`
 * field D2BinFieldInputStrc.fpLinker with the six-argument linker prototype
 * (/auto_proto/dt_43fbd679), and 006bdeeb with the one-argument key lookup.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createCallSiteOverrideCastTransformer, type CallSiteOverride } from '../builtins/call-site-override-cast.js';

const structFields = { D2BinFieldInputStrc: { fpLinker: 'void *', nSize: 'int' } };

function transform(code: string, overrides: CallSiteOverride[], used = new Set<string>()): string {
  return emit(createCallSiteOverrideCastTransformer({ overrides, usedTypedefs: used, structFields })(parse(code)) as AnyNode).trim();
}

const BODY = `void f(D2BinFieldInputStrc* pIn, char* a, void* b, int c, int d, int e, int g) {
  (*pIn->fpLinker)(a, b, c, d, e, g);
  pIn->fpLinker(a);
}`;

describe('call-site-override-cast', () => {
  it('casts each untyped call to the override of its arity, and reports the typedef', () => {
    const used = new Set<string>();
    const out = transform(BODY, [
      { funcdef: 'dt_9d1fdd79', arity: 1 },
      { funcdef: 'dt_43fbd679', arity: 6 },
      { funcdef: 'dt_43fbd679', arity: 6 },
    ], used);
    assert.match(out, /\(\(dt_43fbd679\)pIn->fpLinker\)\(a, b, c, d, e, g\)/);
    assert.match(out, /\(\(dt_9d1fdd79\)pIn->fpLinker\)\(a\)/);
    assert.deepStrictEqual([...used].sort(), ['dt_43fbd679', 'dt_9d1fdd79']);
  });

  it('leaves a call alone when two different overrides share its arity', () => {
    const out = transform(BODY, [{ funcdef: 'dt_a', arity: 1 }, { funcdef: 'dt_b', arity: 1 }]);
    assert.ok(!out.includes('dt_'), out);
  });

  it('leaves a typed callee alone', () => {
    const out = transform('void f(int (*pfn)(int)) { pfn(1); }', [{ funcdef: 'dt_a', arity: 1 }]);
    assert.ok(!out.includes('dt_a'), out);
  });
});

describe('call-site-override-cast: the decompiler\'s code * cast', () => {
  it('is replaced by the override\'s cast, not stacked under it (LRUCACHE_ForEach)', () => {
    const out = transform('int f(void *pfnCallback, void *pEntry, int d) { return (*(code *)pfnCallback)(pEntry, d); }',
      [{ funcdef: 'dt_43f4227c', arity: 2 }]);
    assert.match(out, /\(\(dt_43f4227c\)pfnCallback\)\(pEntry, d\)/, out);
    assert.ok(!out.includes('code'), out);
  });
});
