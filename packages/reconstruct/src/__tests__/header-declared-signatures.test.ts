/**
 * `HEADER_DECLARED_SIGNATURES` — the slots a header owns and the database is
 * kept out of.
 *
 * `platformDeclaredFunctionNames()` deliberately blocks every CRT / excluded /
 * platform-shim name from `functionParamTypes`, because Ghidra's record of such
 * a callee and the declaration the reconstruction is compiled against routinely
 * disagree. That left no way to state the DECLARATION's own answer either, so
 * two live sites got no conversion at all:
 *
 *   Fog/Debug.cpp:2731    CRT_Encode_Secure_Pointer(HandleExceptionWithStackDump)
 *   Fog/Source/SFile.cpp  FloatToLong(nJulianDay, pYear)
 *
 * These pin that each stated name really is header-owned (otherwise the table is
 * shadowing a model record instead of filling a hole) and that what it states is
 * what `d2_platform.h` actually writes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { HEADER_DECLARED_SIGNATURES } from '../codegen/crt-mapping.js';
import {
  generatePlatformHeader,
  platformDeclaredFunctionNames,
} from '../codegen/platform-types.js';

describe('HEADER_DECLARED_SIGNATURES', () => {
  const names = platformDeclaredFunctionNames();
  const header = generatePlatformHeader({ seedType: true });

  it('states only names the model is already blocked from claiming', () => {
    // A name the database DOES reach would be shadowed rather than filled in,
    // and the header's answer would silently win over a real record.
    for (const name of Object.keys(HEADER_DECLARED_SIGNATURES)) {
      assert.ok(names.has(name), `${name} is not header-owned — it needs no entry`);
    }
  });

  it('spells CRT_Encode_Secure_Pointer the way the header declares it', () => {
    const sig = HEADER_DECLARED_SIGNATURES.CRT_Encode_Secure_Pointer;
    assert.deepEqual(sig.paramTypes, ['void *']);
    assert.equal(sig.returnType, 'void *');
    assert.ok(header.includes('void* CRT_Encode_Secure_Pointer(void* pPointer);'), 'decl moved');
    // Not an overload set: taking its address never has to name a member.
    assert.ok(!sig.overloaded);
  });

  it('spells the two-word FloatToLong the way the header declares it', () => {
    const sig = HEADER_DECLARED_SIGNATURES.FloatToLong;
    assert.deepEqual(sig.paramTypes, ['int32_t', 'int32_t']);
    assert.equal(sig.returnType, 'uint32_t');
    assert.ok(header.includes('static inline uint32_t FloatToLong(int32_t lo, int32_t hi)'), 'decl moved');
  });

  it('marks FloatToLong overloaded, because the header really does overload it', () => {
    // `_ftol2` takes the two halves of a double; the shim beside it takes a
    // float. Arity is what keeps the two-word entry off the one-word sites, and
    // the overload flag is what makes an address-of spell which member it means.
    assert.ok(HEADER_DECLARED_SIGNATURES.FloatToLong.overloaded);
    assert.ok(header.includes('static inline int32_t FloatToLong(float f)'), 'decl moved');
  });
});
