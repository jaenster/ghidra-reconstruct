import { test } from 'node:test';
import assert from 'node:assert';
import { buildWorkerCommand, fixUpResult } from './local-worker.js';

// The local transport must hand the worker exactly what the daemon's handler.ts
// buildCommand would, or the same worker code answers a different question.

test('list_data_symbols is the worker command get_global_variables', () => {
  assert.deepStrictEqual(
    buildWorkerCommand('list_data_symbols', { offset: 0, limit: 500, sortBy: 'address', _other: 1 }),
    { command: 'get_global_variables', params: { offset: 0, limit: 500, sortBy: 'address' } },
  );
});

test('decompile takes its timeout from decompileTimeout, not timeout', () => {
  assert.deepStrictEqual(
    buildWorkerCommand('decompile', { address: '00401000', decompileTimeout: 60, timeout: 5 }),
    { command: 'decompile', params: { address: '00401000', timeout: 60 } },
  );
});

test('batch_decompile keeps decompileTimeout under its own name', () => {
  assert.deepStrictEqual(
    buildWorkerCommand('batch_decompile', { addresses: ['a', 'b'], limit: 2, decompileTimeout: 60 }),
    { command: 'batch_decompile', params: { addresses: ['a', 'b'], limit: 2, decompileTimeout: 60 } },
  );
});

test('execute_script defaults to python and maps scriptTimeout to timeout', () => {
  assert.deepStrictEqual(
    buildWorkerCommand('execute_script', { code: 'x', scriptTimeout: 9 }),
    { command: 'execute_script', params: { code: 'x', timeout: 9, language: 'python' } },
  );
  assert.strictEqual(buildWorkerCommand('execute_script', { code: 'x', language: 'java' }).params.language, 'java');
});

test('undefined parameters are dropped, as JSON.stringify drops them on the daemon path', () => {
  assert.deepStrictEqual(
    buildWorkerCommand('list_functions', { offset: 100, limit: 100, filter: undefined }),
    { command: 'list_functions', params: { offset: 100, limit: 100 } },
  );
});

test('a tool the daemon does not map is refused, not passed through', () => {
  assert.throws(() => buildWorkerCommand('get_cache_version', {}), /Unknown tool: get_cache_version/);
});

test('execute_script output is parsed when it is JSON and left alone when not', () => {
  assert.deepStrictEqual(fixUpResult('execute_script', { output: ' [1,2]\n' }), { output: [1, 2] });
  assert.deepStrictEqual(fixUpResult('execute_script', { output: 'plain text' }), { output: 'plain text' });
});

test('rawPseudocode is stripped from decompile and batch_decompile results', () => {
  assert.deepStrictEqual(fixUpResult('decompile', { pseudocode: 'a', rawPseudocode: 'b' }), { pseudocode: 'a' });
  assert.deepStrictEqual(
    fixUpResult('batch_decompile', { results: [{ pseudocode: 'a', rawPseudocode: 'b' }] }),
    { results: [{ pseudocode: 'a' }] },
  );
});
