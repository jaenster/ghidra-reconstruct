import { test } from 'node:test';
import assert from 'node:assert';
import { applyEvents, buildIndices, changedMemberTokens, byValueEmbedders, type ChangeEvent, type LiveModel } from '../model.js';
import { factsScriptOutput } from './fake-facts.js';

/**
 * v1858: three fields of D2DataTableTxtStrc went from `D2AllStatesDataTbl *` to
 * `uint16_t *`. The readers reach them through the global `sgptDataTable` and never spell
 * the struct's name, so none was decompiled again; the model kept `[i].nStateId`, and four
 * units failed to compile. A member's type, offset or size moving must send every body
 * that spells the member to be decompiled again, as must a moved layout for the members
 * of every type that embeds it by value.
 */

const READER = '005c8980';
const OTHER = '005c9000';

const field = (name: string, dataType: string, offset: number, size = 4) => ({ name, dataType, offset, size });

function model(fields: ReturnType<typeof field>[], extraTypes: unknown[] = []): LiveModel {
  return {
    seq: 0,
    options: {},
    primary: {
      functions: [
        { name: 'SKILLDRUID_ApplyAccumulatedStateDamage', address: READER, calledFunctions: [],
          decompiled: 'BOOL f(void) { eState = (eD2States)sgptDataTable->pAllStatesDataTblFlag0x10[nStateIdx].nStateId; }' },
        { name: 'Other', address: OTHER, calledFunctions: [], decompiled: 'void Other(void) { sgptDataTable->nTxtStatesSize = 0; }' },
        ...Array.from({ length: 200 }, (_, i) => ({ name: `Filler${i}`, address: (0x500000 + i * 16).toString(16).padStart(8, '0'), decompiled: '' })),
      ],
      globals: [],
      dataTypes: [
        { name: 'D2DataTableTxtStrc', category: '/D2Common', kind: 'STRUCTURE', size: 0x200, fields },
        ...extraTypes,
      ],
    },
  } as unknown as LiveModel;
}

function client(freshFields: ReturnType<typeof field>[], decompiled: string[], size = 0x200) {
  return {
    async sendCommand(cmd: string, params: Record<string, unknown>) {
      if (cmd === 'get_data_type') {
        if (params.name === 'D2DataTableTxtStrc') return { name: params.name, category: params.category, type: 'Structure', size, fields: freshFields };
        return { name: params.name, category: params.category, type: 'Structure', size: 8, fields: [] };
      }
      if (cmd === 'decompile') { decompiled.push(String(params.address)); return { pseudocode: 'void f(void) {}' }; }
      if (cmd === 'get_function_info') return { name: 'f', address: String(params.address), signature: 'void f(void)', returnType: 'void', parameters: [], localVariables: [], callingConvention: '__stdcall', size: 10 };
      if (cmd === 'execute_script' && factsScriptOutput(params.code) !== null) return { success: true, output: factsScriptOutput(params.code)! };
      if (cmd === 'execute_script') return { success: true, output: '' };
      return {};
    },
  } as never;
}

const ev = { seq: 1, kind: 'datatype.changed', target: 'datatype', key: '/D2Common/D2DataTableTxtStrc' } as ChangeEvent;
const BEFORE = [field('pAllStatesDataTblFlag0x10', 'D2AllStatesDataTbl *', 0x17c), field('nTxtStatesSize', 'int', 0x180)];

test('a retyped member re-decompiles the bodies that read it, not the struct name\'s', async () => {
  const m = model(BEFORE);
  const decompiled: string[] = [];
  await applyEvents(m, buildIndices(m), [ev], client([field('pAllStatesDataTblFlag0x10', 'uint16_t *', 0x17c), field('nTxtStatesSize', 'int', 0x180)], decompiled));
  assert.deepStrictEqual(decompiled, [READER]);
});

test('a renamed member re-decompiles the bodies that spell either name', async () => {
  const m = model(BEFORE);
  const decompiled: string[] = [];
  await applyEvents(m, buildIndices(m), [ev], client([field('pStates', 'D2AllStatesDataTbl *', 0x17c), field('nTxtStatesSize', 'int', 0x180)], decompiled));
  assert.deepStrictEqual(decompiled, [READER]);
});

test('a moved or resized member moves the layout: every member\'s readers go', async () => {
  const m = model(BEFORE);
  const decompiled: string[] = [];
  await applyEvents(m, buildIndices(m), [ev], client([field('pAllStatesDataTblFlag0x10', 'D2AllStatesDataTbl *', 0x17c), field('nTxtStatesSize', 'int', 0x184)], decompiled));
  assert.deepStrictEqual(decompiled.sort(), [READER, OTHER].sort());
});

test('member diffs: type, offset, size, enum value; size alone moves the layout', () => {
  const s = (fields: unknown[], size = 8) => ({ name: 'S', kind: 'STRUCTURE', size, fields }) as never;
  assert.deepStrictEqual(changedMemberTokens(s([field('a', 'int', 0), field('b', 'int', 4)]), s([field('a', 'int', 0), field('b', 'int', 4)])), { tokens: [], layoutChanged: false });
  assert.deepStrictEqual(changedMemberTokens(s([field('a', 'int', 0), field('b', 'int', 4)]), s([field('a', 'uint', 0), field('b', 'int', 4)])), { tokens: ['a'], layoutChanged: false });
  assert.deepStrictEqual(changedMemberTokens(s([field('a', 'int', 0)]), s([field('a', 'int', 0)], 16)), { tokens: ['a'], layoutChanged: true });
  const e = (values: unknown[]) => ({ name: 'E', kind: 'ENUM', size: 4, values }) as never;
  assert.deepStrictEqual(changedMemberTokens(e([{ name: 'X', value: 0 }, { name: 'Y', value: 1 }]), e([{ name: 'X', value: 0 }, { name: 'Y', value: 2 }])), { tokens: ['Y'], layoutChanged: false });
});

