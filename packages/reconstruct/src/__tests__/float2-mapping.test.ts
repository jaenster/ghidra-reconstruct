/**
 * `float2` is Ghidra's 2-byte float, and it reaches the tree only as a cast
 * artifact. `CheckCollision_Vector` genuinely returns 16 bits - it tail-forwards
 * two functions that both do `MOV AX,0x27` - so at every call site Ghidra
 * composes the missing upper half from a synthetic variable and writes
 *
 *   (eCollisionFlags)(float2)(float)((uint32_t)extraout_var << 16 | (uint32_t)eVar1 & 0xffffu)
 *
 * 22 sites across D2Common/Collision.cpp, D2Game/Objects, D2Game/Quests and
 * D2Client/SKILLS. Unmapped, every one of them is
 * `error: 'float2' was not declared in this scope`.
 *
 * The fix is float10's fix: a name in the platform header plus an entry in the
 * type tables. The target is `uint16_t`, not a float - see the comments there.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generatePlatformHeader, GHIDRA_ARTIFACT_TYPES } from '../codegen/platform-types.js';

describe('float2 is a declared type', () => {
  it('d2_platform.h typedefs it, the way it typedefs float10', () => {
    const header = generatePlatformHeader();
    assert.ok(
      /typedef\s+uint16_t\s+float2;/.test(header),
      'd2_platform.h must declare float2'
    );
    // The precedent it follows must still be there.
    assert.ok(/typedef\s+long double\s+float10;/.test(header));
  });

  it('the typedef comes after <cstdint>, so uint16_t is in scope', () => {
    const header = generatePlatformHeader();
    const cstdint = header.indexOf('<cstdint>');
    const float2 = header.indexOf('typedef uint16_t float2;');
    assert.ok(cstdint >= 0, 'platform header must include <cstdint>');
    assert.ok(float2 > cstdint, 'float2 typedef must follow the <cstdint> include');
  });

  it('is registered as a Ghidra artifact type, like float10', () => {
    assert.ok(GHIDRA_ARTIFACT_TYPES.has('float2'));
    assert.ok(GHIDRA_ARTIFACT_TYPES.has('float10'));
  });

  it('the typedef target is an integer, not a float', () => {
    // A 2-byte float has no portable C++ spelling on i686-w64-mingw32, and the
    // sites that use it need the low 16 bits to survive, not IEEE half rounding.
    // The parser-side table is pinned in cpp-parser's ghidra-types test.
    const header = generatePlatformHeader();
    const line = header.split('\n').find(l => /\bfloat2;/.test(l));
    assert.ok(line, 'no float2 typedef in the platform header');
    assert.ok(!/\b(float|double)\b/.test(line!), line!);
  });
});
