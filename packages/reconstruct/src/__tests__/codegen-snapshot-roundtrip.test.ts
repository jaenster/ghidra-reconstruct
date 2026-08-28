/**
 * Acceptance test for the extraction snapshot.
 *
 * The snapshot exists so a codegen change can be tried without a ~20 minute
 * re-extraction. That is only safe if replaying a snapshot produces EXACTLY the
 * tree the run that wrote it produced — so this drives the real writer, the real
 * reader, and the real `reconstruct(..., { codegenOnly: true })` entry point, and
 * compares the resulting files byte for byte.
 *
 * The dataset is a small synthetic program, not 1.14d Game.exe: it exercises the
 * shapes the snapshot has to survive (decompiled bodies, structs/enums/unions/
 * funcdefs, globals with structured initializers, namespaced functions, a
 * detected class) but it does NOT prove anything about volume.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, readFile, readdir, writeFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join, relative } from 'path';

import { generateProject, writeProject } from '../codegen/index.js';
import {
  SNAPSHOT_FORMAT_VERSION,
  assessStaleness,
  describeSnapshot,
  readSnapshot,
  readSnapshotManifest,
  snapshotExists,
  writeSnapshot,
  type CodegenSnapshot,
} from '../snapshot.js';
import { reconstruct } from '../index.js';
import type {
  AnalyzedDataSymbol,
  DetectedClass,
  ExtractedDataType,
  ExtractedFunction,
  ExtractedNamespace,
  ProgramInfo,
  ReconstructOptions,
} from '../types.js';

const programInfo: ProgramInfo = {
  name: 'Game.exe',
  path: '/windows/lod/1.14d/Game.exe',
  format: 'PE',
  architecture: 'x86',
  compiler: 'msvc',
  imageBase: '0x400000',
  languageId: 'x86:LE:32:default',
  endianness: 'little',
  pointerSize: 4,
};

function fn(
  name: string,
  address: string,
  returnType: string,
  body: string,
  ns?: string
): ExtractedFunction {
  return {
    name,
    address,
    signature: `${returnType} ${name}(void)`,
    returnType,
    parameters: [],
    localVariables: [],
    callingConvention: '__cdecl',
    size: 0x40,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    namespace: ns,
    decompiled: body,
    calledFunctions: [],
    comment: `@address ${address}`,
  };
}

const dataTypes: ExtractedDataType[] = [
  {
    kind: 'STRUCTURE',
    name: 'D2RoomStrc',
    category: '/Diablo2/ROOM',
    size: 12,
    fields: [
      { name: 'nX', dataType: 'int', offset: 0, size: 4 },
      { name: 'nY', dataType: 'int', offset: 4, size: 4 },
      { name: 'pNext', dataType: 'D2RoomStrc *', offset: 8, size: 4 },
    ],
  } as ExtractedDataType,
  {
    kind: 'ENUM',
    name: 'eD2RoomFlags',
    category: '/Diablo2/ROOM',
    size: 4,
    values: [
      { name: 'ROOMFLAG_NONE', value: 0 },
      { name: 'ROOMFLAG_ACTIVE', value: 1 },
    ],
  } as ExtractedDataType,
  {
    kind: 'UNION',
    name: 'D2RoomPayload',
    category: '/Diablo2/ROOM',
    size: 4,
    fields: [
      { name: 'nRaw', dataType: 'int', offset: 0, size: 4 },
      { name: 'pRoom', dataType: 'D2RoomStrc *', offset: 0, size: 4 },
    ],
  } as ExtractedDataType,
  {
    kind: 'FUNCTION_DEFINITION',
    name: 'D2RoomVisitFunc',
    category: '/Diablo2/ROOM',
    size: 4,
    returnType: 'void',
    parameters: [{ name: 'pRoom', dataType: 'D2RoomStrc *', ordinal: 0 }],
  } as ExtractedDataType,
];

const functions: ExtractedFunction[] = [
  fn(
    'ROOM_GetFirst',
    '0x401000',
    'D2RoomStrc *',
    'D2RoomStrc * ROOM_GetFirst(void)\n{\n  return (D2RoomStrc *)0x0;\n}\n',
    'D2Common::Rooms'
  ),
  fn(
    'ROOM_Count',
    '0x401100',
    'int',
    'int ROOM_Count(void)\n{\n  int iVar1;\n  iVar1 = 0;\n  return iVar1;\n}\n',
    'D2Common::Rooms'
  ),
  fn('CLIENT_Init', '0x402000', 'void', 'void CLIENT_Init(void)\n{\n  return;\n}\n', 'D2Client'),
];

const globals: AnalyzedDataSymbol[] = [
  {
    name: 'gpRoomList',
    address: '006fc000',
    dataType: 'D2RoomStrc *',
    size: 4,
    isInitialized: false,
    xrefCount: 4,
    scope: 'global',
    namespace: 'D2Common::Rooms',
  },
  {
    name: 'gRoomOrigin',
    address: '006fc010',
    dataType: 'D2RoomStrc',
    size: 12,
    isInitialized: true,
    xrefCount: 3,
    scope: 'global',
    namespace: 'D2Common::Rooms',
    initializedData: {
      kind: 'struct',
      fields: [
        { name: 'nX', value: { kind: 'scalar', value: '0' } },
        { name: 'nY', value: { kind: 'scalar', value: '0' } },
        { name: 'pNext', value: { kind: 'pointer', value: '0x0' } },
      ],
    },
  },
  {
    // `auto` BSS: the type normalization must survive a snapshot round trip too.
    name: 'gpUnknownBlob',
    address: '006fc020',
    dataType: 'auto',
    size: 4,
    isInitialized: false,
    xrefCount: 2,
    scope: 'global',
    namespace: 'D2Client',
  },
];

const namespaces: ExtractedNamespace[] = [
  { name: 'Rooms', fullPath: 'D2Common::Rooms', functionCount: 2, isClass: false },
  { name: 'D2Client', fullPath: 'D2Client', functionCount: 1, isClass: false },
];

const classes: DetectedClass[] = [];

function makeOptions(outputDir: string): ReconstructOptions {
  return {
    outputDir,
    format: 'cpp',
    organization: 'namespace',
    generateCMake: true,
    generateSourceMaps: true,
    transformPreset: 'quick',
    includeAddressComments: true,
    promoteStaticGlobals: false,
  };
}

function makeSnapshot(): CodegenSnapshot {
  return {
    manifest: {
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      provenance: {
        writtenAt: new Date().toISOString(),
        projectPath: 'ghidra://ghidra.typeguru.nl:13100/Diablo2Lod',
        programPath: '/windows/lod/1.14d/Game.exe',
        programVersion: 641,
        cacheVersion: 98765,
        programInfo,
      },
      projectName: 'Diablo2',
      counts: {
        functions: functions.length,
        dataTypes: dataTypes.length,
        globals: globals.length,
        namespaces: namespaces.length,
        classes: classes.length,
        strings: 4242,
      },
    },
    functions,
    dataTypes,
    globals,
    namespaces,
    classes,
    staticPromotions: [['006fc030', 'D2Common::Rooms::ROOM_Count']],
    warnings: ['Excluded 7 data types matching exclude patterns'],
  };
}

/** Every generated file as [relative path, bytes], sorted — the comparison unit. */
async function readTree(root: string): Promise<[string, string][]> {
  const out: [string, string][] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push([relative(root, full), await readFile(full, 'utf8')]);
    }
  }
  await walk(root);
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

