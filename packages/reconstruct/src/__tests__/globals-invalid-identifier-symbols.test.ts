/**
 * Regression test: a data symbol whose Ghidra NAME is not a legal C++ identifier
 * must still be declared — under a sanitized spelling that the reference sites
 * use too. Refusing to declare it does not remove the references.
 *
 * `recon/diablo-2/globals.cpp` has 283 `// skipped: X (invalid identifier)`
 * lines (globals.h has 83), and the very next lines reference those symbols:
 *
 *   globals.cpp:74166  // skipped: RTTI_Base_Class_Descriptor_at_(0,-1,0,64) (invalid identifier)
 *   globals.cpp:74205  RTTIBaseClassDescriptor* RTTI_Base_Class_Array[2] = {
 *                        &TSHashTableReuse_SGAMEDATA::RTTI_Base_Class_Descriptor_at_(0,-1,0,64), ... };
 *     -> 'RTTI_Base_Class_Descriptor_at_' is not a member of 'TSHashTableReuse_SGAMEDATA'
 *
 * The same rule already exists elsewhere in the pipeline: the function-body
 * transform names Storm's string label `s_.?AUBREAKCMD@@_007088d8` as
 * `s___AUBREAKCMD___007088d8` (Storm/Source/SEVT.cpp:568), so a declaration
 * sanitized the same way is exactly what those bodies need.
 *
 * Fixtures verbatim from recon/diablo-2/globals.cpp:74166, :74205, :4334.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  generateExternDeclaration,
  generateGlobalsImpl,
  emitDataValue,
  sanitizeSymbolName,
  setMultidimArrayGlobals,
  setGlobalInitializerTypes,
} from '../codegen/globals-header.js';
import type { AnalyzedDataSymbol, ReconstructOptions } from '../types.js';

const options = {
  outputDir: '/tmp/test',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
} as ReconstructOptions & { projectName?: string; binaryName?: string };

/** globals.cpp:74166 — an MSVC RTTI base-class descriptor. */
const RTTI_DESCRIPTOR: AnalyzedDataSymbol = {
  name: 'RTTI_Base_Class_Descriptor_at_(0,-1,0,64)',
  address: '006fd1c8',
  dataType: 'int',
  size: 24,
  isInitialized: true,
  value: '0',
  xrefCount: 2,
  scope: 'global',
  namespace: 'TSHashTable_SGAMEDATA',
} as AnalyzedDataSymbol;

/** globals.cpp:4334 — a decompiler-invented string label. */
const STRING_LABEL: AnalyzedDataSymbol = {
  name: 's_.?AUBREAKCMD@@_007088d8',
  address: '007088d8',
  dataType: 'char[14]',
  suggestedType: 'char[14]',
  size: 14,
  isInitialized: false,
  xrefCount: 1,
  scope: 'global',
} as AnalyzedDataSymbol;

describe('symbols whose Ghidra name is not a legal C++ identifier', () => {
  beforeEach(() => {
    setMultidimArrayGlobals([]);
    setGlobalInitializerTypes(undefined);
  });

  it('declares them instead of emitting a "// skipped" comment', () => {
    const decl = generateExternDeclaration(RTTI_DESCRIPTOR);
    assert.doesNotMatch(decl, /^\/\/ skipped:/);
    assert.strictEqual(decl, 'extern int RTTI_Base_Class_Descriptor_at__0__1_0_64_;');
  });

  it('defines them in globals.cpp under the SAME spelling', () => {
    const impl = generateGlobalsImpl([RTTI_DESCRIPTOR], options);
    assert.doesNotMatch(impl, /\/\/ skipped:/);
    assert.match(impl, /\bRTTI_Base_Class_Descriptor_at__0__1_0_64_\b/);
  });

  it('references them from an initializer under the SAME spelling', () => {
    const ref = emitDataValue(
      { kind: 'pointer', value: 'TSHashTableReuse_SGAMEDATA::RTTI_Base_Class_Descriptor_at_(0,-1,0,64)' },
      0
    );
    assert.strictEqual(
      ref,
      '&TSHashTableReuse_SGAMEDATA::RTTI_Base_Class_Descriptor_at__0__1_0_64_'
    );
  });

  it('declaration and reference agree for the Storm string label the bodies name', () => {
    // Storm/Source/SEVT.cpp:568 names it `s___AUBREAKCMD___007088d8`.
    assert.strictEqual(sanitizeSymbolName(STRING_LABEL.name), 's___AUBREAKCMD___007088d8');
    assert.strictEqual(
      generateExternDeclaration(STRING_LABEL),
      'extern char s___AUBREAKCMD___007088d8[14];'
    );
  });

  it('still declines to declare an INTERIOR label — the container is declared instead', () => {
    const interior = { ...STRING_LABEL, name: 'g_chunks.capacity' } as AnalyzedDataSymbol;
    assert.strictEqual(generateExternDeclaration(interior), '');
  });
});
