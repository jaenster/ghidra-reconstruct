import { test } from 'node:test';
import assert from 'node:assert';
import { applyEvents, buildIndices, type ChangeEvent, type LiveModel } from '../model.js';

/**
 * The version journal keys a renamed type by its NEW path and carries the old one in
 * oldName, while the model still holds it under the old one. The rename must replace
 * the old record and decompile every body that spells the old name again; read as a
 * new type, the old record stayed and no body moved.
 */

const USER = '00543210';

function model(): LiveModel {
  return {
    seq: 0,
    options: {},
    primary: {
      functions: [
        { name: 'PLAYERTRADE_Accept', address: USER, decompiled: 'void PLAYERTRADE_Accept(D2UnknownStructure0x18 *pRecord) {}', calledFunctions: [] },
        ...Array.from({ length: 200 }, (_, i) => ({ name: `Filler${i}`, address: (0x500000 + i * 16).toString(16).padStart(8, '0'), decompiled: '' })),
      ],
      globals: [],
      dataTypes: [
        { name: 'D2UnknownStructure0x18', category: '/D2Game', kind: 'STRUCTURE', size: 24, fields: [] },
      ],
    },
  } as unknown as LiveModel;
}

test('a renamed type replaces its old record and re-decompiles the bodies that spell it', async () => {
  const m = model();
  const decompiled: string[] = [];
  const client = {
    async sendCommand(cmd: string, params: Record<string, unknown>) {
      if (cmd === 'get_data_type') return { name: params.name, category: params.category, type: 'Structure', size: 24, fields: [] };
      if (cmd === 'decompile') { decompiled.push(String(params.address)); return { pseudocode: 'void PLAYERTRADE_Accept(D2TradeRecordStrc *pRecord) {}' }; }
      if (cmd === 'get_function_info') return { name: 'PLAYERTRADE_Accept', address: String(params.address), signature: 'void f(void)', returnType: 'void', parameters: [], localVariables: [], callingConvention: '__stdcall', size: 10 };
      if (cmd === 'execute_script') return { success: true, output: '' };
      return {};
    },
  } as never;
  const ev = {
    seq: 1, kind: 'datatype.renamed', target: 'datatype',
    key: '/D2Game/D2TradeRecordStrc', oldName: '/D2Game/D2UnknownStructure0x18', newName: '/D2Game/D2TradeRecordStrc',
  } as ChangeEvent;
  await applyEvents(m, buildIndices(m), [ev], client);

  assert.deepStrictEqual(m.primary.dataTypes.map(t => `${t.category}/${t.name}`), ['/D2Game/D2TradeRecordStrc']);
  assert.deepStrictEqual(decompiled, [USER]);
});
