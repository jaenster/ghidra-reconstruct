#!/usr/bin/env npx tsx
/**
 * Reconstruct A2 Racer II (Davilex, 1998) from the remote Ghidra via the ghidra-mcp daemon.
 *
 * Two binaries make up one source tree:
 *   spel.dat -> C:\work\A2racII\Game\        (engine)
 *   menu.dat -> C:\work\A2racII\menu\Ned\prog\ (frontend)
 * Both statically link C:\work\winlib\, so each run emits its own copy of winlib and the
 * two are reconciled afterwards rather than one silently overwriting the other.
 *
 * Usage: npx tsx run-a2racer.ts [game|menu]
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

const TARGETS = {
  game: { programPath: '/spel.dat', outputDir: 'repo-game', projectName: 'A2racII_Game' },
  menu: { programPath: '/menu.dat', outputDir: 'repo-menu', projectName: 'A2racII_Menu' },
} as const;

const which = (process.argv[2] ?? 'game') as keyof typeof TARGETS;
const target = TARGETS[which];
if (!target) {
  console.error(`usage: npx tsx run-a2racer.ts [${Object.keys(TARGETS).join('|')}]`);
  process.exit(2);
}

const PROJECT_PATH = 'ghidra://ghidra.typeguru.nl:13100/A2Racer2';
const DAEMON_URL = process.env.GHIDRA_DAEMON_URL ?? 'https://ghidra.typeguru.nl';
const PROJECT_DIR = join(__dirname, 'project-a2racer');
const OUTPUT_DIR = join(__dirname, target.outputDir);

const ERROR_LOG_PATH = join(PROJECT_DIR, `parser-errors-${which}.log`);
try { writeFileSync(ERROR_LOG_PATH, `# Parse errors\n`); } catch { /* ok */ }
setParseErrorLogPath(ERROR_LOG_PATH);

defaultRegistry.setEnabled('goto-cleanup', true);

async function main() {
  if (!process.env.GHIDRA_MCP_TOKEN) {
    console.error('error: GHIDRA_MCP_TOKEN not set (run oauth-login and export it)');
    process.exit(2);
  }

  console.log('='.repeat(60));
  console.log(`A2 Racer II reconstruction — ${which} (${target.programPath})`);
  console.log('='.repeat(60));
  console.log(`Project: ${PROJECT_PATH}`);
  console.log(`Daemon:  ${DAEMON_URL}`);
  console.log(`Output:  ${OUTPUT_DIR}`);

  const projectConfig = await loadProjectConfig(PROJECT_DIR);
  console.log(projectConfig
    ? `Config: ${projectConfig.modules ? Object.keys(projectConfig.modules).length : 0} modules`
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
      projectName: target.projectName,
      projectConfig: projectConfig ?? undefined,
    },
    {
      daemonUrl: DAEMON_URL,
      programPath: target.programPath,
      decompileTimeout: 60,
      // VC5 static CRT: the CRT is linked in, so let the detector strip it.
      excludeLibraryCode: true,
      excludePatterns: [
        /^VisualStudio$/,
        /^compiler$/,
        /^CRT$/,
        /^_Wrappers$/,
        /^type_info$/,
        /^tm$/,
        /^vtable$/,
        /^wchar_t$/,
        /^EH(ExceptionRecord|RegistrationNode)$/,
        /^EXCEPTION$/i,
        /^LDBL12$/,
        /^LDOUBLE$/,
        /^localeinfo_struct$/,
        /^threadmbcinfostruct$/,
        /^std(:|$)/,
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
      const p = join(PROJECT_DIR, '.ghidra-mcp', `buildinfo-${which}.json`);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(result.buildInfo));
    }
    if (result.warnings.length) console.log(`  Warnings: ${result.warnings.length}`);
  } else {
    console.error('Reconstruction FAILED:');
    for (const e of (result.errors ?? [])) console.error('  ERR:', e);
    if (result.warnings?.length) console.error(`  (${result.warnings.length} warnings)`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
