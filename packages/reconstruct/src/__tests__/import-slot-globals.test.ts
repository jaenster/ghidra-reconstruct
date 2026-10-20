/**
 * C4-10: an import address table slot is not program data. `PTR_FreeSid_006cc044` is
 * the IAT entry Ghidra types as a pointer with an external reference
 * (`->ADVAPI32.DLL::FreeSid`); the code calls `FreeSid` by name, and the slot's image
 * "value" is the hint/name RVA the loader overwrites. Emitting it as
 * `void* PTR_FreeSid_006cc044 = (void*)0x00302d16;` declared and defined a global no
 * body names, holding a value nothing may read.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateGlobalsHeader, generateGlobalsImpl, markUnnamedImportSlots } from '../codegen/globals-header.js';
import { parseImportSlots } from '../extract/globals.js';
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

const slot = (name: string, address: string, refs: string[]): AnalyzedDataSymbol => ({
  name, address, dataType: 'pointer', size: 4, value: '00302d16', isInitialized: true,
  xrefCount: refs.length, referencingFunctions: refs, scope: 'global', suggestedType: 'void*',
  importSlot: `ADVAPI32.DLL::${name}`,
});

describe('import slots', () => {
  it('parses the extraction script rows', () => {
    const m = parseImportSlots('006cc044\tADVAPI32.DLL::FreeSid\n006cc5b8\tBINKW32.DLL::_BinkOpen@8\n\njunk\n');
    assert.strictEqual(m.size, 2);
    assert.strictEqual([...m.values()][1], 'BINKW32.DLL::_BinkOpen@8');
  });

  it('a slot no body names is neither declared nor defined; one a body reads as data stays', () => {
    const unnamed = slot('PTR_FreeSid_006cc044', '006cc044', ['Fog::Src::ErrorManager::WriteCrashReportProcessInfo']);
    const named = slot('PTR_GetProcAddress_006cc148', '006cc148', ['Storm::Lib::LIB_Resolve']);
    const plain: AnalyzedDataSymbol = {
      name: 'gnCounter', address: '00700000', dataType: 'int', size: 4, isInitialized: true,
      xrefCount: 1, referencingFunctions: ['Storm::Lib::LIB_Resolve'], scope: 'global', suggestedType: 'int',
    };
    const functions = [
      { name: 'WriteCrashReportProcessInfo', namespace: 'Fog::Src::ErrorManager', decompiled: 'void f(void) { FreeSid(pSid); }' },
      { name: 'LIB_Resolve', namespace: 'Storm::Lib', decompiled: 'void g(void) { pfn = PTR_GetProcAddress_006cc148; gnCounter = 1; }' },
    ];
    const globals = [unnamed, named, plain];
    assert.strictEqual(markUnnamedImportSlots(globals, functions), 1);
    const header = generateGlobalsHeader(globals, options);
    const impl = generateGlobalsImpl(globals, options);
    assert.doesNotMatch(header + impl, /PTR_FreeSid_006cc044/);
    assert.match(header, /PTR_GetProcAddress_006cc148/);
    assert.match(header, /gnCounter/);
  });

  it('a function the model does not have is never emitted, so it names nothing', () => {
    const g = slot('PTR_FreeSid_006cc044', '006cc044', ['compiler::___crtGetEnvironmentStringsA']);
    assert.strictEqual(markUnnamedImportSlots([g], []), 1);
  });

  it('the name in a comment or a string is not a use', () => {
    const g = slot('PTR_FreeSid_006cc044', '006cc044', ['F']);
    const n = markUnnamedImportSlots([g], [{ name: 'F', decompiled: '/* PTR_FreeSid_006cc044 */ f("PTR_FreeSid_006cc044");' }]);
    assert.strictEqual(n, 1);
  });
});
