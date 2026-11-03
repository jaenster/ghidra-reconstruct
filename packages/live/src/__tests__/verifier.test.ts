import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyEvents, buildIndices, fetchFunctionRecord, readGlobalRecords, type ChangeEvent, type LiveModel, type ModelIndices } from '../model.js';
import { ModelVerifier, shortDiff, verifierConfigFromEnv, type VerifierConfig, type VerifierHost } from '../verifier.js';
import { computeHashCache } from '../dirty-units.js';

/**
 * The verifier reads what Ghidra prints now through the refresh path and compares it with
 * the model. These run it against a fake worker whose answers can move under the model the
 * way v1858's did: a body changed with no change record naming the function.
 */

interface FakeFn { name: string; body: string; signature?: string }
interface FakeGlobal {
  name: string; dataType: string; size: number; isInitialized: boolean; referencingFunctions: string[];
  value?: unknown; data?: unknown; dataFails?: boolean;
}

function fakeGhidra(
  fns: Map<string, FakeFn>,
  types: Map<string, { name: string; category: string; size: number; fields: unknown[] }> = new Map(),
  globals: Map<string, FakeGlobal> = new Map(),
) {
  const calls: Array<{ cmd: string; params: Record<string, unknown> }> = [];
  let onCall: ((cmd: string) => void) | null = null;
  const row = (address: string) => {
    const f = fns.get(address)!;
    return {
      name: f.name, address, signature: f.signature ?? `void ${f.name}(void)`, returnType: 'void',
      parameters: [], localVariables: [], callingConvention: '__stdcall', size: 16,
    };
  };
  const client = {
    async sendCommand(cmd: string, params: Record<string, unknown> = {}) {
      calls.push({ cmd, params });
      onCall?.(cmd);
      switch (cmd) {
        case 'get_function_info': {
          const a = String(params.address);
          if (!fns.has(a)) throw new Error('no function');
          return row(a);
        }
        case 'list_functions': {
          const name = String(params.regex).replace(/^\^|\$$/g, '');
          return { functions: [...fns.keys()].filter(a => fns.get(a)!.name === name).map(row) };
        }
        case 'decompile': return { pseudocode: fns.get(String(params.address))!.body };
        case 'get_data_type': {
          const t = types.get(`${params.name}\u0000${params.category}`);
          if (!t) throw new Error('Data type not found');
          return { ...t, type: 'Structure' };
        }
        case 'execute_script': {
          const code = String(params.code);
          // labelsAt: the labels at the addresses it names.
          if (code.includes('st.getSymbols(ad)')) {
            const asked = [...code.matchAll(/"([0-9a-f]+)"/g)].map(m => m[1]);
            return { success: true, output: asked.filter(a => globals.has(a)).map(a => `L\t${a}\t${globals.get(a)!.name}\n`).join('') };
          }
          if (code.includes('getAllSymbols')) {
            return { success: true, output: [...globals].map(([a, g]) => `${a}\t${g.name}\n`).join('') };
          }
          return { success: true, output: '' };
        }
        case 'list_data_symbols': {
          const names = new Set(String(params.regex).replace(/^\^\(\?:|\)\$$/g, '').split('|'));
          const rows = [...globals].filter(([, g]) => names.has(g.name)).map(([address, g]) => ({
            name: g.name, address, dataType: g.dataType, size: g.size, value: g.value, isInitialized: g.isInitialized,
            xrefCount: g.referencingFunctions.length, referencingFunctions: g.referencingFunctions,
          }));
          return { globals: rows, total: rows.length };
        }
        case 'read_data_value': {
          const g = globals.get(String(params.address));
          if (!g || g.dataFails) throw new Error('read failed');
          return { value: g.data };
        }
        default: return {};
      }
    },
  };
  return { client: client as never, calls, setOnCall: (f: ((cmd: string) => void) | null) => { onCall = f; } };
}

const ADDRS = ['00401000', '00401100', '00401200', '00401300', '00401400', '00401500'];

