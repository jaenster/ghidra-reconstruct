/**
 * The visibility rules across several globals units: a global globals.h leaves out
 * is declared by a unit only where an initializer that unit defines names it, and
 * storage nothing names is declared by no unit at all.
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

function func(namespace: string, name: string, address: string, body: string): ExtractedFunction {
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
    namespace,
    decompiled: `int ${name}(void)\n{\n${body}\n}\n`,
    calledFunctions: [],
  } as ExtractedFunction;
}

function global(name: string, address: string, extra: Partial<AnalyzedDataSymbol> = {}): AnalyzedDataSymbol {
  return { name, address, dataType: 'int', size: 4, isInitialized: true, value: '0x5', xrefCount: 0, scope: 'global', ...extra } as AnalyzedDataSymbol;
}

const COMMON = 'D2Common::Dummy';
const GAME = 'D2Game::Dummy';
const FOG = 'Fog::Dummy';

const functions = [
  func(COMMON, 'ReadsCommonTable', '0x401000', '  return gaCommonTable[0] != 0;'),
  func(COMMON, 'ReadsByAddress', '0x401100', '  return 0;'),
  func(GAME, 'ReadsGameTable', '0x402000', '  return gaGameTable[0] != 0;'),
  func(FOG, 'ReadsFog', '0x403000', '  return gnFogUsed;'),
];
const namespaces: ExtractedNamespace[] = [
  { name: 'Dummy', fullPath: COMMON, functionCount: 2, isClass: false },
  { name: 'Dummy', fullPath: GAME, functionCount: 1, isClass: false },
  { name: 'Dummy', fullPath: FOG, functionCount: 1, isClass: false },
];

const table = (name: string, address: string, reader: string): AnalyzedDataSymbol => global(name, address, {
  dataType: 'int *[1]', size: 4, value: undefined, referencingFunctions: [reader],
  initializedData: { kind: 'array', elements: [{ kind: 'pointer', value: 'gnSharedTarget' }] },
});

const globals = [
  table('gaCommonTable', '006fd000', `${COMMON}::ReadsCommonTable`),
  table('gaGameTable', '006fd010', `${GAME}::ReadsGameTable`),
  // Named only by the two tables' initializers, which two units define.
  global('gnSharedTarget', '006fd020'),
  global('gnByAddress', '006fd030', { referencingFunctions: [`${COMMON}::ReadsByAddress`] }),
  global('gnUnnamedData', '006fd040', { value: '0x7' }),
  global('gnFogUsed', '006fd050', { referencingFunctions: [`${FOG}::ReadsFog`] }),
];

describe('global visibility across globals units', () => {
  const project = generateProject('vis-units', functions, [] as DetectedClass[], [], globals, namespaces, options, programInfo);
  const unit = (module: string): string => project.files.get(`globals/${module}.cpp`)?.content ?? '';
  const units = [...project.files].filter(([p]) => p.startsWith('globals/') && p.endsWith('.cpp'));

  it('places each table in its reader\'s unit', () => {
    assert.match(unit('D2Common'), /gaCommonTable\[1\] =/);
    assert.match(unit('D2Game'), /gaGameTable\[1\] =/);
    assert.match(unit('Fog'), /\bint gnFogUsed\b/);
  });

  it('declares an initializer-only global in the units whose initializers name it', () => {
    assert.match(unit('D2Common'), /extern int gnSharedTarget;/);
    assert.match(unit('D2Game'), /extern int gnSharedTarget;/);
  });

  it('declares it in no unit that does not name it', () => {
    assert.ok(!/\bgnSharedTarget\b/.test(unit('Fog')), unit('Fog'));
  });

  it('declares storage nothing names in no unit', () => {
    for (const [path, file] of units) {
      assert.ok(!/extern int gnByAddress\b/.test(file.content), `${path} declares gnByAddress`);
      assert.ok(!/extern int gnUnnamedData\b/.test(file.content), `${path} declares gnUnnamedData`);
    }
  });
});
