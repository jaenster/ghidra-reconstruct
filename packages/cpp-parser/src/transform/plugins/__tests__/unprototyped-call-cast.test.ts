/**
 * Unprototyped-Call-Cast Plugin Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { unprototypedCallCastPlugin } from '../builtins/unprototyped-call-cast.js';

describe('unprototypedCallCastPlugin', () => {
  const run = (code: string, options: Record<string, unknown> = {}): string =>
    emit(unprototypedCallCastPlugin.createTransformer(options)(parse(code)) as AnyNode)
      .replace(/\s+/g, ' ')
      .trim();

  // ---- must fix ----

  it('restores the parameter list on a FARPROC call that carries arguments', () => {
    // ApplicationMain 00405d98: CALL EDI after one PUSH, no ESP fixup.
    const out = run(`void f() {
      FARPROC pfnKeyhook;
      HWND hWnd;
      (*pfnKeyhook)(hWnd);
    }`);
    assert.ok(out.includes('((intptr_t (__stdcall *)(HWND))pfnKeyhook)(hWnd)'), out);
  });

  it('reaches the same slot when the call is written without the dereference', () => {
    const out = run(`void f() { FARPROC pfn; HWND h; pfn(h); }`);
    assert.ok(out.includes('((intptr_t (__stdcall *)(HWND))pfn)(h)'), out);
  });

  it('writes one parameter per argument, in order', () => {
    const out = run(`void f() { FARPROC pfn; HWND h; uint32_t n; pfn(h, n, h); }`);
    assert.ok(out.includes('(intptr_t (__stdcall *)(HWND, unsigned int, HWND))'), out);
  });

  it('places a slot declared outside the body, from its recorded spelling', () => {
    const out = run(`void f() { HWND h; gpfnHook(h); }`, {
      globalTypes: { gpfnHook: 'FARPROC' },
    });
    assert.ok(out.includes('((intptr_t (__stdcall *)(HWND))gpfnHook)(h)'), out);
  });

  it('types an argument read from a struct field the model can place', () => {
    const out = run(`void f() { FARPROC pfn; pCtx->hWindow; pfn(pCtx->hWindow); }`, {
      fieldTypes: { hWindow: 'HWND' },
    });
    assert.ok(out.includes('(intptr_t (__stdcall *)(HWND))'), out);
  });

  // ---- must NOT fix ----

  it('leaves a zero-argument FARPROC call alone - `()` already means that in C++', () => {
    // The SAME variable at 00405eaa: CALL EAX with nothing pushed. Casting it
    // to the install hook's signature is the corruption this pass avoids.
    const out = run(`void f() { FARPROC pfnKeyhook; (*pfnKeyhook)(); }`);
    assert.ok(out.includes('(*pfnKeyhook)()'), out);
    assert.ok(!out.includes('__stdcall'), out);
  });

  it('leaves a call through a PROTOTYPED function pointer alone', () => {
    // The slot's own declaration already carries the parameter list; there is
    // nothing to restore, and a cast would only be a chance to name it wrong.
    const out = run(`void f() { HWND h; (*fpDraw)(h); }`, {
      globalTypes: { fpDraw: 'void (*)(HWND)' },
    });
    assert.ok(out.includes('(*fpDraw)(h)'), out);
    assert.ok(!out.includes('__stdcall'), out);
  });

  it('leaves a plain function call alone', () => {
    const out = run(`void f() { HWND h; InstallKeyboardHook(h); }`);
    assert.ok(!out.includes('__stdcall'), out);
  });

  it('refuses when an argument type cannot be determined', () => {
    const out = run(`void f() { FARPROC pfn; pfn(nSomethingUndeclared); }`);
    assert.ok(out.includes('pfn(nSomethingUndeclared)'), out);
    assert.ok(!out.includes('__stdcall'), out);
  });

  it('refuses when only SOME argument types are known', () => {
    const out = run(`void f() { FARPROC pfn; HWND h; pfn(h, nUnknown); }`);
    assert.ok(!out.includes('__stdcall'), out);
  });

  it('leaves an unregistered opaque typedef alone', () => {
    const out = run(`void f() { PROC pfn; HWND h; (*pfn)(h); }`);
    assert.ok(!out.includes('__stdcall'), out);
  });

  it('honours a caller-supplied registry instead of the default', () => {
    const out = run(`void f() { PROC pfn; HWND h; (*pfn)(h); }`, {
      unprototypedFuncPtrs: { PROC: { returnType: 'int' } },
    });
    assert.ok(out.includes('((int (*)(HWND))pfn)(h)'), out);
  });
});
