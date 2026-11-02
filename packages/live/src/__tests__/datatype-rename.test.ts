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

test('a rename reaches the records that refer to it, not the ones that only share a prefix', async () => {
  const { renameReferrers, baseTypeName } = await import('../model.js');
  assert.equal(baseTypeName('struct D2UnknownStructure0x18 *[3]'), 'D2UnknownStructure0x18');
  assert.equal(baseTypeName('const D2UnknownStructure0x18 * const'), 'D2UnknownStructure0x18');
  const types = [
    { name: 'D2UnknownStructure0x18', category: '/a', kind: 'STRUCTURE', fields: [] },
    { name: 'D2UnknownStructure0x18 *', category: '/a', kind: 'POINTER' },
    // pointer to the renamed struct inside another struct
    { name: 'D2UnitDataPlayerStrc', category: '/', kind: 'STRUCTURE', fields: [{ name: 'pTrade', dataType: 'D2UnknownStructure0x18 *' }] },
    // typedef chain: the first link names the renamed type, the second only the first link
    { name: 'TradeRecordPtr', category: '/', kind: 'TYPEDEF', underlyingType: 'D2UnknownStructure0x18 *' },
    { name: 'TradeRecordPtrAlias', category: '/', kind: 'TYPEDEF', underlyingType: 'TradeRecordPtr' },
    // function definition parameter
    { name: 'pfnTradeCallback', category: '/', kind: 'FUNCTION_DEFINITION', returnType: 'void', parameters: [{ name: 'pRecord', dataType: 'D2UnknownStructure0x18 *' }] },
    // a longer name with the same prefix is a different type
    { name: 'D2Other', category: '/', kind: 'STRUCTURE', fields: [{ name: 'p', dataType: 'D2UnknownStructure0x18Ex *' }] },
  ];
  const r = renameReferrers(types as never, new Set(['D2UnknownStructure0x18']), new Map([['D2UnknownStructure0x18', 'D2TradeRecordStrc']]));
  assert.deepStrictEqual(r.typeSlots.map(i => types[i].name), ['D2UnknownStructure0x18 *', 'D2UnitDataPlayerStrc', 'TradeRecordPtr', 'pfnTradeCallback']);
  assert.equal(r.derivedNames.get(1), 'D2TradeRecordStrc *');
  assert.ok(r.names.has('D2UnknownStructure0x18 *'));
});

test('a struct that points at a renamed type is read again, and so is a global of it', async () => {
  const m = model();
  m.primary.dataTypes.push({ name: 'D2UnitDataPlayerStrc', category: '/', kind: 'STRUCTURE', size: 4, fields: [{ name: 'pTradeCopyInventory', dataType: 'D2UnknownStructure0x18 *', offset: 0, size: 4 }] } as never);
  m.primary.globals.push({ name: 'gpTradeRecord', address: '00700000', dataType: 'D2UnknownStructure0x18 *' } as never);
  const asked: string[] = [];
  const client = {
    async sendCommand(cmd: string, params: Record<string, unknown>) {
      if (cmd === 'get_data_type') {
        asked.push(String(params.name));
        if (params.name === 'D2UnitDataPlayerStrc') return { name: 'D2UnitDataPlayerStrc', category: '/', type: 'Structure', size: 4, fields: [{ name: 'pTradeCopyInventory', dataType: 'D2TradeRecordStrc *', offset: 0, length: 4 }] };
        return { name: params.name, category: params.category, type: 'Structure', size: 24, fields: [] };
      }
      if (cmd === 'list_data_symbols') { asked.push(`global:${params.filter}`); return { symbols: [] }; }
      if (cmd === 'decompile') return { pseudocode: 'void PLAYERTRADE_Accept(D2TradeRecordStrc *pRecord) {}' };
      if (cmd === 'execute_script') return { success: true, output: '' };
      return {};
    },
  } as never;
  const ev = {
    seq: 1, kind: 'datatype.renamed', target: 'datatype',
    key: '/D2Game/D2TradeRecordStrc', oldName: '/D2Game/D2UnknownStructure0x18', newName: '/D2Game/D2TradeRecordStrc',
  } as ChangeEvent;
  await applyEvents(m, buildIndices(m), [ev], client);
  assert.ok(asked.includes('D2UnitDataPlayerStrc'));
  assert.ok(asked.includes('global:gpTradeRecord'));
  const player = m.primary.dataTypes.find(t => t.name === 'D2UnitDataPlayerStrc') as unknown as { fields: { dataType: string }[] };
  assert.equal(player.fields[0].dataType, 'D2TradeRecordStrc *');
});

test('a renamed type moves to where the listing puts it; a referrer\'s users are not decompiled', async () => {
  const m = model();
  m.primary.dataTypes.unshift({ name: 'D2Aaa', category: '/', kind: 'STRUCTURE', size: 4, fields: [] } as never);
  m.primary.dataTypes.splice(1, 0, { name: 'D2UnitDataPlayerStrc', category: '/', kind: 'STRUCTURE', size: 4, fields: [{ name: 'p', dataType: 'D2UnknownStructure0x18 *', offset: 0, size: 4 }] } as never);
  // A body that names only the referrer, not the renamed type.
  m.primary.functions.push({ name: 'PLAYER_GetData', address: '00600000', decompiled: 'D2UnitDataPlayerStrc *PLAYER_GetData(void) {}' } as never);
  const decompiled: string[] = [];
  const client = {
    async sendCommand(cmd: string, params: Record<string, unknown>) {
      if (cmd === 'get_data_type') return { name: params.name, category: params.category, type: 'Structure', size: 4, fields: [] };
      if (cmd === 'list_data_types') return { dataTypes: [
        { name: 'D2Aaa', category: '/', type: 'Structure' },
        { name: 'D2TradeRecordStrc', category: '/D2Game', type: 'Structure' },
        { name: 'D2UnitDataPlayerStrc', category: '/', type: 'Structure' },
      ], total: 3 };
      if (cmd === 'decompile') { decompiled.push(String(params.address)); return { pseudocode: 'void f(void) {}' }; }
      if (cmd === 'execute_script') return { success: true, output: '' };
      return {};
    },
  } as never;
  const ev = {
    seq: 1, kind: 'datatype.renamed', target: 'datatype',
    key: '/D2Game/D2TradeRecordStrc', oldName: '/D2Game/D2UnknownStructure0x18', newName: '/D2Game/D2TradeRecordStrc',
  } as ChangeEvent;
  await applyEvents(m, buildIndices(m), [ev], client);
  assert.deepStrictEqual(m.primary.dataTypes.map(t => t.name), ['D2Aaa', 'D2TradeRecordStrc', 'D2UnitDataPlayerStrc']);
  assert.deepStrictEqual(decompiled, [USER]);
});
