#!/usr/bin/env npx tsx
/**
 * Reconstruct a binary from a Ghidra project, via the ghidra-mcp daemon.
 * Requires GHIDRA_PROJECT_PATH in the env, and GHIDRA_MCP_TOKEN for an
 * OAuth-protected daemon.
 *
 * Needs --stack-size=8192 for deeply nested function ASTs; re-execs itself.
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

const PROJECT_PATH = process.env.GHIDRA_PROJECT_PATH;
if (!PROJECT_PATH) {
  console.error('error: GHIDRA_PROJECT_PATH not set (e.g. ghidra://HOST:PORT/ProjectName)');
  process.exit(2);
}
// Override GHIDRA_DAEMON_URL when the ghidra-mcp daemon is not on localhost
// (e.g. a remote host or a container).
const DAEMON_URL = process.env.GHIDRA_DAEMON_URL ?? 'http://localhost:8432';
const PROGRAM_PATH = process.env.GHIDRA_PROGRAM_PATH ?? '/Game.exe';
const PROJECT_DIR = join(__dirname, 'project');
const OUTPUT_DIR = join(__dirname, 'output');

const ERROR_LOG_PATH = join(PROJECT_DIR, 'parser-errors.log');
try { writeFileSync(ERROR_LOG_PATH, `# Parse errors\n`); } catch { /* ok */ }
setParseErrorLogPath(ERROR_LOG_PATH);

defaultRegistry.setEnabled('goto-cleanup', true);

async function main() {
  if (!process.env.GHIDRA_MCP_TOKEN) {
    console.error('error: GHIDRA_MCP_TOKEN not set (run oauth-login and export it)');
    process.exit(2);
  }

  console.log('='.repeat(60));
  console.log('Ghidra binary reconstruction (TS)');
  console.log('='.repeat(60));
  console.log(`Project: ${PROJECT_PATH}`);
  console.log(`Daemon:  ${DAEMON_URL}`);
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
      excludePatterns: [
        /^compiler$/,
        /^VisualStudio$/,
        /^CRT$/,
        /^_Wrappers$/,
        /^DName(Node|StatusNode)?$/,
        /^UnDecorator$/,
        /^EH(ExceptionRecord|RegistrationNode)$/,
        /^EXCEPTION$/i,
        /^LDBL12$/,
        /^LDOUBLE$/,
        /^charNode$/,
        /^pcharNode$/,
        /^type_info$/,
        /^localeinfo_struct$/,
        /^threadmbcinfostruct$/,
        /^tm$/,
        /^vtable$/,
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
