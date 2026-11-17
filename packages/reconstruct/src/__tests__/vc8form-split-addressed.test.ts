import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildFuncPtrArgCastTables } from '../codegen/index.js';
import { generateFunctionImplementation, getParseErrorCount } from '../codegen/impl.js';
import type { ExtractedFunction, ExtractedFunctionDefinition, ReconstructOptions } from '../types.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/split-addressed-codegen-004ea310.json', import.meta.url), 'utf8')) as {
  fn: ExtractedFunction; callees: ExtractedFunction[]; callbackType: ExtractedFunctionDefinition;
  options: ReconstructOptions; tag: string;
};
const tables = () => buildFuncPtrArgCastTables([fixture.fn, ...fixture.callees], [], [fixture.callbackType], [fixture.callbackType]);
const context = (funcPtrArgCasts = tables()) => ({ targetPointerSize: 4, targetLanguageId: 'x86:LE:32:default', funcPtrArgCasts });
const tagged = () => ({ ...fixture.fn, tags: [...(fixture.fn.tags ?? []), { type: 'vc8form', data: fixture.tag }] });

describe('split: complete SkillDesc production function generation', () => {
  it('derives each output span from the four real callee bodies', () => {
    const t = tables();
    for (const index of [1, 2, 3]) {
      assert.deepEqual(t.paramReach!.argReach('SKILLDESC_DrawDamageWithRange', index, 9), { lo: 0, hi: 4 });
    }
  });
  it('starts only the later minimum lifetime and preserves the dual-wield call', () => {
    const errors = getParseErrorCount();
    const before = generateFunctionImplementation(fixture.fn, undefined, fixture.options, context());
    const after = generateFunctionImplementation(tagged(), undefined, fixture.options, context());
    assert.equal(getParseErrorCount(), errors);
    assert.doesNotMatch(before, /nMinDamageLocal/);
    assert.match(after, /uint32_t nMinDamageLocal = 0;/);
    assert.match(after, /SKILLDESC_DrawSkillDmgPhysical\([^;]+, nMinDamage, pDamCalc2,/);
    assert.match(after, /SKILLDESC_DrawDamageWithRange\(pUnit, \(int\*\)&nMinDamageLocal,/);
    assert.match(after, /SKILLDESC_DrawDamageNumbers\(nMinDamageLocal,/);
    assert.doesNotMatch(after, /struct __frame/);
  });
  it('refuses without the earlier call by-value contract', () => {
    const t = tables();
    for (const key of Object.keys(t.functionParamTypes ?? {})) {
      if (key.endsWith('SKILLDESC_DrawSkillDmgPhysical')) delete t.functionParamTypes![key];
    }
    const before = generateFunctionImplementation(fixture.fn, undefined, fixture.options, context(t));
    const after = generateFunctionImplementation(tagged(), undefined, fixture.options, context(t));
    assert.equal(after, before);
  });
});
