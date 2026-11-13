import { test } from 'node:test';
import assert from 'node:assert';
import { applyEvents, buildIndices, type ChangeEvent, type LiveModel } from '../model.js';
import { factsScriptOutput } from './fake-facts.js';

/**
 * A caller's decompile depends on its callee's call signature, not on the callee's
 * body or local names. When the producer says the signature did not change
 * (callersUnaffected), only the edited function is decompiled again; otherwise its
 * callers are too. The client is a fake that records which functions it decompiled.
 */

const CALLEE = '00479bc0';
const CALLER = '00479d00';

function fakeClient(decompiled: string[]) {
  return {
    async sendCommand(cmd: string, params: Record<string, unknown>) {
      if (cmd === 'decompile') { decompiled.push(String(params.address)); return { pseudocode: 'void f(void) {}' }; }
      if (cmd === 'get_function_info') return { name: params.address === CALLER ? 'PartyPanel' : 'GetRosterPartyId', address: String(params.address), signature: 'int f(void)', returnType: 'int', parameters: [], localVariables: [], callingConvention: '__fastcall', size: 10 };
      if (cmd === 'execute_script' && factsScriptOutput(params.code) !== null) return { success: true, output: factsScriptOutput(params.code)! };
      if (cmd === 'execute_script') return { success: true, output: '' };
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
        { name: 'GetRosterPartyId', address: CALLEE, decompiled: '', calledFunctions: [] },
        { name: 'PartyPanel', address: CALLER, decompiled: '', calledFunctions: ['GetRosterPartyId'] },
        ...Array.from({ length: 200 }, (_, i) => ({ name: `Filler${i}`, address: (0x500000 + i * 16).toString(16).padStart(8, '0'), decompiled: '' })),
      ],
      globals: [],
      dataTypes: [],
    },
  } as unknown as LiveModel;
}

test('an edit inside a function whose call signature held re-decompiles only that function', async () => {
  const m = model();
  const decompiled: string[] = [];
  const ev = { seq: 1, kind: 'function.changed', target: 'function', key: CALLEE, callersUnaffected: true } as ChangeEvent;
  await applyEvents(m, buildIndices(m), [ev], fakeClient(decompiled));
  assert.deepStrictEqual(decompiled.sort(), [CALLEE]);
});

test('without that guarantee the callers are decompiled again too', async () => {
  const m = model();
  const decompiled: string[] = [];
  const ev = { seq: 1, kind: 'function.changed', target: 'function', key: CALLEE } as ChangeEvent;
  await applyEvents(m, buildIndices(m), [ev], fakeClient(decompiled));
  assert.deepStrictEqual(decompiled.sort(), [CALLEE, CALLER]);
});

/**
 * A body that takes the function's address without calling it prints the function's
 * type too: SBig.cpp passes a constructor to `_eh_vector_constructor_iterator_`, and a
 * convention change on that constructor left the file declaring the old one (strict red
 * at Ghidra v2073). The operand references' `C` rows name those bodies.
 */
const TAKER = '00480000';

function modelWithTaker(): LiveModel {
  const m = model();
  (m.primary.functions as unknown[]).push({
    name: 'BuildArray', address: TAKER, decompiled: '', calledFunctions: ['_eh_vector_constructor_iterator_'],
    operandRefs: { refs: [], derived: [], functions: [{ ins: '00480010', op: 0, to: CALLEE }] },
  });
  return m;
}

test('a signature change re-decompiles the bodies that take the function address', async () => {
  const m = modelWithTaker();
  const decompiled: string[] = [];
  const ev = { seq: 1, kind: 'function.signature', target: 'function', key: CALLEE } as ChangeEvent;
  await applyEvents(m, buildIndices(m), [ev], fakeClient(decompiled));
  assert.deepStrictEqual(decompiled.sort(), [CALLEE, CALLER, TAKER]);
});

test('an edit whose call signature held leaves the address takers alone', async () => {
  const m = modelWithTaker();
  const decompiled: string[] = [];
  const ev = { seq: 1, kind: 'function.changed', target: 'function', key: CALLEE, callersUnaffected: true } as ChangeEvent;
  await applyEvents(m, buildIndices(m), [ev], fakeClient(decompiled));
  assert.deepStrictEqual(decompiled.sort(), [CALLEE]);
});

test('the address-taker index follows the operand references', () => {
  const m = modelWithTaker();
  const indices = buildIndices(m);
  assert.deepStrictEqual([...(indices.addressTakersOf.get(CALLEE) ?? [])], [TAKER]);
  assert.strictEqual(indices.addressTakersOf.get(TAKER), undefined);
});
