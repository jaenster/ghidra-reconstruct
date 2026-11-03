import { test } from 'node:test';
import assert from 'node:assert';
import { adoptGhidraNames, applyEvents, buildIndices, reorderDataTypes, type ChangeEvent, type LiveModel } from '../model.js';
import { disambiguateVtableTypes } from '@ghidra-mcp/reconstruct/modules/vtable-types';
import { factsScriptOutput } from './fake-facts.js';

/**
 * The model carries the snapshot's type names, and a reconstruct pass renamed some of
 * them: Ghidra's `/WardenClient/vtable` is `WardenClientVtable` in the model, the second
 * `fpDrawGroundTile` is `D2RendererFunctionsStrc_fpDrawGroundTile`. The listing, the
 * journal and get_data_type answer in Ghidra's names. Ranked by the model's names, every
 * renamed type was missing from the listing and a reorder moved all of them to the end
 * (v1846-v1858: 50 types, WardenClient.h changed on the v1861 reseed).
 */

const listing = [
  { name: 'D2Aaa', category: '/', type: 'structure' },
  { name: 'D2Aaa *', category: '/', type: 'pointer' },
  { name: 'fpDrawGroundTile', category: '/Diablo2/GFX/D2GfxHelperStrc', type: 'function' },
  { name: 'fpDrawGroundTile', category: '/Diablo2/GFX/D2RenderCallbackStrc', type: 'function' },
  { name: 'fpDrawGroundTile *', category: '/Diablo2/GFX/D2RenderCallbackStrc', type: 'pointer' },
  { name: 'D2TradeRecordStrc', category: '/D2Game', type: 'structure' },
  { name: 'vtable', category: '/WardenClient', type: 'structure' },
  { name: 'vtable *', category: '/WardenClient', type: 'pointer' },
  { name: 'WardenClient', category: '/WardenClient', type: 'structure' },
  { name: 'zzz', category: '/', type: 'structure' },
];

/** The model as a snapshot written before the passes recorded sourceName holds it. */
function model(): LiveModel {
  const dt = (name: string, category: string, kind: string) => ({ name, category, kind, size: 4, ...(kind === 'STRUCTURE' ? { fields: [] } : {}) });
  return {
    seq: 0,
    options: {},
    primary: {
      functions: [
        { name: 'PLAYERTRADE_Accept', address: '00543210', decompiled: 'void PLAYERTRADE_Accept(D2UnknownStructure0x18 *p) {}', calledFunctions: [] },
        ...Array.from({ length: 200 }, (_, i) => ({ name: `Filler${i}`, address: (0x500000 + i * 16).toString(16).padStart(8, '0'), decompiled: '' })),
      ],
      globals: [],
      dataTypes: [
        dt('D2Aaa', '/', 'STRUCTURE'),
        dt('D2Aaa *', '/', 'POINTER'),
        dt('fpDrawGroundTile', '/Diablo2/GFX/D2GfxHelperStrc', 'FUNCTION_DEFINITION'),
        dt('D2RendererFunctionsStrc_fpDrawGroundTile', '/Diablo2/GFX/D2RenderCallbackStrc', 'FUNCTION_DEFINITION'),
        dt('D2RendererFunctionsStrc_fpDrawGroundTile *', '/Diablo2/GFX/D2RenderCallbackStrc', 'POINTER'),
        dt('D2UnknownStructure0x18', '/D2Game', 'STRUCTURE'),
        dt('WardenClientVtable', '/WardenClient', 'STRUCTURE'),
        dt('WardenClientVtable *', '/WardenClient', 'POINTER'),
        dt('WardenClient', '/WardenClient', 'STRUCTURE'),
        dt('zzz', '/', 'STRUCTURE'),
      ],
    },
  } as unknown as LiveModel;
}

function client(asked: string[] = []) {
  return {
    async sendCommand(cmd: string, params: Record<string, unknown>) {
      if (cmd === 'list_data_types') return { dataTypes: listing, total: listing.length };
      if (cmd === 'get_data_type') {
        asked.push(`${params.category}/${params.name}`);
        const kind = listing.find(t => t.name === params.name && t.category === params.category)?.type;
        // get_data_type names no kind for a pointer or an array.
        return kind === 'pointer' ? { name: params.name, category: params.category, size: 4 }
          : { name: params.name, category: params.category, type: kind ?? 'structure', size: 4, fields: [] };
      }
      if (cmd === 'decompile') return { pseudocode: 'void PLAYERTRADE_Accept(D2TradeRecordStrc *p) {}' };
      if (cmd === 'get_function_info') return { name: 'PLAYERTRADE_Accept', address: String(params.address), signature: 'void f(void)', returnType: 'void', parameters: [], localVariables: [], callingConvention: '__stdcall', size: 10 };
      if (cmd === 'execute_script' && factsScriptOutput(params.code) !== null) return { success: true, output: factsScriptOutput(params.code)! };
      if (cmd === 'execute_script') return { success: true, output: '' };
      return {};
    },
  } as never;
}

