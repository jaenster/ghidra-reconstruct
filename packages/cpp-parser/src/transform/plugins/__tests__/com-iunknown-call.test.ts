/**
 * A C-COM call through Ghidra's `IUnknown *` is respelled against the platform's C++
 * `IUnknown` (mingw <unknwnbase.h>), which has the methods but no `lpVtbl`.
 * Real 1.14d sites: the d3d texture/floor/subtile cache release loops and
 * `gpDDrawComObject->lpVtbl->Release(gpDDrawComObject)` in DirectDraw's Release.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createComIUnknownCallTransformer } from '../builtins/com-iunknown-call.js';

function transform(code: string, globalTypes: Record<string, string> = {}): string {
  return emit(createComIUnknownCallTransformer({ globalTypes })(parse(code)) as AnyNode).trim();
}

describe('com-iunknown-call', () => {
  it('a local IUnknown * releases through the C++ method', () => {
    const out = transform('void f(void) { IUnknown* pIface; pIface = Get(); if (pIface) { pIface->lpVtbl->Release(pIface); } }');
    assert.match(out, /pIface->Release\(\);/);
    assert.ok(!out.includes('lpVtbl'), out);
  });

  it('a global IUnknown *, and the deref-call spelling', () => {
    const out = transform('void f(void) { (*gpDDrawComObject->lpVtbl->Release)(gpDDrawComObject); }',
      { gpDDrawComObject: 'IUnknown *' });
    assert.match(out, /gpDDrawComObject->Release\(\);/);
  });

  it('QueryInterface keeps its remaining arguments in order', () => {
    const out = transform('long f(IUnknown* p, void* iid, void** pp) { return p->lpVtbl->QueryInterface(p, iid, pp); }');
    assert.match(out, /p->QueryInterface\(iid, pp\)/);
  });

  it('leaves another interface, another receiver, or another method alone', () => {
    for (const src of [
      'void f(IDirectDrawSurface7* p) { p->lpVtbl->Release(p); }',
      'void f(IUnknown* p, IUnknown* q) { p->lpVtbl->Release(q); }',
      'void f(IUnknown* p) { p->lpVtbl->Frob(p); }',
    ]) {
      assert.match(transform(src), /lpVtbl/, src);
    }
  });
});
