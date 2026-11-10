/** How many shards the generation child runs. */

import { totalmem } from 'node:os';

/**
 * As regen-local.sh sizes it - each shard holds the whole model, about 1.2 GB - and then
 * no more shards than the units to emit can use.
 *
 * Every shard rebuilds every global table from the whole snapshot before it emits
 * anything (~25 s at v2046), and only the emission divides. Measured idle on v2046
 * (scripts/verify-live-incremental.sh): one re-emitted unit costs 44 s on eight shards
 * and 46 s on one, but 285 s of CPU and 12 GB against 61 s and 3 GB - and on a loaded
 * machine the eight setups contend (one unit once took 175 s). 24 units cost 50 s on
 * eight and 66 s on one, so the break-even is a few units: a shard is added per
 * UNITS_PER_SHARD units to emit. The tree does not depend on the shard count.
 */
export function generationWorkers(env: NodeJS.ProcessEnv = process.env, memoryBytes: number = totalmem()): number {
  const forced = Number(env.D2_LIVE_GEN_WORKERS ?? '');
  if (Number.isInteger(forced) && forced > 0) return forced;
  const gb = Math.floor(memoryBytes / 1024 ** 3);
  const machine = Math.max(1, Math.min(8, Math.floor(((gb - 4) * 10) / 15)));
  if (!env.RECON_REUSE_DIR) return machine;
  const units = (env.RECON_EMIT_UNITS ?? '').split(',').filter(Boolean).length;
  const perShard = Number(env.D2_LIVE_UNITS_PER_SHARD ?? '');
  const each = Number.isInteger(perShard) && perShard > 0 ? perShard : UNITS_PER_SHARD;
  return Math.max(1, Math.min(machine, Math.ceil(units / each)));
}

/** Units to emit per shard: where a second shard's setup starts paying for itself. */
const UNITS_PER_SHARD = 4;
