/**
 * Union Value Member Plugin Tests
 *
 * The case is Skills_CltDoFunc_EMon_FallingMissileWithZ (004efdf0) at v1998, whose
 * slot union made Ghidra print `((D2UnitStrc *)(nTmp + nInitPosZ)).nInitPosZ`: a
 * strict error. The read is the value as the 32-bit member, so a conversion.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { unionValueMemberPlugin } from '../builtins/union-value-member.js';

const structFields = {
  Slotmc: { pTargetUnit: 'D2UnitStrc *', nInitPosZ: 'int32_t' },
  Slotf: { pUnit: 'D2UnitStrc *', fScale: 'float' },
  D2UnitStrc: { dwUnitId: 'uint32_t' },
};
const run = (code: string) =>
  emit(unionValueMemberPlugin.createTransformer({ structFields } as never)(parse(code)) as AnyNode).replace(/\s+/g, '');

describe('unionValueMemberPlugin', () => {
  it('reads the value as the integer member of the slot union', () => {
    const out = run(`void f(int nTmp, int nInitPosZ) { Slotmc uSlotC; int n; uSlotC.nInitPosZ = nTmp + nInitPosZ; n = ((D2UnitStrc *)(nTmp + nInitPosZ)).nInitPosZ * -2; }`);
    assert.ok(out.includes('n=(int32_t)(nTmp+nInitPosZ)*-2;'), out);
  });

  it('leaves a float member, which needs the bits', () => {
    const out = run(`void f(int v) { Slotf u; float x; x = ((D2UnitStrc *)v).fScale; }`);
    assert.ok(out.includes('x=((D2UnitStrc*)v).fScale;'), out);
  });

  it('needs a local of the union type', () => {
    const out = run(`void f(int v) { int n; n = ((D2UnitStrc *)v).nInitPosZ; }`);
    assert.ok(out.includes('n=((D2UnitStrc*)v).nInitPosZ;'), out);
  });

  it('leaves an arrow access through a cast', () => {
    const out = run(`void f(int v) { Slotmc u; int n; n = ((D2UnitStrc *)v)->dwUnitId; }`);
    assert.ok(out.includes('n=((D2UnitStrc*)v)->dwUnitId;'), out);
  });
});