const renameEvent = {
  seq: 1, kind: 'datatype.renamed', target: 'datatype',
  key: '/D2Game/D2TradeRecordStrc', oldName: '/D2Game/D2UnknownStructure0x18', newName: '/D2Game/D2TradeRecordStrc',
} as ChangeEvent;

test('a rename elsewhere leaves the types a reconstruct pass renamed where the listing puts them', async () => {
  const m = model();
  await applyEvents(m, buildIndices(m), [renameEvent], client());
  assert.deepStrictEqual(m.primary.dataTypes.map(t => t.name), [
    'D2Aaa',
    'D2Aaa *',
    'fpDrawGroundTile',
    'D2RendererFunctionsStrc_fpDrawGroundTile',
    'D2RendererFunctionsStrc_fpDrawGroundTile *',
    'D2TradeRecordStrc',
    'WardenClientVtable',
    'WardenClientVtable *',
    'WardenClient',
    'zzz',
  ]);
  const byName = new Map(m.primary.dataTypes.map(t => [t.name, t]));
  assert.equal(byName.get('WardenClientVtable')!.sourceName, 'vtable');
  assert.equal(byName.get('WardenClientVtable *')!.sourceName, 'vtable *');
  assert.equal(byName.get('D2RendererFunctionsStrc_fpDrawGroundTile')!.sourceName, 'fpDrawGroundTile');
  assert.equal(byName.get('fpDrawGroundTile')!.sourceName, undefined);
});

test('a change to a renamed type re-reads it under its Ghidra name and keeps the emitted name', async () => {
  const m = model();
  reorderDataTypes(m.primary.dataTypes, listing.map(t => ({ ...t, kind: t.type.toUpperCase() })));
  const asked: string[] = [];
  const ev = { seq: 2, kind: 'datatype.changed', target: 'datatype', key: '/WardenClient/vtable' } as ChangeEvent;
  await applyEvents(m, buildIndices(m), [ev], client(asked));
  assert.deepStrictEqual(asked, ['/WardenClient/vtable']);
  // Read as a new type, the raw record was appended beside the stale one.
  assert.equal(m.primary.dataTypes.length, 10);
  const vt = m.primary.dataTypes.filter(t => t.category === '/WardenClient' && t.kind === 'STRUCTURE');
  assert.deepStrictEqual(vt.map(t => [t.name, t.sourceName]), [['WardenClientVtable', 'vtable'], ['WardenClient', undefined]]);
});

test('a change to a renamed type in a model that never reordered is not read as a new type', async () => {
  const m = model();
  const ev = { seq: 2, kind: 'datatype.changed', target: 'datatype', key: '/WardenClient/vtable' } as ChangeEvent;
  await applyEvents(m, buildIndices(m), [ev], client());
  assert.deepStrictEqual(m.primary.dataTypes.filter(t => t.category === '/WardenClient').map(t => t.name),
    ['WardenClientVtable', 'WardenClientVtable *', 'WardenClient']);
});

test('a pointer read again keeps the kind the listing gives it', async () => {
  const m = model();
  reorderDataTypes(m.primary.dataTypes, listing.map(t => ({ ...t, kind: t.type.toUpperCase() })));
  const ev = { seq: 2, kind: 'datatype.changed', target: 'datatype', key: '/D2Aaa *' } as ChangeEvent;
  await applyEvents(m, buildIndices(m), [ev], client());
  const p = m.primary.dataTypes.filter(t => t.name === 'D2Aaa *');
  assert.deepStrictEqual(p.map(t => t.kind), ['POINTER']);
});

test('names are adopted only on a unique pairing', () => {
  const types = [
    { name: 'AVtable', category: '/X', kind: 'STRUCTURE' },
    { name: 'BVtable', category: '/X', kind: 'STRUCTURE' },
    { name: 'Lone', category: '/Y', kind: 'STRUCTURE' },
  ];
  const n = adoptGhidraNames(types as never, [
    { name: 'vtable', category: '/X', kind: 'STRUCTURE' },
    { name: 'Other', category: '/Y', kind: 'STRUCTURE' },
  ]);
  assert.equal(n, 0);
  assert.ok(types.every(t => !('sourceName' in t)));
});

test('the vtable pass records the name Ghidra holds the type under', () => {
  const types = [
    { name: 'vtable', category: '/WardenClient', kind: 'STRUCTURE', fields: [] },
    { name: 'vtable *', category: '/WardenClient', kind: 'POINTER' },
  ];
  disambiguateVtableTypes(types as never);
  assert.deepStrictEqual(types.map(t => [t.name, (t as { sourceName?: string }).sourceName]), [
    ['WardenClientVtable', 'vtable'],
    ['WardenClientVtable *', 'vtable *'],
  ]);
});