async function setup(opts: { types?: boolean; globals?: Map<string, FakeGlobal> } = {}) {
  const fns = new Map<string, FakeFn>(ADDRS.map((a, i) => [a, { name: `Fn${i}`, body: `void Fn${i}(void)\n{\n  g = ${i};\n  return;\n}\n` }]));
  const types = new Map<string, { name: string; category: string; size: number; fields: unknown[] }>();
  if (opts.types) {
    types.set('S\u0000/D2', { name: 'S', category: '/D2', size: 8, fields: [{ name: 'p', dataType: 'int *', offset: 0, size: 4 }] });
  }
  const globalState = opts.globals ?? new Map<string, FakeGlobal>();
  const g = fakeGhidra(fns, types, globalState);
  const functions = [];
  for (const a of ADDRS) {
    const r = await fetchFunctionRecord(g.client, undefined, a, { reextractInfo: true, timeout: 30, log: () => {} });
    functions.push({ ...r!.record, calledFunctions: [] });
  }
  const dataTypes = opts.types
    ? [{ name: 'S', category: '/D2', kind: 'STRUCTURE', size: 8, description: '', alignment: undefined, fields: [{ name: 'p', dataType: 'int *', offset: 0, size: 4 }] }]
    : [];
  const model = { seq: 5_000_000, options: {}, primary: { functions, globals: [], dataTypes, programInfo: { format: 'Portable Executable (PE)' } } } as unknown as LiveModel;
  // The globals as a reconcile reads them, so an unchanged one matches.
  if (globalState.size > 0) {
    const read = await readGlobalRecords(model, g.client, [...globalState.keys()], () => {});
    for (const r of read!.records.values()) if (r) model.primary.globals.push(r);
  }
  const indices = buildIndices(model);
  g.calls.length = 0;
  return { fns, types, globalState, g, model, indices };
}

function host(model: LiveModel, indices: ModelIndices, client: never, idle: () => boolean = () => true) {
  const applied: ChangeEvent[][] = [];
  const logs: string[] = [];
  const h: VerifierHost = {
    model: () => model,
    indices: () => indices,
    client: () => client,
    idle,
    // What the daemon does with them: the ordinary update, then an incremental rebuild.
    applyStale: async events => { applied.push(events); await applyEvents(model, indices, events, client); },
    log: m => logs.push(m),
  };
  return { h, applied, logs };
}

const cfg = (over: Partial<VerifierConfig> = {}): VerifierConfig => ({
  enabled: true, batchSize: 3, typeBatchSize: 8, globalBatchSize: 200, concurrency: 2, pauseMs: 0, quietMs: 0, keepMismatches: 50, ...over,
});

