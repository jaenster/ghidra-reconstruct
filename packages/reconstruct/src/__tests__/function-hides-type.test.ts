/**
 * A function named after the struct it returns keeps its Ghidra name; the TYPE
 * is spelled root-qualified (`::D2WinImageEx`), and elaborated as well
 * (`struct ::D2WinImageEx`) when the function itself is at root scope, where
 * `::D2WinImageEx` would name the function.
 *
 * Measured on 1.14d v1882: `D2WinImageEx` (004fd770) returns `D2WinImageEx *` and
 * lives in D2Win::Src::D2WinImage. The generator used to rename it
 * `Create_D2WinImageEx` - a name in no binary - and the call in FORMS_CreateAnyForm
 * (another unit) still said `D2WinImage::D2WinImageEx(...)`: "'D2WinImageEx' is
 * not a member of 'D2Win::Src::D2WinImage'". `T *T(...)` is legal C++; inside the
 * function's scope only an elaborated specifier still names the class.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateProject } from '../codegen/index.js';
import type {
  AnalyzedDataSymbol,
  DetectedClass,
  ExtractedDataType,
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
  transformPreset: 'full',
  includeAddressComments: false,
  promoteStaticGlobals: false,
};

const programInfo: ProgramInfo = {
  name: 'Game.exe',
  path: '/tmp/Game.exe',
  format: 'PE',
  architecture: 'x86',
  compiler: 'msvc',
  imageBase: '0x400000',
  languageId: 'x86:LE:32:default',
  endianness: 'little',
  pointerSize: 4,
};

const CALLER_NS = 'D2Win::Src::D2WinMain';

function scenario(creatorNs: string | undefined) {
  const q = creatorNs ? `${creatorNs}::` : '';
  const creator = {
    name: 'D2WinImageEx',
    address: '004fd770',
    signature: 'D2WinImageEx * D2WinImageEx(int nPosX)',
    returnType: 'D2WinImageEx *',
    parameters: [{ name: 'nPosX', dataType: 'int', size: 4, ordinal: 0 }],
    localVariables: [{ name: 'pNew', dataType: 'D2WinImageEx *', size: 4 }],
    callingConvention: '__cdecl',
    size: 0x20,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    namespace: creatorNs,
    decompiled:
      `D2WinImageEx * ${q}D2WinImageEx(int nPosX)\n{\n` +
      `  D2WinImageEx *pNew;\n\n` +
      `  pNew = (D2WinImageEx *)0x0;\n` +
      `  pNew->nPosX = nPosX + (int)sizeof(D2WinImageEx);\n` +
      `  return pNew;\n}\n`,
    calledFunctions: [],
  } as unknown as ExtractedFunction;

  const caller = {
    name: 'FORMS_CreateAnyForm',
    address: '004fe000',
    signature: 'D2WinImageEx * FORMS_CreateAnyForm(int nPosX)',
    returnType: 'D2WinImageEx *',
    parameters: [{ name: 'nPosX', dataType: 'int', size: 4, ordinal: 0 }],
    localVariables: [{ name: 'pImageEx', dataType: 'D2WinImageEx *', size: 4 }],
    callingConvention: '__cdecl',
    size: 0x20,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    namespace: CALLER_NS,
    decompiled:
      `D2WinImageEx * ${CALLER_NS}::FORMS_CreateAnyForm(int nPosX)\n{\n` +
      `  D2WinImageEx *pImageEx;\n\n` +
      `  pImageEx = ${q}D2WinImageEx(nPosX);\n` +
      `  FORMS_SetCreator((void *)0x4fd770);\n` +
      `  return pImageEx;\n}\n`,
    calledFunctions: ['D2WinImageEx', 'FORMS_SetCreator'],
  } as unknown as ExtractedFunction;

  const namespaces: ExtractedNamespace[] = [
    ...(creatorNs ? [{ name: 'D2WinImage', fullPath: creatorNs, functionCount: 1, isClass: false }] : []),
    { name: 'D2WinMain', fullPath: CALLER_NS, functionCount: 1, isClass: false },
  ];

  const dataTypes: ExtractedDataType[] = [{
    name: 'D2WinImageEx',
    kind: 'STRUCTURE',
    size: 8,
    fields: [
      { name: 'nPosX', dataType: 'int', offset: 0, size: 4 },
      { name: 'nPosY', dataType: 'int', offset: 4, size: 4 },
    ],
  } as unknown as ExtractedDataType];

  // A table of form constructors, named by the function's database path.
  const table: AnalyzedDataSymbol = {
    name: 'gpfnFormCreators',
    address: '006fd000',
    dataType: 'void *[1]',
    size: 4,
    isInitialized: true,
    xrefCount: 1,
    scope: 'global',
    initializedData: { kind: 'array', elements: [{ kind: 'pointer', value: `${q}D2WinImageEx` }] },
  } as unknown as AnalyzedDataSymbol;

  const project = generateProject(
    'hides', [creator, caller], [] as DetectedClass[], dataTypes, [table], namespaces,
    options, programInfo,
  );
  const files = [...project.files.entries()];
  const byPath = (suffix: string) => files.find(([p]) => p.endsWith(suffix))?.[1].content ?? '';
  return { files, byPath };
}

describe('a function that hides the struct it returns, in a namespace', () => {
  const { files, byPath } = scenario('D2Win::Src::D2WinImage');
  const header = byPath('Src/D2WinImage.h');
  const impl = byPath('Src/D2WinImage.cpp');
  const caller = byPath('D2WinMain.cpp');

  it('keeps its Ghidra name - the generator invents none', () => {
    for (const [path, f] of files) assert.doesNotMatch(f.content, /Create_/, path);
    assert.match(header, /\bD2WinImageEx\(int nPosX\)/, header);
  });

  it('spells the type root-qualified in the declaration', () => {
    assert.match(header, /(?:^|[^\w:])::D2WinImageEx \* *(?:__cdecl )?D2WinImageEx\(int nPosX\)/m, header);
  });

  it('spells it so in the definition, its locals, casts and sizeof', () => {
    assert.match(impl, /::D2WinImageEx \* *(?:__cdecl )?D2WinImageEx\(int nPosX\)/, impl);
    assert.doesNotMatch(impl, /(?<!::)\bD2WinImageEx\s*\*/, impl);
    assert.match(impl, /sizeof\(::D2WinImageEx\)/, impl);
  });

  it('needs no elaborated specifier, since `::` cannot reach a namespaced function', () => {
    for (const [path, f] of files) assert.doesNotMatch(f.content, /struct ::D2WinImageEx/, path);
  });

  it('is called from another unit by its Ghidra name', () => {
    assert.match(caller, /\bD2WinImage::D2WinImageEx\(nPosX\)/, caller);
  });

  it('is named by its Ghidra name where its address is taken', () => {
    assert.match(caller, /FORMS_SetCreator\(.*\bD2WinImage::D2WinImageEx\)/, caller);
  });

  it('is named by its Ghidra name in a table initializer', () => {
    const line = files.map(([, f]) => f.content).join('\n').split('\n')
      .find(l => l.includes('gpfnFormCreators') && l.includes('=')) ?? '';
    assert.match(line, /&D2Win::Src::D2WinImage::D2WinImageEx\b/, line);
  });
});

