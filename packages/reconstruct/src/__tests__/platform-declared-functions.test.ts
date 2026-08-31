/**
 * The platform-declaration registry — `platformDeclaredFunctionNames()`.
 *
 * The registry answers "did this emitter write that callee's declaration?". It
 * decides whether a call argument may be cast to Ghidra's prototype, so an entry
 * that has quietly stopped being emitted is not a cosmetic drift: it puts a name
 * back into the cast tables carrying a signature the compiler never sees.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  generatePlatformHeader,
  platformDeclaredFunctionNames,
} from '../codegen/platform-types.js';
import {
  EXCLUDED_SYMBOL_DECLS, CRT_DECLARED_FUNCTION_NAMES,
  EXTERNAL_IMPORT_REFERENCE_RENAMES, declaredIdentifier,
} from '../codegen/crt-mapping.js';

describe('platform declaration registry', () => {
  const header = generatePlatformHeader({ seedType: true });
  const names = platformDeclaredFunctionNames();

  it('claims the Win32 entry points whose Ghidra prototype is known wrong', () => {
    // wsprintfA is the case that motivated the registry: `(LPSTR, LPCSTR, ...)`
    // in winuser.h, four fixed `undefined4` in the database.
    for (const n of ['wsprintfA', 'CreateThread', 'EnterCriticalSection', 'timeGetTime']) {
      assert.ok(names.has(n), `${n} missing from the registry`);
    }
  });

  it('every name it declares itself is really written into d2_platform.h', () => {
    // The CRT names come from <cstring>/<cstdio>/<windows.h> and the _Wrappers::
    // entries are written inside a namespace block, so neither appears verbatim.
    // An external stdcall import's DECORATED spelling is in the registry for the
    // passes that see a call site before it is undecorated, and is deliberately
    // never written into the header — the identifier it renames to is.
    const external = new Set<string>(CRT_DECLARED_FUNCTION_NAMES);
    for (const d of EXCLUDED_SYMBOL_DECLS) {
      if (d.emitted.startsWith('_Wrappers::')) external.add(d.emitted);
    }
    for (const spelling of Object.keys(EXTERNAL_IMPORT_REFERENCE_RENAMES)) {
      external.add(spelling);
    }
    const missing = [...names].filter(
      n => !external.has(n) && !header.includes(n),
    );
    assert.deepStrictEqual(missing, [], `registry names no longer emitted: ${missing.join(', ')}`);
  });

  it('carries the excluded-namespace declarations and the CRT header names', () => {
    for (const d of EXCLUDED_SYMBOL_DECLS) {
      assert.ok(names.has(d.emitted), d.emitted);
      assert.ok(names.has(declaredIdentifier(d)), declaredIdentifier(d));
    }
    for (const n of CRT_DECLARED_FUNCTION_NAMES) assert.ok(names.has(n), n);
  });

  it('does not claim a name the reconstruction owns', () => {
    // Reconstructed D2 code must keep its own prototypes in the cast tables.
    for (const n of ['DRLG_GenerateRoom', 'FILETOOLS_GetTempPath_UTF8']) {
      assert.ok(!names.has(n), `${n} must not be treated as header-owned`);
    }
  });
});
