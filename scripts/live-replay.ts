/**
 * Replay one incremental step of the live daemon offline and compare it with a full
 * generation of the same model.
 *
 *   npx tsx scripts/live-replay.ts --before <snapshot> --after <snapshot> --work <dir>
 *       [--reference <tree>] [--keep-before]
 *
 * `before` and `after` are two snapshots of the model (a daemon's live-snapshot, or a
 * batch regen's codegen-snapshot) at consecutive points; `after` is the model once the
 * change set between them was applied. The script does what the daemon does across
 * that check-in:
 *
 *   1. a full generation from `before` into <work>/tree, which also writes the
 *      buildinfo and the per-unit identifier records the next selection reads;
 *   2. the dirty-unit selection, from `before`'s hashes against `after`'s model;
 *   3. an incremental generation from `after` into the same tree, reusing every unit
 *      the selection left out.
 *
 * With --reference (a full generation of `after`), it then lists every file that
 * differs. Any difference is a unit the selection should have re-emitted.
 * --keep-before skips step 1 when <work>/tree-before already holds its output.
 *
 * --project-json <file> generates with another project.json (a fixture's
 * foreignReferences). --foreign-watch runs step 3 the way the daemon notices a
 * commit to the foreign sources: only when ForeignSourceWatch sees their
 * fingerprint differ from the one step 1 recorded; otherwise the tree stays as
 * step 1 left it.
 *
 * Built packages are used (pnpm build first), as the daemon uses them.
 */
import { cp, mkdir, rm, symlink, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { loadSnapshotModel } from '../packages/live/dist/snapshot-model.js';
import { rebuild } from '../packages/live/dist/rebuild.js';
import { computeHashCache, loadBuildInfo, selectDirtyUnits } from '../packages/live/dist/dirty-units.js';
import { ForeignSourceWatch } from '../packages/live/dist/foreign-watch.js';
import { foreignSourcesFingerprint } from '../packages/reconstruct/dist/codegen/file-static-functions.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const before = arg('before');
  const after = arg('after');
  const work = arg('work');
  const reference = arg('reference');
  if (!before || !after || !work) {
    console.error('usage: live-replay.ts --before <snapshot> --after <snapshot> --work <dir> [--reference <tree>] [--keep-before]');
    process.exit(2);
  }
  const workDir = resolve(work);
  const projectDir = join(workDir, 'project');
  const tree = join(workDir, 'tree');
  const treeBefore = join(workDir, 'tree-before');
  const identCache = join(workDir, 'unit-identifiers.json');
  const keepBefore = process.argv.includes('--keep-before') && existsSync(treeBefore);

  await mkdir(join(projectDir, '.ghidra-mcp'), { recursive: true });
  const projectJson = resolve(arg('project-json') ?? 'project/project.json');
  await rm(join(projectDir, 'project.json'), { force: true });
  await symlink(projectJson, join(projectDir, 'project.json'));
  // project.json names override sources relative to the project directory's parent.
  if (!existsSync(join(workDir, 'overrides'))) await symlink(resolve('overrides'), join(workDir, 'overrides'));

  // Work on copies: a rebuild writes the model back over its snapshot directory.
  const snapBefore = join(workDir, 'snap-before');
  const snapAfter = join(workDir, 'snap-after');
  for (const [src, dst] of [[before, snapBefore], [after, snapAfter]] as const) {
    await rm(dst, { recursive: true, force: true });
    await cp(resolve(src), dst, { recursive: true });
  }

  const log = (m: string): void => console.log(`[replay] ${m}`);
  const modelBefore = await loadSnapshotModel(snapBefore, {} as never, 0);
  const modelAfter = await loadSnapshotModel(snapAfter, {} as never, 0);

  if (!keepBefore) {
    await rm(treeBefore, { recursive: true, force: true });
    await rm(identCache, { force: true });
    const r = await rebuild(modelBefore, {
      outputDir: treeBefore, projectDir, logDir: join(workDir, 'logs'), log, emitUnits: null, identCachePath: identCache,
    });
    if (!r.ok) throw new Error(`full generation of 'before' failed; see ${r.logPath}`);
    await cp(identCache, `${identCache}.before`);
    await cp(join(projectDir, '.ghidra-mcp', 'buildinfo.json'), join(workDir, 'buildinfo.before.json'));
  } else {
    await cp(`${identCache}.before`, identCache);
  }

  const selection = selectDirtyUnits({
    buildInfo: await loadBuildInfo(join(workDir, 'buildinfo.before.json')),
    previous: computeHashCache({
      functions: modelBefore.primary.functions,
      dataTypes: modelBefore.primary.dataTypes,
      globals: modelBefore.primary.globals,
    }),
    identCacheEmpty: false,
    functions: modelAfter.primary.functions,
    dataTypes: modelAfter.primary.dataTypes,
    globals: modelAfter.primary.globals,
  });
  log(`selection: ${selection.reason}`);
  log(`units: ${(selection.units ?? ['(all)']).join(' ')}`);

  await rm(tree, { recursive: true, force: true });
  await cp(treeBefore, tree, { recursive: true });
  const incremental = async (): Promise<void> => {
    const r = await rebuild(modelAfter, {
      outputDir: tree, projectDir, logDir: join(workDir, 'logs'), log,
      emitUnits: selection.units, reuseDir: tree, identCachePath: identCache,
    });
    if (!r.ok) throw new Error(`incremental generation failed; see ${r.logPath}`);
  };
  if (process.argv.includes('--foreign-watch')) {
    const config = JSON.parse(await readFile(projectJson, 'utf-8')) as { foreignReferences?: Array<{ path: string; addressBase?: string }> };
    const builtInfo = JSON.parse(await readFile(join(workDir, 'buildinfo.before.json'), 'utf-8')) as { foreignSources?: string };
    const watch = new ForeignSourceWatch({
      current: () => foreignSourcesFingerprint(config.foreignReferences ?? [], projectDir),
      built: () => builtInfo.foreignSources ?? null,
      idle: () => true,
      rebuild: async () => { await incremental(); return null; },
      log,
    });
    log(`foreign watch: ${await watch.check()}`);
  } else {
    await incremental();
  }

  if (reference) {
    const diff = spawnSync('diff', ['-rq', tree, resolve(reference)], { encoding: 'utf8' });
    const lines = diff.stdout.split('\n').filter(Boolean);
    for (const l of lines) console.log(l);
    console.log(`[replay] ${lines.length} difference(s) against ${reference}`);
    process.exitCode = lines.length === 0 ? 0 : 1;
  }
}

main().catch(err => { console.error(err); process.exit(1); });
