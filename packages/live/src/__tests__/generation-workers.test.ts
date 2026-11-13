import { test } from 'node:test';
import assert from 'node:assert';
import { generationWorkers } from '../generation-workers.js';

const GB64 = 64 * 1024 ** 3;
const units = (n: number) => Array.from({ length: n }, (_, i) => `U${i}`).join(',');

test('a full emission uses the machine-sized shard count', () => {
  assert.equal(generationWorkers({}, GB64), 8);
});

test('an incremental run gets one shard per 4 units to emit, at least one, at most the machine', () => {
  const reuse = (n: number) => ({ RECON_REUSE_DIR: '/prev', RECON_EMIT_UNITS: units(n) });
  assert.equal(generationWorkers(reuse(0), GB64), 1);
  assert.equal(generationWorkers(reuse(1), GB64), 1);
  assert.equal(generationWorkers(reuse(4), GB64), 1);
  assert.equal(generationWorkers(reuse(5), GB64), 2);
  assert.equal(generationWorkers(reuse(24), GB64), 6);
  assert.equal(generationWorkers(reuse(273), GB64), 8);
  assert.equal(generationWorkers({ RECON_REUSE_DIR: '/prev' }, GB64), 1);
});

test('D2_LIVE_GEN_WORKERS and D2_LIVE_UNITS_PER_SHARD override', () => {
  assert.equal(generationWorkers({ D2_LIVE_GEN_WORKERS: '3', RECON_REUSE_DIR: '/p', RECON_EMIT_UNITS: 'A' }, GB64), 3);
  assert.equal(generationWorkers({ D2_LIVE_UNITS_PER_SHARD: '5', RECON_REUSE_DIR: '/p', RECON_EMIT_UNITS: units(11) }, GB64), 3);
});
