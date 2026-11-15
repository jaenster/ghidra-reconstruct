import {readFileSync} from 'node:fs';
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {generateFunctionImplementation} from '../codegen/impl.js';
import type {ExtractedFunction, ReconstructOptions} from '../types.js';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/zero-life-durability-v2105.json', import.meta.url), 'utf8'));
const fn = fixture.function as ExtractedFunction;
const options: ReconstructOptions = {outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false, generateSourceMaps: false, transformPreset: 'full', includeAddressComments: false, promoteStaticGlobals: false};
const context = {targetPointerSize: 4, targetLanguageId: 'x86:LE:32:default', funcPtrArgCasts: fixture.tables};
function emit(tag?: string, tables = fixture.tables) {
  return generateFunctionImplementation({...fn, tags: [...(fn.tags ?? []), ...(tag ? [{type: 'vc8form', data: tag}] : [])]}, undefined, options, {...context, funcPtrArgCasts: tables});
}
describe('zero-path lifetime through complete durability codegen', () => {
  it('preserves current main without the optional form', () => assert.equal(emit(), fixture.baseline));
  it('applies the local diagnostic form after normal variable and guard transforms', () => {
    const output = emit(fixture.tag);
    const before = `int32_t bHasDurabilityBonus = D2Common::ITEMS::Items::ITEM_GetTxtItemTypes_throwable(pUnit);\n    if (bHasDurabilityBonus) {\n      return;\n    }`;
    const after = `if (D2Common::ITEMS::Items::ITEM_GetTxtItemTypes_throwable(pUnit)) {\n      return;\n    }\n    int32_t bHasDurabilityBonus = 0;`;
    assert.ok(fixture.baseline.includes(before));
    const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
    assert.equal(flat(output), flat(fixture.baseline.replace(before, after)));
  });
  it('refuses a stale decompile seal', () => assert.equal(emit(fixture.tag.replace(/dh=[0-9a-f]+/, 'dh=ffffffff')), fixture.baseline));
  it('requires the direct callee integer-return contract', () => {
    const tables = {...fixture.tables, functionReturnTypes: {}};
    const control = emit(undefined, tables);
    assert.equal(emit(fixture.tag, tables), control);
  });
});
