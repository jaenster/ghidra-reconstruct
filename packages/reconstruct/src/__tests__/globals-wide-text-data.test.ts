/**
 * Ghidra's `unicode` is a NUL-terminated run of 16-bit code units. The emitter
 * had no case for it: `u_(null)_006f2f8c` @006f2f8c (`unicode`, 14 bytes,
 * value `(null)`) came out as
 *
 *   uint16_t u__null__006f2f8c = "(null)";
 *
 * — the SCALAR type for a seven-element array, and a narrow string literal for a
 * wide run. Both halves wrong, and `invalid conversion from 'const char*' to
 * 'uint16_t'` on the way out.
 *
 * Fixtures verbatim from the extraction snapshot.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  generateExternDeclaration,
  generateGlobalsImpl,
  inferArrayDeclaration,
  setMultidimArrayGlobals,
  setGlobalInitializerTypes,
} from '../codegen/globals-header.js';
import type { AnalyzedDataSymbol, ReconstructOptions } from '../types.js';

const options = {
  outputDir: '/tmp/test', format: 'cpp', organization: 'namespace',
  generateCMake: false, generateSourceMaps: false, transformPreset: 'full',
  includeAddressComments: false,
} as ReconstructOptions & { projectName?: string; binaryName?: string };

const uNull = {
  name: 'u_(null)_006f2f8c', address: '006f2f8c',
  dataType: 'unicode', suggestedType: 'unicode',
  size: 14, value: '(null)', isInitialized: true, xrefCount: 7, scope: 'global',
  initializedData: { kind: 'string', value: '(null)' },
} as unknown as AnalyzedDataSymbol;

/** A NARROW run in a `char[N]`, which a string literal initialises correctly. */
const szNarrow = {
  name: 's_end_006d9060', address: '006d9060',
  dataType: 'string', suggestedType: 'char[4]',
  size: 4, value: 'end', isInitialized: true, xrefCount: 1, scope: 'global',
  initializedData: { kind: 'string', value: 'end' },
} as unknown as AnalyzedDataSymbol;

describe('a Ghidra `unicode` datum', () => {
  beforeEach(() => {
    setMultidimArrayGlobals([]);
    setGlobalInitializerTypes(undefined);
  });

  it('is seven code units, not one scalar', () => {
    assert.deepStrictEqual(inferArrayDeclaration(uNull), { type: 'uint16_t', count: 7 });
  });

  it('is emitted as a wide array with its code units', () => {
    const impl = generateGlobalsImpl([uNull], options);
    assert.ok(
      /uint16_t u__null__006f2f8c\[7\] = \{ '\(', 'n', 'u', 'l', 'l', '\)', 0 \}/.test(impl),
      `wide run not emitted element-wise:\n${impl}`,
    );
    assert.ok(!impl.includes('= "(null)"'), `narrow string literal for a wide run:\n${impl}`);
  });

  it('declares the same array in the header the definition has to match', () => {
    assert.strictEqual(
      generateExternDeclaration(uNull),
      'extern uint16_t u__null__006f2f8c[7];',
    );
  });

  it('leaves a NARROW run as the string literal it has always been', () => {
    const impl = generateGlobalsImpl([szNarrow], options);
    assert.ok(impl.includes('"end"'), `narrow run broken up:\n${impl}`);
  });
});
