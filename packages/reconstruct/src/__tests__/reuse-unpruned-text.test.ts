/**
 * An incremental run reuses a unit's text as the unit loop emitted it, never the tree.
 *
 * The tree on disk has been through the include pass, which keeps only what the file
 * used under that run's placement. Reusing it would carry the old pruning forward: once a
 * type or a function moves to another header, the reused file could never include the
 * new home. So the unit loop keeps its own text beside the identifier cache, and reuse
 * reads that; the include pass then runs on it as it runs on freshly emitted text.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { ExtractedFunction, ProgramInfo, ReconstructOptions } from '../types.js';
import { pruneIncludes, type PrunableFile } from '../codegen/include-pruning.js';
import { quotedIncludePath } from '../codegen/path-case.js';

// The cache path is read when the generator module loads.
const dir = mkdtempSync(join(tmpdir(), 'reuse-unpruned-'));
const cachePath = join(dir, 'unit-identifiers.json');
process.env.RECON_UNIT_IDENT_CACHE = cachePath;
const { generateProject, configureIncrementalEmit } = await import('../codegen/index.js');

const programInfo: ProgramInfo = {
  name: 'T.exe', path: '/tmp/T.exe', format: 'PE', architecture: 'x86', compiler: 'msvc',
  imageBase: '0x400000', languageId: 'x86:LE:32:default', endianness: 'little', pointerSize: 4,
};

const options = {
  outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false,
  generateSourceMaps: false, transformPreset: 'full', includeAddressComments: false,
  promoteStaticGlobals: false,
} as ReconstructOptions;

function fn(ns: string, name: string, address: string, body: string): ExtractedFunction {
  return {
    name, address, namespace: ns, returnType: 'int', signature: `int ${name}(void)`,
    parameters: [], localVariables: [], callingConvention: '__cdecl', size: 0x20,
    isThunk: false, isExternal: false, hasVarArgs: false, calledFunctions: [],
    decompiled: `int ${name}(void)\n\n{\n  ${body}\n}\n`,
  } as ExtractedFunction;
}

const namespaces = [
  { name: 'A', fullPath: 'A', functions: [] },
  { name: 'B', fullPath: 'B', functions: [] },
] as never[];
const functions = () => [
  fn('A', 'A_One', '00401000', 'return 1;'),
  fn('B', 'B_One', '00402000', 'return A::A_One() + 1;'),
];

function generate(): Map<string, string> {
  const project = generateProject('t', functions(), [], [], [], namespaces, options, programInfo, []);
  return new Map([...project.files].map(([p, f]) => [p, f.content]));
}

describe('reuse reads the unit text the unit loop emitted', () => {
  configureIncrementalEmit(null, null);
  process.env.RECON_KEEP_ALL_INCLUDES = '1';
  const unpruned = generate();
  delete process.env.RECON_KEEP_ALL_INCLUDES;
  const full = generate();
  const units = [...full.keys()].filter(p => p.endsWith('.cpp') && /\b[AB]\.cpp$/.test(p));

  it('keeps each emitted unit as it was before stage 2 rewrote it', () => {
    assert.strictEqual(units.length, 2, [...full.keys()].join(', '));
    for (const p of units) {
      const kept = join(`${cachePath}.units`, p);
      assert.ok(existsSync(kept), `${p} has no kept text`);
      assert.strictEqual(readFileSync(kept, 'utf-8'), unpruned.get(p), p);
    }
  });

  it('reuses that text, not the tree, and matches a full generation', () => {
    // The tree a previous run wrote, here deliberately not what the generator would write.
    const tree = join(dir, 'tree');
    for (const p of units) {
      mkdirSync(dirname(join(tree, p)), { recursive: true });
      writeFileSync(join(tree, p), '// stale tree text, never to be reused\n');
    }
    configureIncrementalEmit([], tree);
    try {
      const incremental = generate();
      for (const [p, content] of full) assert.strictEqual(incremental.get(p), content, p);
      // And it was reused, not emitted again: a mark in the kept text reaches the output.
      const kept = join(`${cachePath}.units`, units[0]);
      const original = readFileSync(kept, 'utf-8');
      writeFileSync(kept, `${original}\n// kept-text mark\n`);
      try {
        assert.match(generate().get(units[0])!, /kept-text mark/);
      } finally {
        writeFileSync(kept, original);
      }
    } finally {
      configureIncrementalEmit(null, null);
    }
  });
});

describe('pruning a reused unit after a type moves to another header', () => {
  const includes = (files: Map<string, PrunableFile>, p: string) =>
    files.get(p)!.content.split('\n').map(l => quotedIncludePath(l)?.path).filter(Boolean);
  // The unit as the unit loop emits it: both candidate homes included.
  const unit = `#include "Lib/One.h"\n#include "Lib/Two.h"\n\nint F(D2PathStrc * p) { return p->nX; }\n`;
  const before = {
    'Lib/One.h': `#pragma once\nstruct D2PathStrc { int nX; };\n`,
    'Lib/Two.h': `#pragma once\nint Other();\n`,
  };
  const after = {
    'Lib/One.h': `#pragma once\nint Other();\n`,
    'Lib/Two.h': `#pragma once\nstruct D2PathStrc { int nX; };\n`,
  };
  const tree = (headers: Record<string, string>, text: string) =>
    new Map(Object.entries({ ...headers, 'Game/Use.cpp': text }).map(([path, content]) => [path, { path, content }]));

  it('finds the new home from the emitted text', () => {
    const first = tree(before, unit);
    pruneIncludes(first);
    assert.deepStrictEqual(includes(first, 'Game/Use.cpp'), ['Lib/One.h']);
    const second = tree(after, unit);
    pruneIncludes(second);
    assert.deepStrictEqual(includes(second, 'Game/Use.cpp'), ['Lib/Two.h']);
  });

  it('could not have found it from the pruned tree', () => {
    const first = tree(before, unit);
    pruneIncludes(first);
    const second = tree(after, first.get('Game/Use.cpp')!.content);
    pruneIncludes(second);
    assert.notDeepStrictEqual(includes(second, 'Game/Use.cpp'), ['Lib/Two.h']);
  });
});
