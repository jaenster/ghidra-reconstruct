import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateFunctionImplementation } from '../codegen/impl.js';
import type { ExtractedFunction, ReconstructOptions } from '../types.js';

// Actual v2109 MCP function/field/global DTOs with local diagnostic tag seals.
// This bounded context does not reproduce the owning snapshot's native control.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/bound-first-clamp-v2109.json', import.meta.url), 'utf8'));
const fn = fixture.fn as ExtractedFunction, options = fixture.options as ReconstructOptions;
const context = (tables = fixture.tables) => ({ targetPointerSize: 4, targetLanguageId: 'x86:LE:32:default', funcPtrArgCasts: tables });

it('005aef70: retains the untagged production body', () => {
  assert.equal(generateFunctionImplementation(fn, undefined, options, context()), fixture.baseline);
});

it('005aef70: normalizes the integer zero threshold and applies both opted-in forms', () => {
  const after = generateFunctionImplementation({ ...fn, tags: [...(fn.tags ?? []), ...fixture.tags] }, undefined, options, context());
  assert.equal(after, fixture.candidate);
  assert.match(after, /pMissilesTxt->Param1 < 1 \? 1 : pMissilesTxt->Param1/);
});

it('005aef70: refuses unproved or volatile field types through the same production path', () => {
  for (const type of ['uint32_t', 'long long', 'float', 'volatile int']) {
    const tables = { ...fixture.tables, structFields: { ...fixture.tables.structFields,
      D2MissilesTxt: { ...fixture.tables.structFields.D2MissilesTxt, Param1: type } } };
    const before = generateFunctionImplementation(fn, undefined, options, context(tables));
    const after = generateFunctionImplementation({ ...fn, tags: [...(fn.tags ?? []), ...fixture.tags] }, undefined, options, context(tables));
    assert.equal(after, before, type);
  }
});
