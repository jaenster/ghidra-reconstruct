import {readFileSync} from 'node:fs';
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {generateFunctionImplementation} from '../codegen/impl.js';
import {setAggregateTypeNames} from '../codegen/platform-types.js';
import type {ExtractedFunction, ReconstructOptions} from '../types.js';

// v2105 live complete models; golden damage bodies come from ece9b518 main.
// 0057c6c0 is the review's address; the nDefender example is 0057c420.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/reused-pointer-slot-v2105.json', import.meta.url), 'utf8'));
const review = JSON.parse(readFileSync(new URL('./fixtures/reused-pointer-review-v2109.json', import.meta.url), 'utf8'));
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
        if(fn.address==='0057c6c0'){
          // The old blanket deferral also suppressed this already-proved enum
          // life. Retain the frozen main golden and name its exact corrections.
          const expected=row.expected
            .replace('    eD2UnitType eVictimType;','    eD2UnitType eVictimType;\n    eD2UnitType nVictim;')
            .replace('pVictim = (D2UnitStrc*)0x6;','nVictim = (eD2UnitType)6;')
            .replace('pVictim = (D2UnitStrc*)pUnit->eUnitType;','nVictim = pUnit->eUnitType;')
            .replace('pVictim == (D2UnitStrc*)0x1','nVictim == 0x1');
          assert.equal(output,expected,'restore the enum local instead of pointer-encoded values');
          assert.doesNotMatch(output,/pVictim = \(D2UnitStrc\*\)/);
          return;
        }
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

describe('review regression guards across Inv and Storm source files',()=>{
  // Fresh complete bodies, with the same bounded typed context as the older
  // fixtures. These guards do not claim a complete owning database export.
  for(const fn of review.functions as ExtractedFunction[])it(`${fn.address} ${fn.name} retains its integer lifetime`,()=>{
    setAggregateTypeNames(fixture.types);
    const output=generateFunctionImplementation(structuredClone(fn),undefined,options,structuredClone(context));
    if(fn.address==='00485410'){
      assert.match(output,/\bint nUnit\b/);
      assert.match(output,/AppendAsWideChar\(wszTempBuffer, nUnit\)/);
      assert.doesNotMatch(output,/pUnit = \(D2UnitStrc\*\)|\(int\)pUnit/);
    }else{
      assert.match(output,/\bint nPszUTF16Out\b/);
      assert.match(output,/pInCur \+= nPszUTF16Out;/);
      assert.doesNotMatch(output,/pszUTF16Out = \(uint16_t\*\)|\(intptr_t\)pszUTF16Out/);
    }
  });
});
