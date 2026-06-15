/**
 * Offline test: excluded namespaces/modules produce NO output file and never
 * land in the CMake source list.
 *
 * Reconstructed C/MSVC-runtime modules (compiler/*, VisualStudio/*) are not
 * game code and pollute the compile with cascade errors, so they must not be
 * emitted at all. Function-level excludePatterns only filter primary-binary
 * functions during extraction; whole runtime namespaces (compiler — which has
 * no pattern at all) and mac-merged secondary functions (extracted WITHOUT
 * excludePatterns, e.g. VisualStudio::start) still reach codegen. The
 * `excludeNamespaces` codegen filter is the single choke point that drops them
 * — functions, classes, datatypes, globals AND the per-namespace file — so they
 * also vanish from the file-derived CMake source list.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateProject } from '../codegen/index.js';
import { generateCMakeLists } from '../codegen/cmake.js';
import type {
  ExtractedFunction,
  ExtractedDataType,
  ExtractedStruct,
  AnalyzedDataSymbol,
  DetectedClass,
  ExtractedNamespace,
  ProgramInfo,
  ReconstructOptions,
} from '../types.js';

const programInfo: ProgramInfo = {
  name: 'Smoke.exe',
  path: '/tmp/Smoke.exe',
  format: 'PE',
  architecture: 'x86',
  compiler: 'msvc',
  imageBase: '0x400000',
  languageId: 'x86:LE:32:default',
  endianness: 'little',
  pointerSize: 4,
};

function func(
  name: string,
  address: string,
  body: string,
  ns: string,
  ifdef?: string
): ExtractedFunction {
  return {
    name,
    address,
    signature: `void ${name}(void)`,
    returnType: 'void',
    parameters: [],
    localVariables: [],
    callingConvention: '__cdecl',
    size: 0x20,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    namespace: ns,
    ifdef,
    decompiled: body,
    calledFunctions: [],
  };
}

function baseOptions(excludeNamespaces?: (string | RegExp)[]): ReconstructOptions {
  return {
    outputDir: './out',
    format: 'cpp',
    organization: 'namespace',
    generateCMake: false,
    generateSourceMaps: false,
    transformPreset: 'quick',
    includeAddressComments: false,
    promoteStaticGlobals: false,
    excludeNamespaces,
  };
}

describe('excludeNamespaces', () => {
  // A realistic mixed dataset: real game code (D2Common) plus two runtime
  // modules — `compiler` (a primary-binary namespace, no exclude pattern) and
  // `VisualStudio` (a mac-merged secondary function that bypassed the
  // extraction-time exclude).
  const functions: ExtractedFunction[] = [
    func('D2_Init', '0x401000', 'void D2_Init(void){return;}\n', 'D2Common'),
    func('_initterm', '0x402000', 'void _initterm(void){return;}\n', 'compiler'),
    func('start', '0x403000', 'void start(void){return;}\n', 'VisualStudio', 'D2_PLATFORM_MAC'),
  ];

  const dataTypes: ExtractedDataType[] = [
    {
      kind: 'STRUCTURE',
      name: 'D2NameStrc',
      category: '/D2Common',
      size: 4,
      fields: [{ name: 'pNext', dataType: 'D2NameStrc *', offset: 0, size: 4 }],
    } as ExtractedStruct,
    // A CRT-runtime struct that lives under the excluded `compiler` category.
    {
      kind: 'STRUCTURE',
      name: '_PtFuncCompare',
      category: '/compiler',
      size: 4,
      fields: [],
    } as ExtractedStruct,
  ];

  const classes: DetectedClass[] = [];
  const globals: AnalyzedDataSymbol[] = [];
  const namespaces: ExtractedNamespace[] = [
    { name: 'D2Common', fullPath: 'D2Common', functionCount: 1, isClass: false },
    { name: 'compiler', fullPath: 'compiler', functionCount: 1, isClass: false },
    { name: 'VisualStudio', fullPath: 'VisualStudio', functionCount: 1, isClass: false },
  ];

  it('emits NO file for excluded namespaces and keeps game code', () => {
    const project = generateProject(
      'smoke',
      functions,
      classes,
      dataTypes,
      globals,
      namespaces,
      baseOptions([/^compiler$/, /^VisualStudio$/]),
      programInfo
    );

    const paths = [...project.files.keys()];

    // No compiler/* or VisualStudio/* files of ANY kind (.h/.cpp/.map).
    const banned = paths.filter(
      p => p.startsWith('compiler/') || p.startsWith('VisualStudio/')
    );
    assert.deepStrictEqual(banned, [], `expected no excluded-namespace files, got: ${banned.join(', ')}`);

    // The excluded function bodies must not appear in ANY emitted file.
    const allContent = [...project.files.values()].map(f => f.content).join('\n');
    assert.doesNotMatch(allContent, /\b_initterm\b/, '_initterm (compiler) must not be emitted');
    assert.doesNotMatch(allContent, /VisualStudio::start|\bstart\(/, 'VisualStudio::start must not be emitted');

    // Real game code still lands in a file.
    const d2Files = paths.filter(p => p.startsWith('D2Common/'));
    assert.ok(d2Files.length > 0, 'expected D2Common game code to still be emitted');
  });

  it('keeps excluded namespaces OUT of the CMake source list', () => {
    const project = generateProject(
      'smoke',
      functions,
      classes,
      dataTypes,
      globals,
      namespaces,
      baseOptions([/^compiler$/, /^VisualStudio$/]),
      programInfo
    );

    const cmake = generateCMakeLists(project, baseOptions());
    assert.doesNotMatch(cmake, /compiler\//, 'CMake must not list compiler/* sources');
    assert.doesNotMatch(cmake, /VisualStudio\//, 'CMake must not list VisualStudio/* sources');
  });

  it('without excludeNamespaces the runtime modules ARE emitted (proves the filter is load-bearing)', () => {
    const project = generateProject(
      'smoke',
      functions,
      classes,
      dataTypes,
      globals,
      namespaces,
      baseOptions(), // no exclusions
      programInfo
    );
    const paths = [...project.files.keys()];
    const emitted = paths.some(p => p.startsWith('compiler/') || p.startsWith('VisualStudio/'));
    assert.ok(emitted, 'control: without exclusion the runtime modules should be emitted');
  });
});
