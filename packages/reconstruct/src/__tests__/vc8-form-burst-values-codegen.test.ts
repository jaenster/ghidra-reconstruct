import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { generateFunctionImplementation } from '../codegen/impl.js';
import { buildFuncPtrArgCastTables } from '../codegen/index.js';
import { vc8FormSpec } from '../codegen/vc8form-spec.js';
import { setAggregateTypeNames, PLATFORM_FUNCDEF_NAMES } from '../codegen/platform-types.js';
import { setKnownFuncDefTypedefs } from '../codegen/globals-header.js';
import type { ExtractedFunction, ReconstructOptions } from '../types.js';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/burst-values-v2109.json', import.meta.url), 'utf8'));
const fn = fixture.fn as ExtractedFunction;
function tables(callees = fixture.callees) {
  setKnownFuncDefTypedefs(PLATFORM_FUNCDEF_NAMES); setAggregateTypeNames(fixture.types);
  return buildFuncPtrArgCastTables([fn, ...callees], fixture.globals, [], fixture.types);
}
function generate(tags = fixture.diagnosticTags, casts = tables()) {
  return generateFunctionImplementation({ ...fn, tags: [...(fn.tags ?? []), ...tags] }, undefined, fixture.options as ReconstructOptions,
    { targetPointerSize: 4, targetLanguageId: 'x86:LE:32:default', funcPtrArgCasts: casts });
}
it('retains the complete production control and preserves the existing contribution tag', () => {
  assert.equal(generate([]), fixture.rawBaseline);
  assert.deepEqual(fn.tags, [{ type: 'nishimura-contrib' }]);
  assert.equal(fn.parameters[3].name, 'nSkillLvl');
});
it('uses the actual getter body to establish two distinct four-byte coordinate outputs', () => {
  const actual = tables();
  for (const index of [2, 3]) assert.deepEqual(actual.paramReach!.argReach('SKILLS_GetTargetOrCursorPos', index, 4), { lo: 0, hi: 4 });
  const incomplete = tables(fixture.callees.map((f: ExtractedFunction) => ({ ...f, decompiled: undefined })));
  assert.notDeepEqual(incomplete.paramReach!.argReach('SKILLS_GetTargetOrCursorPos', 3, 4), { lo: 0, hi: 4 });
});
it('applies independent initialization order before delaying the overwrite and packing by addition', () => {
  const tags = [...fixture.diagnosticTags].reverse();
  assert.deepEqual(vc8FormSpec({ ...fn, tags }).forms.map(f => f.form.op), ['seq', 'delay', 'packadd']);
  assert.equal(generate(tags), fixture.rawCandidate);
  assert.match(fixture.rawCandidate, /if \(\(int\)nMissileCount <= 0\)[\s\S]*return 1;[\s\S]*nSkillLvl = nMissileCount;/);
});
it('refuses the delayed store without its earlier by-value contract and skips all stale forms', () => {
  const incomplete = tables(); incomplete.functionParamTypes = {};
  const withoutDelay = fixture.diagnosticTags.filter((t: { data: string }) => !t.data.startsWith('delay('));
  assert.equal(generate(fixture.diagnosticTags, incomplete), generate(withoutDelay, incomplete));
  const stale = fixture.diagnosticTags.map((t: { type: string; data: string }) => ({ ...t, data: t.data.replace(/dh=[0-9a-f]+/, 'dh=ffffffff') }));
  assert.equal(vc8FormSpec({ ...fn, tags: stale }).stale.length, 3);
  assert.equal(generate(stale), fixture.rawBaseline);
});