test('a type embedding a moved one by value is found to a fixpoint; a pointer is not', () => {
  const types = [
    { name: 'Inner', kind: 'STRUCTURE', fields: [] },
    { name: 'Outer', kind: 'STRUCTURE', fields: [{ name: 'inner', dataType: 'Inner' }] },
    { name: 'Outermost', kind: 'STRUCTURE', fields: [{ name: 'outer', dataType: 'Outer[2]' }] },
    { name: 'Holder', kind: 'STRUCTURE', fields: [{ name: 'pInner', dataType: 'Inner *' }] },
  ];
  assert.deepStrictEqual(byValueEmbedders(types as never, new Set(['Inner'])).map(i => types[i].name), ['Outer', 'Outermost']);
});

test('a struct embedding a resized one is read again and its members\' readers go', async () => {
  const outer = { name: 'D2Outer', category: '/', kind: 'STRUCTURE', size: 0x204, fields: [field('sTable', 'D2DataTableTxtStrc', 0, 0x200), field('nAfter', 'int', 0x200)] };
  const m = model(BEFORE, [outer]);
  m.primary.functions[1].decompiled = 'void Other(void) { gOuter.nAfter = 0; }';
  const decompiled: string[] = [];
  const res = await applyEvents(m, buildIndices(m), [ev], client(BEFORE, decompiled, 0x210));
  assert.ok(res.touchedDataTypes.some(k => k.includes('D2Outer')), res.touchedDataTypes.join(', '));
  assert.ok(decompiled.includes(OTHER), decompiled.join(', '));
});

test('a member change re-reads the globals held in the type by value, not those pointing at it', async () => {
  const head = (fields: unknown[]) => ({ name: 'D2StormListHead', category: '/', kind: 'STRUCTURE', size: 12, fields });
  const before = [field('nLinkOffset', 'int32_t', 0), field('pPrevLink', 'StormLinkStrc *', 4), field('pNext', 'int32_t', 8)];
  const after = [field('nLinkOffset', 'int32_t', 0), field('terminator', 'StormLinkStrc', 4, 8)];
  const m = model(BEFORE, [head(before), { name: 'D2Archive', category: '/', kind: 'STRUCTURE', size: 16, fields: [field('list', 'D2StormListHead', 0, 12), field('n', 'int', 12)] }]);
  m.primary.globals.push(
    { name: 'gMpqArchiveList', address: '00708354', dataType: 'D2StormListHead', referencingFunctions: [] } as never,
    { name: 'gArchive', address: '00708400', dataType: 'D2Archive', referencingFunctions: [] } as never,
    { name: 'gpList', address: '00708500', dataType: 'D2StormListHead *', referencingFunctions: [] } as never,
  );
  const asked: string[] = [];
  const c = {
    async sendCommand(cmd: string, params: Record<string, unknown>) {
      if (cmd === 'get_data_type') {
        if (params.name === 'D2StormListHead') return { name: params.name, category: '/', type: 'Structure', size: 12, fields: after.map(f => ({ ...f, length: f.size })) };
        return { name: params.name, category: params.category, type: 'Structure', size: 16, fields: [{ name: 'list', dataType: 'D2StormListHead', offset: 0, length: 12 }, { name: 'n', dataType: 'int', offset: 12, length: 4 }] };
      }
      if (cmd === 'list_data_symbols') { asked.push(`global:${params.regex}`); return { total: 0, globals: [] }; }
      if (cmd === 'decompile') return { pseudocode: 'void f(void) {}' };
      if (cmd === 'get_function_info') return { name: 'f', address: String(params.address), signature: 'void f(void)', returnType: 'void', parameters: [], localVariables: [], callingConvention: '__stdcall', size: 10 };
      if (cmd === 'execute_script' && factsScriptOutput(params.code) !== null) return { success: true, output: factsScriptOutput(params.code)! };
      if (cmd === 'execute_script') {
        const code = String(params.code);
        if (code.includes('String[] addrs')) asked.push(...['00708354', '00708400', '00708500'].filter(a => code.includes(a)).map(a => `addr:${a}`));
        return { success: true, output: '' };
      }
      return {};
    },
  } as never;
  const e = { seq: 1, kind: 'datatype.changed', target: 'datatype', key: '/D2StormListHead' } as ChangeEvent;
  await applyEvents(m, buildIndices(m), [e], c);
  const reread = (name: string, addr: string) =>
    asked.some(a => (a.startsWith('global:') && new RegExp(a.slice(7)).test(name)) || a === `addr:${addr}`);
  assert.ok(reread('gMpqArchiveList', '00708354'), asked.join(', '));
  assert.ok(reread('gArchive', '00708400'), asked.join(', '));
  assert.ok(!reread('gpList', '00708500'), asked.join(', '));
});
