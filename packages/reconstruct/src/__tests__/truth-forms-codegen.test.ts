import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateFunctionImplementation } from '../codegen/impl.js';
import { vc8formBodyHash } from '../codegen/vc8form-spec.js';
import type { ExtractedFunction, ReconstructOptions } from '../types.js';

// Two live v2102 uses, with their existing seals and resolved MCP locals.
// The expected bodies were emitted by current main c2a with the same facts.
// This bounded fixture does not establish compatibility for every live tag.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/truth-forms-v2102.json', import.meta.url), 'utf8'));
const options = fixture.options as ReconstructOptions;
for (const row of fixture.rows) it(`${row.fn.address}: retains the active truth form through full generation`, () => {
  const fn = row.fn as ExtractedFunction;
  assert.equal(vc8formBodyHash(fn.decompiled!), row.dh);
  const after = generateFunctionImplementation(fn, undefined, options, { funcPtrArgCasts: fixture.tables });
  assert.equal(after, row.expected);
  const untagged = generateFunctionImplementation({ ...fn, tags: [] }, undefined, options, { funcPtrArgCasts: fixture.tables });
  assert.notEqual(after, untagged, 'the existing sealed form must actually apply');
});
it('refuses the full logical form when the global operand types are unknown', () => {
  const fn = fixture.rows.find((r: { fn: ExtractedFunction }) => r.fn.address === '00497480').fn as ExtractedFunction;
  const tagged = generateFunctionImplementation(fn, undefined, options);
  const untagged = generateFunctionImplementation({ ...fn, tags: [] }, undefined, options);
  assert.equal(tagged, untagged);
});
