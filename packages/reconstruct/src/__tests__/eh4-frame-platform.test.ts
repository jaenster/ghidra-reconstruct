/**
 * EH4 frames (Ghidra round O2 typed their registration EH4_EXCEPTION_REGISTRATION,
 * category /CRT/SEH, which the CRT exclusion filters): d2_platform.h defines the type,
 * `__except_handler4` is declared with the handler type the frame stores, and the
 * TEB's `void*` ExceptionList is cast into the typed `Next` link, as C converted it.
 * v1410: 8 errors in Fog/Debug.cpp, Fog/Engine/Application.cpp and Fog/Src/LogManager.cpp.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateProject } from '../codegen/index.js';
import { generatePlatformHeader } from '../codegen/platform-types.js';
import { sehLoweringDecision } from '../codegen/seh-lowering-spec.js';
import type { AnalyzedDataSymbol, ExtractedFunction, ReconstructOptions } from '../types.js';

const options: ReconstructOptions = {
  outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false,
  generateSourceMaps: false, transformPreset: 'full', includeAddressComments: false,
  promoteStaticGlobals: false,
};

const DEBUG_THREAD = `
/* @function DebugThread */

void Fog::Debug::DebugThread(void)

{
  EH4_EXCEPTION_REGISTRATION tSehFrame;
  
  tSehFrame.TryLevel = -2;
  tSehFrame.ExceptionHandler = compiler::__except_handler4;
  tSehFrame.Next = ExceptionList;
  ExceptionList = &tSehFrame;
  tSehFrame.TryLevel = 0;
  ExceptionList = tSehFrame.Next;
  return;
}
`;

describe('EH4 frames', () => {
  it('d2_platform.h defines the registration and declares the handler with its field type', () => {
    const h = generatePlatformHeader({} as never);
    assert.match(h, /struct EH4_EXCEPTION_REGISTRATION \{/);
    assert.match(h, /EH4_EXCEPT_HANDLER ExceptionHandler;/);
    assert.match(h, /extern "C" int __except_handler4\(struct _EXCEPTION_RECORD\* pExceptionRecord, EH4_EXCEPTION_REGISTRATION\* pRegistration, CONTEXT\* pContext, void\* pDispatcherContext\);/);
  });

  it('the void* ExceptionList is cast into the typed Next link', () => {
    const fn = {
      name: 'DebugThread', address: '00401a70', signature: 'void DebugThread(void)', returnType: 'void',
      parameters: [], localVariables: [], callingConvention: '__stdcall', size: 0x80, isThunk: false,
      isExternal: false, hasVarArgs: false, namespace: 'Fog::Debug', decompiled: DEBUG_THREAD,
      calledFunctions: [],
    } as unknown as ExtractedFunction;
    const list = {
      name: 'ExceptionList', address: 'ffdff000', dataType: 'void *', size: 4, scope: 'global',
      referencingFunctions: ['Fog::Debug::DebugThread', 'Other::f'], isInitialized: false,
    } as unknown as AnalyzedDataSymbol;
    const project = generateProject('T', [fn], [], [], [list], [], options);
    const cpp = [...project.files.values()].find(f => f.path.endsWith('.cpp') && f.content.includes('DebugThread('));
    assert.ok(cpp);
    assert.match(cpp!.content, /tSehFrame\.Next = \(EH4_EXCEPTION_REGISTRATION ?\*\)ExceptionList;/, cpp!.content);
  });

  it('is reported, not lowered', () => {
    const d = sehLoweringDecision({ sehFrame: { kind: 'eh4', scopeTable: '00702290', handlerSymbol: '__except_handler4', entries: [], tryLevelStores: {} } as never });
    assert.deepStrictEqual(d, { lower: false, reason: 'eh4 frames are not lowered' });
  });
});
