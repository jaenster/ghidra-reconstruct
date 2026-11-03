import { describe, it } from 'node:test';
import assert from 'node:assert';
import { extractDataType, extractDataTypes, type ExtractedDataType } from '@ghidra-mcp/reconstruct';
import { DETAIL_KINDS } from '@ghidra-mcp/reconstruct/extract/types';
import { disambiguateVtableTypes } from '@ghidra-mcp/reconstruct/modules/vtable-types';
import { disambiguateCategoryDuplicates } from '@ghidra-mcp/reconstruct/modules/category-duplicate-types';
import { dedupeDataTypesByName, isExcludedDataType } from '@ghidra-mcp/reconstruct/modules/data-type-normalize';
import { applyEvents, buildIndices, dataTypeKey, type ChangeEvent, type LiveModel } from '../model.js';
import { checkDataTypes, dataTypeEvent } from '../verifier.js';
import { EXCLUDE_PATTERNS } from '../exclude-patterns.js';
import { factsScriptOutput } from './fake-facts.js';

/**
 * v1864: right after a reseed the verifier called ButtonImplementation, ButtonWrapper and
 * ChatIgnoreList stale ("fields differ") and its repair published 16 strict errors. Ghidra
 * had not changed. The extraction's whole-list passes had rewritten those records (each
 * class's `vtable *` field points at `<Owner>Vtable`), and a type read on its own had not
 * been through them. These types, in the shape Ghidra answers them, go through the real
 * extraction passes to make the model, and the verifier must find that model current;
 * a real field change must still be found and applied in the model's form.
 */

type Field = { name: string; dataType: string; offset: number; size: number; comment?: string };
type Ghidra = { name: string; category: string; type: string; size: number; fields?: Field[]; values?: Array<{ name: string; value: number }>; returnType?: string; parameters?: unknown[] };

const vtableOf = (owner: string, cat: string, slots: string[]): Ghidra => ({
  name: 'vtable', category: cat, type: 'structure', size: slots.length * 4,
  fields: slots.map((s, i) => ({ name: s, dataType: `${s} *`, offset: i * 4, size: 4 })),
});

function ghidraTypes(): Ghidra[] {
  return [
    { name: 'ButtonImplementation', category: '/D2Client/UI/Button', type: 'structure', size: 12, fields: [
      { name: 'pVtable', dataType: 'vtable *', offset: 0, size: 4, comment: 'virtual function table' },
      { name: 'nPosX', dataType: 'int', offset: 4, size: 4 },
      { name: 'nPosY', dataType: 'int', offset: 8, size: 4 },
    ] },
    vtableOf('ButtonImplementation', '/ButtonImplementation', ['ScalarDeletingDestructor', 'Draw']),
    { name: 'vtable *', category: '/ButtonImplementation', type: 'pointer', size: 4 },
    { name: 'ButtonWrapper', category: '/D2Client/UI/Button', type: 'structure', size: 12, fields: [
      { name: 'pVtable', dataType: 'vtable *', offset: 0, size: 4, comment: 'virtual function table' },
      { name: 'nUnused04', dataType: 'undefined4', offset: 4, size: 4 },
      { name: 'pImplementation', dataType: 'ButtonImplementation *', offset: 8, size: 4 },
    ] },
    vtableOf('ButtonWrapper', '/ButtonWrapper', ['ScalarDeletingDestructor', 'GetValue']),
    { name: 'ChatIgnoreList', category: '/D2Common/Chat/Ignorelist', type: 'structure', size: 4, fields: [
      { name: '_vfptr', dataType: 'vtable *', offset: 0, size: 4 },
    ] },
    vtableOf('ChatIgnoreList', '/ChatIgnoreList', ['Destroy']),
    // A category duplicate: the second fpDrawGroundTile is renamed after the struct
    // that owns its category, and that struct's field is repointed.
    { name: 'fpDrawGroundTile', category: '/Diablo2/GFX/D2GfxHelperStrc', type: 'function', size: 4, returnType: 'void', parameters: [{ name: 'a', dataType: 'int', ordinal: 0 }] },
    { name: 'fpDrawGroundTile', category: '/Diablo2/GFX/D2RenderCallbackStrc', type: 'function', size: 4, returnType: 'BOOL', parameters: [] },
    { name: 'D2RendererFunctionsStrc', category: '/Diablo2/GFX', type: 'structure', size: 4, fields: [
      { name: 'nfpDrawGroundTile', dataType: 'fpDrawGroundTile *', offset: 0, size: 4 },
    ] },
    { name: 'D2RenderCallbackStrc', category: '/Diablo2/GFX', type: 'structure', size: 4, fields: [
      { name: 'pfDrawGroundTile', dataType: 'fpDrawGroundTile *', offset: 0, size: 4 },
    ] },
    // Two same-named enums: the dedup keeps the first and merges the second's values.
    { name: 'eCollisionFlags', category: '/Diablo2/COLLISION', type: 'enum', size: 4, values: [{ name: 'COLLIDE_WALL', value: 1 }] },
    { name: 'eCollisionFlags', category: '/_Source/Collision', type: 'enum', size: 4, values: [{ name: 'COLLIDE_WALL', value: 1 }, { name: 'COLLISION_LOS', value: 0x805 }] },
  ];
}

