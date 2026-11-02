/**
 * Prologue PUSH-reg slots (extract/prologue-slots.ts) and the out-parameter oracle
 * (codegen/out-params.ts) that `dead-out-slot-store` reads.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrologueSlots, applyPrologueSlots, parsePrologueFrames, applyPrologueFrames, PROLOGUE_SLOT_SCRIPT } from '../extract/prologue-slots.js';
import { createOutParamOracle, makeTypeSize } from '../codegen/out-params.js';
import type { ExtractedDataType, ExtractedFunction } from '../types.js';

describe('prologue slots', () => {
  it('the script walks PUSH EBP; MOV EBP,ESP and the register pushes after it', () => {
    assert.ok(PROLOGUE_SLOT_SCRIPT.includes('"PUSH EBP"') && PROLOGUE_SLOT_SCRIPT.includes('"MOV EBP,ESP"'));
    assert.ok(PROLOGUE_SLOT_SCRIPT.includes('sb.append("P\\t")'));
  });
  it('SHA1_FromBigIntBytes 0052a270: PUSH EBP; MOV EBP,ESP; PUSH ECX; PUSH ESI; PUSH EDI', () => {
    const slots = parsePrologueSlots(['P\t0052a270\t-8\tECX', 'P\t0052a270\t-12\tESI', 'P\t0052a270\t-16\tEDI', 'junk'].join('\n'));
    const f = { address: '0052a270', name: 'SHA1_FromBigIntBytes' } as ExtractedFunction;
    assert.equal(applyPrologueSlots(slots, [f]), 1);
    assert.deepEqual(f.pushSlots, [{ offset: -8, reg: 'ECX' }, { offset: -12, reg: 'ESI' }, { offset: -16, reg: 'EDI' }]);
  });
  it('the script records a SUB ESP,N right after PUSH EBP; MOV EBP,ESP as an F row', () => {
    assert.ok(PROLOGUE_SLOT_SCRIPT.includes('s0.startsWith("SUB ESP,0x")'));
    assert.ok(PROLOGUE_SLOT_SCRIPT.includes('sb.append("F\\t")'));
  });
  it('BarbFindItemSkill 005a8000 (SUB ESP,0x20) and InitPerspective 006b59a0 (SUB ESP,0x854)', () => {
    const output = ['F\t005a8000\t32', 'F\t006b59a0\t2132', 'P\t0052a270\t-8\tECX', 'F\t00401000\tx', 'F\t00401010\t0', 'junk'].join('\n');
    const frames = parsePrologueFrames(output);
    assert.deepEqual([...frames], [['005a8000', 32], ['006b59a0', 2132]]);
    const fns = [{ address: '005a8000' }, { address: '0x006B59A0' }, { address: '0052a270' }] as ExtractedFunction[];
    assert.equal(applyPrologueFrames(frames, fns), 2);
    assert.deepEqual(fns.map(f => f.frameReserve), [32, 2132, undefined]);
    // The PUSH slots are read from the same output, and an F row is not one.
    assert.deepEqual([...parsePrologueSlots(output).keys()], ['0052a270']);
  });
});

describe('out-parameter oracle', () => {
  const fn = (name: string, params: [string, string][], decompiled: string): ExtractedFunction => ({
    name, address: '00423950', namespace: 'Storm::Source::SBig',
    parameters: params.map(([n, t], i) => ({ name: n, dataType: t, ordinal: i, size: 4 })),
    decompiled,
  } as unknown as ExtractedFunction);
  it('SBigNew 00423950 writes its BigData ** on both paths', () => {
    const sbigNew = fn('SBigNew', [['ppBigData', 'BigData * *']],
      `void Storm::Source::SBig::SBigNew(BigData **ppBigData)\n{\n  BigData *pBigNum;\n  pBigNum = Storm::SMem::SMemAlloc(0x168,"x",0x521,0);\n  if (pBigNum != (BigData *)0x0) {\n    *ppBigData = pBigNum;\n    return;\n  }\n  *ppBigData = (BigData *)0x0;\n  return;\n}`);
    const o = createOutParamOracle(new Map([['SBigNew', sbigNew], ['Storm::Source::SBig::SBigNew', sbigNew]]), []);
    assert.equal(o.outParamWidth('Storm::Source::SBig::SBigNew', 0), 4);
    assert.equal(o.outParamWidth('SBigNew', 1), null);
    assert.equal(o.outParamWidth('Nope', 0), null);
  });
  it('sizes: pointers 4, scalars by name, model types by their size', () => {
    const ts = makeTypeSize([{ name: 'D2SeedStrc', kind: 'STRUCTURE', size: 8, category: '/' } as ExtractedDataType]);
    assert.equal(ts('BigData * *'), 4);
    assert.equal(ts('uint'), 4);
    assert.equal(ts('short int'), 2);
    assert.equal(ts('D2SeedStrc'), 8);
    assert.equal(ts('Unknown'), null);
  });
});
