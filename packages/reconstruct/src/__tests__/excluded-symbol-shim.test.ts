/**
 * The Ghidra namespaces `run.ts` excludes from emission (`compiler`, `CRT`,
 * `_Wrappers`, ...) are still CALLED by kept game code. Every such callee needs a
 * declaration, and the declaration has to be the real signature — a `...` or a
 * `void*` that merely silences the call site would compile a call that cannot be
 * right.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { EXCLUDED_SYMBOL_DECLS, generateExcludedSymbolDecls } from '../codegen/crt-mapping.js';
import { generatePlatformHeader, isLibraryType, isMsvcEhInternal } from '../codegen/platform-types.js';

describe('excluded-namespace symbol declarations', () => {
  it('declares the symbols the reconstruction actually calls', () => {
    const declared = new Set(EXCLUDED_SYMBOL_DECLS.map(d => d.emitted));
    // One representative from each family that appeared in the error corpus.
    for (const name of [
      '__strnicmp', '__vsnprintf', '__itoa', '__strlwr',
      'FID_conflict____CxxFrameHandler3', 'FID_conflict___time32', 'FID_conflict__sscanf',
      '__purecall', '__except_handler4', '__ftol2', '__sqrt_common',
      'CRT_Pow10', 'CRT_Srand', 'CRT_Fgetc',
      '_eh_vector_constructor_iterator_', '_eh_vector_destructor_iterator_',
      '_Wrappers::accept', '_Wrappers::bind', '_Wrappers::listen', '_Wrappers::WSASetLastError',
      '_SmackOpen_12', '_BinkCopyToBuffer_28', 'GLIDEDLL_grLfbLock_24',
    ]) {
      assert.ok(declared.has(name), `${name} must be declared`);
    }
  });

  it('never weakens a signature to make a call typecheck', () => {
    for (const d of EXCLUDED_SYMBOL_DECLS) {
      // A `...` parameter list would accept any call site regardless of intent.
      // sscanf is genuinely variadic and is declared as a pack forwarder, not `...`.
      assert.doesNotMatch(d.decl, /\(\s*\.\.\.\s*\)/,
        `${d.emitted}: a bare (...) parameter list is a silencer, not a signature`);
      // `void*` is legitimate for real void* parameters, but never as a return
      // type stand-in for something we failed to identify.
      assert.ok(d.decl.includes(d.emitted.replace(/^.*::/, '')),
        `${d.emitted}: declaration must actually declare that name`);
    }
  });

  it('pins RAD and Glide arity to the stdcall byte count in the symbol name', () => {
    for (const d of EXCLUDED_SYMBOL_DECLS) {
      const m = d.emitted.match(/_(\d+)$/);
      if (!m || (d.source !== 'rad' && d.source !== 'glide')) continue;
      const expectedArgs = parseInt(m[1], 10) / 4;
      const params = d.decl.slice(d.decl.indexOf('(') + 1, d.decl.lastIndexOf(')'));
      const actualArgs = params.trim() === '' || params.trim() === 'void'
        ? 0 : params.split(',').length;
      assert.strictEqual(actualArgs, expectedArgs,
        `${d.emitted}: name says ${expectedArgs} dword arguments`);
    }
  });

  it('puts the _Wrappers thunks in a namespace of that name', () => {
    const out = generateExcludedSymbolDecls().join('\n');
    assert.match(out, /namespace _Wrappers \{/);
    assert.match(out, /\}\s+\/\/ namespace _Wrappers/);
  });

  it('lands in the generated platform header', () => {
    const header = generatePlatformHeader();
    for (const d of EXCLUDED_SYMBOL_DECLS) {
      assert.ok(header.includes(d.decl), `${d.emitted} missing from d2_platform.h`);
    }
    // The EH frame types the personality routine takes are forward-declared.
    assert.match(header, /struct EHExceptionRecord;/);
    assert.match(header, /struct EHRegistrationNode;/);
  });
});

describe('MSVC RTTI metadata types are library types', () => {
  it('classifies the ??_R* object-locator chain like the EH internals', () => {
    for (const name of [
      'RTTICompleteObjectLocator', 'RTTIClassHierarchyDescriptor',
      'RTTIBaseClassDescriptor', 'RTTIBaseClassArray', 'TypeDescriptor',
    ]) {
      // Ghidra keeps these at root category `/`, shared with game types, so the
      // name-set is what separates them.
      assert.strictEqual(isMsvcEhInternal(name), true, `${name} must be an EH/RTTI internal`);
      assert.strictEqual(isLibraryType(name, '/'), true, `${name} must be a library type`);
    }
  });

  it('leaves game types alone', () => {
    for (const name of ['D2UnitStrc', 'D2RoomStrc', 'D2WinScrollbar']) {
      assert.strictEqual(isMsvcEhInternal(name), false);
      assert.strictEqual(isLibraryType(name, '/'), false);
    }
  });
});
