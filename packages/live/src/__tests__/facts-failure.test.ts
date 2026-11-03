import { test } from 'node:test';
import assert from 'node:assert';
import { applyEvents, buildIndices, FactsRefreshError, type ChangeEvent, type LiveModel } from '../model.js';

/**
 * A re-decompiled function whose facts cannot be read stops the batch. Its old facts are
 * cleared by then, so carrying on would publish it without any.
 */

const ADDR = '00401000';
const TEXT = 'int F(int a)\n{\n  if (a == 0) {\n    return 1;\n  }\n  return 0;\n}\n';

function client(factsOutput: string) {
  return {
    async sendCommand(cmd: string, params: Record<string, unknown>) {
      if (cmd === 'execute_script') {
        const code = String(params.code);
        if (code.includes('getCCodeMarkup')) return { success: true, output: factsOutput };
        return { success: true, output: '' };
      }
      if (cmd === 'get_function_info') return { name: 'F', address: ADDR, signature: 'int F(int a)', returnType: 'int', parameters: [], localVariables: [], callingConvention: '__cdecl', size: 10 };
      if (cmd === 'decompile') return { pseudocode: TEXT };
      return {};
    },
  } as never;
}

function model(): LiveModel {
  return {
    seq: 0,
    options: {},
    primary: {
      functions: [
        { name: 'F', address: ADDR, decompiled: TEXT, maskSites: { count: 1, sites: [] } },
        ...Array.from({ length: 200 }, (_, i) => ({ name: `Filler${i}`, address: (0x500000 + i * 16).toString(16).padStart(8, '0'), decompiled: '' })),
      ],
      globals: [],
      dataTypes: [],
    },
  } as unknown as LiveModel;
}

const ev = { seq: 1, kind: 'function.changed', target: 'function', key: ADDR } as ChangeEvent;

test('an exception in the facts script stops the batch', async () => {
  const m = model();
  await assert.rejects(
    applyEvents(m, buildIndices(m), [ev], client(`F\t${ADDR}\terror\tfail\tjava.lang.NullPointerException\n`)),
    (e: unknown) => e instanceof FactsRefreshError && /00401000 \(script error: java\.lang\.NullPointerException\)/.test(e.message),
  );
});

test('a function the facts script leaves out stops the batch', async () => {
  const m = model();
  await assert.rejects(applyEvents(m, buildIndices(m), [ev], client('')), FactsRefreshError);
});