let tmp: string;
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'recon-snapshot-'));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('extraction snapshot round trip', () => {
  it('writes a snapshot whose manifest carries the Ghidra provenance', async () => {
    const dir = join(tmp, 'snap-manifest');
    await writeSnapshot(dir, makeSnapshot());

    assert.ok(await snapshotExists(dir));
    const manifest = await readSnapshotManifest(dir);
    assert.strictEqual(manifest.formatVersion, SNAPSHOT_FORMAT_VERSION);
    assert.strictEqual(manifest.provenance.programVersion, 641);
    assert.strictEqual(manifest.provenance.cacheVersion, 98765);
    assert.strictEqual(manifest.provenance.programPath, '/windows/lod/1.14d/Game.exe');
    assert.ok(Date.parse(manifest.provenance.writtenAt) > 0);

    const banner = describeSnapshot(dir, manifest);
    assert.match(banner, /Ghidra version: 641/);
    assert.match(banner, /daemon is NOT contacted/);
    assert.match(banner, /Game\.exe/);
  });

  it('reads back exactly what was written', async () => {
    const dir = join(tmp, 'snap-identity');
    const original = makeSnapshot();
    await writeSnapshot(dir, original);
    const loaded = await readSnapshot(dir);

    assert.deepStrictEqual(loaded.functions, original.functions);
    assert.deepStrictEqual(loaded.dataTypes, original.dataTypes);
    assert.deepStrictEqual(loaded.globals, original.globals);
    assert.deepStrictEqual(loaded.namespaces, original.namespaces);
    assert.deepStrictEqual(loaded.classes, original.classes);
    assert.deepStrictEqual(loaded.staticPromotions, original.staticPromotions);
    assert.deepStrictEqual(loaded.warnings, original.warnings);
    assert.strictEqual(loaded.manifest.counts.strings, 4242);
  });

  it('generateProject from a reloaded snapshot is byte-identical', async () => {
    const dir = join(tmp, 'snap-codegen');
    // Mirrors production ordering: snapshot first, then codegen (which mutates
    // its inputs in place — the reload must not inherit those mutations).
    await writeSnapshot(dir, makeSnapshot());

    const direct = generateProject(
      'Diablo2',
      functions,
      classes,
      dataTypes,
      globals,
      namespaces,
      makeOptions(join(tmp, 'out-direct')),
      programInfo
    );

    const loaded = await readSnapshot(dir);
    const replayed = generateProject(
      loaded.manifest.projectName,
      loaded.functions,
      loaded.classes,
      loaded.dataTypes,
      loaded.globals,
      loaded.namespaces,
      makeOptions(join(tmp, 'out-replayed')),
      loaded.manifest.provenance.programInfo
    );

    const a = [...direct.files.entries()].map(([p, f]) => [p, f.content]).sort();
    const b = [...replayed.files.entries()].map(([p, f]) => [p, f.content]).sort();

    assert.ok(a.length > 0, 'expected generated files');
    assert.deepStrictEqual(b, a);
  });

  it('reconstruct({ codegenOnly }) writes a byte-identical tree', async () => {
    const dir = join(tmp, 'snap-e2e');
    await writeSnapshot(dir, makeSnapshot());

    // Baseline: the same inputs through generateProject + writeProject directly.
    const baselineDir = join(tmp, 'tree-baseline');
    const baselineOpts = makeOptions(baselineDir);
    const baseline = generateProject(
      'Diablo2',
      functions,
      classes,
      dataTypes,
      globals,
      namespaces,
      baselineOpts,
      programInfo
    );
    await writeProject(baseline, baselineDir, baselineOpts);

    // The replay, through the real entry point. No daemon is reachable here.
    const replayDir = join(tmp, 'tree-replay');
    const result = await reconstruct(
      'ghidra://unused',
      { ...makeOptions(replayDir), projectDir: join(tmp, 'no-config') },
      { codegenOnly: true, snapshotDir: dir, daemonUrl: 'http://127.0.0.1:1' }
    );

    assert.ok(result.success, `codegen-only run failed: ${result.errors.join('; ')}`);
    assert.strictEqual(result.stats.functionsProcessed, functions.length);
    assert.strictEqual(result.stats.stringsExtracted, 4242);
    // The warnings recorded at extraction time come back with it.
    assert.ok(result.warnings.some(w => w.includes('Excluded 7 data types')));

    const replayed = await readTree(replayDir);
    const base = await readTree(baselineDir);
    assert.deepStrictEqual(replayed.map(e => e[0]), base.map(e => e[0]));

    // Every generated SOURCE file must match byte for byte. CMakeLists.txt and
    // README.md are excluded here because the generator stamps `new Date()` into
    // both, so no two runs of ANY kind produce identical copies of them — that
    // predates the snapshot and is asserted separately below.
    const STAMPED = new Set(['CMakeLists.txt', 'README.md']);
    const codeOnly = (t: [string, string][]) => t.filter(([path]) => !STAMPED.has(path));
    assert.ok(codeOnly(base).length > 0, 'expected generated source files');
    assert.deepStrictEqual(codeOnly(replayed), codeOnly(base));

    // The two stamped files match once their timestamp line is set aside.
    const stripStamp = (text: string) =>
      text
        .split('\n')
        .filter(l => !l.includes('Generated at:') && !l.startsWith('*Generated:'))
        .join('\n');
    for (const name of STAMPED) {
      const r = replayed.find(([path]) => path === name);
      const b = base.find(([path]) => path === name);
      assert.ok(r && b, `${name} missing from one of the trees`);
      assert.strictEqual(stripStamp(r![1]), stripStamp(b![1]), `${name} differs beyond its timestamp`);
    }
  });
});

