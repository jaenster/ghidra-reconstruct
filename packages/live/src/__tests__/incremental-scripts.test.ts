import { test } from 'node:test';
import assert from 'node:assert';
import { applyEvents, buildIndices, type ChangeEvent, type LiveModel } from '../model.js';

/**
 * The incremental path re-runs the two read-only scripts the full extraction runs
 * beside the listings: the primary-label script after a global is re-listed (the row
 * carries no flag), and the operand-reference script for every function it refreshed
 * (folded-address-rebase reads it). The client is a fake that answers only what these
 * paths ask.
 */

const ZLIB = '0042e120';
const REFS = [
  'F\t0042e120',
  'R\t0042e2e8\t1\t006d38a8\tDATA\t1',
  'A\t0042e2e8\t006d38a8\t006d36a6\t0042e2ed',
  '',
].join('\n');

function fakeClient(calls: string[], primary = 'Game.exe.ram:006f3168\tgaLocaleCategoryNames\t\n') {
  return {
    async sendCommand(cmd: string, params: Record<string, unknown>) {
      if (cmd === 'execute_script') {
        const code = String(params.code);
        if (code.includes('getReferencesFrom')) { calls.push(`oprefs ${code.match(/String only = "([^"]*)"/)![1]}`); return { success: true, output: REFS }; }
        if (code.includes('getPrimarySymbol')) { calls.push('primary'); return { success: true, output: primary }; }
        throw new Error(`unexpected script`);
      }
      calls.push(cmd);
      if (cmd === 'get_function_info') return { name: 'ZLIB_InflateTable', address: ZLIB, signature: 'int ZLIB_InflateTable(void)', returnType: 'int', parameters: [], localVariables: [], callingConvention: '__cdecl', size: 10 };
      if (cmd === 'decompile') return { pseudocode: 'int ZLIB_InflateTable(void) { return 0; }' };
      if (cmd === 'list_data_symbols') {
        return { total: 2, globals: [
          { name: 'gaCrtLocaleCategoryTable', address: '006f3168', dataType: 'int', size: 4, referencingFunctions: [] },
          { name: 'gaLocaleCategoryNames', address: '006f3168', dataType: 'int', size: 4, referencingFunctions: [] },
        ] };
      }
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
        { name: 'ZLIB_InflateTable', address: ZLIB, decompiled: 'int ZLIB_InflateTable(void) { return 0; }', operandRefs: { refs: [], derived: [] } },
        { name: 'Other', address: '00401000', decompiled: '', operandRefs: { refs: [], derived: [{ ins: '1', to: '2', value: '3', at: '4' }] } },
        // Enough functions that one edit stays on the per-function path.
        ...Array.from({ length: 200 }, (_, i) => ({ name: `Filler${i}`, address: (0x500000 + i * 16).toString(16).padStart(8, '0'), decompiled: '' })),
      ],
      globals: [
        { name: 'gaCrtLocaleCategoryTable', address: '006f3168', dataType: 'int', size: 4, primary: true },
        { name: 'gaLocaleCategoryNames', address: '006f3168', dataType: 'int', size: 4, primary: false },
      ],
      dataTypes: [],
    },
  } as unknown as LiveModel;
}

test('a refreshed function gets its operand references again, and only it', async () => {
  const m = model();
  const calls: string[] = [];
  const ev = { seq: 1, kind: 'function.changed', target: 'function', key: ZLIB } as ChangeEvent;
  await applyEvents(m, buildIndices(m), [ev], fakeClient(calls));
  assert.ok(calls.includes(`oprefs ${ZLIB}`), calls.join(', '));
  const fn = m.primary.functions.find(f => f.name === 'ZLIB_InflateTable')!;
  assert.deepStrictEqual(fn.operandRefs!.derived, [{ ins: '0042e2e8', to: '006d38a8', value: '006d36a6', at: '0042e2ed' }]);
  assert.strictEqual(m.primary.functions.find(f => f.name === 'Other')!.operandRefs!.derived.length, 1);
});

test('a re-listed global gets its primary flag from the symbol table again', async () => {
  const m = model();
  const calls: string[] = [];
  const ev = { seq: 1, kind: 'global.renamed', target: 'global', key: '006f3168' } as ChangeEvent;
  await applyEvents(m, buildIndices(m), [ev], fakeClient(calls));
  assert.ok(calls.includes('primary'), calls.join(', '));
  const flags = Object.fromEntries(m.primary.globals.map(g => [g.name, (g as { primary?: boolean }).primary]));
  assert.deepStrictEqual(flags, { gaCrtLocaleCategoryTable: false, gaLocaleCategoryNames: true });
});
