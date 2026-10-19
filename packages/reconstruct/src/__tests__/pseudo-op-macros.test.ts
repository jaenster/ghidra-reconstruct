/**
 * The pseudo-op macros d2_platform.h still defines, compiled and run. Every other
 * pseudo-op is lowered on the AST (pseudo-op-lower) and must NOT have a definition: a
 * macro that compiles but computes something else is a silent wrong value in the rebuild,
 * and a missing one is a compile error that names the site.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { compileAndRun, hasNativeGpp, printHex, readHex } from '@ghidra-mcp/cpp-parser/testing/native-cpp';
import { ghidraPseudoOpMacroLines } from '../codegen/platform-types.js';

const run = (exprs: Record<string, string>) =>
  readHex(compileAndRun(ghidraPseudoOpMacroLines().join('\n'),
    Object.entries(exprs).map(([k, e]) => printHex(k, e)).join('\n')));

describe('pseudo-op macros: what is left', { skip: !hasNativeGpp() }, () => {
  it('CONCAT still joins two halves, for an operand pseudo-op-lower left in place', () => {
    assert.deepStrictEqual(run({ c: 'CONCAT22(0x1234, 0x5678)' }), { c: 0x12345678n });
  });

  it('the lowered pseudo-ops have no definition, so a survivor fails to compile', () => {
    for (const call of ['SUB41(1u, 0)', 'ZEXT14(1)', 'CARRY4(1u, 1u)', 'SBORROW4(1, 1)', 'ZPULL(1u, 0, 1)']) {
      assert.throws(() => run({ v: call }), undefined, `${call} still compiles`);
    }
  });
});

describe('platform header: artifact support', { skip: !hasNativeGpp() }, () => {
  it('refuses -ffast-math, which breaks isnan and float bit patterns', async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
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
