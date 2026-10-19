/**
 * Compile a C++ snippet with the host's g++ and run it, for tests that must check what an
 * emitted expression EVALUATES to rather than how it is spelled. A substring assertion is
 * satisfied by `-0x44` where `0x44` was meant; the compiler is not.
 *
 * Every lowering checked this way is written in fixed-width types (`uint32_t`, `int8_t`),
 * so the host's own word size does not change the answer, and `char` is made signed as it
 * is on the target. Tests skip when no g++ exists.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let cached: boolean | undefined;

/** True when a native g++ is on PATH. */
export function hasNativeGpp(): boolean {
  if (cached === undefined) {
    try { execFileSync('g++', ['--version'], { stdio: 'pipe' }); cached = true; } catch { cached = false; }
  }
  return cached;
}

/**
 * Build `prelude` + `int main() { body }` and return what the program prints. The prelude
 * already has <cstdint>, <cstring>, <cmath> and <cstdio>.
 */
export function compileAndRun(prelude: string, body: string, opts: { optimize?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'native-cpp-'));
  try {
    const src = join(dir, 't.cpp');
    const exe = join(dir, 't');
    writeFileSync(src, [
      '#include <cstdint>', '#include <cstring>', '#include <cmath>', '#include <cstdio>',
      prelude, 'int main() {', body, 'return 0;', '}', '',
    ].join('\n'));
    // -fsigned-char: the target (MSVC and mingw on x86) has a signed `char`, an ARM host does not.
    // -O2 on request, for a test whose subject is what the optimiser may do (inlining).
    execFileSync('g++', ['-std=c++17', opts.optimize ? '-O2' : '-O0', '-w', '-fsigned-char', src, '-o', exe], { stdio: 'pipe' });
    return execFileSync(exe, [], { encoding: 'utf8' });
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
