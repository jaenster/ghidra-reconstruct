/**
 * Regression test: an emitted `#include "..."` must name a file the same run
 * emitted, and every emitted file must still be on disk once writeProject is
 * done.
 *
 * What this guards, measured on 1.14d:
 *
 *  1. `globals.h` emitted `D2Client/GAME/Draw.h`, `D2Client/GAME/Game.h` and
 *     `D2Common/ITEMS/Items.h`. Every translation unit includes globals.h, so
 *     three unresolvable includes failed all 489 of them with
 *     `fatal error: ... No such file or directory` — files, failing and errors
 *     all read 489, which is the signature of a fatal-header collapse and not of
 *     a real regression.
 *
 *  2. The paths were not wrong. writeProject had WRITTEN all three and then
 *     deleted them. Its stale-file prune compares its keep-set against what
 *     readdir observes, and on a case-insensitive filesystem those spellings
 *     need not match: `D2Client::GAME::Draw` and `D2Client::Game::Record` are
 *     two output directories and one directory on disk, named for whichever
 *     spelling mkdir created first. Every file written under the other spelling
 *     was absent from the keep-set and was unlinked — 21 headers, three of them
 *     reachable from globals.h.
 *
 * So the invariant is stated twice, once against the emitted file table and once
 * against the filesystem, because the two disagreed and only the filesystem was
 * telling the truth.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { generateProject, writeProject, findUnresolvableIncludes } from '../codegen/index.js';
import type {
  AnalyzedDataSymbol,
  ExtractedDataType,
  ExtractedFunction,
  ProgramInfo,
  ReconstructOptions,
  ReconstructedProject,
  SourceFile,
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

function struct(name: string, ns: string): ExtractedDataType {
  return {
    name,
    kind: 'STRUCTURE',
    size: 4,
    category: `/${ns.replace(/::/g, '/')}`,
    fields: [{ name: 'nValue', dataType: 'int', offset: 0, size: 4 }],
  } as ExtractedDataType;
}

function global(name: string, address: string, type: string): AnalyzedDataSymbol {
  return {
    name,
    address,
    dataType: type,
    suggestedName: name,
    suggestedType: type,
    size: 4,
    scope: 'global',
    xrefCount: 4,
  } as AnalyzedDataSymbol;
}

// The three shapes that produced the failure:
//   - `Draw` living under a folder namespace whose spelling differs from a
//     sibling's (GAME vs Game),
//   - `Items` being both a folder namespace and the file inside it,
//   - a by-value global whose struct is owned by one of those units, which is
//     what makes globals.h include it at all.
const functions: ExtractedFunction[] = [
  func('DRAW_Tile', '0x401000', 'D2Client::GAME::Draw'),
  func('GAME_Poll', '0x401100', 'D2Client::GAME::Game'),
  func('CLIENT_Record', '0x401200', 'D2Client::GAME::Record'),
  func('CLIENT_RecordNew', '0x401300', 'D2Client::Game::Record'),
  func('ITEMS_Alloc', '0x401400', 'D2Common::ITEMS::Items'),
  func('ITEMS_Free', '0x401500', 'D2Common::Items::Items'),
  func('PATH_Step', '0x401600', 'D2Common::PATH::Path'),
];

const dataTypes: ExtractedDataType[] = [
  struct('D2DrawStateStrc', 'D2Client/GAME/Draw'),
  struct('D2ItemsStateStrc', 'D2Common/ITEMS/Items'),
];

const globals: AnalyzedDataSymbol[] = [
  global('gDrawState', '0x600000', 'D2DrawStateStrc'),
  global('gItemsState', '0x600010', 'D2ItemsStateStrc'),
];

function build(): ReconstructedProject {
  return generateProject(
    'Reconstructed',
    functions,
    [],
    dataTypes,
    globals,
    [],
    options,
    programInfo
  );
}

describe('emitted include resolution', () => {
  it('every generated include names a file the run emitted', () => {
    const project = build();
    const unresolved = findUnresolvableIncludes(project);
    const report = [...unresolved]
      .map(([inc, referrers]) => `${inc} <- ${referrers.join(', ')}`)
      .join('\n');
    assert.strictEqual(unresolved.size, 0, `unresolvable includes:\n${report}`);
  });

  it('reports an include whose file is not in the emitted table', () => {
    // Guards the check itself: a checker that resolves against a derived path
    // instead of the emitted table would pass this too.
    const project = build();
    const anyHeader = [...project.files.keys()].find(p => p.endsWith('.h') && p.includes('/'));
    assert.ok(anyHeader, 'expected at least one nested header');

    const consumer: SourceFile = {
      path: 'consumer.cpp',
      content: `#include "${anyHeader}"\n#include "D2Client/GAME/Nowhere.h"\n`,
      type: 'implementation',
      functions: [],
      includes: [],
    };
    project.files.set(consumer.path, consumer);

    const unresolved = findUnresolvableIncludes(project);
    assert.deepStrictEqual([...unresolved.keys()], ['D2Client/GAME/Nowhere.h']);
  });
});

describe('writeProject leaves every emitted file on disk', () => {
  it('keeps files whose paths differ only in case, and still prunes real strays', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghidra-recon-prune-'));
    try {
      // A stray from a previous run: nothing this run writes, so it must go.
      mkdirSync(join(dir, 'Stale'), { recursive: true });
      writeFileSync(join(dir, 'Stale', 'Gone.h'), '#pragma once\n', 'utf-8');

      const file = (path: string): SourceFile => ({
        path,
        content: `#pragma once\n// ${path}\n`,
        type: path.endsWith('.h') ? 'header' : 'implementation',
        functions: [],
        includes: [],
      });

      // Two directory spellings that are one directory on a case-insensitive
      // filesystem, plus a file only the second spelling contains — the exact
      // shape the prune deleted.
      const paths = [
        'D2Client/GAME/Draw.h',
        'D2Client/GAME/Record.h',
        'D2Client/Game/Record.h',
        'D2Client/Game/Roster.h',
      ];

      const project: ReconstructedProject = {
        name: 'Reconstructed',
        files: new Map(paths.map(p => [p, file(p)])),
        sourceMaps: new Map(),
        dataTypes: [],
        globals: [],
        classes: [],
        namespaces: [],
      };

      await writeProject(project, dir, { ...options, outputDir: dir, generateCMake: false });

      for (const p of project.files.keys()) {
        assert.ok(existsSync(join(dir, p)), `writeProject wrote ${p} and then removed it`);
      }
      assert.ok(!existsSync(join(dir, 'Stale', 'Gone.h')), 'a real stray must still be pruned');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
