/**
 * The build file must describe the tree, not the intent.
 *
 * `generateCMakeLists` used to walk `project.files` with its own loop while
 * `writeProject` wrote the tree from a different one. Nothing forced the two to
 * agree, and the two ways they can disagree are both fatal and both silent
 * until someone runs cmake:
 *
 *   - a path listed in SOURCES that was never written - configure dies on a
 *     missing source, so nothing builds at all;
 *   - a written .cpp missing from SOURCES - it builds, and then links with
 *     everything that file defined undefined. The per-module `globals.*.cpp`
 *     units are exactly this shape: they carry the global DEFINITIONS, so
 *     omitting them produces a tree that compiles clean and links to nothing.
 *
 * These tests pin the invariant as set equality against the real writer, so a
 * future emitter that registers files through a new path cannot reintroduce
 * either half. The one permitted difference is the Mac-only modules, which are
 * written but deliberately not compiled - the build targets the Windows binary.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { generateCMakeLists, generateMakefile, collectBuildFiles } from '../codegen/cmake.js';
import { writeProject } from '../codegen/index.js';
import type { ReconstructedProject, ReconstructOptions, SourceFile } from '../types.js';

const options: ReconstructOptions = {
  outputDir: './out',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: true,
  generateSourceMaps: false,
  transformPreset: 'quick',
  includeAddressComments: false,
  promoteStaticGlobals: false,
};

function file(p: string, type: SourceFile['type']): [string, SourceFile] {
  return [p, { path: p, content: `// ${p}\n`, type, functions: [], includes: [] }];
}

/**
 * A project shaped like the real output: module sub-directories, the central
 * `globals.cpp` plus its per-module split, a root header, and a Mac-only module.
 */
function makeProject(): ReconstructedProject {
  const files = new Map<string, SourceFile>([
    file('Fog/Alloc.cpp', 'implementation'),
    file('Fog/Alloc.h', 'header'),
    file('Storm/Replicator.h', 'header'),
    file('D2Client/Game/Draw.cpp', 'implementation'),
    file('globals.cpp', 'implementation'),
    file('globals.Fog.cpp', 'implementation'),
    file('globals.Storm.cpp', 'implementation'),
    file('globals.D2Client.cpp', 'implementation'),
    file('globals.h', 'header'),
    file('MacSpecific/MacMain.cpp', 'implementation'),
    file('StormMac/SMemMac.cpp', 'implementation'),
    file('StormMac/SMemMac.h', 'header'),
  ]);

  return {
    name: 'Game.exe',
    files,
    sourceMaps: new Map(),
    dataTypes: [],
    globals: [],
    classes: [],
    namespaces: [],
  };
}

/** Read a `set(NAME ... )` block back out of emitted CMake, without regex over code. */
function cmakeList(cmake: string, name: string): string[] {
  const lines = cmake.split('\n');
  const start = lines.indexOf(`set(${name}`);
  assert.notStrictEqual(start, -1, `no set(${name}) block in the emitted CMakeLists.txt`);
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === ')') return out;
    out.push(lines[i].trim());
  }
  assert.fail(`unterminated set(${name}) block`);
}

async function walk(root: string, dir = ''): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, dir), { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(root, rel)));
    else out.push(rel);
  }
  return out;
}

const MAC_ONLY = (p: string) => p.startsWith('MacSpecific/') || p.startsWith('StormMac/');

describe('CMake source list matches the written tree', () => {
  it('SOURCES and HEADERS are exactly the files writeProject puts on disk', async () => {
    const project = makeProject();
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmake-source-list-'));

    try {
      await writeProject(project, outputDir, { ...options, outputDir });

      const onDisk = await walk(outputDir);
      const diskSources = onDisk.filter(p => p.endsWith('.cpp') && !MAC_ONLY(p)).sort();
      const diskHeaders = onDisk.filter(p => p.endsWith('.h') && !MAC_ONLY(p)).sort();

      const cmake = await fs.readFile(path.join(outputDir, 'CMakeLists.txt'), 'utf-8');

      // Both directions at once: a listed-but-unwritten source and a
      // written-but-unlisted one are each a set difference.
      assert.deepStrictEqual(cmakeList(cmake, 'SOURCES'), diskSources);
      assert.deepStrictEqual(cmakeList(cmake, 'HEADERS'), diskHeaders);
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it('lists every per-module globals unit, not just the central one', () => {
    const project = makeProject();
    const sources = cmakeList(generateCMakeLists(project, options), 'SOURCES');

    for (const unit of ['globals.cpp', 'globals.Fog.cpp', 'globals.Storm.cpp', 'globals.D2Client.cpp']) {
      assert.ok(sources.includes(unit), `${unit} defines globals and must be compiled`);
    }
  });

  it('lists nothing the project does not hold', () => {
    const project = makeProject();
    const cmake = generateCMakeLists(project, options);

    for (const listed of [...cmakeList(cmake, 'SOURCES'), ...cmakeList(cmake, 'HEADERS')]) {
      assert.ok(project.files.has(listed), `${listed} is listed but is not an emitted file`);
    }
  });

  it('drops an entry the writer would skip', () => {
    // Stand-in for the historical `Fog/Replicator.cpp`: an entry that reached
    // the file map and then did not reach the tree. Whatever removes it must
    // remove it from the build list too, because it is the same map.
    const project = makeProject();
    project.files.delete('globals.Fog.cpp');

    const sources = cmakeList(generateCMakeLists(project, options), 'SOURCES');
    assert.ok(!sources.includes('globals.Fog.cpp'));
    assert.ok(sources.includes('globals.Storm.cpp'));
  });

  it('excludes the Mac-only modules from every emitter', () => {
    const project = makeProject();
    const { sources, headers } = collectBuildFiles(project.files);

    assert.deepStrictEqual(sources.filter(MAC_ONLY), []);
    assert.deepStrictEqual(headers.filter(MAC_ONLY), []);

    // The Makefile emitter used to keep its own loop with no Mac filter.
    const makefile = generateMakefile(project, options);
    assert.ok(!makefile.includes('MacSpecific/'));
    assert.ok(!makefile.includes('StormMac/'));
  });

  it('scopes a directory list to that directory and strips the prefix', () => {
    const project = makeProject();
    const { sources, headers } = collectBuildFiles(project.files, 'Fog');

    assert.deepStrictEqual(sources, ['Alloc.cpp']);
    assert.deepStrictEqual(headers, ['Alloc.h']);
  });
});

describe('decompiled-code compile flags', () => {
  it('does not relax C++ conformance', () => {
    // The tree compiles strict with 0 errors; -fpermissive would hide the next
    // regression rather than surface it.
    const cmake = generateCMakeLists(makeProject(), options);
    assert.ok(!cmake.includes('-fpermissive'));
    assert.ok(cmake.includes('add_compile_options(-w -fms-extensions)'));
  });
});
