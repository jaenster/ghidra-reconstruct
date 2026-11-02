import { test } from 'node:test';
import assert from 'node:assert';
import { applyEvents, buildIndices, type ChangeEvent, type LiveModel } from '../model.js';

/**
 * A check-in can add a label or take one away. The full extraction lists globals in
 * the symbol table's order, so an added one must appear there - not be skipped as
 * "not in the model" - and a removed one must leave the model. The functions that
 * reference either are decompiled again.
 */

function model(): LiveModel {
  return {
    seq: 0,
    options: {},
    primary: {
      functions: [
        { name: 'UserOfB', address: '00401000', decompiled: 'void UserOfB(void) { gB = 1; }' },
        { name: 'UserOfC', address: '00401100', decompiled: 'void UserOfC(void) { gC = 1; }' },
        ...Array.from({ length: 200 }, (_, i) => ({ name: `Filler${i}`, address: (0x500000 + i * 16).toString(16).padStart(8, '0'), decompiled: '' })),
      ],
      globals: [
        { name: 'gA', address: '00700000', dataType: 'int', size: 4, referencingFunctions: [] },
        { name: 'gC', address: '00700010', dataType: 'int', size: 4, referencingFunctions: ['UserOfC'] },
      ],
      dataTypes: [],
    },
  } as unknown as LiveModel;
}

function client(labels: string, decompiled: string[]) {
  return {
    async sendCommand(cmd: string, params: Record<string, unknown>) {
      if (cmd === 'execute_script') {
        const code = String(params.code);
        if (code.includes('String[] addrs')) return { success: true, output: labels };
        if (code.includes('getAllSymbols(true)')) return { success: true, output: '00700000\tgA\n00700008\tgB\n00700010\tgC\n' };
        return { success: true, output: '' };
      }
      if (cmd === 'list_data_symbols') {
        const all = [{ name: 'gB', address: '00700008', dataType: 'int', size: 4, referencingFunctions: ['UserOfB'] }];
        const re = new RegExp(String(params.regex ?? ''));
        return { total: 1, globals: all.filter(g => re.test(g.name)) };
      }
      if (cmd === 'decompile') { decompiled.push(String(params.address)); return { pseudocode: 'void f(void) {}' }; }
      if (cmd === 'get_function_info') return { name: 'f', address: String(params.address), signature: 'void f(void)', returnType: 'void', parameters: [], localVariables: [], callingConvention: '__cdecl', size: 4 };
      return {};
    },
  } as never;
}

test('a label added in a check-in becomes a global at the listing\'s place, and its users move', async () => {
  const m = model();
  const decompiled: string[] = [];
  const ev = { seq: 1, kind: 'data.changed', target: 'global', key: '00700008' } as ChangeEvent;
  await applyEvents(m, buildIndices(m), [ev], client('00700008\tgB\n', decompiled));
  assert.deepStrictEqual(m.primary.globals.map(g => g.name), ['gA', 'gB', 'gC']);
  const gB = m.primary.globals[1] as { scope?: string; suggestedType?: string };
  assert.ok(gB.scope !== undefined && gB.suggestedType !== undefined, 'analysed as the full pass analyses it');
  assert.deepStrictEqual(decompiled, ['00401000']);
});

test('a label removed in a check-in leaves the model, and its users move', async () => {
  const m = model();
  const decompiled: string[] = [];
  const ev = { seq: 1, kind: 'data.changed', target: 'global', key: '00700010' } as ChangeEvent;
  await applyEvents(m, buildIndices(m), [ev], client('', decompiled));
  assert.deepStrictEqual(m.primary.globals.map(g => g.name), ['gA']);
  assert.deepStrictEqual(decompiled, ['00401100']);
});