describe('model verifier', () => {
  it('finds a body Ghidra prints differently, updates the model through the ordinary path and queues the unit', async () => {
    const { fns, g, model, indices } = await setup();
    // v1858: a struct field retyped, the reader never named the struct, so no change record
    // sent it to be decompiled again. Ghidra prints it differently now; the model does not.
    fns.get('00401100')!.body = 'void Fn1(void)\n{\n  g = (short)tbl[i];\n  return;\n}\n';
    const before = computeHashCache(model.primary);
    const { h, applied, logs } = host(model, indices, g.client);
    const v = new ModelVerifier(h, cfg(), null);

    assert.equal(await v.step(), 'verified');

    assert.equal(applied.length, 1, 'one update queued');
    assert.deepStrictEqual(applied[0].map(e => [e.kind, e.key, e.callersUnaffected, e.seq]), [['function.changed', '00401100', true, 0]]);
    assert.match(indices.fnByAddr.get('00401100')!.decompiled!, /\(short\)tbl\[i\]/, 'the model holds what Ghidra prints');
    const after = computeHashCache(model.primary);
    assert.notEqual(after.functions['00401100'].hash, before.functions['00401100'].hash, 'the dirty-unit selection sees it');
    assert.equal(after.functions['00401000'].hash, before.functions['00401000'].hash);
    assert.equal(model.seq, 5_000_000, 'the journal position does not move');

    const s = v.status() as { mismatchesTotal: number; mismatches: Array<{ key: string; fields: string[]; diff: string; applied: string }>; sweptThisCycle: number; cursor: { key: string } };
    assert.equal(s.mismatchesTotal, 1);
    assert.deepStrictEqual(s.mismatches[0].fields, ['decompiled']);
    assert.equal(s.mismatches[0].applied, 'applied');
    assert.match(s.mismatches[0].diff, /- g = 1;\n\+ g = \(short\)tbl\[i\];/);
    assert.equal(s.sweptThisCycle, 3);
    assert.equal(s.cursor.key, '00401200');
    assert.ok(logs.some(l => /MODEL STALE: function Fn1 \(00401100\): decompiled/.test(l)));
  });

  it('a matching model queues nothing and changes nothing', async () => {
    const { g, model, indices } = await setup();
    const before = JSON.stringify(model.primary.functions);
    const { h, applied } = host(model, indices, g.client);
    const v = new ModelVerifier(h, cfg({ batchSize: 6 }), null);
    assert.equal(await v.step(), 'verified');
    assert.equal(applied.length, 0);
    assert.equal(JSON.stringify(model.primary.functions), before);
    assert.equal(g.calls.filter(c => c.cmd === 'decompile').length, 6);
  });

  it('a moved signature sends the callers too', async () => {
    const { fns, g, model, indices } = await setup();
    fns.get('00401000')!.signature = 'int Fn0(int a)';
    const { h, applied } = host(model, indices, g.client);
    await new ModelVerifier(h, cfg(), null).step();
    assert.equal(applied[0][0].callersUnaffected, false);
  });

  it('an event arriving mid-step stops the reads and throws the step away', async () => {
    const { fns, g, model, indices } = await setup();
    fns.get('00401000')!.body = 'void Fn0(void)\n{\n  changed();\n}\n';
    let busy = false;
    g.setOnCall(cmd => { if (cmd === 'decompile') busy = true; });
    const { h, applied } = host(model, indices, g.client, () => !busy);
    const v = new ModelVerifier(h, cfg({ batchSize: 6, concurrency: 1 }), null);

    assert.equal(await v.step(), 'interrupted');
    assert.equal(g.calls.filter(c => c.cmd === 'decompile').length, 1, 'no read handed out after the event');
    assert.equal(applied.length, 0, 'nothing from an interrupted step is applied');
    const s = v.status() as { cursor: { key: string | null }; sweptThisCycle: number; mismatchesTotal: number };
    assert.equal(s.cursor.key, null, 'the cursor stays where the step started');
    assert.equal(s.sweptThisCycle, 0);
    assert.equal(s.mismatchesTotal, 0);
  });

  it('reads nothing while the daemon is busy, nor before the quiet period', async () => {
    const { g, model, indices } = await setup();
    let idle = false;
    let now = 1_000_000;
    const { h } = host(model, indices, g.client, () => idle);
    const v = new ModelVerifier(h, cfg({ quietMs: 30_000 }), null, () => now);
    assert.equal(await v.step(), 'busy');
    idle = true;
    now += 10_000;
    assert.equal(await v.step(), 'busy', 'idle, but not for the quiet period yet');
    now += 25_000;
    assert.equal(await v.step(), 'verified');
    assert.equal(g.calls.filter(c => c.cmd === 'decompile').length, 3);
  });

  it('persists the cursor and resumes after a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'verifier-'));
    try {
      const path = join(dir, 'live-verifier.json');
      const { g, model, indices } = await setup();
      const first = new ModelVerifier(host(model, indices, g.client).h, cfg(), path);
      await first.load();
      await first.step();
      const saved = JSON.parse(await readFile(path, 'utf8')) as { cursor: { phase: string; key: string }; cycle: number };
      assert.deepStrictEqual(saved.cursor, { phase: 'functions', key: '00401200' });

      g.calls.length = 0;
      const second = new ModelVerifier(host(model, indices, g.client).h, cfg(), path);
      await second.load();
      await second.step();
      assert.deepStrictEqual(g.calls.filter(c => c.cmd === 'decompile').map(c => c.params.address), ['00401300', '00401400', '00401500']);
      const s = second.status() as { cycle: number; sweptThisCycle: number };
      assert.equal(s.cycle, 1, 'the same cycle, not a new one');
      assert.equal(s.sweptThisCycle, 6);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('sweeps functions, then types, then globals, then closes the cycle', async () => {
    const { types, g, model, indices } = await setup({ types: true });
    types.get('S\u0000/D2')!.fields = [{ name: 'p', dataType: 'uint16_t *', offset: 0, size: 4 }];
    let now = 0;
    const { h, applied } = host(model, indices, g.client);
    const v = new ModelVerifier(h, cfg({ batchSize: 6 }), null, () => now);
    const outcomes = [];
    for (let i = 0; i < 5; i++) { now += 1000; outcomes.push(await v.step()); }
    assert.deepStrictEqual(outcomes, ['verified', 'verified', 'verified', 'verified', 'cycle-complete']);
    assert.deepStrictEqual(applied.map(b => b.map(e => [e.kind, e.key])), [[['datatype.changed', 'S\u0000/D2']]]);
    assert.equal((model.primary.dataTypes[0] as unknown as { fields: Array<{ dataType: string }> }).fields[0].dataType, 'uint16_t *');
    const s = v.status() as { cycle: number; lastFullCycleMs: number; cursor: unknown; cycleStartedAt: unknown };
    assert.equal(s.lastFullCycleMs, 4000);
    assert.deepStrictEqual(s.cursor, { phase: 'functions', key: null });
    assert.equal(s.cycleStartedAt, null);
  });

  const GLOBALS = () => new Map<string, FakeGlobal>([
    ['00700000', { name: 'gpStateTable', dataType: 'D2AllStatesDataTbl *', size: 4, isInitialized: false, referencingFunctions: ['Fn1'] }],
    ['00700010', { name: 'gaDefaults', dataType: 'int[4]', size: 16, isInitialized: true, referencingFunctions: ['Fn2'], data: [1, 2, 3, 4] }],
    ['00700020', { name: 'gnUnused', dataType: 'int', size: 4, isInitialized: false, referencingFunctions: [] }],
  ]);
  const toGlobals = (v: ModelVerifier) => { (v as unknown as { state: { cursor: unknown } }).state.cursor = { phase: 'globals', key: null }; };

  it('finds a global Ghidra retyped and fixes it through the reconcile, readers included', async () => {
    const { globalState, g, model, indices } = await setup({ globals: GLOBALS() });
    globalState.get('00700000')!.dataType = 'uint16_t *';
    const { h, applied } = host(model, indices, g.client);
    const v = new ModelVerifier(h, cfg(), null);
    toGlobals(v);
    g.calls.length = 0;

    assert.equal(await v.step(), 'verified');

    assert.deepStrictEqual(applied.map(b => b.map(e => [e.kind, e.target, e.key, e.seq])), [[['data.changed', 'global', '00700000', 0]]]);
    assert.equal(model.primary.globals.find(x => x.name === 'gpStateTable')!.dataType, 'uint16_t *');
    // The reconcile sends the reader to be decompiled again: its text moves with the type.
    assert.ok(g.calls.some(c => c.cmd === 'decompile' && c.params.address === '00401100'));
    const s = v.status() as { mismatches: Array<{ kind: string; fields: string[] }>; sweptThisCycle: number };
    assert.equal(s.mismatches[0].kind, 'global');
    assert.ok(s.mismatches[0].fields.includes('gpStateTable.dataType'), s.mismatches[0].fields.join());
    assert.equal(s.sweptThisCycle, 3);
  });

  it('finds a global whose initialized value moved, and fixes it', async () => {
    const { globalState, g, model, indices } = await setup({ globals: GLOBALS() });
    globalState.get('00700010')!.data = [1, 2, 3, 5];
    const { h, applied } = host(model, indices, g.client);
    const v = new ModelVerifier(h, cfg(), null);
    toGlobals(v);
    await v.step();
    assert.deepStrictEqual(applied.map(b => b.map(e => e.key)), [['00700010']]);
    assert.deepStrictEqual(model.primary.globals.find(x => x.name === 'gaDefaults')!.initializedData, [1, 2, 3, 5]);
    const s = v.status() as { mismatches: Array<{ fields: string[] }> };
    assert.deepStrictEqual(s.mismatches[0].fields, ['gaDefaults.initializedData']);
  });

  it('a global label gone or added is a mismatch; a failed value read is not', async () => {
    const { globalState, g, model, indices } = await setup({ globals: GLOBALS() });
    globalState.get('00700020')!.name = 'gnRenamed';
    globalState.get('00700010')!.dataFails = true;
    const { h, applied } = host(model, indices, g.client);
    const v = new ModelVerifier(h, cfg(), null);
    toGlobals(v);
    await v.step();
    assert.deepStrictEqual(applied.map(b => b.map(e => e.key)), [['00700020']]);
    const s = v.status() as { mismatches: Array<{ fields: string[] }>; unverifiedTotal: number };
    assert.deepStrictEqual(s.mismatches[0].fields, ['gnUnused (gone)', 'gnRenamed (new)']);
    assert.equal(s.unverifiedTotal, 1, 'the unread value is unverified, never applied as "no data"');
    assert.ok(model.primary.globals.some(x => x.name === 'gnRenamed'));
    assert.ok(!model.primary.globals.some(x => x.name === 'gnUnused'));
  });

  it('a step whose reads may have seen another version is thrown away', async () => {
    const { fns, g, model, indices } = await setup();
    fns.get('00401000')!.body = 'void Fn0(void)\n{\n  changed();\n}\n';
    let checks = 0;
    const { h, applied } = host(model, indices, g.client);
    // The worker followed a check-in while the step read.
    h.versionMoved = async () => ++checks > 1;
    const v = new ModelVerifier(h, cfg(), null);
    assert.equal(await v.step(), 'interrupted');
    assert.equal(applied.length, 0);
    assert.equal((v.status() as { cursor: { key: string | null } }).cursor.key, null);
  });

  it('verify_now checks the named functions whatever the daemon is doing, and can leave the model alone', async () => {
    const { fns, g, model, indices } = await setup();
    fns.get('00401500')!.body = 'void Fn5(void)\n{\n  h = 5;\n}\n';
    const { h, applied } = host(model, indices, g.client, () => false);
    const v = new ModelVerifier(h, cfg(), null);
    const r = await v.verifyNow(['0x00401500', '00401000'], { apply: false }) as { functions: Array<{ key: string; status: string }>; stale: number };
    assert.deepStrictEqual(r.functions.map(f => [f.key, f.status]), [['00401500', 'mismatch'], ['00401000', 'match']]);
    assert.equal(r.stale, 1);
    assert.equal(applied.length, 0);
    assert.doesNotMatch(indices.fnByAddr.get('00401500')!.decompiled!, /h = 5/);
  });

  it('a failed decompile is unverified, never a match or a mismatch', async () => {
    const { g, model, indices } = await setup();
    const inner = g.client as unknown as { sendCommand: (c: string, p: Record<string, unknown>) => Promise<unknown> };
    const send = inner.sendCommand.bind(inner);
    const client = { sendCommand: (c: string, p: Record<string, unknown>) => c === 'decompile' && p.address === '00401000' ? Promise.reject(new Error('timeout')) : send(c, p) };
    const { h, applied } = host(model, indices, client as never);
    const v = new ModelVerifier(h, cfg(), null);
    await v.step();
    assert.equal(applied.length, 0);
    assert.equal((v.status() as { unverifiedTotal: number }).unverifiedTotal, 1);
  });
});

describe('verifier settings and diff', () => {
  it('is on by default only against the local worker', () => {
    assert.equal(verifierConfigFromEnv({}, true).enabled, true);
    assert.equal(verifierConfigFromEnv({}, false).enabled, false);
    assert.equal(verifierConfigFromEnv({ D2_LIVE_VERIFY: '0' }, true).enabled, false);
    assert.equal(verifierConfigFromEnv({ D2_LIVE_VERIFY: '1' }, false).enabled, true);
    const c = verifierConfigFromEnv({ D2_LIVE_VERIFY_BATCH: '40', D2_LIVE_VERIFY_PAUSE_MS: '500', D2_LIVE_VERIFY_BATCH_BAD: 'x' }, true);
    assert.equal(c.batchSize, 40);
    assert.equal(c.pauseMs, 500);
    assert.equal(verifierConfigFromEnv({ D2_LIVE_VERIFY_BATCH: 'nope' }, true).batchSize, 16);
  });

  it('shows the first differing region with a line of context', () => {
    const d = shortDiff('a\nb\nc\nd\n', 'a\nb\nX\nd\n');
    assert.equal(d, '@@ line 3\n  b\n- c\n+ X');
  });
});
