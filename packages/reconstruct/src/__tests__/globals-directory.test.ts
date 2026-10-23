/**
 * The central globals files live in `globals/`, not at the tree root:
 * `globals/globals.h`, `globals/globals.cpp` and one `globals/<Module>.cpp` per
 * module. Every include of the header follows, spelled tree-relative like every
 * other header, and resolves byte for byte to a file the project emits.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateProject } from '../codegen/index.js';
import {
  GLOBALS_HEADER, globalsHeaderPathUnder, globalsUnitPath, isGlobalsHeaderPath, isGlobalsUnitPath,
} from '../codegen/globals-layout.js';
import { quotedIncludePath, resolveQuotedInclude } from '../codegen/path-case.js';
import { parseSource, treeFromFiles } from '../lint/tree.js';
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
  format: 'PE',
  architecture: 'x86',
  compiler: 'msvc',
  imageBase: '0x400000',
  languageId: 'x86:LE:32:default',
  endianness: 'little',
  pointerSize: 4,
};

function func(name: string, address: string, ns: string, body: string): ExtractedFunction {
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
    decompiled: `void ${name}(void)\n{\n${body}\n  return;\n}\n`,
    calledFunctions: [],
  } as ExtractedFunction;
}

function global(name: string, address: string, readers: string[]): AnalyzedDataSymbol {
  return {
    name,
    address,
    dataType: 'int',
    size: 4,
    isInitialized: false,
    xrefCount: readers.length,
    scope: 'global',
    referencingFunctions: readers,
  } as AnalyzedDataSymbol;
}

const functions: ExtractedFunction[] = [
  func('ClientTick', '0x401000', 'D2Client::Game', '  gClientCounter = gClientCounter + 1;'),
  func('CommonTick', '0x402000', 'D2Common::Units', '  gCommonCounter = gSharedCounter;'),
  func('ServerTick', '0x403000', 'D2Game::Units', '  gSharedCounter = 0;'),
];

const namespaces: ExtractedNamespace[] = [
  { name: 'Game', fullPath: 'D2Client::Game', functionCount: 1, isClass: false },
  { name: 'Units', fullPath: 'D2Common::Units', functionCount: 1, isClass: false },
  { name: 'Units', fullPath: 'D2Game::Units', functionCount: 1, isClass: false },
];

const globals: AnalyzedDataSymbol[] = [
  global('gClientCounter', '0x700000', ['D2Client::Game::ClientTick']),
  global('gCommonCounter', '0x700004', ['D2Common::Units::CommonTick']),
  // Read by two modules: no single module owns it, so it stays in the shared unit.
  global('gSharedCounter', '0x700008', ['D2Common::Units::CommonTick', 'D2Game::Units::ServerTick']),
];

describe('globals files are written to globals/', () => {
  const project = generateProject(
    'globalsdir', functions, [] as DetectedClass[], [], globals, namespaces, options, programInfo);
  const paths = [...project.files.keys()];

  it('emits the header, the shared unit and one unit per module there', () => {
    const inDir = paths.filter(p => p.startsWith('globals/')).sort();
    assert.deepStrictEqual(inDir, [
      'globals/D2Client.cpp',
      'globals/D2Common.cpp',
      'globals/globals.cpp',
      'globals/globals.h',
    ]);
  });

  it('leaves no globals file at the tree root', () => {
    const root = paths.filter(p => !p.includes('/') && /^globals/.test(p));
    assert.deepStrictEqual(root, []);
  });

  it('places each definition in its unit', () => {
    assert.match(project.files.get('globals/D2Client.cpp')!.content, /\bgClientCounter\b/);
    assert.match(project.files.get('globals/D2Common.cpp')!.content, /\bgCommonCounter\b/);
    assert.match(project.files.get('globals/globals.cpp')!.content, /\bgSharedCounter\b/);
  });

  it('includes the header by its tree-relative path everywhere', () => {
    const includers = [...project.files.values()].filter(f =>
      f.content.split('\n').some(l => quotedIncludePath(l)?.path.endsWith('globals.h')));
    assert.ok(includers.length >= 5, `expected the units and the function files, got ${includers.map(f => f.path)}`);
    for (const f of includers) {
      const specs = f.content.split('\n').map(l => quotedIncludePath(l)?.path).filter(p => p?.endsWith('globals.h'));
      assert.deepStrictEqual(specs, [GLOBALS_HEADER], f.path);
      assert.ok(f.includes.includes(GLOBALS_HEADER) || f.path.startsWith('globals/'), f.path);
    }
  });

  it('every quoted include of an emitted file resolves case-exactly', () => {
    const exact = new Set(paths);
    const folded = new Set(paths.map(p => p.toLowerCase()));
    for (const f of project.files.values()) {
      for (const line of f.content.split('\n')) {
        const inc = quotedIncludePath(line);
        if (!inc) continue;
        if (!resolveQuotedInclude(f.path, inc.path, p => folded.has(p.toLowerCase()))) continue;
        assert.ok(resolveQuotedInclude(f.path, inc.path, p => exact.has(p)), `${f.path}: ${inc.path}`);
      }
    }
  });
});

describe('globals layout paths', () => {
  it('puts the header under a target directory when there is one', () => {
    assert.strictEqual(globalsHeaderPathUnder(''), 'globals/globals.h');
    assert.strictEqual(globalsHeaderPathUnder('core'), 'core/globals/globals.h');
  });

  it('names the shared unit and the module units beside the header', () => {
    assert.strictEqual(globalsUnitPath(GLOBALS_HEADER, undefined, '.cpp'), 'globals/globals.cpp');
    assert.strictEqual(globalsUnitPath(GLOBALS_HEADER, '_Wrappers', '.cpp'), 'globals/_Wrappers.cpp');
    assert.strictEqual(globalsUnitPath('core/globals/globals.h', 'Fog', '.c'), 'core/globals/Fog.c');
  });

  it('gives a module named like the shared unit no path of its own', () => {
    assert.strictEqual(globalsUnitPath(GLOBALS_HEADER, 'globals', '.cpp'), undefined);
    assert.strictEqual(globalsUnitPath(GLOBALS_HEADER, 'Globals', '.cpp'), undefined);
    assert.strictEqual(globalsUnitPath(GLOBALS_HEADER, 'Global', '.cpp'), 'globals/Global.cpp');
  });

  it('recognises the globals files in both the directory and the older root layout', () => {
    assert.ok(isGlobalsHeaderPath('globals/globals.h'));
    assert.ok(isGlobalsHeaderPath('globals.h'));
    assert.ok(!isGlobalsHeaderPath('D2Game/globals.h'));
    for (const p of ['globals/globals.cpp', 'globals/D2Client.cpp', 'globals.cpp', 'globals.D2Client.cpp']) {
      assert.ok(isGlobalsUnitPath(p), p);
    }
    for (const p of ['globals/globals.h', 'globals/sub/X.cpp', 'D2Game/globals.cpp', 'globalsX.cpp']) {
      assert.ok(!isGlobalsUnitPath(p), p);
    }
  });

  it('lint reads the externs from globals/globals.h', () => {
    const tree = treeFromFiles('/tree', [parseSource('globals/globals.h', 'extern int gaTable[4];\n')]);
    assert.ok(tree.globals.has('gaTable'));
  });
});
