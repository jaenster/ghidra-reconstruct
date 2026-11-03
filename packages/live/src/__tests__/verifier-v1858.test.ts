/**
 * The incident the verifier exists for, against the real model: the daemon's v1858 model
 * kept `pAllStatesDataTblFlag0x10[i].nStateId` in SKILLDRUID_ApplyAccumulatedStateDamage
 * (005c8980) and three other readers after the field became `uint16_t *`, because no
 * change record named them. A full codegen of that model reproduced the broken tree, so
 * only Ghidra could say the model was stale.
 *
 * Needs the parked model and recordings of the local worker's answers, which hold
 * decompiled program text and so stay out of the repository. D2_LIVE_V1858_FIXTURE names
 * a directory holding:
 *
 *   live-snapshot/            the parked daemon model (v1858, stale)
 *   recording-functions.json  {functions, types, calls[{command, params, response}]}: the
 *                             worker's answers to checkFunctions/checkDataTypes (read-only)
 *   recording-globals.json    {addresses, calls}: its answers to checkGlobals (optional)
 *   buildinfo.json            that model's buildinfo, to check which units the update
 *                             selects (optional)
 *
 * execute_script answers are keyed by their script timeout, everything else by its
 * arguments. Skipped when the variable is not set.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { applyEvents } from '../model.js';
import { loadSnapshotModel, indexSnapshotModel } from '../snapshot-model.js';
import { checkFunctions, checkDataTypes, checkGlobals, ModelVerifier } from '../verifier.js';
import { computeHashCache, loadBuildInfo, selectDirtyUnits } from '../dirty-units.js';

const FIXTURE = process.env.D2_LIVE_V1858_FIXTURE;
const SNAPSHOT = FIXTURE && join(FIXTURE, 'live-snapshot');
const RECORDING = FIXTURE && join(FIXTURE, 'recording-functions.json');
const GLOBALS = FIXTURE && join(FIXTURE, 'recording-globals.json');
const BUILDINFO = FIXTURE && join(FIXTURE, 'buildinfo.json');
const skip = !SNAPSHOT || !RECORDING || !existsSync(SNAPSHOT) || !existsSync(RECORDING)
  ? 'D2_LIVE_V1858_FIXTURE not set' : false;

interface Recording {
  functions: string[];
  types: string[];
  addresses?: string[];
  calls: Array<{ command: string; params: Record<string, unknown>; response: unknown }>;
}

/** Answers from the recording; an unrecorded question fails the test rather than guessing. */
function replay(rec: Recording) {
  const answers = new Map<string, unknown>();
  const key = (command: string, p: Record<string, unknown>): string => {
    switch (command) {
      case 'get_function_info': case 'decompile': return `${command} ${p.address}`;
      case 'list_functions': return `${command} ${p.regex}`;
      case 'get_data_type': return `${command} ${p.name}\u0000${p.category}`;
      case 'list_data_symbols': return `${command} ${p.regex}`;
      case 'read_data_value': return `${command} ${p.address}`;
      case 'execute_script': return `${command} ${p.scriptTimeout}`;
      default: return `${command} ${JSON.stringify(p)}`;
    }
  };
  for (const c of rec.calls) answers.set(key(c.command, c.params), c.response);
  const asked: string[] = [];
  return {
    asked,
    client: {
      async sendCommand(command: string, params: Record<string, unknown> = {}) {
        const k = key(command, params);
        asked.push(k);
        if (!answers.has(k)) throw new Error(`not recorded: ${k}`);
        return structuredClone(answers.get(k));
      },
    } as never,
  };
}

