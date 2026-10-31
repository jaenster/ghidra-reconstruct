/**
 * Compile a C++ snippet and run it, for tests that must check what an emitted expression
 * EVALUATES to rather than how it is spelled. A substring assertion is satisfied by `-0x44`
 * where `0x44` was meant; the compiler is not.
 *
 * The toolchain is the target's: 32-bit mingw g++, the compiler the tree's strict build
 * uses, with the .exe run under wine. `GHIDRA_TEST_CXX` picks one explicitly:
 *   mingw  i686-w64-mingw32-g++ + wine
 *   host   the host's g++, native binaries (every lowering checked this way is written in
 *          fixed-width types, so the host's word size does not change the answer; inline
 *          x86 asm in an override body does)
 *   none   no toolchain: the compile-and-run tests skip
 * Unset, the first of mingw, host that builds and runs a probe program is used. With none
 * that works and no explicit `none`, the tests FAIL: they are the value-preservation net
 * for generator rewrites, and a silent skip reads as a pass.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestToolchain {
  name: 'mingw' | 'host';
  /** C++ compiler argv, before the compiler's own flags. */
  cxx: string[];
  /** C compiler argv. */
  cc: string[];
  /** Flags every build gets: static runtime, target `char`. */
  flags: string[];
  /** Executable suffix the compiler expects. */
  exe: string;
  /** argv that runs `exe`. */
  runner: (exe: string) => string[];
}

// -fsigned-char: the target (MSVC and mingw on x86) has a signed `char`, an ARM host does not.
// -static under mingw: wine finds no libstdc++/libgcc DLL beside a temp-dir exe.
// __USE_MINGW_ANSI_STDIO: C++ gets it from libstdc++; C needs it for %llx and %zu.
const CANDIDATES: Record<TestToolchain['name'], TestToolchain> = {
  mingw: {
    name: 'mingw',
    cxx: ['i686-w64-mingw32-g++'],
    cc: ['i686-w64-mingw32-gcc', '-D__USE_MINGW_ANSI_STDIO=1'],
    flags: ['-static', '-fsigned-char'],
    exe: '.exe',
    runner: exe => ['wine', exe],
  },
  host: {
    name: 'host',
    cxx: ['g++'],
    cc: ['cc'],
    flags: ['-fsigned-char'],
    exe: '',
    runner: exe => [exe],
  },
};

/** Environment for a run: wine's own diagnostics stay off stdout and stderr. */
const RUN_ENV = { ...process.env, WINEDEBUG: process.env.WINEDEBUG ?? '-all' };

let resolved: TestToolchain | null | undefined;
let failure = '';

function probe(tc: TestToolchain): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'toolchain-probe-'));
  try {
    const src = join(dir, 't.cpp');
    const exe = join(dir, 't' + tc.exe);
    writeFileSync(src, '#include <cstdio>\nint main() { printf("ok %u\\n", (unsigned)sizeof(void*)); return 0; }\n');
    const cc = spawnSync(tc.cxx[0], [...tc.cxx.slice(1), ...tc.flags, src, '-o', exe], { stdio: 'pipe', env: RUN_ENV });
    if (cc.status !== 0) return `${tc.cxx[0]}: ${cc.error ?? cc.stderr?.toString().trim().split('\n').slice(0, 3).join(' | ')}`;
    const run = runWith(tc, exe, { timeoutMs: 60_000 });
    if (run.status !== 0 || !/^ok \d/.test(run.stdout)) return `${tc.runner(exe)[0]}: ${run.error ?? (run.stderr || `exit ${run.status}`)}`;
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The toolchain compile-and-run tests use, or null when `GHIDRA_TEST_CXX=none`. Throws when none works. */
export function testToolchain(): TestToolchain | null {
  if (resolved === undefined) {
    const want = process.env.GHIDRA_TEST_CXX;
    if (want === 'none') {
      resolved = null;
    } else {
      if (want && !(want in CANDIDATES)) throw new Error(`GHIDRA_TEST_CXX=${want}: expected mingw, host or none`);
      const order = want ? [CANDIDATES[want as TestToolchain['name']]] : [CANDIDATES.mingw, CANDIDATES.host];
      const why: string[] = [];
      for (const tc of order) {
        const err = probe(tc);
        if (!err) { resolved = tc; break; }
        why.push(`${tc.name}: ${err}`);
      }
      if (resolved === undefined) {
        failure = `no C++ toolchain builds and runs a program (${why.join('; ')}). `
          + 'Install i686-w64-mingw32-g++ and wine, or set GHIDRA_TEST_CXX=none to skip these tests.';
        resolved = null;
      }
    }
  }
  if (failure) throw new Error(failure);
  return resolved;
}

/**
 * False only under `GHIDRA_TEST_CXX=none`, for a test's `skip`. With no working toolchain it
 * is true, so each test runs and fails with the reason: an error thrown while node:test
 * collects tests marks the suite but leaves the run's exit status 0.
 */
export function hasNativeGpp(): boolean {
  return process.env.GHIDRA_TEST_CXX !== 'none';
}

function need(): TestToolchain {
  const tc = testToolchain();
  if (!tc) throw new Error('compile-and-run test ran with GHIDRA_TEST_CXX=none');
  return tc;
}

/** Path of the executable `base` (no suffix) builds to under the test toolchain. */
export function exePath(base: string): string {
  return base + need().exe;
}

/** Compile `src` (C++, or C when it ends in .c) to `exe`. Throws with the compiler's stderr. */
export function compileTo(src: string, exe: string, flags: string[] = [], opts: { timeoutMs?: number } = {}): SpawnSyncReturns<Buffer> {
  const tc = need();
  const argv = src.endsWith('.c') ? tc.cc : tc.cxx;
  return spawnSync(argv[0], [...argv.slice(1), ...tc.flags, ...flags, src, '-o', exe], {
    stdio: 'pipe', env: RUN_ENV, timeout: opts.timeoutMs, killSignal: 'SIGKILL',
  });
}

export interface RunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  stdout: string;
  stderr: string;
}

