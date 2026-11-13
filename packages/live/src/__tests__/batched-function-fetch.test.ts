import { test } from 'node:test';
import assert from 'node:assert';
import { fetchFunctionRecords } from '../model.js';

/**
 * A refresh reads names, listing rows and bodies in batches. The records must equal what
 * the per-function calls (get_function_info, list_functions per name, decompile) give,
 * in fewer round trips, and each batched call that fails must fall back to them.
 */

interface Fn { address: string; name: string; body?: string; thunk?: boolean; throws?: boolean; unlisted?: boolean }
const FNS: Fn[] = [
  { address: '00401000', name: 'Alpha', body: 'void Alpha(void) {}' },
  { address: '00401100', name: 'Beta', body: 'int Beta(int a) { return a; }' },
  { address: '00401200', name: 'Shared', body: 'void Shared(void) { one(); }' },
  { address: '00401300', name: 'Shared', body: 'void Shared(void) { two(); }' },
  { address: '00401400', name: 'Thunk', thunk: true },
  { address: '00401500', name: 'Broken', throws: true },
  { address: '00401600', name: 'Hidden', body: 'void Hidden(void) {}', unlisted: true },
  { address: '00401700', name: 'NoText' },
];

function row(f: Fn) {
  return { name: f.name, address: f.address, signature: `void ${f.name}(void)`, returnType: 'void', parameters: [], localVariables: [], callingConvention: '__cdecl', size: 4, isThunk: !!f.thunk, isExternal: false };
}

function fakeClient(batched: boolean) {
  const calls: string[] = [];
  const at = (a: string) => FNS.find(f => f.address === String(a).replace(/^0x/i, ''));
  return {
    calls,
    client: {
      async sendCommand(cmd: string, params: Record<string, unknown>) {
        calls.push(cmd);
        if (cmd === 'execute_script') {
          if (!batched) return { success: false, error: 'scripts unavailable' };
          const addrs = [...String(params.code).matchAll(/"([0-9a-fx]+)"/gi)].map(m => m[1]);
          return { success: true, output: 'FUNCTION-NAMES\n' + addrs.map((a, i) => { const f = at(a); return f ? `F\t${i}\t${f.address}\t${f.name}` : `-\t${i}`; }).join('\n') + '\n' };
        }
        if (cmd === 'get_function_info') { const f = at(String(params.address)); if (!f) throw new Error('none'); return row(f); }
        if (cmd === 'list_functions') {
          const re = new RegExp(String(params.regex), 'i');
          return { functions: FNS.filter(f => !f.unlisted && re.test(f.name)).map(row), total: 0 };
        }
        if (cmd === 'decompile') { const f = at(String(params.address))!; if (f.throws) throw new Error('decompiler crashed'); return { pseudocode: f.body }; }
        if (cmd === 'batch_decompile') {
          if (!batched) throw new Error('no batch');
          const results = []; const failed = [];
          for (const a of params.addresses as string[]) { const f = at(a)!; if (f.throws) failed.push({ address: f.address, name: f.name, error: 'decompiler crashed' }); else results.push({ functionName: f.name, address: f.address, signature: '', pseudocode: f.body }); }
          return { results, failed, total: results.length, decompiled: results.length };
        }
        return {};
      },
    } as never,
  };
}

async function fetch(batched: boolean) {
  const { client, calls } = fakeClient(batched);
  const items = [...FNS.map(f => ({ existing: { name: 'Old' + f.name, address: f.address, decompiled: 'old body', namespace: 'NS' } as never, addr: f.address })),
    { existing: undefined, addr: '00409999' }];
  const log: string[] = [];
  const got = await fetchFunctionRecords(client, items, { reextractInfo: true, timeout: 30, log: m => log.push(m) });
  return { got, calls, log };
}

test('batched reads give the records the per-function reads give', async () => {
  const batched = await fetch(true);
  const single = await fetch(false);
  assert.deepStrictEqual(batched.got, single.got);
  assert.deepStrictEqual([...batched.log].sort(), [...single.log].sort());
  const byAddr = new Map(batched.got.map(g => [g?.record.address, g]));
  assert.equal(byAddr.get('00401300')!.record.decompiled, 'void Shared(void) { two(); }', 'a shared name resolves by address');
  assert.equal(byAddr.get('00401400')!.record.decompiled, 'old body', 'a thunk keeps its body');
  assert.equal(byAddr.get('00401500')!.decompileFailed, true);
  assert.equal(byAddr.get('00401500')!.record.decompiled, 'old body');
  assert.equal(byAddr.get('00401700')!.record.decompiled, undefined, 'an uncompleted decompile carries no text, as decompile returns it');
  assert.equal(byAddr.get('00401600')!.record.name, 'Hidden', 'an unlisted function falls back to get_function_info');
  assert.equal(batched.got[batched.got.length - 1], null, 'a vanished function reads as null');
  assert.equal(byAddr.get('00401000')!.record.namespace, 'NS', 'fields the fresh record leaves undefined are kept');
});

test('batched reads cost a handful of round trips, not three per function', async () => {
  const { calls } = await fetch(true);
  const count = (c: string) => calls.filter(x => x === c).length;
  assert.equal(count('execute_script'), 1);
  assert.equal(count('list_functions'), 1);
  assert.equal(count('batch_decompile'), 1);
  assert.equal(count('decompile'), 0);
  assert.equal(count('get_function_info'), 1, 'only for the unlisted function');
});
