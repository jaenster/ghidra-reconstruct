/**
 * Ghidra hangs a data symbol under a namespace the generator does not emit it
 * in — the namespace component is dropped as invalid, folded into its parent, or
 * collapsed — so the symbol lands at ROOT scope while body references keep the
 * qualifier:
 *
 *   Fog/File.cpp: error: 'vftable' is not a member of 'crashy'
 *
 * globals.h declares `extern pointer vftable[7];` at root scope and puts the
 * namespaced one in `namespace crashy::Report`. The reference must therefore be
 * root-qualified (`::vftable`), decided from the globals symbol table on the
 * qualified-name node — a reference whose qualifying scope really does declare
 * the name is left alone.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateImplementation, type ImplGenContext } from '../codegen/impl.js';
import type {
  AnalyzedDataSymbol,
  ExtractedFunction,
  ReconstructOptions,
} from '../types.js';

const options: ReconstructOptions = {
  outputDir: '/tmp/test',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
  promoteStaticGlobals: false,
};

function global_(name: string, namespace?: string): AnalyzedDataSymbol {
  return {
    name,
    namespace,
    address: '0x006fb000',
    dataType: 'pointer[7]',
    size: 28,
    isInitialized: true,
    xrefCount: 4,
    scope: 'global',
  };
}

const FUNC: ExtractedFunction = {
  name: 'FILETOOLS_ResetOffsets',
  address: '0x00401070',
  signature: 'void FILETOOLS_ResetOffsets(FILE * pFile)',
  returnType: 'void',
  parameters: [{ name: 'pFile', dataType: 'FILE *', size: 4, ordinal: 0 }],
  localVariables: [],
  callingConvention: '__fastcall',
  size: 64,
  isThunk: false,
  isExternal: false,
  hasVarArgs: false,
  namespace: 'Fog::File',
  decompiled: [
    'void FILETOOLS_ResetOffsets(FILE *pFile)',
    '{',
    '  pFile->_ptr = (char *)crashy::vftable;',
    '  pFile->_base = (char *)crashy::Report::vftable;',
    '  return;',
    '}',
  ].join('\n'),
};

const context: ImplGenContext = {
  analyzedGlobals: [global_('vftable'), global_('vftable', 'crashy::Report')],
  knownNamespaces: new Set(['Fog', 'Fog::File', 'crashy::Report']),
};

describe('namespace-qualified reference to a root-scope symbol', () => {
  it('root-qualifies the reference whose scope does not declare the name', () => {
    const impl = generateImplementation(
      'Fog/File', [FUNC], undefined, 'Fog/File.h', options, { ...context }, undefined, new Set<string>(),
    );

    assert.ok(
      impl.includes('::vftable'),
      `expected the root qualifier — got:\n${impl}`,
    );
    assert.ok(
      !/(?<![:\w])crashy::vftable/.test(impl),
      `crashy does not declare vftable — got:\n${impl}`,
    );
  });

  it('leaves a reference alone when the qualifying scope really declares it', () => {
    const impl = generateImplementation(
      'Fog/File', [FUNC], undefined, 'Fog/File.h', options, { ...context }, undefined, new Set<string>(),
    );

    assert.ok(
      impl.includes('crashy::Report::vftable'),
      `the namespaced global must keep its qualifier — got:\n${impl}`,
    );
  });

  it('does nothing without a globals symbol table', () => {
    const impl = generateImplementation(
      'Fog/File', [FUNC], undefined, 'Fog/File.h', options, {}, undefined, new Set<string>(),
    );

    assert.ok(
      impl.includes('crashy::vftable'),
      `no symbol table means no decision to make — got:\n${impl}`,
    );
  });
});
