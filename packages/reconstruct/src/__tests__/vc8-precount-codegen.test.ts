import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateFunctionImplementation, getParseErrorCount } from '../codegen/impl.js';
import { buildFuncPtrArgCastTables } from '../codegen/index.js';
import { OverrideRegistry } from '../overrides/index.js';
import type { ProjectConfig } from '../config/schema.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/unit-count-precount-live.json', import.meta.url), 'utf8'));
function source(tag = fixture.tag, getter = fixture.getter, extra = [], overrides?: OverrideRegistry) {
  const fn = { ...fixture.fn, tags: [...fixture.fn.tags, ...(tag ? [{ type: 'vc8form', data: tag }] : [])] };
  return generateFunctionImplementation(fn, undefined, fixture.options, {
    targetLanguageId: 'x86:LE:32:default', targetPointerSize: 4, overrides,
    funcPtrArgCasts: buildFuncPtrArgCastTables([fn, getter, ...extra], [], [], [fixture.unitType], [], [], { writeEffects: false }),
  }, true);
}
it('applies the measured precount body through production codegen and its real callee proof', () => {
  const before = getParseErrorCount();
  assert.equal(source(''), fixture.baseline);
  assert.equal(source(), fixture.candidate);
  assert.equal(getParseErrorCount(), before);
});
it('refuses stale decompile evidence', () => {
  assert.equal(source(fixture.tag.replace(/dh=\w+/, 'dh=00000000')), fixture.baseline);
});
it('refuses an effect newly added to the actual getter', () => {
  const getter = { ...fixture.getter, decompiled: fixture.getter.decompiled.replace('return pUnit->pListNext;', 'Observe(); return pUnit->pListNext;') };
  assert.notEqual(getter.decompiled, fixture.getter.decompiled);
  assert.equal(source(fixture.tag, getter), fixture.baseline);
});
it('refuses a callee with a source override', () => {
  const overrides = new OverrideRegistry({ overrides: [{ address: fixture.getter.address, action: 'patch', patches: [] }] } as unknown as ProjectConfig, '.', []);
  assert.equal(source(fixture.tag, fixture.getter, [], overrides), fixture.baseline);
});
it('refuses an ambiguous call spelling', () => {
  assert.equal(source(fixture.tag, fixture.getter, [{ ...fixture.getter, address: '00552dc0' }]), fixture.baseline);
});