function fakeGhidra(types: Ghidra[]) {
  return {
    async sendCommand(cmd: string, params: Record<string, unknown> = {}) {
      if (cmd === 'list_data_types') {
        return { dataTypes: types.map(t => ({ name: t.name, category: t.category, type: t.type, size: t.size })), total: types.length };
      }
      if (cmd === 'get_data_type') {
        const t = types.find(x => x.name === params.name && x.category === params.category);
        if (!t) throw new Error(`no type ${params.category}/${params.name}`);
        // get_data_type names no kind for a pointer.
        return t.type === 'pointer' ? { name: t.name, category: t.category, size: t.size } : structuredClone(t);
      }
      if (cmd === 'decompile') return { pseudocode: 'void BUTTON_Draw(ButtonImplementation *p) {}' };
      if (cmd === 'get_function_info') return { name: 'BUTTON_Draw', address: String(params.address), signature: 'void BUTTON_Draw(ButtonImplementation * p)', returnType: 'void', parameters: [], localVariables: [], callingConvention: '__stdcall', size: 10 };
      if (cmd === 'execute_script' && factsScriptOutput(params.code) !== null) return { success: true, output: factsScriptOutput(params.code)! };
      if (cmd === 'execute_script') return { success: true, output: '' };
      return {};
    },
  } as never;
}

/** The extraction's type list as the snapshot holds it: listing, details, the passes. */
async function extractAsSnapshot(client: never): Promise<ExtractedDataType[]> {
  const listing = await extractDataTypes(client, { limit: 10000 });
  let list: ExtractedDataType[] = [];
  for (const t of listing) list.push(DETAIL_KINDS.has(t.kind) ? await extractDataType(client, t.name, t.category) : t);
  list = list.filter(dt => !isExcludedDataType(dt, EXCLUDE_PATTERNS));
  disambiguateVtableTypes(list);
  disambiguateCategoryDuplicates(list);
  return dedupeDataTypesByName(list).result;
}

function modelOf(dataTypes: ExtractedDataType[]): LiveModel {
  return {
    seq: 0,
    options: {},
    primary: {
      functions: [
        { name: 'BUTTON_Draw', address: '004bac00', decompiled: 'void BUTTON_Draw(ButtonImplementation *p) {}', calledFunctions: [] },
        // Enough bystanders that one affected reader stays a partial refresh.
        ...Array.from({ length: 200 }, (_, i) => ({ name: `Filler${i}`, address: (0x500000 + i * 16).toString(16).padStart(8, '0'), decompiled: '' })),
      ],
      globals: [],
      dataTypes,
    },
  } as unknown as LiveModel;
}

