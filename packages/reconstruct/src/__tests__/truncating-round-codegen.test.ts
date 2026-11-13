import { it } from 'node:test';
import assert from 'node:assert/strict';
import { generateFunctionImplementation } from '../codegen/impl.js';
import { hashFunction } from '../modules/buildinfo.js';
import type { ExtractedFunction, ReconstructOptions } from '../types.js';

const options: ReconstructOptions = {
  outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false,
  generateSourceMaps: false, transformPreset: 'full', includeAddressComments: false,
  promoteStaticGlobals: false,
};
function fn(withFacts: boolean): ExtractedFunction {
  return {
    name: 'Convert', address: '0061bce0', signature: 'int Convert(double x)', returnType: 'int',
    parameters: [{ name: 'x', dataType: 'double', size: 8, ordinal: 0, storage: 'Stack[0x4]' }],
    localVariables: [], callingConvention: '__cdecl', size: 32, isThunk: false,
    isExternal: false, hasVarArgs: false,
    decompiled: 'int Convert(double x) { return (int)ROUND(x * 7.0 + 0.5); }',
    ...(withFacts ? { truncatingRounds: { count: 1, sites: [{ ord: 0, width: 4 as const }] } } : {}),
  };
}
it('carries native truncation facts through the complete codegen pipeline', () => {
  assert.match(generateFunctionImplementation(fn(false), undefined, options), /std::nearbyint/);
  const out = generateFunctionImplementation(fn(true), undefined, options);
  assert.doesNotMatch(out, /ROUND|nearbyint/);
  assert.match(out, /\(int\)(?:32_t)?\(?x \* 7\.0 \+ 0\.5/);
});
it('invalidates generated output when truncation facts are added or removed', () => {
  assert.notEqual(hashFunction(fn(false)), hashFunction(fn(true)));
  const changed = fn(true);
  changed.truncatingRounds!.sites[0].width = 8;
  assert.notEqual(hashFunction(fn(true)), hashFunction(changed));
});
