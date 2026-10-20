/** The address of InterlockedCompareExchange is the __stdcall forwarder's; calls keep the intrinsic. */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { importAddressForwarderPlugin } from '../builtins/import-address-forwarder.js';

const t = (c: string) => emit(importAddressForwarderPlugin.createTransformer({})(parse(c)) as AnyNode).trim();

describe('import-address-forwarder', () => {
  it('respells only the address-taken use', () => {
    const out = t('void f(LONG *p) { fnInterlockedCompareExchange pfn; pfn = InterlockedCompareExchange_exref; InterlockedCompareExchange(p, 0, 0); s.InterlockedCompareExchange = 0; }');
    assert.match(out, /pfn = d2_InterlockedCompareExchange;/);
    assert.match(out, /\n\s*InterlockedCompareExchange\(p, 0, 0\);/);
    assert.match(out, /s\.InterlockedCompareExchange = 0;/);
  });
});