describe('a function that hides the struct it returns, at root scope', () => {
  const { files, byPath } = scenario(undefined);
  const caller = byPath('D2WinMain.cpp');

  it('keeps its name and elaborates the type, so `::D2WinImageEx` cannot name the function', () => {
    for (const [path, f] of files) assert.doesNotMatch(f.content, /Create_/, path);
    assert.match(caller, /\bD2WinImageEx\(nPosX\)/, caller);
    assert.doesNotMatch(caller, /(?<!struct )::D2WinImageEx\s*\*/, caller);
    assert.match(caller, /struct ::D2WinImageEx\s*\*\s*pImageEx/, caller);
  });

  it('elaborates it in the definition, its locals, casts and sizeof', () => {
    const impl = files.filter(([p]) => p.endsWith('.cpp')).map(([, f]) => f.content)
      .find(c => /D2WinImageEx\(int nPosX\) \{/.test(c)) ?? '';
    assert.match(impl, /struct ::D2WinImageEx \* *(?:__cdecl )?D2WinImageEx\(int nPosX\)/, impl);
    assert.doesNotMatch(impl, /(?<!struct ::)\bD2WinImageEx\s*\*/, impl);
    assert.match(impl, /sizeof\(struct ::D2WinImageEx\)/, impl);
  });
});
