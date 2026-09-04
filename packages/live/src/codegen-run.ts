#!/usr/bin/env node
/**
 * The child process that generates the tree.
 *
 * Generation NEVER runs in the daemon's own process. Codegen mutates the model
 * it is handed and keeps module-level state that is never reset between runs —
 * the `claimedGlobals` WeakSet in `codegen/globals-header.ts` is the clearest
 * example, but it is not the only one. A second in-process generation would
 * therefore not equal the first, and the difference would show up as a handful
 * of globals quietly missing from the second tree. A fresh process makes that
 * impossible by construction, and costs about two seconds against a generation
 * that measures ~559 s (stage1 ~556 s, stage2 ~3 s).
 *
 * Everything here mirrors `run.ts` at the repo root. That is deliberate and it
 * is load-bearing: the daemon's output is only byte-identical to the batch
 * regen's while the two configure the pipeline the same way. A divergence in
 * this file is exactly the bug that would make the live tree quietly differ
 * from the oracle.
 */

import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

import { reconstruct } from '@ghidra-mcp/reconstruct';
import { loadProjectConfig } from '@ghidra-mcp/reconstruct/config/index';
import { configureCodegen } from '@ghidra-mcp/reconstruct/codegen-defaults';

/**
 * The namespace exclusions, copied verbatim from `run.ts`.
 *
 * They reach `generateAndWrite` on the codegen-only path too, so they change
 * which functions are emitted. run.ts is the authority; if it gains or loses a
 * pattern and this list does not follow, the live tree and the batch tree stop
 * matching and nothing reports it until a `full_regen` diff is run.
 */
const EXCLUDE_PATTERNS: RegExp[] = [
  /^compiler$/,
  /^VisualStudio$/,
  /^CRT$/,
  /^_Wrappers$/,
  /^DName(Node|StatusNode)?$/,
  /^pDNameNode$/,
  /^UnDecorator$/,
  /(^|::)Replicator$/,
  /^EXCEPTION$/i,
  /^LDBL12$/,
  /^LDOUBLE$/,
  /^charNode$/,
  /^pcharNode$/,
  /^type_info$/,
  /^localeinfo_struct$/,
  /^threadmbcinfostruct$/,
  /^tm$/,
  /^wchar_t$/,
  /^s$/,
  /^\/usr\//,
  /^usr_lib_libc/,
  /^std(:|$)/,
  /^\/System\//,
  /^MacSpecific$/,
  /^StormMac$/,
];

async function main(): Promise<void> {
  const projectDir = requireEnv('RECON_CHILD_PROJECT_DIR');
  const outputDir = requireEnv('RECON_CHILD_OUTPUT_DIR');
  const snapshotDir = requireEnv('RECON_CHILD_SNAPSHOT_DIR');
  const projectName = process.env.RECON_CHILD_PROJECT_NAME ?? 'Reconstructed';

  // The parse-error log is process-wide emitter configuration applied by the
  // ENTRY POINT, not part of ReconstructOptions. run.ts does this before
  // calling reconstruct and so must this — an entry point that skips it emits
  // different bodies.
  const errorLogPath = join(projectDir, 'parser-errors.log');
  try { writeFileSync(errorLogPath, '# Parse errors\n'); } catch { /* ok */ }
  configureCodegen(errorLogPath);

  const projectConfig = await loadProjectConfig(projectDir);

  const result = await reconstruct(
    '(from snapshot)',
    {
      outputDir,
      projectDir,
      generateCMake: true,
      generateSourceMaps: true,
      promoteStaticGlobals: true,
      projectName,
      projectConfig: projectConfig ?? undefined,
    },
    {
      decompileTimeout: 60,
      excludeLibraryCode: false,
      codegenOnly: true,
      snapshotDir,
      // The snapshot the daemon just wrote is seconds old by definition, but the
      // age check reads the manifest's `writtenAt`, which `writeSnapshot`
      // carries over from the ORIGINAL extraction. Left at the default the
      // daemon would start refusing to rebuild a week after the last full run.
      snapshotMaxAgeHours: Number.POSITIVE_INFINITY,
      excludePatterns: EXCLUDE_PATTERNS,
      // Serial. The parallel shards are only trustworthy because a script diffs
      // their tree against the serial one; the daemon's whole claim is that its
      // tree equals the oracle, so it takes the path the oracle takes.
      generationWorkers: 1,
      onProgress: (phase: string, current: number, total: number) => {
        // Line-per-milestone, not a redrawn progress bar: this stdout goes to a
        // log file, where \r would produce one unreadable line.
        if (total > 0 && (current === total || current % 500 === 0)) {
          console.log(`[${phase}] ${current}/${total}`);
        }
      },
    },
  );

  if (!result.success) {
    console.error(`generation FAILED: ${result.errors.join('\n---\n')}`);
    process.exit(1);
  }

  // The daemon parses this line rather than the human-readable summary: a
  // structured last line survives any amount of progress noise above it.
  console.log(`RESULT ${JSON.stringify({
    filesWritten: result.filesWritten.length,
    functions: result.stats.functionsProcessed,
    classes: result.stats.classesDetected,
    dataTypes: result.stats.dataTypesExtracted,
    globals: result.stats.globalsExtracted,
    warnings: result.warnings.length,
    timeMs: result.stats.timeMs,
  })}`);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`error: ${name} not set`);
    process.exit(2);
  }
  return value;
}

main().catch(e => { console.error(e); process.exit(1); });
