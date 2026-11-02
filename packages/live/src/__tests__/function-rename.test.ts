import { test } from 'node:test';
import assert from 'node:assert';
import { applyEvents, buildIndices, type ChangeEvent, type LiveModel } from '../model.js';

/**
 * A renamed function is spelled in more places than its call sites. The full
 * extraction reads everything fresh, so the daemon must reach: a body that takes the
 * function's address without calling it, a global that lists it among its referencing
 * functions (and derives its owner from that list), and a table whose initialized data
 * points at it. A re-read global also carries the plate comment at its address.
 */

const F = '00401000';
const USER = '00401100';
const OLD = 'OOGUTIL_Unused10';
const NEW = 'OOGUTIL_FilterPrintableAsciiChar';
const NS = 'D2Multi::OOGUtilities';

function model(): LiveModel {
  return {
    seq: 0,
    options: {},
    primary: {
      functions: [
        { name: OLD, namespace: NS, address: F, decompiled: `int ${OLD}(int c) { return c; }`, operandRefs: { refs: [{ ins: F, op: 0, to: '00700000', type: 'READ', encoded: true }], derived: [] } },
        { name: 'OOGUTIL_SetupList', address: USER, decompiled: `void OOGUTIL_SetupList(void) { SetFilter(${OLD}); }`, calledFunctions: [] },
        ...Array.from({ length: 200 }, (_, i) => ({ name: `Filler${i}`, address: (0x500000 + i * 16).toString(16).padStart(8, '0'), decompiled: '' })),
      ],
      globals: [
        { name: 'gRef', address: '00700000', dataType: 'int', size: 4, referencingFunctions: [`${NS}::${OLD}`], ownerFunction: OLD },
        { name: 'gTab', address: '00700010', dataType: 'pointer[1]', size: 4, referencingFunctions: [], initializedData: { values: [{ offset: 0, value: `${NS}::${OLD}` }] } },
        { name: 'gOther', address: '00700020', dataType: 'int', size: 4, referencingFunctions: ['Filler1'] },
      ],
      dataTypes: [],
    },
  } as unknown as LiveModel;
}

test('a function rename reaches non-call spellings, referencing globals and pointer tables', async () => {
  const m = model();
  const decompiled: string[] = [];
  const listed: string[] = [];
  const client = {
    async sendCommand(cmd: string, params: Record<string, unknown>) {
      if (cmd === 'execute_script') {
        const code = String(params.code);
        if (code.includes('String[] addrs')) {
          return { success: true, output: 'L\t00700000\tgRef\nC\t00700000\tplate\\nline\nL\t00700010\tgTab\n' };
        }
        return { success: true, output: '' };
      }
      if (cmd === 'get_function_info') {
        const name = params.address === F ? NEW : 'OOGUTIL_SetupList';
        return { name, namespace: params.address === F ? NS : undefined, address: String(params.address), signature: 'int f(void)', returnType: 'int', parameters: [], localVariables: [], callingConvention: '__stdcall', size: 4 };
      }
      if (cmd === 'decompile') {
        decompiled.push(String(params.address));
        return { pseudocode: params.address === F ? `int ${NEW}(int c) { return c; }` : `void OOGUTIL_SetupList(void) { SetFilter(${NEW}); }` };
      }
      if (cmd === 'list_data_symbols') {
        listed.push(String(params.regex));
        const rows = [
          { name: 'gRef', address: '00700000', dataType: 'int', size: 4, referencingFunctions: [`${NS}::${NEW}`] },
          { name: 'gTab', address: '00700010', dataType: 'pointer[1]', size: 4, referencingFunctions: [] },
        ];
        const re = new RegExp(String(params.regex ?? ''));
        return { total: 2, globals: rows.filter(r => re.test(r.name)) };
      }
      return {};
    },
  } as never;
  const ev = { seq: 1, kind: 'symbol.renamed', target: 'function', key: F, oldName: OLD, newName: NEW } as ChangeEvent;
  await applyEvents(m, buildIndices(m), [ev], client);

  assert.ok(decompiled.includes(USER), 'the body that passes the old name along is decompiled again');
  const lists = (n: string) => listed.some(r => new RegExp(r).test(n));
  assert.ok(lists('gRef') && lists('gTab'), listed.join(', '));
  assert.ok(!lists('gOther'));
  assert.equal(listed.length, 1, 'one listing call for every name, not one per name');
  const gRef = m.primary.globals.find(g => g.name === 'gRef') as { referencingFunctions: string[]; ownerFunction?: string; comment?: string };
  assert.deepStrictEqual(gRef.referencingFunctions, [`${NS}::${NEW}`]);
  assert.equal(gRef.ownerFunction, NEW);
  assert.equal(gRef.comment, 'plate\nline');
});