describe('model verifier against the stale v1858 model', { skip }, () => {
  it('flags 005c8980 and the other readers stale, matches the rest, and the update selects their units', async () => {
    const rec = JSON.parse(await readFile(RECORDING!, 'utf8')) as Recording;
    const model = await loadSnapshotModel(SNAPSHOT!, { decompileTimeout: 60 } as never, 0);
    model.options = { ...model.options, decompileTimeout: 60 };
    const indices = indexSnapshotModel(model);
    const { client } = replay(rec);

    const checks = await checkFunctions(model, indices, client, rec.functions, { concurrency: 4, log: () => {} });
    const druid = checks.find(c => c.key === '005c8980')!;
    assert.equal(druid.status, 'mismatch');
    assert.deepStrictEqual(druid.fields, ['decompiled'], 'only the body moved: the record and its facts agree');
    assert.match(druid.diff!, /- .*pAllStatesDataTblFlag0x10\[nStateIdx\]\.nStateId;/);
    assert.match(druid.diff!, /\+ .*\(short\)sgptDataTable->pAllStatesDataTblFlag0x10\[nStateIdx\];/);
    const stale = checks.filter(c => c.status === 'mismatch').map(c => c.key).sort();
    assert.deepStrictEqual(stale, ['004c72f0', '005c8980', '0062c100', '00645270', '00646020']);
    const others = checks.filter(c => !stale.includes(c.key));
    assert.ok(others.length > 0 && others.every(c => c.status === 'match'),
      `every other function matches: ${others.filter(c => c.status !== 'match').map(c => `${c.key} ${c.status} ${c.fields ?? c.note}`).join('; ')}`);

    if (rec.types.length > 0) {
      const types = await checkDataTypes(model, client, rec.types, { concurrency: 4, log: () => {} });
      const table = types.find(t => t.name === 'D2DataTableTxtStrc');
      if (table) assert.equal(table.status, 'match', 'the retyped struct itself was re-read at v1858');
    }

    // The whole loop: verify_now hands the stale ones to the ordinary update.
    const before = computeHashCache(model.primary);
    let applied: Promise<void> = Promise.resolve();
    const v = new ModelVerifier({
      model: () => model, indices: () => indices, client: () => client, idle: () => true,
      applyStale: events => (applied = applyEvents(model, indices, events, client).then(() => {})),
      log: () => {},
    }, { enabled: true, batchSize: 16, typeBatchSize: 64, globalBatchSize: 200, concurrency: 4, pauseMs: 0, quietMs: 0, keepMismatches: 50 }, null);
    const r = await v.verifyNow(rec.functions) as { stale: number };
    await applied;
    assert.equal(r.stale, 5);
    assert.match(indices.fnByAddr.get('005c8980')!.decompiled!, /\(eD2States\)\(short\)sgptDataTable->pAllStatesDataTblFlag0x10\[nStateIdx\];/);
    const after = computeHashCache(model.primary);
    const moved = Object.keys(after.functions).filter(a => after.functions[a].hash !== before.functions[a]?.hash).sort();
    assert.deepStrictEqual(moved, stale);

    if (BUILDINFO && existsSync(BUILDINFO)) {
      const selection = selectDirtyUnits({
        buildInfo: await loadBuildInfo(BUILDINFO), previous: before, identCacheEmpty: false,
        functions: model.primary.functions, dataTypes: model.primary.dataTypes, globals: model.primary.globals,
      });
      assert.ok(selection.units !== null, selection.reason);
      for (const unit of ['D2Game::SKILLS::SkillDruid', 'D2Common::Skills', 'D2Common::ITEMS::Items', 'D2Client::SKILLS::Skills']) {
        assert.ok(selection.units!.includes(unit), `${unit} selected; got ${selection.units!.join(', ')}`);
      }
    }
  });

  it('flags the global v1858 untyped (gpUnicodeCodeToMapTable) and matches its neighbours', { skip: !GLOBALS || !existsSync(GLOBALS) ? 'no recording-globals.json' : false }, async () => {
    const rec = JSON.parse(await readFile(GLOBALS!, 'utf8')) as Recording;
    const model = await loadSnapshotModel(SNAPSHOT!, {} as never, 0);
    const { client } = replay(rec);
    const checks = await checkGlobals(model, client, rec.addresses!, { log: () => {} });
    const table = checks.find(c => c.key === '00882b2c')!;
    assert.equal(table.status, 'mismatch');
    assert.ok(table.fields!.includes('gpUnicodeCodeToMapTable.dataType'), table.fields!.join());
    // Two plate comments the reconcile reads at the address (labelsAt) and the full pass's
    // list_comments join never attached: a reconcile/batch drift the verifier surfaces,
    // pinned here so a change on either side shows.
    const others = checks.filter(c => c.key !== '00882b2c' && c.status !== 'match');
    assert.deepStrictEqual(others.map(c => [c.key, c.fields]), [
      ['0089db90', ['lpCriticalSection_0089db90.comment']],
      ['008e9430', ['gaColorDistanceLookupTable[256].comment']],
    ]);
    assert.equal(checks.filter(c => c.status === 'match').length, rec.addresses!.length - 3);
  });
});
