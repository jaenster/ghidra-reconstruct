/**
 * Ghidra sometimes emits `goto LAB_xxxx;` whose target label was dropped (it sat
 * in an unrecovered block, e.g. a fault/error exit). C++ rejects "label used but
 * not defined". The codegen must synthesize the missing label as an empty
 * statement at function end so the goto compiles (jumps ≈ return).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateImplementation } from '../codegen/impl.js';
import type { ExtractedFunction, ReconstructOptions } from '../types.js';

const options: ReconstructOptions = {
  outputDir: './out', format: 'cpp', organization: 'flat',
  generateCMake: false, generateSourceMaps: false, transformPreset: 'full',
  includeAddressComments: false, promoteStaticGlobals: false,
};

function makeFunc(decompiled: string): ExtractedFunction {
  return {
    name: 'DropsGotoTarget', address: '0x00675850',
    signature: 'void DropsGotoTarget(int nVal)', returnType: 'void',
    parameters: [{ name: 'nVal', dataType: 'int', size: 4, ordinal: 0, storage: 'register' }],
    localVariables: [], callingConvention: '__stdcall', size: 64,
    isThunk: false, isExternal: false, hasVarArgs: false, decompiled,
  };
}

describe('undefined goto-label synthesis', () => {
  it('defines a Ghidra goto target that was never emitted', () => {
    const impl = generateImplementation('m', [makeFunc(
      'void DropsGotoTarget(int nVal) {\n' +
      '    if (3 < nVal) {\n' +
      '        goto LAB_00677aa7;\n' +
      '    }\n' +
      '    return;\n' +
      '}'
    )], undefined, 'm.h', options, {});
    assert.ok(/LAB_00677aa7\s*:/.test(impl), `expected synthesized 'LAB_00677aa7:' in:\n${impl}`);
  });

  it('does NOT synthesize a duplicate stub when the label IS defined', () => {
    const impl = generateImplementation('m', [makeFunc(
      'void DropsGotoTarget(int nVal) {\n' +
      '    if (3 < nVal) goto LAB_001;\n' +
      '    return;\n' +
      'LAB_001:\n' +
      '    return;\n' +
      '}'
    )], undefined, 'm.h', options, {});
    // No synthesized stub (`LAB_001: ;  // synthesized…`) — whether the goto was
    // structured away by goto-cleanup or kept with its real definition, we must
    // never invent a second one.
    assert.ok(!/LAB_001\s*:\s*;\s*\/\/ synthesized/.test(impl), `must not synthesize a duplicate stub in:\n${impl}`);
  });

  it('leaves a non-Ghidra undefined label alone (real labels are not ours to invent)', () => {
    const impl = generateImplementation('m', [makeFunc(
      'void DropsGotoTarget(int nVal) {\n' +
      '    if (3 < nVal) goto cleanup;\n' +
      '    return;\n' +
      '}'
    )], undefined, 'm.h', options, {});
    assert.ok(!/^\s*cleanup\s*:\s*;/m.test(impl), `must not synthesize a non-Ghidra label in:\n${impl}`);
  });
});
