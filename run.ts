#!/usr/bin/env npx tsx
/**
 * Reconstruct a binary from a Ghidra project, via the ghidra-mcp daemon.
 * Requires GHIDRA_PROJECT_PATH in the env, and GHIDRA_MCP_TOKEN for an
 * OAuth-protected daemon.
 *
 * Needs --stack-size=8192 for deeply nested function ASTs; re-execs itself.
 *
 * Fast codegen loop:
 *
 *   npx tsx run.ts                    full run; also writes an extraction snapshot
 *   npx tsx run.ts --codegen-only     replay that snapshot, never touch the daemon
 *
 * Flags (each also settable from the env):
 *   --codegen-only          GHIDRA_CODEGEN_ONLY=1
 *   --snapshot-dir=PATH     GHIDRA_SNAPSHOT_DIR      default <projectDir>/.ghidra-mcp/codegen-snapshot
 *   --no-snapshot           GHIDRA_SNAPSHOT=0        full run, but do not write one
 *                           GHIDRA_SNAPSHOT_MAX_AGE_HOURS  refuse a snapshot older than this (default 168)
 *
 * The cross-check binary (the mac build) is extracted once per Ghidra version of
 * THAT program and replayed from disk after that — it moves at version 5 while
 * the windows build is at 643. Its cache invalidates on the exact version, so a
 * bypass is rarely needed, but:
 *
 *   --no-mac-cache          GHIDRA_MAC_CACHE=0       always re-extract it, cache nothing
 *   --mac-decompile-all     GHIDRA_MAC_DECOMPILE_ALL=1  fetch the ~8k bodies the merge drops
 *   --source-cache-dir=PATH GHIDRA_SOURCE_CACHE_DIR  default <projectDir>/.ghidra-mcp/source-cache
 *
 * The two together restore the pre-shortcut secondary phase exactly, which is
 * how a suspected difference gets bisected.
 */

import { execFileSync } from 'child_process';

if (!process.execArgv.some(a => /stack.size/i.test(a))) {
  try {
    execFileSync(
      process.execPath,
      ['--stack-size=8192', ...process.execArgv, ...process.argv.slice(1)],
      { stdio: 'inherit', env: process.env }
    );
  } catch (e: any) {
    process.exit(e.status ?? 1);
  }
  process.exit(0);
}

import { reconstruct, setParseErrorLogPath } from './packages/reconstruct/src/index.js';
import { loadProjectConfig } from './packages/reconstruct/src/config/index.js';
import { resetGotoCleanupStats, defaultRegistry } from './packages/cpp-parser/dist/transform/plugins/index.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const hasFlag = (name: string) => argv.includes(name);
const flagValue = (name: string): string | undefined => {
  const prefix = `${name}=`;
  const inline = argv.find(a => a.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] : undefined;
};

const CODEGEN_ONLY = hasFlag('--codegen-only') || process.env.GHIDRA_CODEGEN_ONLY === '1';
const WRITE_SNAPSHOT = !hasFlag('--no-snapshot') && process.env.GHIDRA_SNAPSHOT !== '0';
const SNAPSHOT_MAX_AGE_HOURS = process.env.GHIDRA_SNAPSHOT_MAX_AGE_HOURS
  ? Number(process.env.GHIDRA_SNAPSHOT_MAX_AGE_HOURS)
  : undefined;
const USE_SOURCE_CACHE = !hasFlag('--no-mac-cache') && process.env.GHIDRA_MAC_CACHE !== '0';
const MAC_DECOMPILE_ALL = hasFlag('--mac-decompile-all') || process.env.GHIDRA_MAC_DECOMPILE_ALL === '1';

// Codegen-only replays a snapshot, so it needs no project URL at all — the
// snapshot records which program it came from.
const PROJECT_PATH = process.env.GHIDRA_PROJECT_PATH ?? (CODEGEN_ONLY ? '(from snapshot)' : undefined);
if (!PROJECT_PATH) {
  console.error('error: GHIDRA_PROJECT_PATH not set (e.g. ghidra://HOST:PORT/ProjectName)');
  process.exit(2);
}
// Override GHIDRA_DAEMON_URL when the ghidra-mcp daemon is not on localhost
// (e.g. a remote host or a container).
const DAEMON_URL = process.env.GHIDRA_DAEMON_URL ?? 'http://localhost:8432';
const PROGRAM_PATH = process.env.GHIDRA_PROGRAM_PATH ?? '/Game.exe';
// Overridable so a codegen-only replay can be pointed at a scratch tree without
// touching the real one; both default to what they always were.
const PROJECT_DIR = process.env.GHIDRA_PROJECT_DIR ?? join(__dirname, 'project');
const OUTPUT_DIR = process.env.GHIDRA_OUTPUT_DIR ?? join(__dirname, 'output');
const SNAPSHOT_DIR = flagValue('--snapshot-dir')
  ?? process.env.GHIDRA_SNAPSHOT_DIR
  ?? undefined;
