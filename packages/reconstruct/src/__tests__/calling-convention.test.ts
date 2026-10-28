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
 * `__stdcall`, `__fastcall` and `__thiscall` are spelled. `__cdecl` and
 * `unknown` are not — see `codegen/calling-convention.ts` for why — so both are
 * asserted absent.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Type, emit } from '@ghidra-mcp/cpp-parser';

import { generateFunctionDeclaration, generateFunctionDefinitionDeclaration } from '../codegen/header.js';
import { generateEhHandlerDefinition } from '../codegen/impl.js';
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

  it('leaves __cdecl and unknown unspelled', () => {
    for (const cc of ['__cdecl', 'unknown']) {
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

describe('the overload-selecting cast names the convention too', () => {
  it('emits `R (__stdcall *)(args)` for a pointer to a function type carrying one', () => {
    const type = Type.pointer(
      Type.function(Type.typedef('BOOL'), [Type.pointer(Type.typedef('D2WinButton'))], false, '__stdcall')
    );
    assert.strictEqual(emit(type), 'BOOL (__stdcall *)(D2WinButton*)');
  });

  it('emits no convention when the function type carries none', () => {
    const type = Type.pointer(
      Type.function(Type.typedef('BOOL'), [Type.pointer(Type.typedef('D2WinButton'))])
    );
    assert.strictEqual(emit(type), 'BOOL (*)(D2WinButton*)');
  });
});

/**
 * ForEachClient loads ECX with the client and EDX with its context argument
 * before `CALL EDI` (0052df26..0052df2a): the callback slot is `__fastcall`, and
 * so are the chat senders handed to it. Emitted without the keyword, both halves
 * were `__cdecl` and agreed with each other while disagreeing with the binary,
 * so every chat broadcast ran on stale registers.
 */
function chatSender(): ExtractedFunction {
  return {
    name: 'CHAT_BroadcastToClient',
    address: '0x00000000',
    signature: 'void CHAT_BroadcastToClient(D2ClientStrc *, void *)',
    returnType: 'void',
    parameters: [
      { name: 'pClient', dataType: 'D2ClientStrc *', size: 4, ordinal: 0, storage: 'ECX:4' },
      { name: 'pPacket', dataType: 'void *', size: 4, ordinal: 1, storage: 'EDX:4' },
    ],
    localVariables: [],
    callingConvention: '__fastcall',
    size: 32,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
  };
}

const forEachClientFn: ExtractedFunctionDefinition = {
  name: 'fpForEachClientFn',
  category: '/Diablo2/D2Game',
  kind: 'FUNCTION_DEFINITION',
  size: 4,
  returnType: 'void',
  parameters: [
    { name: 'pClient', dataType: 'D2ClientStrc *', ordinal: 0 },
    { name: 'pContext', dataType: 'void *', ordinal: 1 },
  ],
  callingConvention: '__fastcall',
};

function hasGpp(): boolean {
  try { execFileSync('i686-w64-mingw32-g++', ['--version'], { stdio: 'pipe' }); return true; } catch { return false; }
}

describe('__fastcall is spelled on functions and funcdefs alike', () => {
  it('spells __fastcall on a declaration and on a definition head', () => {
    const decl = generateFunctionDeclaration(chatSender(), options);
    assert.match(decl, /void __fastcall CHAT_BroadcastToClient\(D2ClientStrc \* pClient, void \* pPacket\);/);
    const def = generateEhHandlerDefinition(chatSender());
    assert.match(def, /void __fastcall CHAT_BroadcastToClient\(D2ClientStrc \* pClient, void \* pPacket\) \{/);
  });

  it('spells __fastcall inside the funcdef typedef declarator', () => {
    assert.strictEqual(
      generateFunctionDefinitionDeclaration(forEachClientFn),
      'typedef void (__fastcall *fpForEachClientFn)(D2ClientStrc * pClient, void * pContext);'
    );
  });

  it('lets a __fastcall callback convert to a __fastcall funcdef parameter with no cast', { skip: !hasGpp() }, () => {
    const src = [
      'struct D2ClientStrc;',
      generateFunctionDefinitionDeclaration(forEachClientFn),
      'void ForEachClient(void * pGame, fpForEachClientFn fpFunction, void * pUnit);',
      generateFunctionDeclaration(chatSender(), options),
      'void Broadcast(void * pGame, void * pPacket) { ForEachClient(pGame, CHAT_BroadcastToClient, pPacket); }',
    ].join('\n');
    assert.match(src, /\(__fastcall \*fpForEachClientFn\)/);
    assert.match(src, /void __fastcall CHAT_BroadcastToClient/);
    const dir = mkdtempSync(join(tmpdir(), 'fastcall-'));
    const file = join(dir, 'chat.cpp');
    writeFileSync(file, src);
    execFileSync('i686-w64-mingw32-g++', ['-std=c++17', '-fsyntax-only', file], { stdio: 'pipe' });

    // The same pair with the callback left `__cdecl` is a type error: the
    // conversion this test relies on is the ABI agreeing, not the absence of one.
    const mismatched = src.replace('void __fastcall CHAT_BroadcastToClient', 'void CHAT_BroadcastToClient');
    writeFileSync(file, mismatched);
    assert.throws(() => execFileSync('i686-w64-mingw32-g++', ['-std=c++17', '-fsyntax-only', file], { stdio: 'pipe' }));
  });

  it('leaves a parameterless __fastcall unspelled on both sides, and keeps a parameterless __stdcall', () => {
    const noArgs: ExtractedFunction = { ...chatSender(), name: 'UIAction_ResetKeyBindingsToDefaults', parameters: [] };
    assert.match(generateFunctionDeclaration(noArgs, options), /^void UIAction_ResetKeyBindingsToDefaults\(/m);
    assert.strictEqual(
      generateFunctionDefinitionDeclaration({ ...forEachClientFn, name: 'pfnUIConfigTabAction', parameters: [] }),
      'typedef void (*pfnUIConfigTabAction)();'
    );
    assert.match(
      generateFunctionDeclaration({ ...noArgs, name: 'GetTickCountThunk', callingConvention: '__stdcall' }, options),
      /void __stdcall GetTickCountThunk\(/
    );
  });
});

/**
 * A `__thiscall` function is emitted free with its receiver as the first
 * parameter; the keyword is what puts that receiver in ECX. The funcdef a
 * vtable slot is declared with carries the same keyword, so the function
 * converts to the slot with no cast and a call through the slot loads ECX.
 */
function listBoxDestructor(): ExtractedFunction {
  return {
    name: 'LISTBOX_Destroy',
    address: '0x00000000',
    signature: 'void * __thiscall LISTBOX_Destroy(D2ListBoxStrc * this, int bFree)',
    returnType: 'void *',
    parameters: [
      { name: 'this', dataType: 'D2ListBoxStrc *', size: 4, ordinal: 0, storage: 'ECX:4' },
      { name: 'bFree', dataType: 'int', size: 4, ordinal: 1, storage: 'Stack[0x4]:4' },
    ],
    localVariables: [],
    callingConvention: '__thiscall',
    size: 32,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
  };
}

const destructorSlot: ExtractedFunctionDefinition = {
  name: 'fpListBoxDestroy',
  category: '/Diablo2/D2Win',
  kind: 'FUNCTION_DEFINITION',
  size: 4,
  returnType: 'void *',
  parameters: [
    { name: 'this', dataType: 'D2ListBoxStrc *', ordinal: 0 },
    { name: 'bFree', dataType: 'int', ordinal: 1 },
  ],
  callingConvention: '__thiscall',
};

describe('__thiscall is spelled on functions and funcdefs alike', () => {
  it('spells __thiscall on a declaration and on a definition head', () => {
    const decl = generateFunctionDeclaration(listBoxDestructor(), options);
    assert.match(decl, /void \* __thiscall LISTBOX_Destroy\(D2ListBoxStrc \* pThis, int bFree\);/);
    const def = generateEhHandlerDefinition(listBoxDestructor());
    assert.match(def, /void \* __thiscall LISTBOX_Destroy\(D2ListBoxStrc \* pThis, int bFree\) \{/);
  });

  it('spells __thiscall inside the funcdef typedef declarator', () => {
    assert.strictEqual(
      generateFunctionDefinitionDeclaration(destructorSlot),
      'typedef void * (__thiscall *fpListBoxDestroy)(D2ListBoxStrc * pThis, int bFree);'
    );
  });

  it('spells __thiscall in a cast to a pointer to a function type carrying it', () => {
    const type = Type.pointer(
      Type.function(Type.pointer(Type.typedef('void')), [Type.pointer(Type.typedef('D2ListBoxStrc')), Type.typedef('int')], false, '__thiscall')
    );
    assert.strictEqual(emit(type), 'void* (__thiscall *)(D2ListBoxStrc*, int)');
  });

  it('leaves a parameterless or variadic __thiscall unspelled on both sides', () => {
    const noArgs: ExtractedFunction = { ...listBoxDestructor(), name: 'LISTBOX_Reset', returnType: 'void', parameters: [] };
    assert.match(generateFunctionDeclaration(noArgs, options), /^void LISTBOX_Reset\(\);/m);
    assert.strictEqual(
      generateFunctionDefinitionDeclaration({ ...destructorSlot, name: 'fpReset', returnType: 'void', parameters: [] }),
      'typedef void (*fpReset)();'
    );
    const variadic: ExtractedFunction = { ...listBoxDestructor(), name: 'LISTBOX_Printf', hasVarArgs: true };
    assert.match(generateFunctionDeclaration(variadic, options), /^void \* LISTBOX_Printf\(D2ListBoxStrc \* pThis, int bFree, \.\.\.\);/m);
    assert.strictEqual(
      generateFunctionDefinitionDeclaration({ ...destructorSlot, name: 'fpPrintf', hasVarArgs: true }),
      'typedef void * (*fpPrintf)(D2ListBoxStrc * pThis, int bFree, ...);'
    );
  });

  it('stores a __thiscall function in its __thiscall slot with no cast, and passes the receiver in ECX', { skip: !hasGpp() }, () => {
    const src = [
      'struct D2ListBoxStrc { int nCount; };',
      generateFunctionDefinitionDeclaration(destructorSlot),
      'struct D2ListBoxVtable { fpListBoxDestroy pfnDestroy; };',
      generateFunctionDeclaration(listBoxDestructor(), options),
      generateEhHandlerDefinition(listBoxDestructor()).replace(/\{[\s\S]*\}/, '{ pThis->nCount = bFree; return pThis; }'),
      'void Install(D2ListBoxVtable * pVtable) { pVtable->pfnDestroy = LISTBOX_Destroy; }',
    ].join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'thiscall-'));
    const file = join(dir, 'listbox.cpp');
    writeFileSync(file, src);
    execFileSync('i686-w64-mingw32-g++', ['-std=c++17', '-O2', '-c', file, '-o', join(dir, 'listbox.o')], { stdio: 'pipe' });
    const asm = execFileSync('i686-w64-mingw32-objdump', ['-d', join(dir, 'listbox.o')], { encoding: 'utf8' });
    // The receiver arrives in ECX; the one stack argument is popped by the callee.
    const body = asm.slice(asm.indexOf('LISTBOX_Destroy'));
    assert.match(body, /%ecx/);
    assert.match(body, /ret\s+\$0x4/);

    // A __cdecl function in that slot is a type error: the ABI must agree.
    writeFileSync(file, src.replace('void * __thiscall LISTBOX_Destroy', 'void * LISTBOX_Destroy'));
    assert.throws(() => execFileSync('i686-w64-mingw32-g++', ['-std=c++17', '-fsyntax-only', file], { stdio: 'pipe' }));
  });
});
