import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateFunctionImplementation } from '../codegen/impl.js';
import { createOverrideRegistry } from '../overrides/index.js';
import type { ExtractedFunction, ReconstructOptions } from '../types.js';

const decompiled = `
/* @function D2WINTIMER_GetElapsed
   @address Game.exe.ram:004fd8f0
   @calling __fastcall */
int __fastcall D2Win::Src::D2WinTimer::D2WINTIMER_GetElapsed(D2WinTimer *pTimer)
{
  OnPress *pOVar1;
  void *nAddress;
  DWORD dwTickCount;
  D2ControlMsg pCallbackArg;
  uint dwState;
  int32_t nLine;
  if ((pTimer->sControl).neD2FormType != FORM_Timer) {
    nLine = 0x6a;
    nAddress = Fog::Src::ErrorManager::GetInstructionPointer();
    Fog::Src::ErrorManager::ERROR_UnrecoverableInternalError_Halt("",nAddress,nLine);
    compiler::exit(-1);
  }
  dwState = (pTimer->sControl).dwState;
  if (((Fog::BitBuffer::gadwBitMasks[2] & dwState) != 0) &&
     ((Fog::BitBuffer::gadwBitMasks[0] & dwState) != 0)) {
    dwTickCount = GetTickCount();
    if (gnTimerNextFireTick <= dwTickCount) {
      pOVar1 = (pTimer->sControl).fpOnPress;
      if (pOVar1 != (OnPress *)0x0) {
        pCallbackArg.pControl = &pTimer->sControl;
        (*pOVar1)(&pCallbackArg);
      }
      gnTimerNextFireTick = pTimer->nTimeoutInSeconds + dwTickCount;
    }
    return 1;
  }
  return 0;
}
`;

const options: ReconstructOptions = {
  outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false,
  generateSourceMaps: false, transformPreset: 'full', includeAddressComments: false, promoteStaticGlobals: false,
};
const func: ExtractedFunction = {
  name: 'D2WINTIMER_GetElapsed', address: '004fd8f0',
  signature: 'int D2WINTIMER_GetElapsed(D2WinTimer * pTimer)', returnType: 'int',
  parameters: [{ name: 'pTimer', dataType: 'D2WinTimer *', size: 4, ordinal: 0, storage: 'ECX' }],
  localVariables: [], callingConvention: '__fastcall', size: 123, isThunk: false,
  isExternal: false, hasVarArgs: false, decompiled,
};

describe('timer callback store persistence', () => {
  it('applies the tracked override to the public decompile without a project config', () => {
    const registry = createOverrideRegistry(undefined, '.');
    assert.ok(registry);
    const before = generateFunctionImplementation(func, undefined, options);
    assert.match(before, /if \(pOVar1\)/);
    const out = generateFunctionImplementation(func, undefined, options, { overrides: registry } as never);
    assert.match(out, /pOVar1 = pTimer->sControl\.fpOnPress;\s+pCallbackArg\.pControl = &pTimer->sControl;\s+if \(pOVar1\)/);
    assert.match(out, /if \(pOVar1\) \{\s+\(\*pOVar1\)\(&pCallbackArg\);/);
  });
});