const SOURCE_CACHE_DIR = flagValue('--source-cache-dir')
  ?? process.env.GHIDRA_SOURCE_CACHE_DIR
  ?? undefined;

const ERROR_LOG_PATH = join(PROJECT_DIR, 'parser-errors.log');
try { writeFileSync(ERROR_LOG_PATH, `# Parse errors\n`); } catch { /* ok */ }
setParseErrorLogPath(ERROR_LOG_PATH);

defaultRegistry.setEnabled('goto-cleanup', true);

async function main() {
  if (!CODEGEN_ONLY && !process.env.GHIDRA_MCP_TOKEN) {
    console.error('error: GHIDRA_MCP_TOKEN not set (run oauth-login and export it)');
    process.exit(2);
  }

  console.log('='.repeat(60));
  console.log('Ghidra binary reconstruction (TS)');
  console.log('='.repeat(60));
  if (CODEGEN_ONLY) {
    console.log('Mode:    codegen-only (no daemon, no extraction, no analysis)');
  } else {
    console.log(`Project: ${PROJECT_PATH}`);
    console.log(`Daemon:  ${DAEMON_URL}`);
  }
  console.log(`Output:  ${OUTPUT_DIR}`);

  const projectConfig = await loadProjectConfig(PROJECT_DIR);
  console.log(projectConfig
    ? `Config: ${projectConfig.modules ? Object.keys(projectConfig.modules).length : 0} modules, ${projectConfig.typeOwnership?.length ?? 0} type-owners, ${projectConfig.crossPlatformLinks?.length ?? 0} links`
    : 'Config: none');

  resetGotoCleanupStats();

  const result = await reconstruct(
    PROJECT_PATH,
    {
      outputDir: OUTPUT_DIR,
      projectDir: PROJECT_DIR,
      generateCMake: true,
      generateSourceMaps: true,
      promoteStaticGlobals: true,
      projectName: process.env.GHIDRA_PROJECT_NAME ?? 'Reconstructed',
      projectConfig: projectConfig ?? undefined,
    },
    {
      daemonUrl: DAEMON_URL,
      programPath: PROGRAM_PATH,
      decompileTimeout: 60,
      excludeLibraryCode: false,
      codegenOnly: CODEGEN_ONLY,
      writeSnapshotFile: WRITE_SNAPSHOT,
      snapshotDir: SNAPSHOT_DIR,
      snapshotMaxAgeHours: SNAPSHOT_MAX_AGE_HOURS,
      sourceCacheDir: SOURCE_CACHE_DIR,
      useSourceCache: USE_SOURCE_CACHE,
      decompileAllSecondary: MAC_DECOMPILE_ALL,
      excludePatterns: [
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
      ],
      onProgress: (phase: string, current: number, total: number) => {
        const pct = total > 0 ? Math.round((current / total) * 100) : 0;
        process.stdout.write(`\r[${phase}] ${current}/${total} (${pct}%)   `);
        if (current === total) console.log(' ✓');
      },
    }
  );

  console.log('\n' + '='.repeat(60));
  if (result.success) {
    const s = result.stats;
    console.log('Reconstruction complete!');
    console.log(`  Functions: ${s.functionsProcessed}  Classes: ${s.classesDetected}  Types: ${s.dataTypesExtracted}`);
    console.log(`  Globals: ${s.globalsExtracted}  Files: ${s.filesGenerated}  Time: ${(s.timeMs / 1000).toFixed(1)}s`);
    if (result.buildInfo) {
      const p = join(PROJECT_DIR, '.ghidra-mcp', 'buildinfo.json');
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(result.buildInfo));
    }
    if (result.warnings.length) console.log(`  Warnings: ${result.warnings.length}`);
  } else {
    // `result.errors` carries full stacks (see reconstruct's catch); print them
    // so a crash in this long regen is diagnosable without a re-run.
    console.error('Reconstruction FAILED:', result.error ?? '(no error field)');
    if (result.errors?.length) console.error('errors:\n' + result.errors.join('\n---\n'));
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
