import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { constantStoresFromTrace, parseConstantStoreRow } from './constant-stores.js';
import type { TraceInsn, ZeroStoreTrace } from './zero-stores.js';
import { parseFunctionFacts, selectFacts, FACT_KEYS } from './function-facts.js';

const instruction = (at: number, change: Partial<TraceInsn>): TraceInsn => ({
  at, entered: false, call: false, mnemonic: 'MOV', op0: null, op1: null,
  writes: [], refs: [], ebpDisp: null, store: null, target: null, ...change,
});
function trace(): ZeroStoreTrace {
  return { locals: [{ name: 'sDamage', offset: -120, size: 112 }], ebpFrame: true, insns: [
    instruction(0x104, { mnemonic: 'CALL', call: true, target: 'SetDamageOnEvent' }),
    instruction(0x109, { op0: { mem: true }, op1: { imm: 1 }, refs: [{ offset: -120, kind: 'w' }], ebpDisp: -116, store: { size: 4, value: { imm: 1 } } }),
    instruction(0x110, { op0: { reg: 'AX' }, op1: { mem: true }, writes: ['AX'] }),
    instruction(0x117, { mnemonic: 'OR', op0: { mem: true }, op1: { reg: 'AX' }, refs: [{ offset: -116, kind: 'x' }], ebpDisp: -112, store: { size: 2, value: null } }),
    instruction(0x11b, { op0: { reg: 'ECX' }, op1: { mem: true }, writes: ['ECX'] }),
    instruction(0x121, { mnemonic: 'OR', op0: { reg: 'ECX' }, op1: { imm: 1 }, writes: ['ECX'] }),
    instruction(0x124, { op0: { mem: true }, op1: { reg: 'ECX' }, refs: [{ offset: -120, kind: 'w' }], ebpDisp: -116, store: { size: 4, value: { reg: 'ECX' } } }),
  ] };
}
const expected = [{ name: 'sDamage', offset: -120, size: 112, fieldOffset: 0, value: 1, at: 0x109, afterCall: { name: 'SetDamageOnEvent', at: 0x104 }, between: [{ offset: 4, size: 2, at: 0x117 }], finalAt: 0x124 }];

describe('native constant-store windows', () => {
  it('records the exact Sacrifice write/other-field-write/overwrite native window', () => {
    assert.deepEqual(constantStoresFromTrace(trace()), expected);
  });
  it('can use a verified EBP frame when stack-reference annotations are absent', () => {
    const t = trace(); t.insns.forEach(i => { i.refs = []; });
    assert.deepEqual(constantStoresFromTrace(t), expected);
  });
  for (const [name, change] of [
    ['unknown frame', (t: ZeroStoreTrace) => { t.ebpFrame = false; }],
    ['overlapping local lifetimes', (t: ZeroStoreTrace) => { t.locals.push({ name: 'sOther', offset: -120, size: 112 }); }],
    ['zero initializer', (t: ZeroStoreTrace) => { t.insns[1].store!.value = { imm: 0 }; }],
    ['unresolved register initializer', (t: ZeroStoreTrace) => { t.insns[1].store!.value = { reg: 'EAX' }; }],
    ['out-of-domain immediate', (t: ZeroStoreTrace) => { t.insns[1].store!.value = { imm: 0x80000000 }; }],
    ['branch entry', (t: ZeroStoreTrace) => { t.insns[2].entered = true; }],
    ['call', (t: ZeroStoreTrace) => { t.insns[2].call = true; }],
    ['jump', (t: ZeroStoreTrace) => { t.insns[2].mnemonic = 'JZ'; }],
    ['stack argument push', (t: ZeroStoreTrace) => { t.insns[2].mnemonic = 'PUSH'; }],
    ['intervening stack read', (t: ZeroStoreTrace) => { t.insns[2].refs = [{ offset: -118, kind: 'r' }]; }],
    ['address escape', (t: ZeroStoreTrace) => { t.insns[2].refs = [{ offset: -120, kind: 'a' }]; }],
    ['unknown memory write', (t: ZeroStoreTrace) => { t.insns[2].store = { size: 4, value: null }; }],
    ['partial overwrite', (t: ZeroStoreTrace) => { t.insns[6].store!.size = 2; }],
    ['overlapping other field', (t: ZeroStoreTrace) => { t.insns[3].refs = [{ offset: -118, kind: 'w' }]; t.insns[3].store!.size = 4; }],
    ['write outside the aggregate', (t: ZeroStoreTrace) => { t.insns[3].refs = [{ offset: 4, kind: 'w' }]; }],
    ['in-place final write', (t: ZeroStoreTrace) => { t.insns[6].refs[0].kind = 'x'; }],
    ['non-increasing native addresses', (t: ZeroStoreTrace) => { t.insns[2].at = t.insns[1].at; }],
    ['no intervening field write', (t: ZeroStoreTrace) => { t.insns.splice(3, 1); }],
    ['no preceding call', (t: ZeroStoreTrace) => { t.insns.shift(); }],
    ['unresolved preceding callee', (t: ZeroStoreTrace) => { t.insns[0].target = null; }],
  ] as const) it(`refuses ${name}`, () => { const t = trace(); change(t); assert.deepEqual(constantStoresFromTrace(t), []); });
  it('decodes the existing zero-store trace row without new native script work', () => {
    const row = 'sDamage,-78,70\t1\t104,c,CALL,m,-,-,-,-,-,SetDamageOnEvent;109,-,MOV,m,i:1,-,-78:w,-74,4:c:1,-;110,-,MOV,r:AX,m,AX,-,-,-,-;117,-,OR,m,r:AX,-,-74:x,-70,2:?,-;11b,-,MOV,r:ECX,m,ECX,-,-,-,-;121,-,OR,r:ECX,i:1,ECX,-,-,-,-;124,-,MOV,m,r:ECX,-,-78:w,-74,4:r:ECX,-';
    assert.deepEqual(parseConstantStoreRow(row), expected);
    assert.deepEqual(parseConstantStoreRow('bad trace'), []);
    const f = parseFunctionFacts('F\t005ce790\tself\t-\t0\t1\nZ\t005ce790\t'+row+'\n').rows.get('005ce790');
    assert.ok(f);
    assert.deepEqual(selectFacts('void f() { sDamage.dwHitFlags = flags | 1; }', '005ce790', f, false).constantStores, expected);
    assert.ok(FACT_KEYS.includes('constantStores'));
  });
});
