import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateFunctionImplementation } from '../codegen/impl.js';
import { vc8formBodyHash, vc8FormSpec } from '../codegen/vc8form-spec.js';

const f = JSON.parse(readFileSync(new URL('./fixtures/issue476-switch-truth-v2101.json', import.meta.url), 'utf8'));
const context = { funcPtrArgCasts: f.tables, _namespaceCollisionTypeNames: f.namespaceCollisionTypeNames };

describe('issue476 account-upgrade proof full-codegen replay', () => {
  it('retains the independently native-calibrated untagged baseline', () => {
    assert.equal(vc8formBodyHash(f.function.decompiled), 'e0070caf');
    assert.equal(generateFunctionImplementation(f.function, undefined, f.options, context), f.untaggedBody);
  });

  it('emits the measured switch with one real sealed tag', () => {
    const fn = { ...f.function, tags: [...f.function.tags, { type: 'vc8form', data: f.tag }] };
    const spec = vc8FormSpec(fn);
    assert.deepEqual(spec?.stale, []);
    assert.equal(spec?.forms.length, 1);
    assert.equal(spec?.forms[0].form.op, 'switch');
    const body = generateFunctionImplementation(fn, undefined, f.options, context);
    assert.equal(body, f.taggedBody);
    assert.match(body, /switch \(\*\(int\*\)pPacketData\)/);
    assert.match(body, /case 2:/);
    assert.match(body, /case 0:/);
    assert.notEqual(body, f.untaggedBody);
  });
});
