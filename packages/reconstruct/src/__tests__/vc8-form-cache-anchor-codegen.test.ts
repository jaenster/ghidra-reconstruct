import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateFunctionImplementation } from '../codegen/impl.js';
import { parseVc8FormTag } from '../codegen/vc8form-spec.js';
import type { ExtractedFunction, ReconstructOptions } from '../types.js';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/cache-anchor-redemption-v2108.json', import.meta.url), 'utf8'));
const fn = fixture.function as ExtractedFunction;
const options = fixture.options as ReconstructOptions;
function generate(tags: Array<{ type: string; data: string }> = []) {
  return generateFunctionImplementation({ ...fn, tags: [...(fn.tags ?? []), ...tags] }, undefined, options,
    { targetPointerSize: 4, targetLanguageId: 'x86:LE:32:default', funcPtrArgCasts: fixture.tables });
}
describe('indexed cache anchors through Redemption function codegen', () => {
  // This is a function-only model, not an owning extraction/native gain assertion.
  // Its untagged output was compared with current main; the calibrated VC8 gain
  // is separately measured at the current published source stage.
  it('retains the exact current-main output without the optional tags', () => {
    assert.equal(generate(), fixture.baseline);
  });
  it('applies both independent lifetimes after normal codegen transforms', () => {
    const actual = generate(fixture.tags);
    assert.equal(actual, fixture.candidate);
    assert.match(actual, /nLifeGain = nCalcVal \* 0x100;\s+int32_t nMaxVal = .*GetMaxLifeFromUnit/);
    assert.match(actual, /nManaGain = nCalcVal \* 0x100;\s+nMaxVal = .*GetMaxManaFromUnit/);
    assert.match(actual, /nStatVal \+= nLifeGain;/);
    assert.match(actual, /nStatVal \+= nManaGain;/);
  });
  it('retains the anchor ordinal and bounded read count through the evidence record', () => {
    const parsed = parseVc8FormTag(fixture.tags[1].data);
    assert.equal(parsed?.form.op, 'cache');
    if (parsed?.form.op !== 'cache') assert.fail('cache tag');
    assert.equal(parsed.form.anchorIndex, 2);
    assert.equal(parsed.form.count, 1);
  });
  it('refuses both tags when the decompile seal is stale', () => {
    assert.equal(generate(fixture.tags.map((t: { type: string; data: string }) =>
      ({ ...t, data: t.data.replace(/dh=[0-9a-f]+/, 'dh=ffffffff') }))), fixture.baseline);
  });
  it('refuses both tags when the function extent is stale', () => {
    assert.equal(generate(fixture.tags.map((t: { type: string; data: string }) =>
      ({ ...t, data: t.data.replace('bh=298-', 'bh=299-') }))), fixture.baseline);
  });
});
