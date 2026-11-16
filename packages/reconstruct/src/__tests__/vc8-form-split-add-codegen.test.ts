import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { generateFunctionImplementation } from '../codegen/impl.js';
import { buildFuncPtrArgCastTables } from '../codegen/index.js';
import { vc8FormSpec } from '../codegen/vc8form-spec.js';
import { foldedAddressFacts } from '../codegen/folded-address-spec.js';
import { setAggregateTypeNames } from '../codegen/platform-types.js';
import type { ExtractedFunction, ReconstructOptions } from '../types.js';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/split-add-act4-v2109.json', import.meta.url), 'utf8'));
const fn = fixture.fn as ExtractedFunction;
const options: ReconstructOptions = { outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false, generateSourceMaps: false, transformPreset: 'full', includeAddressComments: false, promoteStaticGlobals: false };
function generate(tag?: string, contracts = true) {
  setAggregateTypeNames(fixture.types);
  const tables = buildFuncPtrArgCastTables([fn, ...fixture.callees], fixture.globals, [], fixture.types);
  if (!contracts) tables.functionParamTypes = {};
  const tagged = { ...fn, tags: [...(fn.tags ?? []), ...(tag ? [{ type: 'vc8form', data: tag }] : [])] };
  return generateFunctionImplementation(tagged, undefined, options, { targetPointerSize: 4, targetLanguageId: 'x86:LE:32:default', funcPtrArgCasts: tables }, true);
}
const tag: string = fixture.diagnosticTags[0].data;
it('keeps the complete Act4 control and original internal declaration through production codegen', () => {
  assert.equal(generate(), fixture.rawBaseline);
  assert.match(fixture.rawBaseline, /static void DRLGOUTDOOR_SpawnAct4OutdoorPresets/);
  assert.equal(fn.parameters[0].storage, 'ESI:4');
  assert.deepEqual(foldedAddressFacts(fn).map(f => [f.value, f.base]), [[0x6f2110, 0x6f22b0], [0x6f2104, 0x6f22a4]]);
});
it('applies the opt-in addition using actual int32_t and by-value callee contracts', () => {
  assert.equal(generate(tag), fixture.rawCandidate);
  assert.notEqual(fixture.rawCandidate, fixture.rawBaseline);
  assert.match(fixture.rawCandidate, /int nLastSceneryBase = nPresetBaseB \+ 3/);
  assert.equal(fixture.rawCandidate.match(/SpawnOutdoorLevelPreset\(pLevel, nLastSceneryBase,/g)?.length, 4);
});
it('keeps old split selection, missing contracts and stale seals on the control', () => {
  assert.equal(generate(tag.replace(',add)', ')')), fixture.rawBaseline);
  assert.equal(generate(tag, false), fixture.rawBaseline);
  const stale = tag.replace(/dh=[0-9a-f]+/, 'dh=ffffffff');
  assert.equal(vc8FormSpec({ ...fn, tags: [{ type: 'vc8form', data: stale }] }).stale.length, 1);
  assert.equal(generate(stale), fixture.rawBaseline);
});
