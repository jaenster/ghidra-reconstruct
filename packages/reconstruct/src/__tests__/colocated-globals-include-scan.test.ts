/**
 * Regression test: co-located global definitions must be part of a struct .cpp
 * BEFORE its dependency scan runs.
 *
 * `generateColocatedGlobalsImpl` output used to be concatenated onto `implContent`
 * AFTER the "body dep feedback" pass in codegen/index.ts had already decided which
 * headers the file needs. Anything named only inside that block — the type being
 * defined, or the functions its initializer takes the address of — was invisible
 * to the scan, so no include was ever added for it.
 *
 * Real 1.14d case: D2Client/Renderer/Renderer.cpp defines
 *
 *     D2RendererFunctionsStrc GlideFunctionTable = {
 *         &D2Client::Renderer::Glide::Initialize, …
 *     };
 *
 * and got 54 "'D2Client::Renderer::Glide' has not been declared" errors because
 * Glide.h was never included.
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
  transformPreset: 'quick',
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

function func(name: string, address: string, ns: string): ExtractedFunction {
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
    decompiled: `void ${name}(void)\n{\n  return;\n}\n`,
    calledFunctions: [],
  } as ExtractedFunction;
}

const dataTypes: ExtractedDataType[] = [
  {
    kind: 'STRUCTURE',
    name: 'D2GlideStateStrc',
    category: '/D2Client/Renderer/Glide',
    size: 8,
    fields: [
      { name: 'nMode', dataType: 'int', offset: 0, size: 4 },
      { name: 'nFlags', dataType: 'int', offset: 4, size: 4 },
    ],
  } as ExtractedDataType,
  {
    kind: 'STRUCTURE',
    name: 'D2RendererFunctionsStrc',
    category: '/D2Client/Renderer',
    size: 4,
    fields: [{ name: 'nfpInitialize', dataType: 'void *', offset: 0, size: 4 }],
  } as ExtractedDataType,
];

const functions: ExtractedFunction[] = [
  func('Initialize', '0x401000', 'D2Client::Renderer::Glide'),
  func('Draw', '0x401100', 'D2Client::Renderer'),
];

const namespaces: ExtractedNamespace[] = [
  { name: 'Glide', fullPath: 'D2Client::Renderer::Glide', functionCount: 1, isClass: false },
  { name: 'Renderer', fullPath: 'D2Client::Renderer', functionCount: 1, isClass: false },
];

/**
 * Lives in Renderer.cpp (ownerStructHeader is Renderer.h) but is TYPED by a
 * struct that Glide.h owns — so only the co-located block names D2GlideStateStrc.
 */
const COLOCATED: AnalyzedDataSymbol = {
  name: 'gGlideState',
  address: '006fc000',
  dataType: 'D2GlideStateStrc',
  size: 8,
  isInitialized: true,
  xrefCount: 2,
  scope: 'struct-colocated',
  namespace: 'D2Client::Renderer',
  ownerStructType: 'D2RendererFunctionsStrc',
  ownerStructHeader: 'D2Client/Renderer.h',
  initializedData: {
    kind: 'struct',
    fields: [
      { name: 'nMode', value: { kind: 'scalar', value: '0' } },
      { name: 'nFlags', value: { kind: 'scalar', value: '0' } },
    ],
  },
};

describe('co-located globals participate in the impl dependency scan', () => {
  const project = generateProject(
    'colocated',
    functions,
    [] as DetectedClass[],
    dataTypes,
    [COLOCATED],
    namespaces,
    options,
    programInfo
  );
  const renderer = project.files.get('D2Client/Renderer.cpp');

  it('emits the co-located definition', () => {
    assert.ok(renderer, 'D2Client/Renderer.cpp was not generated');
    assert.match(renderer!.content, /D2GlideStateStrc gGlideState = \{/);
  });

  it('includes the header owning a type named only in the co-located block', () => {
    // Without the include, D2GlideStateStrc is incomplete and the brace
    // initializer is "variable has initializer but incomplete type".
    assert.match(renderer!.content, /#include "D2Client\/Renderer\/Glide\.h"/);
  });

  it('keeps the co-located block after the includes', () => {
    const lastInclude = renderer!.content.lastIndexOf('#include');
    const block = renderer!.content.indexOf('Co-located global data definitions');
    assert.ok(block > lastInclude, 'co-located block must not precede the includes');
  });
});
