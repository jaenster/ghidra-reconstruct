/**
 * Prologue PUSH-reg slots (extract/prologue-slots.ts) and the out-parameter oracle
 * (codegen/out-params.ts) that `dead-out-slot-store` reads.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrologueSlots, applyPrologueSlots, PROLOGUE_SLOT_SCRIPT } from '../extract/prologue-slots.js';
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
