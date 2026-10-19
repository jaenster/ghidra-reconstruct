/**
 * The platform header defines no Ghidra notation, and compiles against both mingw CRT
 * flavours.
 *
 * Every pseudo-op is lowered on the AST (pseudo-op-lower) and must NOT have a definition: a
 * macro that compiles but computes something else is a silent wrong value in the rebuild,
 * and a missing one is a compile error that names the site. The same holds for Ghidra's own
 * types (`unkfloat1`), which type-normalize spells as C types.
 *
 * The header used to compile only against UCRT headers: `_time64` was mapped onto `time`,
 * which takes `__time64_t*` only where `time_t` is 64-bit. mingw's default msvcrt headers
 * give the 32-bit target a 32-bit `time_t` (as VC6, which built the original, did), and
 * `__time64(__time64_t*)` failed in every TU. And GCC's <x86intrin.h> beside mingw's
 * <intrin.h> redeclared the 3DNow! intrinsics on headers that do not guard them.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasNativeGpp } from '@ghidra-mcp/cpp-parser/testing/native-cpp';
import { generatePlatformHeader } from '../codegen/platform-types.js';

const PSEUDO_OPS = /^#\s*define\s+(CONCAT|SUB|ZEXT|SEXT|CARRY|SCARRY|SBORROW)\d+\b|^#\s*define\s+(ZPULL|SPULL|ROUND|ABS|LOCK|UNLOCK|rdtsc|swi)\b/m;

describe('platform header: no Ghidra notation is defined', () => {
  const header = generatePlatformHeader();
  it('defines no pseudo-op', () => {
    assert.strictEqual(PSEUDO_OPS.exec(header)?.[0], undefined);
  });
  it('declares no unkfloat1', () => {
    assert.ok(!/\bunkfloat1\b/.test(header.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')));
  });
});

let mingw: boolean | undefined;
function hasMingw(): boolean {
  if (mingw === undefined) {
    try { execFileSync('i686-w64-mingw32-g++', ['--version'], { stdio: 'pipe' }); mingw = true; } catch { mingw = false; }
  }
  return mingw;
}

const CRT_FLAVOURS: Record<string, string[]> = {
  'msvcrt (mingw default)': [],
  'UCRT': ['-D__MSVCRT_VERSION__=0xE00', '-D_UCRT'],
};

/** Errors from compiling `body` in `main` after the generated header, for one CRT flavour. */
function compileWithHeader(body: string, flags: string[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'platform-header-'));
  try {
    writeFileSync(join(dir, 'd2_platform.h'), generatePlatformHeader());
    writeFileSync(join(dir, 'd2_enums.h'), '');
    writeFileSync(join(dir, 't.cpp'), `#include "d2_platform.h"\nint main() {\n${body}\nreturn 0;\n}\n`);
    try {
      execFileSync('i686-w64-mingw32-g++',
        ['-std=c++17', '-fsyntax-only', '-w', '-fms-extensions', ...flags, join(dir, 't.cpp')], { stdio: 'pipe' });
      return [];
    } catch (e) {
      return String((e as { stderr?: Buffer }).stderr ?? e).split('\n').filter(l => / error: /.test(l));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('platform header: compiles against both CRT flavours', { skip: !hasMingw() }, () => {
  for (const [flavour, flags] of Object.entries(CRT_FLAVOURS)) {
    it(`${flavour}: the header and its time, CPUID and INT3 helpers`, () => {
      assert.deepStrictEqual(compileWithHeader(
        '__time64_t t = __time64(nullptr); (void)t; (void)FID_conflict___time32(nullptr);\n' +
        '(void)D2_Cpuid(0); __debugbreak(); (void)__rdtsc();', flags), []);
    });
    it(`${flavour}: a surviving pseudo-op or Ghidra type does not compile`, () => {
      for (const body of ['(void)CONCAT22(1, 2);', '(void)SUB41(1u, 0);', 'unkfloat1 b = 0; (void)b;']) {
        assert.notDeepStrictEqual(compileWithHeader(body, flags), [], `${body} compiles`);
      }
    });
  }
});

describe('platform header: artifact support', { skip: !hasNativeGpp() }, () => {
  it('refuses -ffast-math, which breaks isnan and float bit patterns', async () => {
    const { ARTIFACT_SUPPORT_LINES } = await import('@ghidra-mcp/cpp-parser');
    const dir = mkdtempSync(join(tmpdir(), 'fastmath-'));
    try {
      const src = join(dir, 't.cpp');
      writeFileSync(src, ['#include <cstdint>', ...ARTIFACT_SUPPORT_LINES, 'int main(){}'].join('\n'));
      execFileSync('g++', ['-std=c++17', '-fsyntax-only', src], { stdio: 'pipe' });
      assert.throws(() => execFileSync('g++', ['-std=c++17', '-ffast-math', '-fsyntax-only', src], { stdio: 'pipe' }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
