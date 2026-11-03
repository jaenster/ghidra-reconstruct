import { test } from 'node:test';
import assert from 'node:assert';
import { extractFunctionFacts, parseFunctionFacts, FactsReadError } from './function-facts.js';
import type { ExtractedFunction } from '../types.js';

/**
 * A function the facts script answers without facts must fail the read, never come back
 * as a function with no facts: an absent fact reads as "none found" in codegen, so the
 * tree would change with nothing to say why.
 */

const TEXT = 'int f(int a)\n{\n  if (a == 0) {\n    return 1;\n  }\n  return 0;\n}\n';

function fn(address: string): ExtractedFunction {
  return { name: `f_${address}`, address, decompiled: TEXT } as unknown as ExtractedFunction;
}

function client(output: string) {
  return {
    async sendCommand(cmd: string) {
      if (cmd === 'execute_script') return { success: true, output };
      throw new Error(`unexpected ${cmd}`);
    },
  } as never;
}

test('the parser keeps why the script gave no facts', () => {
  const out = parseFunctionFacts([
    'F\t00401000\tnone\tfail',
    'F\t00401100\tabc123\tfail',
    'F\t00401200\terror\tfail\tjava.lang.NullPointerException: zext',
  ].join('\n'));
  assert.strictEqual(out.rows.size, 0);
  assert.deepStrictEqual(Object.fromEntries(out.failed), {
    '00401000': 'not a function',
    '00401100': 'no decompile',
    '00401200': 'script error: java.lang.NullPointerException: zext',
  });
});

test('an exception in the script fails the read with the function and the reason', async () => {
  const err = await extractFunctionFacts(
    client('F\t00401000\terror\tfail\tjava.lang.ArrayIndexOutOfBoundsException: 3\n'),
    [fn('00401000')], { compareSites: false },
  ).then(() => null, e => e);
  assert.ok(err instanceof FactsReadError, String(err));
  assert.match(err.message, /1 function\(s\): 00401000 \(script error: java\.lang\.ArrayIndexOutOfBoundsException: 3\)/);
});

test('a function missing from the script output fails the read', async () => {
  await assert.rejects(
    extractFunctionFacts(client(''), [fn('00401000')], { compareSites: false }),
    (e: unknown) => e instanceof FactsReadError && e.failed.get('00401000') === 'no row in the script output',
  );
});

test('a script that does not run fails the read', async () => {
  const failing = { async sendCommand() { return { success: false, error: 'compile error: zrow' }; } } as never;
  await assert.rejects(extractFunctionFacts(failing, [fn('00401000')], { compareSites: false }), /compile error: zrow/);
});
