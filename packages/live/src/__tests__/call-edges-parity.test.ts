import { test } from 'node:test';
import assert from 'node:assert';
import { buildCallGraph, populateCalledFunctions } from '@ghidra-mcp/reconstruct/analysis/callgraph';
import { applyEvents, buildIndices, type ChangeEvent, type LiveModel } from '../model.js';
import { factsScriptOutput } from './fake-facts.js';

/**
 * A refreshed function's call edges must be what a full extraction records: the
 * function's own name (its definition line prints it), calls in first-occurrence
 * order, and nothing that is only mentioned without a call.
 */

const SELF = '0042da50';
const BODY = [
  'uint crc32_combine_(uint a, uint b)',
  '{',
  '  pfn = crc32;',
  '  gf2_matrix_square(even, odd);',
  '  return crc32_combine_(gf2_matrix_square(odd, even), b);',
  '}',
].join('\n');

function functions() {
  return [
    { name: 'crc32', address: '0042d900', decompiled: 'uint crc32(void) {}' },
    { name: 'crc32_combine_', address: SELF, decompiled: '' },
    { name: 'gf2_matrix_square', address: '0042db00', decompiled: 'void gf2_matrix_square(void) {}' },
    ...Array.from({ length: 200 }, (_, i) => ({ name: `Filler${i}`, address: (0x500000 + i * 16).toString(16).padStart(8, '0'), decompiled: '' })),
  ];
}

test('a refreshed body gets the call edges a full extraction gives it', async () => {
  const m = { seq: 0, options: {}, primary: { functions: functions(), globals: [], dataTypes: [] } } as unknown as LiveModel;
  const client = {
    async sendCommand(cmd: string, params: Record<string, unknown>) {
      if (cmd === 'decompile') return { pseudocode: BODY };
      if (cmd === 'get_function_info') return { name: 'crc32_combine_', address: String(params.address), signature: 'uint f(void)', returnType: 'uint', parameters: [], localVariables: [], callingConvention: '__cdecl', size: 10 };
      if (cmd === 'execute_script' && factsScriptOutput(params.code) !== null) return { success: true, output: factsScriptOutput(params.code)! };
      if (cmd === 'execute_script') return { success: true, output: '' };
      return {};
    },
  } as never;
  const ev = { seq: 1, kind: 'function.changed', target: 'function', key: SELF, callersUnaffected: true } as ChangeEvent;
  await applyEvents(m, buildIndices(m), [ev], client);

  const full = functions();
  full[1].decompiled = BODY;
  populateCalledFunctions(full as never, buildCallGraph(full as never));
  const live = m.primary.functions.find(f => f.address === SELF)!;
  assert.deepStrictEqual(live.calledFunctions, (full[1] as { calledFunctions?: string[] }).calledFunctions);
  assert.deepStrictEqual(live.calledFunctions, ['crc32_combine_', 'gf2_matrix_square']);
});
