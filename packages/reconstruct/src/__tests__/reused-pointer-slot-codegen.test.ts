import {readFileSync} from 'node:fs';
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {generateFunctionImplementation} from '../codegen/impl.js';
import {setAggregateTypeNames} from '../codegen/platform-types.js';
import type {ExtractedFunction, ReconstructOptions} from '../types.js';

// v2105 live complete models; golden damage bodies come from ece9b518 main.
// 0057c6c0 is the review's address; the nDefender example is 0057c420.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/reused-pointer-slot-v2105.json', import.meta.url), 'utf8'));
const options: ReconstructOptions = {
  outputDir: './out', format: 'cpp', organization: 'namespace',
  generateCMake: false, generateSourceMaps: false, transformPreset: 'full',
  includeAddressComments: false, promoteStaticGlobals: false,
};
const context = {targetPointerSize: 4, targetLanguageId: 'x86:LE:32:default', funcPtrArgCasts: fixture.tables, nullGetterEnums: fixture.tables.enumValues};

describe('reused integer pointer slot through complete function codegen', () => {
  for (const row of fixture.functions) {
    it(`${row.function.address} ${row.function.name}`, () => {
      setAggregateTypeNames(fixture.types);
      const fn = row.function as ExtractedFunction;
      const output = generateFunctionImplementation(fn, undefined, options, context);
      if (fn.address !== '00573cb0') {
        assert.equal(output, row.expected, 'preserve the current main complete body');
        if (fn.address === '0057c420') {
          assert.match(output, /int32_t nDefender;/);
          assert.match(output, /if \(!nDefender\)/);
          assert.match(output, /nDefender != 0x64/);
          assert.match(output, /D2ApplyPercent\(nMaxHp, nDefender, 100\)/);
          assert.doesNotMatch(output, /\(D2UnitStrc\*\)nDefender/);
        }
        return;
      }
      assert.match(output, /uint32_t nMonRegionField;/);
      assert.match(output, /MONSTER_RollComponentAppearance\(pMonRegionField, pUnit\)/);
      assert.match(output, /if \(nTmpInt && nMonRegionField &&/);
      assert.match(output, /\(\(D2MonsterRegionFieldStrc\*\)\(uintptr_t\)nMonRegionField\)\[3\]/);
      assert.match(output, /uint32_t pDVar2;/);
      assert.match(output, /pDVar2 = nMonRegionField;/);
      assert.equal((output.match(/\bpMonRegionField\b/g) ?? []).length, 2);
      assert.doesNotMatch(output, /\(D2MonsterRegionFieldStrc\*\)nMonRegionField/);
    });
  }
});