// The output goes to files beside the exe, not pipes. A wine run that has to start the
// wineserver and its services hands them the pipe too, and they hold it open for seconds
// after the program exits: every run would wait out their idle timeout.
function runWith(tc: TestToolchain, exe: string, opts: { timeoutMs?: number }): RunResult {
  const [cmd, ...args] = tc.runner(exe);
  const outPath = exe + '.stdout', errPath = exe + '.stderr';
  const out = openSync(outPath, 'w'), err = openSync(errPath, 'w');
  let r: SpawnSyncReturns<Buffer>;
  try {
    r = spawnSync(cmd, args, { stdio: ['ignore', out, err], env: RUN_ENV, timeout: opts.timeoutMs, killSignal: 'SIGKILL' });
  } finally {
    closeSync(out);
    closeSync(err);
  }
  const read = (p: string) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
  return {
    status: r.status, signal: r.signal, error: r.error,
    stdout: read(outPath).replace(/\r\n/g, '\n'), stderr: read(errPath),
  };
}

/** Run a built executable. stdout has the target's CRLF folded to LF. */
export function runExe(exe: string, opts: { timeoutMs?: number } = {}): RunResult {
  return runWith(need(), exe, opts);
}

/** C++ compiler argv of the test toolchain, for syntax-only checks. */
export function testCxx(): string[] {
  return need().cxx;
}

/**
 * Build `prelude` + `int main() { body }` and return what the program prints. The prelude
 * already has <cstdint>, <cstring>, <cmath> and <cstdio>.
 */
export function compileAndRun(prelude: string, body: string, opts: { optimize?: boolean; flags?: string[] } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'native-cpp-'));
  try {
    const src = join(dir, 't.cpp');
    const exe = exePath(join(dir, 't'));
    writeFileSync(src, [
      '#include <cstdint>', '#include <cstring>', '#include <cmath>', '#include <cstdio>',
      prelude, 'int main() {', body, 'return 0;', '}', '',
    ].join('\n'));
    // -O2 on request, for a test whose subject is what the optimiser may do (inlining).
    // `flags`: e.g. -fwrapv, for a reference that spells the machine's wrapping arithmetic
    // in signed C (GCC folds `x * -2 < 0` to `x > 0` even at -O0 without it).
    const cc = compileTo(src, exe, ['-std=c++17', opts.optimize ? '-O2' : '-O0', '-w', ...(opts.flags ?? [])]);
    if (cc.status !== 0) throw new Error(`does not compile:\n${cc.error ?? cc.stderr.toString()}`);
    const run = runExe(exe);
    if (run.status !== 0) throw new Error(`exited ${run.status ?? run.signal}:\n${run.stderr}`);
    return run.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `printf` line that prints `expr` as an unsigned 64-bit hex value, tagged with `label`. */
export function printHex(label: string, expr: string): string {
  return `printf("%s=%llx\\n", ${JSON.stringify(label)}, (unsigned long long)(${expr}));`;
}

/** Parse `label=hex` lines from `printHex` output. */
export function readHex(output: string): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const line of output.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = BigInt('0x' + line.slice(eq + 1).trim());
  }
  return out;
}
