/**
 * Regression test: a namespace reachable ONLY through an address-taken reference
 * in a data initializer must still get its header included.
 *
 * Two holes, both measured on 1.14d:
 *
 *  1. globals.cpp's include set was computed from the DECLARED TYPE of each
 *     global and nothing else. A handler table whose initializer names
 *     `&D2Common::Skills::SkillMonst::Skills_SrvDoFunc_083` says nothing about
 *     SkillMonst in its type, so SkillMonst.h was never included — 222
 *     "has not been declared" errors in globals.cpp alone.
 *
 *  2. The per-file dependency scan resolved a function reference by its BARE
 *     name through a one-entry-per-name map. `Initialize` is declared by Glide,
 *     Direct3D, DirectDraw and Windowed alike, so the map is last-wins: whichever
 *     renderer was organized last won and the other three stayed undeclared
 *     (54 errors for Glide, 54 for DirectDraw). An ambiguous name has to be
 *     resolved from the qualifier actually written at the reference site.
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

// `Initialize` in four different renderers — the ambiguity that makes a bare-name
// map useless. Only Glide's and DirectDraw's are actually referenced below.
const functions: ExtractedFunction[] = [
  func('Initialize', '0x401000', 'D2Client::Renderer::Glide'),
  func('Initialize', '0x401100', 'D2Client::Renderer::Direct3D'),
  func('Initialize', '0x401200', 'D2Client::Renderer::DirectDraw'),
  func('Initialize', '0x401300', 'D2Client::Renderer::Windowed'),
  // Doubled segment on the declaration side; the reference must find it anyway.
  func('Skills_SrvDoFunc_083', '0x402000', 'D2Common::Skills::Skills::SkillMonst'),
  func('Nothing', '0x403000', 'D2Common::Dummy'),
];

const namespaces: ExtractedNamespace[] = [
  { name: 'Glide', fullPath: 'D2Client::Renderer::Glide', functionCount: 1, isClass: false },
  { name: 'Direct3D', fullPath: 'D2Client::Renderer::Direct3D', functionCount: 1, isClass: false },
  { name: 'DirectDraw', fullPath: 'D2Client::Renderer::DirectDraw', functionCount: 1, isClass: false },
  { name: 'Windowed', fullPath: 'D2Client::Renderer::Windowed', functionCount: 1, isClass: false },
  { name: 'SkillMonst', fullPath: 'D2Common::Skills::Skills::SkillMonst', functionCount: 1, isClass: false },
  { name: 'Dummy', fullPath: 'D2Common::Dummy', functionCount: 1, isClass: false },
];

const dataTypes: ExtractedDataType[] = [];

/** A central global whose ONLY link to Glide/DirectDraw/SkillMonst is its initializer. */
const HANDLER_TABLE: AnalyzedDataSymbol = {
  name: 'gHandlerTable',
  address: '006fd000',
  dataType: 'void *[3]',
  size: 12,
  isInitialized: true,
  xrefCount: 3,
  scope: 'global',
  initializedData: {
    kind: 'array',
    elements: [
      { kind: 'pointer', value: 'D2Client::Renderer::Glide::Initialize' },
      { kind: 'pointer', value: 'D2Client::Renderer::DirectDraw::Initialize' },
      { kind: 'pointer', value: 'D2Common::Skills::Skills::SkillMonst::Skills_SrvDoFunc_083' },
    ],
  },
};

describe('initializer-only references pull in their declaring headers', () => {
  const project = generateProject(
    'initrefs',
    functions,
    [] as DetectedClass[],
    dataTypes,
    [HANDLER_TABLE],
    namespaces,
    options,
    programInfo
  );
  const globalsImpl = project.files.get('globals.cpp');

  it('generates globals.cpp with the table', () => {
    assert.ok(globalsImpl, 'globals.cpp was not generated');
    assert.match(globalsImpl!.content, /gHandlerTable/);
  });

  it('resolves an ambiguous bare name from the qualifier at the reference site', () => {
    // `Initialize` exists in four namespaces; exactly the two that are referenced
    // must be included, and picking one arbitrarily is the bug.
    assert.match(globalsImpl!.content, /#include "D2Client\/Renderer\/Glide\.h"/);
    assert.match(globalsImpl!.content, /#include "D2Client\/Renderer\/DirectDraw\.h"/);
  });

  it('includes a header reached only through a doubled-segment reference', () => {
    assert.match(globalsImpl!.content, /#include "D2Common\/Skills\/SkillMonst\.h"/);
  });
});
