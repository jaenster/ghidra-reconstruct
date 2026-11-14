import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateFunctionImplementation, type ImplGenContext } from '../codegen/impl.js';
import { vc8formBodyHash } from '../codegen/vc8form-spec.js';
import type { ExtractedFunction, ReconstructOptions } from '../types.js';

// Fresh v2099 MCP models, full live enum values and the declared global type.
// No manual branch-layout facts. This fixture is not an owning snapshot export.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/switch-default-v2099.json', import.meta.url), 'utf8'));
const options: ReconstructOptions = { outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false, generateSourceMaps: false, transformPreset: 'full', includeAddressComments: false, promoteStaticGlobals: false };
function source(fn: ExtractedFunction, tag: 'none' | 'current' | 'stale', tables = fixture.tables) {
  // Explicit unit-test seals, never used in a live proposal.
  const data = `${fixture.forms[fn.address]};ev=0000000000;bh=${fn.size}-00000000;dh=${tag === 'stale' ? '00000000' : vc8formBodyHash(fn.decompiled!)}`;
  return generateFunctionImplementation({ ...fn, tags: [...(fn.tags ?? []), ...(tag === 'none' ? [] : [{ type: 'vc8form', data }])] }, undefined, options, { funcPtrArgCasts: tables } as ImplGenContext);
}
for (const fn of fixture.functions as ExtractedFunction[]) it(`${fn.address}: full emission adds only the current measured case group`, () => {
  const before = source(fn, 'none'), after = source(fn, 'current');
  assert.equal(source(fn, 'stale'), before);
  const group = fn.address === '0065ce40' ? /case 57:\s*case 58:\s*return;/
    : fn.address === '00486b80' ? /case 3:\s*case 4:\s*case 5:\s*case 17:\s*return 0;/
      : /case 3:\s*case 4:\s*case 5:\s*return 0;/;
  assert.doesNotMatch(before, group); assert.match(after, group);
  assert.equal(after.replace(group, '').replace(/\s/g, ''), before.replace(/\s/g, ''));
});
it('refuses an unresolved enum label or missing selector type through full emission', () => {
  for (const fn of fixture.functions as ExtractedFunction[]) {
    const tables = fn.address === '0065ce40' ? { ...fixture.tables, enumValues: {} } : { ...fixture.tables, globalTypes: {} };
    assert.equal(source(fn, 'current', tables), source(fn, 'none', tables));
  }
});
it('recognizes an existing enum alias and leaves that full body unchanged', () => {
  const fn = fixture.functions.find((f: ExtractedFunction) => f.address === '0065ce40') as ExtractedFunction;
  const tables = { ...fixture.tables, enumValues: { ...fixture.tables.enumValues, UNITSTAT_hitpoints: 57 } };
  assert.equal(source(fn, 'current', tables), source(fn, 'none', tables));
});
