import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMPILER_FENCE_SUPPORT_LINES } from '@ghidra-mcp/cpp-parser';
import { generateFunctionImplementation, type ImplGenContext } from '../codegen/impl.js';
import { generatePlatformHeader } from '../codegen/platform-types.js';
import { vc8formBodyHash } from '../codegen/vc8form-spec.js';
import type { ExtractedFunction, ReconstructOptions } from '../types.js';

// Full current MCP bodies and manually native-attested branch-layout facts.
// This fixture is not an owning Ghidra snapshot/export.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/cache-link-fence-v2098.json', import.meta.url), 'utf8'));
const functions = fixture.functions as ExtractedFunction[];
const options: ReconstructOptions = {
  outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false,
  generateSourceMaps: false, transformPreset: 'full', includeAddressComments: false, promoteStaticGlobals: false,
};
function source(fn: ExtractedFunction, tag: 'none' | 'current' | 'stale', tables = fixture.tables) {
  const anchors = fixture.anchors[fn.address] as string[];
  // Explicit unit-test seals; no live proposal is built from these placeholders.
  const seal = `;ev=0000000000;bh=${fn.size}-00000000;dh=${tag === 'stale' ? '00000000' : vc8formBodyHash(fn.decompiled!)}`;
  const model = { ...fn, tags: [...(fn.tags ?? []), ...(tag === 'none' ? [] : [{ type: 'vc8form', data: `fence(${anchors.join(',')})${seal}` }])] };
  return generateFunctionImplementation(model, undefined, options, { funcPtrArgCasts: tables } as ImplGenContext);
}
for (const fn of functions) it(`${fn.address}: applies only the current measured fence form through full emission`, () => {
  const before = source(fn, 'none'), after = source(fn, 'current');
  assert.equal(source(fn, 'stale'), before);
  assert.doesNotMatch(before, /D2_COMPILER_FENCE/);
  assert.equal((after.match(/D2_COMPILER_FENCE\(\);/g) ?? []).length, 1);
  assert.equal(after.replace(/\s*D2_COMPILER_FENCE\(\);/, ''), before);
  assert.match(after, /->pPrev = 0;\s*D2_COMPILER_FENCE\(\);\s*if /);
});
it('refuses absent layout facts without changing that emission', () => {
  const tables = { ...fixture.tables, structLayouts: {} };
  for (const fn of functions) assert.equal(source(fn, 'current', tables), source(fn, 'none', tables));
});
it('the generated platform header carries exactly the helper exercised by native tests', () => {
  assert.ok(generatePlatformHeader().includes(COMPILER_FENCE_SUPPORT_LINES.join('\n')));
});
