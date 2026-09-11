import { test } from 'node:test';
import assert from 'node:assert';
import { decompileFunction } from './functions.js';

/**
 * The worker reads two different budgets out of the same params object:
 * `decompileTimeout` (seconds, the Ghidra decompiler) and `timeout` (the worker
 * pool). Sending the seconds value under `timeout` starved every large function
 * and the failure was silent - the caller just kept the previous body.
 */
test('decompile asks for the decompiler budget, not the worker-pool one', async () => {
  let seen: Record<string, unknown> | undefined;
  const connection = {
    sessionId: 's',
    async sendCommand(_cmd: string, params: Record<string, unknown>) {
      seen = params;
      return { pseudocode: 'void f(void) { return; }' };
    },
    async close() {},
  } as never;

  await decompileFunction(connection, '0x0060bff0', 60);

  assert.equal(seen!.decompileTimeout, 60);
  assert.equal(seen!.timeout, undefined, 'a bare timeout is the worker pool budget');
  assert.equal(seen!._commandTimeout, 70000);
});
