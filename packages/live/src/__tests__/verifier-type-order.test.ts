import { test } from 'node:test';
import assert from 'node:assert';
import { applyEvents, buildIndices, type ChangeEvent, type LiveModel } from '../model.js';
import { ModelVerifier, type VerifierConfig, type VerifierHost } from '../verifier.js';
import { computeHashCache, selectDirtyUnits } from '../dirty-units.js';

/**
 * The type list's order is a whole-program input: the emitter lays a header's types out
 * in it, and no per-record read sees it. The sweep compares it with one listing call per
 * cycle; a drift is MODEL STALE, goes through the ordinary update (which reorders), and
 * the moved types' headers are dirty although no record changed.
 */

const listing = [
  { name: 'A', category: '/', type: 'structure' },
  { name: 'vtable', category: '/WardenClient', type: 'structure' },
  { name: 'WardenClient', category: '/WardenClient', type: 'structure' },
  { name: 'Z', category: '/', type: 'structure' },
];

function model(): LiveModel {
  const dt = (name: string, category: string) => ({ name, category, kind: 'STRUCTURE', size: 4, fields: [] });
  return {
    seq: 1_861_000_000,
    options: {},
    primary: {
      functions: [],
      globals: [],
      // The renamed vtable at the end, as the pre-1105 model held it.
      dataTypes: [dt('A', '/'), dt('WardenClient', '/WardenClient'), dt('Z', '/'), dt('WardenClientVtable', '/WardenClient')],
    },
  } as unknown as LiveModel;
}

const client = {
  async sendCommand(cmd: string, params: Record<string, unknown> = {}) {
    if (cmd === 'list_data_types') return { dataTypes: listing, total: listing.length };
    if (cmd === 'get_data_type') return { name: params.name, category: params.category, type: 'structure', size: 4, fields: [] };
    return {};
  },
} as never;

const cfg: VerifierConfig = {
  enabled: true, batchSize: 3, typeBatchSize: 8, globalBatchSize: 200, concurrency: 1, pauseMs: 0, quietMs: 0, keepMismatches: 50,
};

test('a cycle finds the type list out of the listing\'s order, logs it and puts it back', async () => {
  const m = model();
  const indices = buildIndices(m);
  const applied: ChangeEvent[][] = [];
  const logs: string[] = [];
  const h: VerifierHost = {
    model: () => m, indices: () => indices, client: () => client, idle: () => true,
    applyStale: async events => { applied.push(events); await applyEvents(m, indices, events, client); },
    log: s => logs.push(s),
  };
  const v = new ModelVerifier(h, cfg, null);
  for (let i = 0; i < 6; i++) await v.step();

  assert.ok(logs.includes('MODEL STALE: type order at position 1: the model has /WardenClient/WardenClient, the listing /WardenClient/WardenClientVtable'), logs.join('\n'));
  assert.deepStrictEqual(applied.map(events => events.map(e => e.kind)), [['datatype.order']], logs.join('\n'));
  assert.deepStrictEqual(m.primary.dataTypes.map(t => t.name), ['A', 'WardenClientVtable', 'WardenClient', 'Z']);
});

test('a reorder alone re-emits the header that emits the moved types, not their users', () => {
  const before = model();
  const cache = computeHashCache({ functions: [], dataTypes: before.primary.dataTypes, globals: [] });
  const after = model();
  const [a, w, z, vt] = after.primary.dataTypes;
  after.primary.dataTypes.splice(0, 4, a, vt, w, z);
  const buildInfo = {
    symbolIndex: {},
    symbolHashes: { x: 'x' },
    modules: [
      { id: 'WardenClient.h', implPath: 'WardenClient.cpp', unitName: 'WardenClient', functionNames: [],
        ownedTypeNames: ['WardenClient', 'WardenClientVtable'], globalAddresses: [], deps: [] },
      { id: 'Other.h', implPath: 'Other.cpp', unitName: 'Other', functionNames: [],
        ownedTypeNames: ['A'], globalAddresses: [], deps: [] },
      // Spells the moved types; their records did not change, so it stays clean.
      { id: 'User.h', implPath: 'User.cpp', unitName: 'User', functionNames: [],
        ownedTypeNames: [], globalAddresses: [], deps: [{ symbol: 'WardenClientVtable', strength: 'type-ref' }, { symbol: 'WardenClient', strength: 'type-ref' }] },
    ],
  };
  const sel = selectDirtyUnits({
    buildInfo: buildInfo as never, previous: cache, identCacheEmpty: false,
    functions: [], dataTypes: after.primary.dataTypes, globals: [],
  });
  assert.deepStrictEqual(sel.units, ['WardenClient'], sel.reason);
});
