/**
 * Compiler-generated MSVC C++ EH handler stubs (`__ehhandler$`, 1.14d 0x6c9bfb-0x6ca6c5)
 * are declared and never defined: their FuncInfo chain is not reconstructible, and the
 * owner's decision is to resolve them at link like the other runtime entries.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { isMsvcEhHandlerStub } from '../codegen/eh-handler-stub.js';

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
