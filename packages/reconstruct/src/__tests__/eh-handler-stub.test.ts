/**
 * Compiler-generated MSVC C++ EH handler stubs (`__ehhandler$`, 1.14d 0x6c9bfb-0x6ca6c5):
 * their FuncInfo chain is not reconstructible, so each is defined as a frame that handles
 * nothing, and the tree links with no symbol left undefined.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { isMsvcEhHandlerStub } from '../codegen/eh-handler-stub.js';
import { generateEhHandlerDefinition } from '../codegen/impl.js';
import type { ExtractedFunction } from '../types.js';

const stub = (calls: string) => ({
  name: '__GSHandlerCheck_EH_6c9bfb',
  decompiled: `_EXCEPTION_DISPOSITION __cdecl
Fog::Src::ErrorManager::__GSHandlerCheck_EH_6c9bfb
          (EHExceptionRecord *pExceptionRecord,EHRegistrationNode *pRegistrationNode,
          _CONTEXT *pContext,void *pDispatcherContext)

{
  _EXCEPTION_DISPOSITION _Var1;
  ${calls}
  _Var1 = compiler::FID_conflict____CxxFrameHandler3
                    (pExceptionRecord,pRegistrationNode,pContext,pDispatcherContext,
                     &FuncInfo_00700a78);
  return _Var1;
}
`,
});
const globals = { FuncInfo_00700a78: 'FuncInfo' };

describe('isMsvcEhHandlerStub', () => {
  it('recognises the stub, with or without /GS guard calls', () => {
    assert.ok(isMsvcEhHandlerStub(stub(''), globals));
    assert.ok(isMsvcEhHandlerStub(stub('Fog::Debug::GuardStack();\n  Fog::Debug::GuardStack();'), globals));
  });
  it('needs the FuncInfo to be EH metadata', () => {
    assert.ok(!isMsvcEhHandlerStub(stub(''), { FuncInfo_00700a78: 'int' }));
    assert.ok(!isMsvcEhHandlerStub(stub(''), {}));
  });
  it('a function that does anything else is not a stub', () => {
    assert.ok(!isMsvcEhHandlerStub(stub('LogError("x");'), globals));
  });
});

describe('generateEhHandlerDefinition', () => {
  const handler = (returnType: string): ExtractedFunction => ({
    name: '__GSHandlerCheck_EH_6c9bfb',
    address: 'ram:006c9bfb',
    signature: `${returnType} __GSHandlerCheck_EH_6c9bfb()`,
    returnType,
    parameters: [
      { name: 'pExceptionRecord', dataType: 'EHExceptionRecord *', size: 4, ordinal: 0 },
      { name: 'pRegistrationNode', dataType: 'EHRegistrationNode *', size: 4, ordinal: 1 },
      { name: 'pContext', dataType: '_CONTEXT *', size: 4, ordinal: 2 },
      { name: 'pDispatcherContext', dataType: 'void *', size: 4, ordinal: 3 },
    ],
    localVariables: [],
    namespace: 'Fog::Src::ErrorManager',
    callingConvention: '__cdecl',
    size: 0x20,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
  });

  it('defines the declared signature and returns ExceptionContinueSearch', () => {
    const out = generateEhHandlerDefinition(handler('_EXCEPTION_DISPOSITION'));
    const lines = out.split('\n');
    assert.ok(lines[0].startsWith('// 1.14d: 006c9bfb'), lines[0]);
    assert.match(lines[1], /^_EXCEPTION_DISPOSITION\s.*__GSHandlerCheck_EH_6c9bfb\(EHExceptionRecord \* ?pExceptionRecord, EHRegistrationNode \* ?pRegistrationNode, _CONTEXT \* ?pContext, void \* ?pDispatcherContext\) \{$/);
    assert.strictEqual(lines[2], '    return ExceptionContinueSearch;');
    assert.strictEqual(lines[3], '}');
  });

  it('does not emit the decompiled call into the frame handler', () => {
    assert.ok(!generateEhHandlerDefinition(handler('int')).includes('CxxFrameHandler3'));
  });
});
