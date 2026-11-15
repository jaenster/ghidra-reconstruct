import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateFunctionImplementation, getParseErrorCount } from '../codegen/impl.js';
import { setAggregateTypeNames } from '../codegen/platform-types.js';
import { vc8formBodyHash } from '../codegen/vc8form-spec.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/register-store-narrow-v2104.json', import.meta.url), 'utf8'));

describe('register-store narrowing through full function codegen', () => {
  // The live decompile, resolved model and native-attested facts are tied to source
  // d589be17 / v2104. This does not stand in for owning snapshot regeneration.
  it('automatically emits the measured SetAnimationSpeed candidate with real field facts', () => {
    setAggregateTypeNames(fixture.dataTypes);
    const before = getParseErrorCount();
    assert.equal(vc8formBodyHash(fixture.fn.decompiled), fixture.dh);
    const code = generateFunctionImplementation(structuredClone(fixture.fn), undefined, fixture.options, structuredClone(fixture.context));
    assert.equal(getParseErrorCount(), before);
    assert.equal(code, fixture.candidate);
    assert.equal(code, fixture.baseline.replace('(short int)nClampedSpeed', 'nClampedSpeed'));
  });
  it('retains the arm cast when its destination field type is unavailable', () => {
    setAggregateTypeNames(fixture.dataTypes);
    const context = structuredClone(fixture.context);
    delete context.funcPtrArgCasts.structFields;
    const code = generateFunctionImplementation(structuredClone(fixture.fn), undefined, fixture.options, context);
    assert.equal(code, fixture.baseline);
  });
});
