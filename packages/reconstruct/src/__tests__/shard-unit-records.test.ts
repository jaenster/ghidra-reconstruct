/**
 * A generation shard ships the unit records it wrote, not the cache it loaded.
 *
 * Every shard loads the whole per-unit identifier cache and records only the units
 * it emits. When it shipped its whole map, the coordinator merged the shards in turn
 * and a later shard's loaded copy of a unit replaced the record the owning shard had
 * just written - so that unit's include basis never reached the cache, and every
 * incremental run re-emitted it again (40 units on the live daemon at v1863).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ExtractedFunction,
  ProgramInfo,
  ReconstructOptions,
} from '../types.js';

// The cache path is read when the generator module loads.
const dir = mkdtempSync(join(tmpdir(), 'shard-records-'));
const cachePath = join(dir, 'unit-identifiers.json');
const stale = { idents: [], declared: [], initRefs: [], statics: [] };
writeFileSync(cachePath, JSON.stringify({ A: stale, B: stale }));
process.env.RECON_UNIT_IDENT_CACHE = cachePath;
const { generateProjectStage1, takeShardOutput } = await import('../codegen/index.js');

const programInfo: ProgramInfo = {
  name: 'T.exe', path: '/tmp/T.exe', format: 'PE', architecture: 'x86', compiler: 'msvc',
  imageBase: '0x400000', languageId: 'x86:LE:32:default', endianness: 'little', pointerSize: 4,
};

const options = {
  outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false,
  generateSourceMaps: false, transformPreset: 'full', includeAddressComments: false,
  promoteStaticGlobals: false,
  projectConfig: {
    version: 1, project: 't', modules: { Mod: { namespaces: ['A', 'B'] } },
    moduleRuns: [{ module: 'Mod', start: '00401000', end: '00403000' }],
  } as never,
} as ReconstructOptions;

function fn(ns: string, name: string, address: string): ExtractedFunction {
  return {
    name, address, namespace: ns, returnType: 'int', signature: `int ${name}(void)`,
    parameters: [], localVariables: [], callingConvention: '__cdecl', size: 0x20,
    isThunk: false, isExternal: false, hasVarArgs: false, calledFunctions: [],
    decompiled: `int ${name}(void)\n\n{\n  return 1;\n}\n`,
  } as ExtractedFunction;
}

describe('shard unit records', () => {
  it('ships only the units the shard emitted, each with its include basis', () => {
    const functions = [fn('A', 'A_One', '00401000'), fn('B', 'B_One', '00402000')];
    const namespaces = [
      { name: 'A', fullPath: 'A', functions: [] },
      { name: 'B', fullPath: 'B', functions: [] },
    ] as never[];
    const shipped = new Map<string, unknown>();
    for (const index of [1, 0]) {
      const out = takeShardOutput(generateProjectStage1('t', functions.map(f => ({ ...f })), [], [], [], namespaces,
        options, programInfo, [], { index, count: 2 }));
      const emitted = out.files.map(([path]) => path).filter(p => p.endsWith('.cpp'));
      for (const [unit, rec] of out.unitRecords) {
        assert.ok(rec.includes, `shard ${index} shipped ${unit} without an include basis (the loaded record)`);
        assert.ok(emitted.some(p => p.includes(`${unit}.cpp`)), `shard ${index} shipped ${unit}, which it did not emit (${emitted.join(', ')})`);
        shipped.set(unit, rec);
      }
    }
    assert.deepStrictEqual([...shipped.keys()].sort(), ['A', 'B']);
  });
});