describe('a stale or damaged snapshot is refused, never used quietly', () => {
  it('refuses a snapshot older than the age limit', () => {
    const manifest = makeSnapshot().manifest;
    manifest.provenance.writtenAt = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();

    const verdict = assessStaleness(manifest);
    assert.strictEqual(verdict.refuse, true);
    assert.match(verdict.message!, /days old/);
  });

  it('warns, but proceeds, on a merely old snapshot', () => {
    const manifest = makeSnapshot().manifest;
    manifest.provenance.writtenAt = new Date(Date.now() - 20 * 3600_000).toISOString();

    const verdict = assessStaleness(manifest);
    assert.strictEqual(verdict.refuse, false);
    assert.strictEqual(verdict.warn, true);
  });

  it('rejects a snapshot written by a different format version', async () => {
    const dir = join(tmp, 'snap-oldformat');
    const snap = makeSnapshot();
    snap.manifest.formatVersion = SNAPSHOT_FORMAT_VERSION + 1;
    await writeSnapshot(dir, snap);

    await assert.rejects(() => readSnapshotManifest(dir), /format v/);
  });

  it('rejects a truncated part file instead of emitting a smaller tree', async () => {
    const dir = join(tmp, 'snap-truncated');
    await writeSnapshot(dir, makeSnapshot());

    const part = join(dir, 'functions.ndjson');
    const lines = (await readFile(part, 'utf8')).split('\n').filter(Boolean);
    await writeFile(part, lines.slice(0, -1).join('\n') + '\n', 'utf8');

    await assert.rejects(() => readSnapshot(dir), /incomplete/);
  });

  it('reports a missing snapshot rather than silently doing nothing', async () => {
    await assert.rejects(
      () => readSnapshotManifest(join(tmp, 'nope')),
      /No extraction snapshot/
    );
  });

  it('leaves no staging directory behind after a successful write', async () => {
    const dir = join(tmp, 'snap-staging');
    await writeSnapshot(dir, makeSnapshot());
    await assert.rejects(() => stat(`${dir}.tmp`));
  });
});
