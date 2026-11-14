import { it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { generateFunctionImplementation, type ImplGenContext } from '../codegen/impl.js';
import type { ExtractedFunction, ReconstructOptions } from '../types.js';

// Full live bodies with manually attested instruction rows, not a Ghidra export.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/issue351-narrow-compares.json', import.meta.url), 'utf8'));
const options: ReconstructOptions = {
  outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false,
  generateSourceMaps: false, transformPreset: 'full', includeAddressComments: false, promoteStaticGlobals: false,
};
const context: ImplGenContext = {
  funcPtrArgCasts: {
    paramFuncdefs: {}, funcdefSignatures: {}, functionSignatures: {}, variableNames: [],
    voidPointerFunctions: [], rootQualifiedTypedefs: [],
    typedefTargets: { byte: 'unsigned char', uint: 'unsigned int', uint8_t: 'unsigned char', uint16_t: 'unsigned short', int32_t: 'int' },
    structFields: { D2RoomExStrc: { fRoomStatus: 'uint8_t', awRoomsInList: 'uint16_t[4]' }, D2CharTemplateTxt: { level: 'uint8_t' } },
  },
};

it('recovers both Arena comparisons, including the second reader of the same CMP', () => {
  const fn = fixture.functions[0] as ExtractedFunction;
  const out = generateFunctionImplementation(fn, undefined, options, context);
  assert.match(out, /if \(nLevel < nPrevLevel\)/);
  assert.match(out, /if \(nLevel > nPrevLevel\)/);
  assert.doesNotMatch(out, /\(u?int(?:32_t)?\)n(?:Level|PrevLevel)/);
  // Without the second setter, its unsigned spelling is still refused a signed tag.
  const missing = fn.compareSites!.split('\n');
  missing[2] = '2\t<\tINT_LESS\t4\t-1\t-\tv:nPrevLevel\tv:nLevel\t00664b3d\t00664b3d\tJLE\t-\t-\t0\t-\t-\t-\t0';
  const partial = generateFunctionImplementation({ ...fn, compareSites: missing.join('\n') }, undefined, options, context);
  assert.match(partial, /\(uint32_t\)nPrevLevel < \(uint32_t\)nLevel/);
});

it('recovers Room depth versus its byte field despite the later goto label', () => {
  const fn = fixture.functions[1] as ExtractedFunction;
  const out = generateFunctionImplementation(fn, undefined, options, context);
  assert.match(out, /if \(pRoomEx->fRoomStatus >= nDepth\)/);
  assert.doesNotMatch(out, /\(uint32_t\)nDepth/);
  const without = generateFunctionImplementation({ ...fn, compareSites: undefined }, undefined, options, context);
  assert.match(without, /\(uint32_t\)nDepth <= \(uint32_t\)pRoomEx->fRoomStatus/);
});
