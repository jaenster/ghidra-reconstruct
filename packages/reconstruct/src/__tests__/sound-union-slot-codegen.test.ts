import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateFunctionImplementation, type ImplGenContext } from '../codegen/impl.js';
import { createOutParamOracle } from '../codegen/out-params.js';
import { setAggregateTypeNames } from '../codegen/platform-types.js';
import { vc8formBodyHash } from '../codegen/vc8form-spec.js';
import type { ExtractedFunction, ExtractedDataType, ReconstructOptions } from '../types.js';

// Actual resolved, hash-matched live models; the fixture records the manually
// native-attested PUSH slot separately from an owning extractor snapshot.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/sound-union-slot.json', import.meta.url), 'utf8'));
const fn = fixture.fn as ExtractedFunction;
const types = fixture.oracleInputs.typeModels as ExtractedDataType[];
const callee = fixture.oracleInputs.calleeModel as ExtractedFunction;
const options = fixture.options as ReconstructOptions;
function context(): ImplGenContext {
  const models = new Map([[fn.name, fn], [`${fn.namespace}::${fn.name}`, fn],
    [callee.name, callee], [`${callee.namespace}::${callee.name}`, callee]]);
  const outParams = createOutParamOracle(models, types);
  assert.equal(outParams.typeSize('D2FloatIntUnion'), 4);
  assert.equal(outParams.outParamWidthNonNull(callee.name, 0), null);
  setAggregateTypeNames(types);
  return { ...fixture.context, funcPtrArgCasts: { ...fixture.context.funcPtrArgCasts, outParams } };
}

it('full sound emission removes only the native PUSH copy before the full-width float store', () => {
  assert.equal(vc8formBodyHash(fn.decompiled!), fixture.dh);
  const facts = context();
  const before = generateFunctionImplementation({ ...fn, pushSlots: [] }, undefined, options, facts);
  const after = generateFunctionImplementation(fn, undefined, options, facts);
  const copy = 'fAttenuation = d2_bits_as<D2FloatIntUnion>(pEnviron);';
  assert.equal(before.split(copy).length, 2);
  assert.doesNotMatch(after, /fAttenuation = d2_bits_as/);
  assert.equal(after.replace(/\s+/g, ' '), before.replace(copy, '').replace(/\s+/g, ' '));
  assert.match(after, /fAttenuation\.fValue = .*SOUNDSMP_ClampAttenuation/);
  assert.match(after, /fAttenuation\.nValue = 0x20/);
  assert.match(after, /&fAttenuation/);
});

it('the owning emitter keeps the PUSH copy without complete union metadata', () => {
  const facts = context();
  const before = generateFunctionImplementation({ ...fn, pushSlots: [] }, undefined, options, facts);
  for (const missing of [{ unionNames: [] }, { aggregateMembers: {} }, { structLayouts: {} }]) {
    assert.equal(generateFunctionImplementation(fn, undefined, options,
      { ...facts, funcPtrArgCasts: { ...facts.funcPtrArgCasts!, ...missing } }), before);
  }
});
