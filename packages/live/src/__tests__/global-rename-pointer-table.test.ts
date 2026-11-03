import { test } from 'node:test';
import assert from 'node:assert';
import { applyEvents, buildIndices, initializedDataSpells, type ChangeEvent, type LiveModel } from '../model.js';
import { factsScriptOutput } from './fake-facts.js';

/**
 * A renamed global is spelled in the initialized data of every table that points at it:
 * the extraction writes a pointer element as its target's label. At v1870
 * bUnitSoundTableInit became gaUnitSoundIdsAmazon and gaUnitSoundTableByClassId kept
 * `{ kind: 'pointer', value: 'bUnitSoundTableInit' }`, so the tree named a label that no
 * longer existed (one strict error). The table must be read again, as the full extraction
 * reads it; a table that does not point at it must not.
 */

const ARR = '00727eac';
const TAB = '0072a008';
const OTHER = '0072a100';
const OLD = 'bUnitSoundTableInit';
const NEW = 'gaUnitSoundIdsAmazon';

const ptr = (value: string) => ({ kind: 'pointer', value });

function model(): LiveModel {
  return {
    seq: 0,
    options: {},
    primary: {
      functions: [
        ...Array.from({ length: 200 }, (_, i) => ({ name: `Filler${i}`, address: (0x500000 + i * 16).toString(16).padStart(8, '0'), decompiled: '' })),
      ],
      globals: [
        { name: OLD, address: ARR, dataType: 'int[11]', size: 44, isInitialized: true, referencingFunctions: [] },
        { name: 'gaUnitSoundTableByClassId', address: TAB, dataType: 'int *32[2]', size: 8, isInitialized: true, referencingFunctions: [],
          initializedData: { kind: 'array', elements: [ptr(OLD), ptr('gaUnitSoundIdsSorceress')] } },
        { name: 'gaOther', address: OTHER, dataType: 'int *32[1]', size: 4, isInitialized: true, referencingFunctions: [],
          initializedData: { kind: 'array', elements: [ptr('gaUnitSoundIdsSorceress')] } },
      ],
      dataTypes: [],
    },
  } as unknown as LiveModel;
}

test('a global rename re-reads the pointer tables whose initialized data name it', async () => {
  const m = model();
  const readData: string[] = [];
  const client = {
    async sendCommand(cmd: string, params: Record<string, unknown>) {
      if (cmd === 'execute_script' && factsScriptOutput(params.code) !== null) return { success: true, output: factsScriptOutput(params.code)! };
      if (cmd === 'execute_script') {
        const code = String(params.code);
        if (code.includes('String[] addrs')) {
          return { success: true, output: `L\t${ARR}\t${NEW}\nL\t${TAB}\tgaUnitSoundTableByClassId\nL\t${OTHER}\tgaOther\n` };
        }
        return { success: true, output: '' };
      }
      if (cmd === 'list_data_symbols') {
        const rows = [
          { name: NEW, address: ARR, dataType: 'int[11]', size: 44, isInitialized: true, referencingFunctions: [] },
          { name: 'gaUnitSoundTableByClassId', address: TAB, dataType: 'int *32[2]', size: 8, isInitialized: true, referencingFunctions: [] },
          { name: 'gaOther', address: OTHER, dataType: 'int *32[1]', size: 4, isInitialized: true, referencingFunctions: [] },
        ];
        const re = new RegExp(String(params.regex ?? ''));
        return { total: rows.length, globals: rows.filter(r => re.test(r.name)) };
      }
      if (cmd === 'read_data_value') {
        const a = String(params.address);
        readData.push(a);
        if (a === TAB) return { value: { kind: 'array', elements: [ptr(NEW), ptr('gaUnitSoundIdsSorceress')] } };
        if (a === ARR) return { value: { kind: 'array', elements: [] } };
        return { value: { kind: 'array', elements: [ptr('gaUnitSoundIdsSorceress')] } };
      }
      return {};
    },
  } as never;
  const ev = { seq: 1, kind: 'symbol.renamed', target: 'global', key: ARR, oldName: OLD, newName: NEW } as ChangeEvent;
  const result = await applyEvents(m, buildIndices(m), [ev], client);

  const tab = m.primary.globals.find(g => g.name === 'gaUnitSoundTableByClassId') as { initializedData: { elements: { value: string }[] } };
  assert.equal(tab.initializedData.elements[0].value, NEW, 'the table points at the new label');
  assert.ok(result.touchedGlobals.includes(TAB), 'the table is a touched global, so its unit re-emits');
  assert.ok(!readData.includes(OTHER), 'a table that does not name the old label is not read');
  assert.ok(m.primary.globals.some(g => g.name === NEW) && !m.primary.globals.some(g => g.name === OLD));
});

test('initializedDataSpells matches a name as an identifier, bare, qualified or with an offset', () => {
  const g = (value: unknown) => ({ initializedData: value }) as never;
  const names = new Set(['gFoo']);
  assert.ok(initializedDataSpells(g(ptr('gFoo')), names));
  assert.ok(initializedDataSpells(g(ptr('gFoo+0x4')), names));
  assert.ok(initializedDataSpells(g(ptr('D2Client::UI::gFoo')), names));
  assert.ok(initializedDataSpells(g({ kind: 'struct', fields: [{ name: 'p', value: ptr('gFoo') }] }), names));
  assert.ok(!initializedDataSpells(g(ptr('gFooBar')), names));
  assert.ok(!initializedDataSpells(g(ptr('DAT_00000000')), names));
});
