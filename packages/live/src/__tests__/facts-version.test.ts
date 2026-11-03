import { test } from 'node:test';
import assert from 'node:assert';
import { ensureFactScriptVersion, type FactExtractor } from '../facts-version.js';
import type { LiveSnapshotModel } from '../snapshot-model.js';

/**
 * A model whose facts were read with another fact script, or an unknown one, reads every
 * function's facts again; the version is stamped only once that read succeeded. Without
 * it, a new fact (the zext-site X row) reaches only the functions edited after the
 * switch, and a missing field reads the same as "none found".
 */

function model(version?: string): LiveSnapshotModel {
  return {
    primary: {
      functions: [
        { name: 'A', address: '00401000', decompiled: 'int A(void) { return 0; }', maskSites: { count: 1, sites: [] } },
        { name: 'B', address: '00401100', decompiled: 'int B(void) { return 1; }' },
      ],
      dataTypes: [], globals: [], strings: [], namespaces: [],
      programInfo: { format: 'Portable Executable (PE)' },
    },
    secondary: null,
    options: {},
    seq: 0,
    classes: [], staticPromotions: [], warnings: [],
    manifest: { formatVersion: 1, projectName: 'p', counts: {}, provenance: { programVersion: 1, ...(version ? { factScriptVersion: version } : {}) } },
    snapshotDir: '/nonexistent',
  } as unknown as LiveSnapshotModel;
}

const stats = { candidates: 2, hits: 0, misses: 2, extracted: 2, unstable: 0, reasons: {}, verified: 0, verifyMismatches: [], stampMs: 0, extractMs: 0, labelMs: 0 };

test('a model at the wanted fact script is left alone', async () => {
  const m = model('v7');
  let called = 0;
  const extract: FactExtractor = async () => { called++; return stats; };
  const r = await ensureFactScriptVersion(m, {} as never, () => {}, 'v7', extract);
  assert.strictEqual(r.refreshed, false);
  assert.strictEqual(called, 0);
  assert.ok(m.primary.functions[0].maskSites, 'facts untouched');
});

for (const had of ['v6', undefined]) {
  test(`a model read with fact script ${had ?? 'unknown'} reads every function's facts again`, async () => {
    const m = model(had);
    let seen: string[] = [];
    const extract: FactExtractor = async (_c, fns) => {
      seen = fns.map(f => f.address);
      assert.ok(fns.every(f => f.maskSites === undefined), 'old facts cleared before the read');
      fns[1].zextSites = { counts: {}, sites: [] } as never;
      return stats;
    };
    const r = await ensureFactScriptVersion(m, {} as never, () => {}, 'v7', extract);
    assert.deepStrictEqual(r, { had: had ?? null, wanted: 'v7', refreshed: true, stats });
    assert.deepStrictEqual(seen, ['00401000', '00401100'], 'every function, not only touched ones');
    assert.strictEqual(m.manifest.provenance.factScriptVersion, 'v7');
    assert.strictEqual(m.primary.functions[0].maskSites, undefined);
    assert.ok(m.primary.functions[1].zextSites);
  });
}

test('a failed read leaves the version unstamped so the next start tries again', async () => {
  const m = model('v6');
  const extract: FactExtractor = async () => { throw new Error('worker gone'); };
  await assert.rejects(ensureFactScriptVersion(m, {} as never, () => {}, 'v7', extract), /worker gone/);
  assert.strictEqual(m.manifest.provenance.factScriptVersion, 'v6');
});
