/**
 * The visibility rules as the tree is emitted: what nothing names is not emitted,
 * what only one unit's initializers name is internal to that unit, storage no
 * text names is defined but declared nowhere, and a TEB label is a field of
 * NtCurrentTeb().
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateProject } from '../codegen/index.js';
import type {
  AnalyzedDataSymbol,
  DetectedClass,
  ExtractedFunction,
  ExtractedNamespace,
  ProgramInfo,
  ReconstructOptions,
} from '../types.js';

const options: ReconstructOptions = {
  outputDir: './out',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'quick',
  includeAddressComments: false,
  promoteStaticGlobals: false,
};

const programInfo: ProgramInfo = {
  name: 'Game.exe',
  path: '/tmp/Game.exe',
  format: 'Portable Executable (PE)',
  architecture: 'x86',
  compiler: 'msvc',
  imageBase: '0x400000',
  languageId: 'x86:LE:32:default',
  endianness: 'little',
  pointerSize: 4,
};

const NS = 'D2Common::Dummy';

function func(name: string, address: string, body: string): ExtractedFunction {
  return {
    name,
    address,
    signature: `int ${name}(void)`,
    returnType: 'int',
    parameters: [],
    localVariables: [],
    callingConvention: '__cdecl',
    size: 0x20,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    namespace: NS,
    decompiled: `int ${name}(void)\n{\n${body}\n}\n`,
    calledFunctions: [],
  } as ExtractedFunction;
}

function global(name: string, address: string, extra: Partial<AnalyzedDataSymbol> = {}): AnalyzedDataSymbol {
  return { name, address, dataType: 'int', size: 4, isInitialized: true, value: '0x5', xrefCount: 0, scope: 'global', ...extra } as AnalyzedDataSymbol;
}

const functions = [
  func('ReadsUsed', '0x401000', '  return gnUsedA + gnUsedB + gaTable[0];'),
  func('ReadsPeb', '0x401100', '  return *(int *)((int)ProcessEnvironmentBlock + 0xc);'),
  func('ReadsByAddress', '0x401200', '  return 0;'),
];
const namespaces: ExtractedNamespace[] = [{ name: 'Dummy', fullPath: NS, functionCount: 3, isClass: false }];

const globals = [
  // Two functions in two files would make these central; the scoping is given here.
  global('gnUsedA', '006fd000', { referencingFunctions: [`${NS}::ReadsUsed`] }),
  global('gnUsedB', '006fd004', { referencingFunctions: [`${NS}::ReadsUsed`] }),
  global('gnNobody', '006fd008'),
  global('gnByAddress', '006fd00c', { referencingFunctions: [`${NS}::ReadsByAddress`] }),
  global('gaTable', '006fd010', {
    dataType: 'int *[1]', size: 4, value: undefined, referencingFunctions: [`${NS}::ReadsUsed`],
    initializedData: { kind: 'array', elements: [{ kind: 'pointer', value: 'gnOnlyInTable' }] },
  }),
  global('gnOnlyInTable', '006fd020'),
  global('ProcessEnvironmentBlock', 'ffdff030', { dataType: 'void *32', value: '00000000', scope: 'static-local', ownerFunction: 'ReadsPeb' }),
  global('LastErrorValue', 'ffdff034', { dataType: 'dword', value: '0x0' }),
];

describe('global visibility in the emitted tree', () => {
  const project = generateProject('vis', functions, [] as DetectedClass[], [], globals, namespaces, options, programInfo);
  const header = project.files.get('globals/globals.h')?.content ?? '';
  const units = [...project.files].filter(([p]) => p.startsWith('globals/') && p.endsWith('.cpp')).map(([, f]) => f.content).join('\n');
  const all = [...project.files.values()].map(f => f.content).join('\n');

  it('declares what a body names', () => {
    assert.match(header, /extern int gnUsedA;/);
  });

  it('emits nothing for a global nothing names', () => {
    assert.ok(!/\bgnNobody\b/.test(all), 'gnNobody is still emitted');
  });

  it('defines storage a function reads by address, and declares it nowhere', () => {
    assert.ok(!/\bgnByAddress\b/.test(header), header);
    assert.match(units, /\bint gnByAddress = 0x5;/);
  });

  it('defines a global only an initializer names as internal to that unit, before its referrer', () => {
    assert.ok(!/\bgnOnlyInTable\b/.test(header), header);
    const at = units.indexOf('static int gnOnlyInTable');
    assert.ok(at >= 0, units);
    assert.ok(at < units.indexOf('gaTable[1] ='), units);
    assert.ok(!/extern int gnOnlyInTable/.test(units), units);
  });

  it('writes a TEB label as the field of the running thread, with no storage', () => {
    assert.ok(all.includes('NtCurrentTeb() + 0x30'), all);
    assert.ok(!/\bProcessEnvironmentBlock\b/.test(all), 'ProcessEnvironmentBlock still has storage or a reference');
    assert.ok(!/\bLastErrorValue\b/.test(all), 'LastErrorValue is still emitted');
  });
});
