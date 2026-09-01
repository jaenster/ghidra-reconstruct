/**
 * Tests for the additional-source extraction cache and for the selective
 * decompile that feeds it.
 *
 * Both exist to take the cross-check binary off the critical path, and both are
 * only acceptable if they change WHAT IS PRODUCED not at all. So the assertions
 * here are about equality and about refusal:
 *
 *   - a written cache reads back with every field intact, bodies included;
 *   - a truncated part or a bumped format version is a hard error, never a
 *     quietly smaller answer;
 *   - a program version that moved, or that could not be read at all, is a MISS
 *     — "probably still current" is how a stale tree gets shipped;
 *   - narrowing the decompile narrows only the bodies, never the listing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  SOURCE_CACHE_FORMAT_VERSION,
  countBodies,
  describeSourceCacheHit,
  readSourceCache,
  readSourceCacheManifest,
  sourceCacheDir,
  verifySourceCache,
  writeSourceCache,
  type CachedSourceExtraction,
} from '../source-cache.js';
import { extractAllFunctions } from '../extract/functions.js';
import type {
  ExtractedFunction,
  GhidraConnection,
  ProgramInfo,
} from '../types.js';

const programInfo: ProgramInfo = {
  name: 'DiabloII_macho',
  path: '/mac/intel/1.14d/DiabloII_macho',
  format: 'Mach-O',
  architecture: 'x86',
  compiler: 'gcc',
  imageBase: '0x1000',
  languageId: 'x86:LE:32:default',
  endianness: 'little',
  pointerSize: 4,
};

// `decompiled` is set only when there IS a body: JSON drops an undefined
// property, so a round-tripped record has the key ABSENT rather than present
// and undefined. Both read as undefined everywhere downstream, but the two are
// distinguishable by deepEqual, and the cache must not be blamed for a
// difference the writer introduced.
function macFunction(name: string, address: string, body?: string): ExtractedFunction {
  return {
    name,
    address,
    signature: `int ${name}(void)`,
    returnType: 'int',
    parameters: [],
    localVariables: [],
    namespace: 'D2Common',
    callingConvention: 'cdecl',
    size: 32,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    ...(body === undefined ? {} : { decompiled: body }),
  };
}

function sampleCache(): CachedSourceExtraction {
  const functions = [
    macFunction('SHARED_WITH_WIN', '0x2000'),
    macFunction('MAC_ONLY_ONE', '0x3000', 'int MAC_ONLY_ONE(void) { return 1; }'),
    macFunction('MAC_ONLY_TWO', '0x4000', 'int MAC_ONLY_TWO(void) { return 2; }'),
  ];
  return {
    manifest: {
      formatVersion: SOURCE_CACHE_FORMAT_VERSION,
      platform: 'mac',
      provenance: {
        writtenAt: new Date().toISOString(),
        ghidra: 'ghidra://ghidra.example:13100/Diablo2Lod',
        programPath: '/mac/intel/1.14d/DiabloII_macho',
        programVersion: 5,
        programInfo,
      },
      counts: {
        functions: functions.length,
        functionsWithBody: countBodies(functions),
        dataTypes: 1,
        globals: 1,
        namespaces: 1,
      },
    },
    functions,
    dataTypes: [{ name: 'D2MacStrc', category: '/Mac', kind: 'STRUCTURE', size: 8, fields: [] } as never],
    globals: [{ name: 'gMacThing', address: '0x9000', dataType: 'int', size: 4, isInitialized: false, xrefCount: 1, scope: 'global' } as never],
    namespaces: [{ name: 'MacSpecific', fullPath: 'MacSpecific', functionCount: 1, symbolCount: 1 } as never],
  };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'source-cache-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('additional-source extraction cache', () => {
  it('round-trips every field, decompiled bodies included', async () => {
    await withTempDir(async base => {
      const dir = sourceCacheDir(base, 'mac');
      const written = sampleCache();
      await writeSourceCache(dir, written);

      const read = await readSourceCache(dir);
      assert.deepEqual(read.functions, written.functions);
      assert.deepEqual(read.dataTypes, written.dataTypes);
      assert.deepEqual(read.globals, written.globals);
      assert.deepEqual(read.namespaces, written.namespaces);
      assert.equal(read.manifest.provenance.programVersion, 5);
      assert.equal(countBodies(read.functions), 2);
    });
  });

  it('reports no cache rather than throwing when the directory is empty', async () => {
    await withTempDir(async base => {
      assert.equal(await readSourceCacheManifest(sourceCacheDir(base, 'mac')), null);
    });
  });

  it('refuses a cache written by a different on-disk format', async () => {
    await withTempDir(async base => {
      const dir = sourceCacheDir(base, 'mac');
      await writeSourceCache(dir, sampleCache());
      const manifestPath = join(dir, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.formatVersion = SOURCE_CACHE_FORMAT_VERSION + 1;
      await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

      await assert.rejects(() => readSourceCacheManifest(dir), /format v/);
    });
  });

  it('refuses a truncated part instead of returning a smaller extraction', async () => {
    await withTempDir(async base => {
      const dir = sourceCacheDir(base, 'mac');
      await writeSourceCache(dir, sampleCache());
      const partPath = join(dir, 'functions.ndjson');
      const lines = (await readFile(partPath, 'utf8')).split('\n').filter(Boolean);
      await writeFile(partPath, lines.slice(0, 1).join('\n') + '\n', 'utf8');

      await assert.rejects(() => readSourceCache(dir), /incomplete/);
    });
  });

  it('is a miss when the program version moved', () => {
    const { manifest } = sampleCache();
    const verdict = verifySourceCache(manifest, {
      platform: 'mac',
      programPath: '/mac/intel/1.14d/DiabloII_macho',
      liveVersion: 6,
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason ?? '', /5 -> 6/);
  });

  it('is a miss when the live version cannot be read at all', () => {
    const { manifest } = sampleCache();
    const verdict = verifySourceCache(manifest, {
      platform: 'mac',
      programPath: '/mac/intel/1.14d/DiabloII_macho',
      liveVersion: null,
    });
    assert.equal(verdict.ok, false);
  });

  it('is a miss when the source now points at a different program', () => {
    const { manifest } = sampleCache();
    assert.equal(
      verifySourceCache(manifest, {
        platform: 'mac',
        programPath: '/mac/intel/1.13c/DiabloII_macho',
        liveVersion: 5,
      }).ok,
      false
    );
    assert.equal(
      verifySourceCache(manifest, {
        platform: 'linux',
        programPath: '/mac/intel/1.14d/DiabloII_macho',
        liveVersion: 5,
      }).ok,
      false
    );
  });

  it('is a hit only when platform, program and version all match', () => {
    const { manifest } = sampleCache();
    assert.equal(
      verifySourceCache(manifest, {
        platform: 'mac',
        programPath: '/mac/intel/1.14d/DiabloII_macho',
        liveVersion: 5,
      }).ok,
      true
    );
  });

  it('names the version and the age in the hit banner', () => {
    const { manifest } = sampleCache();
    const banner = describeSourceCacheHit('/tmp/mac', manifest, Date.parse(manifest.provenance.writtenAt) + 7_200_000);
    assert.match(banner, /MAC SOURCE CACHE HIT/);
    assert.match(banner, /Ghidra version: 5/);
    assert.match(banner, /2\.0 h ago/);
  });
});

describe('selective decompilation of a cross-check binary', () => {
  /** Records which addresses were actually asked for a body. */
  function fakeConnection(decompiled: string[]): GhidraConnection {
    return {
      sessionId: 'test',
      async close() {},
      async sendCommand<T>(command: string, params?: Record<string, unknown>): Promise<T> {
        if (command === 'list_functions') {
          const all = [
            { name: 'SHARED_A', address: '0x1000' },
            { name: 'MAC_ONLY_B', address: '0x2000' },
            { name: 'SHARED_C', address: '0x3000' },
            { name: 'FUN_00004000', address: '0x4000' },
          ].map(f => ({
            ...f,
            signature: `int ${f.name}(void)`,
            returnType: 'int',
            callingConvention: 'cdecl',
            size: 16,
            isThunk: false,
            isExternal: false,
            hasVarArgs: false,
          }));
          const offset = Number(params?.offset ?? 0);
          const limit = Number(params?.limit ?? 100);
          return { functions: all.slice(offset, offset + limit), total: all.length } as T;
        }
        if (command === 'batch_decompile') {
          const addresses = params?.addresses as string[];
          decompiled.push(...addresses);
          return {
            results: addresses.map(address => ({
              functionName: 'x',
              address,
              signature: 'int x(void)',
              pseudocode: `/* body of ${address} */`,
            })),
            failed: [],
            total: addresses.length,
            decompiled: addresses.length,
          } as T;
        }
        throw new Error(`unexpected command ${command}`);
      },
    };
  }

  it('lists everything but decompiles only what the filter keeps', async () => {
    const asked: string[] = [];
    const functions = await extractAllFunctions(fakeConnection(asked), {
      decompile: true,
      decompileFilter: f => f.name === 'MAC_ONLY_B',
    });

    // The listing is untouched — the shared functions' ADDRESSES are the whole
    // reason the cross-check binary is extracted at all.
    assert.deepEqual(functions.map(f => f.name), ['SHARED_A', 'MAC_ONLY_B', 'SHARED_C', 'FUN_00004000']);
    assert.deepEqual(asked, ['0x2000']);
    assert.equal(functions.find(f => f.name === 'MAC_ONLY_B')?.decompiled, '/* body of 0x2000 */');
    assert.equal(functions.find(f => f.name === 'SHARED_A')?.decompiled, undefined);
  });

  it('decompiles everything when no filter is given', async () => {
    const asked: string[] = [];
    await extractAllFunctions(fakeConnection(asked), { decompile: true });
    assert.deepEqual(asked, ['0x1000', '0x2000', '0x3000', '0x4000']);
  });
});
