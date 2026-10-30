/**
 * Which callees get their calls back, decided over the functions of their unit.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { planInlinedCalls } from '../codegen/inlined-calls.js';
import type { ExtractedFunction, ExtractedParameter } from '../types.js';

function fn(name: string, address: string, body: string, params: ExtractedParameter[] = []): ExtractedFunction {
  const list = params.map(p => `${p.dataType} ${p.name}`).join(',') || 'void';
  return {
    name,
    address,
    signature: `int ${name}(${list})`,
    returnType: 'int',
    parameters: params,
    localVariables: [],
    callingConvention: '__stdcall',
    size: 0x20,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    namespace: 'Unit',
    decompiled: `int __stdcall Unit::${name}(${list})\n\n{\n${body}\n}\n`,
  };
}

const param = (name: string, ordinal: number): ExtractedParameter => ({ name, dataType: 'int', size: 4, ordinal, storage: ordinal === 0 ? 'EAX:4' : 'Stack[0x4]:4' });

function plan(callees: ExtractedFunction[], others: ExtractedFunction[]) {
  const all = [...callees, ...others].map(f => ({ key: f.address, func: f }));
  return planInlinedCalls(
    callees.map(f => ({ key: f.address, func: f, unit: 'Unit' })),
    () => all,
    {},
  );
}

describe('planInlinedCalls', () => {
  // PLAYERMSG_GetMessageType, 00548eb0: nothing but its parameters and constants.
  const getType = fn('GetType', '00548eb0', '  return -(b != a) & 3;', [param('a', 0), param('b', 1)]);

  it('takes a body of parameters alone where it is the one copy in the unit', () => {
    const site = fn('Keepalive', '00549fa0', '  return -(n != 1) & 3;', [param('n', 0)]);
    const p = plan([getType], [site]);
    assert.deepStrictEqual([...p.sitesByCallee.get('00548eb0') ?? []], ['00549fa0']);
  });

  it('refuses it where the unit holds two copies', () => {
    const one = fn('One', '00549fa0', '  return -(n != 1) & 3;', [param('n', 0)]);
    const two = fn('Two', '00549fc0', '  return -(n != 2) & 3;', [param('n', 0)]);
    assert.strictEqual(plan([getType], [one, two]).sitesByCallee.size, 0);
  });

  // NET_SID_GetTime32_00521b40 and _00522bb0: the same body twice.
  it('takes two functions that are each other\'s copy for duplicates', () => {
    const body = '  int t;\n  t = Clock(p->nSeed);\n  return t;';
    const a = fn('TimeA', '00521b40', body, [{ ...param('p', 0), dataType: 'Seed *' }]);
    const b = fn('TimeB', '00522bb0', body, [{ ...param('p', 0), dataType: 'Seed *' }]);
    // Either alone is a call in the other.
    assert.deepStrictEqual([...plan([a], [b]).sitesByCallee.get('00521b40') ?? []], ['00522bb0']);
    assert.strictEqual(plan([a, b], []).sitesByCallee.size, 0);
  });
});
