/**
 * Ghidra names a JMP thunk after the import it forwards to and files it in its module's
 * namespace: Fog::SMem::GetTickCount (004112b0) beside Win32 GetTickCount. The decompiler
 * prints a direct import call bare and a call to the thunk qualified. Inside
 * `namespace Fog::SMem` the bare spelling binds to the thunk, so SMemResetHeapStats
 * (00411280) called through the thunk where the original called through the IAT.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateImplementation, type ImplGenContext } from '../codegen/impl.js';
import type { AnalyzedDataSymbol, ExtractedFunction, ReconstructOptions } from '../types.js';

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

const fn = (name: string, address: string, body: string[]): ExtractedFunction => ({
  name,
  address,
  signature: `void ${name}(void)`,
  returnType: 'void',
  parameters: [],
  localVariables: [],
  callingConvention: '__stdcall',
  size: 42,
  isThunk: false,
  isExternal: false,
  hasVarArgs: false,
  namespace: 'Fog::SMem',
  decompiled: [`void Fog::SMem::${name}(void)`, '{', ...body, '  return;', '}'].join('\n'),
});

const RESET = fn('SMemResetHeapStats', '0x00411280', ['  g_SMemLastTickCount = GetTickCount();']);
const VIA_THUNK = fn('SMemViaThunk', '0x00411290', ['  g_SMemLastTickCount = Fog::SMem::GetTickCount();']);

const tickCount: AnalyzedDataSymbol = {
  name: 'g_SMemLastTickCount',
  address: '0x007a0000',
  dataType: 'DWORD',
  size: 4,
  isInitialized: false,
  xrefCount: 2,
  scope: 'global',
};

const context = (): ImplGenContext => ({
  analyzedGlobals: [tickCount],
  knownNamespaces: new Set(['Fog', 'Fog::SMem']),
  functionNameToHeader: new Map([
    ['Fog::SMem::GetTickCount', 'Fog/SMem.h'],
    ['Fog::SMem::SMemResetHeapStats', 'Fog/SMem.h'],
    ['Fog::SMem::SMemViaThunk', 'Fog/SMem.h'],
  ]),
});

const gen = (f: ExtractedFunction): string =>
  generateImplementation('Fog/SMem', [f], undefined, 'Fog/SMem.h', options, context(), undefined, new Set<string>());

describe('import call beside a same-named namespace thunk', () => {
  it('root-qualifies the bare import call', () => {
    const impl = gen(RESET);
    assert.ok(/(?<![\w:])::GetTickCount\(\)/.test(impl), `expected ::GetTickCount() - got:\n${impl}`);
  });

  it('leaves the thunk call bound to the thunk', () => {
    const impl = gen(VIA_THUNK);
    assert.ok(!/(?<![\w:])::GetTickCount\(\)/.test(impl), `the thunk call must not reach the import - got:\n${impl}`);
    assert.ok(/GetTickCount\(\)/.test(impl), impl);
  });
});
