/**
 * A one-state C++ EH frame as the local guard VC8 builds it for (eh-state-guard). The shapes are
 * the generator's for SpinnerImplementation::Destructor 004bbe10 (MATCH with the guard) and
 * ButtonWrapper::Destructor 004badd0 (its frame slots grouped as one struct).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { ehStateGuardPlugin } from '../builtins/eh-state-guard.js';

function run(code: string) {
  const sites: unknown[] = [];
  const refused: string[] = [];
  const out = emit(ehStateGuardPlugin.createTransformer({ onSite: (s: unknown) => sites.push(s), onRefuse: (w: string) => refused.push(w) })(parse(code)) as AnyNode).trim();
  return { out, sites, refused };
}

const SPINNER = (lifetime = '    Core::Archive::DC6_FreeAndDelete(pThis->pDC6);') => `void __fastcall Destructor(::SpinnerImplementation * pThis, int) {
    pfnEHHandlerRoutine pExceptionHandler = SehHandler_6ca198;
    void* pSavedExceptionList = ExceptionList;
    ExceptionList = &pSavedExceptionList;
    pThis->pVtable = (SpinnerImplementationVtable*)(void*)SpinnerImplementation::vftable;
    uint32_t dwSehState = 0;
${lifetime}
    dwSehState = -1;
    UI::Destructor((::UIWidget*)pThis);
    ExceptionList = pSavedExceptionList;
}`;

describe('eh-state-guard', () => {
  it('SpinnerImplementation::Destructor 004bbe10: the vtable store constructs, the base destructor destroys', () => {
    const { out, sites } = run(SPINNER());
    assert.match(out, /struct EhState0 \{\s*::SpinnerImplementation\* pThis;\s*__forceinline EhState0\(::SpinnerImplementation\* pThis_\) \{\s*this->pThis = pThis_;\s*pThis->pVtable = \(SpinnerImplementationVtable\*\)\(void\*\)SpinnerImplementation::vftable;\s*\}\s*__forceinline ~EhState0\(\) \{\s*UI::Destructor\(\(::UIWidget\*\)pThis\);\s*\}\s*\};/);
    assert.match(out, /EhState0 eh0\{pThis\};\s*Core::Archive::DC6_FreeAndDelete\(pThis->pDC6\);\s*\}$/);
    assert.doesNotMatch(out, /ExceptionList|dwSehState|SehHandler_6ca198/);
    assert.deepStrictEqual(sites, [{ guard: 'EhState0', copies: ['pThis'], constructed: true }]);
  });

  it('ButtonWrapper::Destructor 004badd0: frame slots in a group; a local loaded after the construction follows the guard', () => {
    const code = `void __thiscall Destructor(::ButtonWrapper * pThis) {
    struct __frame0_t {
      void* pPrevExcList;
      PFN_CrtExceptionFilter* pcStack12;
      int32_t nEhState;
    };
    __frame0_t __frame0;
    __frame0.pcStack12 = _Wrappers::CRT_ExceptionFilter2;
    __frame0.pPrevExcList = ExceptionList;
    ExceptionList = &__frame0.pPrevExcList;
    pThis->pVtable = (ButtonWrapperVtable*)(void*)ButtonWrapper::vftable;
    ::ButtonImplementation* this_00 = pThis->pImplementation;
    __frame0.nEhState = 0;
    if (this_00) {
      this_00->pVtable->ScalarDeletingDestructor(this_00, 1);
    }
    __frame0.nEhState = -1;
    UI::Destructor((::UIWidget*)pThis);
    ExceptionList = __frame0.pPrevExcList;
}`;
    const { out, sites } = run(code);
    assert.match(out, /struct EhState0 \{\s*::ButtonWrapper\* pThis;\s*__forceinline EhState0\(::ButtonWrapper\* pThis_\) \{\s*this->pThis = pThis_;\s*pThis->pVtable = \(ButtonWrapperVtable\*\)\(void\*\)ButtonWrapper::vftable;\s*\}/);
    assert.match(out, /EhState0 eh0\{pThis\};\s*::ButtonImplementation\* this_00 = pThis->pImplementation;\s*if \(this_00\)/);
    assert.doesNotMatch(out, /ExceptionList|nEhState =|CRT_ExceptionFilter2/);
    assert.deepStrictEqual(sites, [{ guard: 'EhState0', copies: ['pThis'], constructed: true }]);
  });

  it('leaves the frame when the lifetime returns, assigns a copied local, or has no destruction', () => {
    assert.match(run(SPINNER('    if (!pThis->pDC6) {\n      return;\n    }\n    Core::Archive::DC6_FreeAndDelete(pThis->pDC6);')).out, /ExceptionList = &pSavedExceptionList/);
    assert.match(run(SPINNER('    pThis = g(pThis);')).out, /ExceptionList = &pSavedExceptionList/);
    const noDestruction = SPINNER().replace('    UI::Destructor((::UIWidget*)pThis);\n', '');
    assert.match(run(noDestruction).out, /ExceptionList = &pSavedExceptionList/);
  });

  it('leaves the frame when the state is stored more than twice', () => {
    const { out } = run(SPINNER('    dwSehState = 1;\n    Core::Archive::DC6_FreeAndDelete(pThis->pDC6);'));
    assert.match(out, /ExceptionList = &pSavedExceptionList/);
  });

  it('leaves the frame when the destruction reads a local loaded after the construction', () => {
    const code = SPINNER().replace('    uint32_t dwSehState = 0;', '    DC6* pDC6 = pThis->pDC6;\n    uint32_t dwSehState = 0;')
      .replace('    UI::Destructor((::UIWidget*)pThis);', '    UI::Destructor((::UIWidget*)pDC6);');
    assert.match(run(code).out, /ExceptionList = &pSavedExceptionList/);
  });
});
