/**
 * The pseudo-op macros d2_platform.h defines, compiled and run. Each case is the value
 * Ghidra's p-code operation produces; a macro that compiles but computes something else
 * is a silent wrong flag or a wrong byte in the rebuild.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { compileAndRun, hasNativeGpp, printHex, readHex } from '@ghidra-mcp/cpp-parser/testing/native-cpp';
import { ghidraPseudoOpMacroLines } from '../codegen/platform-types.js';

const run = (exprs: Record<string, string>) =>
  readHex(compileAndRun(ghidraPseudoOpMacroLines().join('\n'),
    Object.entries(exprs).map(([k, e]) => printHex(k, e)).join('\n')));

describe('pseudo-op macros: carry flag', { skip: !hasNativeGpp() }, () => {
  it('CARRY1/CARRY2 report the carry out of the operand width', () => {
    // (uint16_t)a + (uint16_t)b promotes to int and never wraps, so without the cast back
    // to the operand width the carry is never seen.
    const v = run({
      c1: 'CARRY1(0xFF, 1)', c1n: 'CARRY1(0xFE, 1)',
      c2: 'CARRY2(0xFFFF, 1)', c2n: 'CARRY2(0xFFFE, 1)',
      c4: 'CARRY4(0xFFFFFFFFu, 1)', c4n: 'CARRY4(0xFFFFFFFEu, 1)',
    });
    assert.deepStrictEqual(v, { c1: 1n, c1n: 0n, c2: 1n, c2n: 0n, c4: 1n, c4n: 0n });
  });
});