const quiet = () => {};
const fieldsOf = (m: LiveModel, name: string) =>
  (m.primary.dataTypes.find(d => d.name === name) as unknown as { fields: Field[] }).fields;

describe('verifier reads types in the extraction\'s form', () => {
  it('finds a freshly extracted model current: vtable fields, category duplicates, merged enums', async () => {
    const client = fakeGhidra(ghidraTypes());
    const model = modelOf(await extractAsSnapshot(client));
    // The passes did rewrite the records this is about.
    assert.strictEqual(fieldsOf(model, 'ButtonImplementation')[0].dataType, 'ButtonImplementationVtable *');
    assert.strictEqual(fieldsOf(model, 'ChatIgnoreList')[0].dataType, 'ChatIgnoreListVtable *');
    assert.strictEqual(fieldsOf(model, 'D2RendererFunctionsStrc')[0].dataType, 'fpDrawGroundTile *');
    assert.ok(model.primary.dataTypes.some(d => d.name === 'D2RenderCallbackStrc_fpDrawGroundTile'));
    const en = model.primary.dataTypes.find(d => d.name === 'eCollisionFlags') as unknown as { values: unknown[] };
    assert.strictEqual(en.values.length, 2);

    const keys = model.primary.dataTypes.map(d => dataTypeKey(d.name, d.category));
    const checks = await checkDataTypes(model, client, keys, { concurrency: 2, log: quiet });
    const off = checks.filter(c => c.status !== 'match');
    assert.deepStrictEqual(off.map(c => `${c.name}: ${c.status} ${(c.fields ?? []).join(',')}${c.note ?? ''}`), []);
  });

  it('still finds a real field change, and the repair keeps the model\'s form', async () => {
    const types = ghidraTypes();
    const client = fakeGhidra(types);
    const model = modelOf(await extractAsSnapshot(client));
    const before = structuredClone(model.primary.dataTypes);

    types[0].fields![2] = { name: 'nTop', dataType: 'int', offset: 8, size: 4 };
    const keys = model.primary.dataTypes.map(d => dataTypeKey(d.name, d.category));
    const checks = await checkDataTypes(model, client, keys, { concurrency: 2, log: quiet });
    const off = checks.filter(c => c.status !== 'match');
    assert.deepStrictEqual(off.map(c => [c.name, c.status, c.fields]), [['ButtonImplementation', 'mismatch', ['fields']]]);

    const indices = buildIndices(model);
    await applyEvents(model, indices, off.map(c => dataTypeEvent(c)) as ChangeEvent[], client, quiet);
    const fields = fieldsOf(model, 'ButtonImplementation');
    assert.strictEqual(fields[0].dataType, 'ButtonImplementationVtable *');
    assert.strictEqual(fields[2].name, 'nTop');

    // The repaired model is what a fresh extraction of the changed program writes.
    const fresh = await extractAsSnapshot(client);
    const strip = (l: ExtractedDataType[]) => l.map(d => ({ ...d, detailUnavailable: undefined }));
    assert.deepStrictEqual(strip(model.primary.dataTypes), strip(fresh));
    assert.notDeepStrictEqual(strip(before), strip(fresh));
  });

  it('a merged enum\'s second category changing is found on the kept enum', async () => {
    const types = ghidraTypes();
    const client = fakeGhidra(types);
    const model = modelOf(await extractAsSnapshot(client));
    types[types.length - 1].values!.push({ name: 'MONSTER_COLLISION_DEFAULT', value: 0x3c01 });
    const key = dataTypeKey('eCollisionFlags', '/Diablo2/COLLISION');
    const [check] = await checkDataTypes(model, client, [key], { concurrency: 1, log: quiet });
    assert.strictEqual(check.status, 'mismatch');
  });
});
