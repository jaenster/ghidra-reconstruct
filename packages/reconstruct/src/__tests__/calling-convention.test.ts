/**
 * Regression test: a function whose Ghidra type carries a calling convention
 * must emit with it.
 *
 * The convention is part of the function's type on this ABI, so a `__stdcall`
 * thread entry point emitted bare is a `__cdecl` function and will not convert
 * to `LPTHREAD_START_ROUTINE`, `WNDPROC` or `LPHANDLER_FUNCTION`. Ghidra records
 * the convention at every address; dropping it in the emitter is what made those
 * conversions impossible.
 *
 * `__thiscall` and `__cdecl` are deliberately NOT spelled — see
 * `codegen/calling-convention.ts` for why — so both are asserted absent.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateFunctionDeclaration, generateFunctionDefinitionDeclaration } from '../codegen/header.js';
import type {
  ExtractedFunction,
  ExtractedFunctionDefinition,
  ReconstructOptions,
} from '../types.js';

const options: ReconstructOptions = {
  outputDir: '/tmp/test',
  format: 'cpp',
  organization: 'flat',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
  promoteStaticGlobals: false,
};

function threadProc(callingConvention: string): ExtractedFunction {
  return {
    name: 'GetDnsResults',
    address: '0x0051bee0',
    signature: 'DWORD GetDnsResults(void *)',
    returnType: 'DWORD',
    parameters: [
      { name: 'lpThreadParam', dataType: 'void *', size: 4, ordinal: 0, storage: 'Stack[0x4]:4' },
    ],
    localVariables: [],
    callingConvention,
    size: 128,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
  };
}

describe('calling conventions in emitted declarations', () => {
  it('spells __stdcall on a declaration whose Ghidra type carries it', () => {
    const decl = generateFunctionDeclaration(threadProc('__stdcall'), options);
    assert.match(decl, /DWORD __stdcall GetDnsResults\(void \* lpThreadParam\);/);
  });

  it('leaves __cdecl, __thiscall and unknown unspelled', () => {
    for (const cc of ['__cdecl', '__thiscall', 'unknown']) {
      const decl = generateFunctionDeclaration(threadProc(cc), options);
      assert.match(decl, /DWORD GetDnsResults\(/, `convention ${cc} should not be spelled`);
      assert.doesNotMatch(decl, /__cdecl|__thiscall|unknown/);
    }
  });

  it('spells the convention inside a function-pointer typedef declarator', () => {
    const fd: ExtractedFunctionDefinition = {
      name: 'fpWindowProc',
      category: '/Diablo2/D2GFX',
      kind: 'FUNCTION_DEFINITION',
      size: 4,
      returnType: 'LRESULT',
      parameters: [{ name: 'hWnd', dataType: 'HWND', ordinal: 0 }],
      callingConvention: '__stdcall',
    };
    assert.strictEqual(
      generateFunctionDefinitionDeclaration(fd),
      'typedef LRESULT (__stdcall *fpWindowProc)(HWND hWnd);'
    );
    assert.strictEqual(
      generateFunctionDefinitionDeclaration({ ...fd, callingConvention: 'unknown' }),
      'typedef LRESULT (*fpWindowProc)(HWND hWnd);'
    );
  });
});
