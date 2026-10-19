/**
 * A re-executed generator that is killed says so. It used to exit 1 with nothing printed
 * (`status ?? 1`), which is how a Linux run whose shards hit the OOM killer looked.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { childExit } from '../child-exit.js';

describe('childExit', () => {
  it('passes a child\'s own status through, silently', () => {
    assert.deepStrictEqual(childExit({ status: 3, signal: null }), { code: 3 });
    assert.deepStrictEqual(childExit({ status: 0, signal: null }), { code: 0 });
  });

  it('names the signal of a killed child and exits 128 + its number', () => {
    let err: unknown;
    try {
      execFileSync(process.execPath, ['-e', 'process.kill(process.pid, "SIGKILL")'], { stdio: 'pipe' });
    } catch (e) { err = e; }
    const exit = childExit(err as { status: number | null; signal: NodeJS.Signals | null });
    assert.strictEqual(exit.code, 137);
    assert.match(exit.message!, /killed by SIGKILL.*OOM killer/);
  });
});
