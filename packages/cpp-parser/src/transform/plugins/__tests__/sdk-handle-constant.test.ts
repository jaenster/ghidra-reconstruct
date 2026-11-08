/**
 * SDK Handle Constant Plugin Tests
 *
 * A predefined registry key and a loader's integer resource id are spelled with the SDK
 * macro that defines them. The value test compiles both spellings against the SDK's own
 * headers: on the 32-bit target they must be the same pointer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { sdkHandleConstantPlugin } from '../builtins/sdk-handle-constant.js';
import { compileAndRun, hasNativeGpp, testToolchain } from '../../../testing/native-cpp.js';

describe('sdkHandleConstantPlugin', () => {
  const transform = (code: string): string =>
    emit(sdkHandleConstantPlugin.createTransformer({})(parse(code)) as AnyNode).replace(/\s+/g, ' ').trim();
  const squash = (s: string) => s.replace(/\s+/g, '');
  const native = { skip: !hasNativeGpp() || testToolchain()?.name !== 'mingw' };

  it('STRTABLE_GetRegistryLanguage: (HKEY)0x80000001 is HKEY_CURRENT_USER', () => {
    const out = transform(`void f() { RegOpenKeyExA((HKEY)0x80000001, "x", 0, 0x20019, &hKey); RegOpenKeyA((HKEY)0x80000002, "y", &h); }`);
    assert.ok(squash(out).includes('RegOpenKeyExA(HKEY_CURRENT_USER,'), out);
    assert.ok(squash(out).includes('RegOpenKeyA(HKEY_LOCAL_MACHINE,'), out);
  });

  it('SREG_InternalSaveEntry: a select between two keys selects between their names', () => {
    const out = transform(`void f(int dwFlags) { RegCreateKeyExA((HKEY)((dwFlags & 4) != 0 ? 0x80000002 : 0x80000001), s, 0); }`);
    assert.ok(squash(out).includes('RegCreateKeyExA((dwFlags&4)!=0?HKEY_LOCAL_MACHINE:HKEY_CURRENT_USER,s,0)'), out);
  });

  it('leaves a key that is not predefined, and a select with one, alone', () => {
    const out = transform(`void f(int c) { g((HKEY)0x0); g((HKEY)0x80000010); g((HKEY)(c ? 0x80000001 : 7)); }`);
    assert.ok(squash(out).includes('g((HKEY)0x0)'), out);
    assert.ok(squash(out).includes('g((HKEY)0x80000010)'), out);
    assert.ok(squash(out).includes('g((HKEY)(c?0x80000001:7))'), out);
  });

  it('D2GFX_Initialize: a loader\'s integer resource name is MAKEINTRESOURCE', () => {
    const out = transform(`void f(int b) {
      h = LoadImageA(hInstance, (LPCSTR)(b != 0 ? 0x67 : 0x66), 1, 0, 0, 0);
      c = LoadCursorA((HINSTANCE)0x0, (LPCSTR)0x7f00);
      a = LoadAcceleratorsA(ghLib, (LPCSTR)0x64);
    }`);
    assert.ok(squash(out).includes('LoadImageA(hInstance,b!=0?MAKEINTRESOURCEA(0x67):MAKEINTRESOURCEA(0x66),1,0,0,0)'), out);
    assert.ok(squash(out).includes('LoadCursorA((HINSTANCE)0x0,MAKEINTRESOURCEA(0x7f00))'), out);
    assert.ok(squash(out).includes('LoadAcceleratorsA(ghLib,MAKEINTRESOURCEA(0x64))'), out);
  });

  it('leaves a null name, an id past 16 bits and a name of any other function alone', () => {
    const out = transform(`void f() { LoadIconA(h, (LPCSTR)0x0); LoadIconA(h, (LPCSTR)0x10000); g(h, (LPCSTR)0x64); }`);
    assert.ok(squash(out).includes('LoadIconA(h,(LPCSTR)0x0)'), out);
    assert.ok(squash(out).includes('LoadIconA(h,(LPCSTR)0x10000)'), out);
    assert.ok(squash(out).includes('g(h,(LPCSTR)0x64)'), out);
  });

  it('the SDK names are the same handles on the target', native, () => {
    const prelude = `
      #include <windows.h>
      #include <stdio.h>
      static unsigned key(HKEY k) { return (unsigned)(UINT_PTR)k; }
      static unsigned name(LPCSTR s) { return (unsigned)(UINT_PTR)s; }
      static unsigned LoadIconA_(HINSTANCE, LPCSTR s) { return name(s); }`;
    const fn = `
      static unsigned f(int c) {
        return key((HKEY)0x80000001) ^ key((HKEY)0x80000002) * 3 ^ key((HKEY)(c ? 0x80000002 : 0x80000001)) * 5
          ^ name((LPCSTR)(c ? 0x67 : 0x66)) * 7;
      }
      static unsigned g(int c) { return LoadIconA_((HINSTANCE)0x0, (LPCSTR)(c ? 0x67 : 0x66)); }`;
    // The loader is a stand-in with the real one's name, so the rewrite applies.
    const out = transform(fn.replace(/LoadIconA_/g, 'LoadIconA')).replace(/LoadIconA/g, 'LoadIconA_');
    assert.ok(squash(out).includes('HKEY_CURRENT_USER'), out);
    assert.ok(squash(out).includes('MAKEINTRESOURCEA(0x67)'), out);
    const call = `printf("%u %u %u %u\\n", f(0), f(1), g(0), g(1));`;
    assert.strictEqual(compileAndRun(prelude + out, call), compileAndRun(prelude + fn, call));
  });
});
