/**
 * Operand data references and the addresses derived from them (extract/operand-refs.ts),
 * and the facts folded-address-rebase is handed (codegen/folded-address-spec.ts).
 * The fixture is OPERAND_REF_SCRIPT's own output for ZLIB_InflateTable (0042e120), read
 * read-only from the live program on 2026-10-20.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { OPERAND_REF_SCRIPT, operandRefScript, parseOperandRefs, applyOperandRefs } from '../extract/operand-refs.js';
import { foldedAddressFacts } from '../codegen/folded-address-spec.js';
import type { ExtractedFunction } from '../types.js';

const ZLIB_OUTPUT = [
  'F\t0042e120',
  'R\t0042e129\t1\t00749de0\tREAD\t1',
  'R\t0042e2bf\t1\t006d3928\tDATA\t1',
  'R\t0042e2c6\t1\t006d3968\tDATA\t1',
  'R\t0042e2e8\t1\t006d38a8\tDATA\t1',
  'A\t0042e2e8\t006d38a8\t006d36a6\t0042e2ed',
  'R\t0042e2f2\t1\t006d36a6\tDATA\t0',
  'R\t0042e2f5\t1\t006d38e8\tDATA\t1',
  'A\t0042e2f5\t006d38e8\t006d36e6\t0042e2fa',
  'R\t0042e2ff\t1\t006d36e6\tDATA\t0',
  'R\t0042e3a1\t1\t006d3968\tREAD\t0',
  'R\t0042e3aa\t1\t006d3928\tREAD\t0',
  // ITEM_RollUniqueItem's offset reference (Ghidra's own "X + n" annotation).
  'F\t005566b0',
  'R\t005569a0\t1\t008846f0\tREAD\t1\t008846f8',
  '',
].join('\n');

describe('operand-refs extraction', () => {
  it('the script runs over every function, or the listed ones', () => {
    assert.ok(OPERAND_REF_SCRIPT.includes('getReferencesFrom'));
    assert.ok(operandRefScript().includes('String only = "";'));
    assert.ok(operandRefScript(['0x0042E120', '5566b0']).includes('String only = "0042e120;005566b0";'));
  });

  it('parses references, derived addresses and offset references', () => {
    const facts = parseOperandRefs(ZLIB_OUTPUT);
    const z = facts.get('0042e120')!;
    assert.strictEqual(z.refs.length, 9);
    assert.deepStrictEqual(z.derived[0], { ins: '0042e2e8', to: '006d38a8', value: '006d36a6', at: '0042e2ed' });
    assert.deepStrictEqual(z.refs.find(r => r.ins === '0042e2f2'), { ins: '0042e2f2', op: 1, to: '006d36a6', type: 'DATA', encoded: false });
    assert.strictEqual(facts.get('005566b0')!.refs[0].base, '008846f8');
  });

  it('a re-run over listed functions clears what they no longer have', () => {
    const fns = [{ address: '0042e120' }, { address: '00401000', operandRefs: { refs: [], derived: [] } }, { address: '00402000', operandRefs: { refs: [], derived: [] } }] as unknown as ExtractedFunction[];
    applyOperandRefs(parseOperandRefs(ZLIB_OUTPUT), fns, ['0042e120', '00401000']);
    assert.ok(fns[0].operandRefs);
    assert.strictEqual(fns[1].operandRefs, undefined);
    assert.ok(fns[2].operandRefs, 'a function the run did not cover keeps its facts');
  });
});

describe('foldedAddressFacts', () => {
  const fn = (out: string, addr: string) => ({ operandRefs: parseOperandRefs(out).get(addr) });

  it('ZLIB_InflateTable: lbase - 257 and lext - 257', () => {
    assert.deepStrictEqual(foldedAddressFacts(fn(ZLIB_OUTPUT, '0042e120')), [
      { value: 0x6d36a6, base: 0x6d38a8, ins: '0042e2e8' },
      { value: 0x6d36e6, base: 0x6d38e8, ins: '0042e2f5' },
    ]);
  });

  it('an offset reference is a fact; its own encoding does not veto it', () => {
    assert.deepStrictEqual(foldedAddressFacts(fn(ZLIB_OUTPUT, '005566b0')), [{ value: 0x8846f0, base: 0x8846f8, ins: '005569a0' }]);
  });

  it('a value another instruction encodes, or two bases derive, is dropped', () => {
    const encoded = ZLIB_OUTPUT.replace('R\t0042e2f2\t1\t006d36a6\tDATA\t0', 'R\t0042e2f2\t1\t006d36a6\tDATA\t1');
    assert.deepStrictEqual(foldedAddressFacts(fn(encoded, '0042e120')).map(f => f.value), [0x6d36e6]);
    const twice = ZLIB_OUTPUT.replace('A\t0042e2f5\t006d38e8\t006d36e6', 'A\t0042e2f5\t006d38e8\t006d36a6');
    assert.deepStrictEqual(foldedAddressFacts(fn(twice, '0042e120')), []);
  });

  it('nothing without the field (an older snapshot)', () => {
    assert.deepStrictEqual(foldedAddressFacts({}), []);
  });
});
