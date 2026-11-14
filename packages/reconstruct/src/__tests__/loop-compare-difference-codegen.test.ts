import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateFunctionImplementation, getParseErrorCount } from '../codegen/impl.js';
import { withResolvedType } from '../extract/functions.js';
import type { ExtractedFunction } from '../types.js';

const fixture = JSON.parse(readFileSync(new URL('../../../cpp-parser/src/transform/plugins/__tests__/fixtures/loop-compare-difference.json', import.meta.url), 'utf8'));

describe('loop comparison difference through full function codegen', () => {
  // The DTOs and decompiles are live MCP captures with matching published dh.
  // compareSites has one MANUAL native-attested length comparison row per
  // function. This test does not claim owning markup extraction/regeneration.
  for (const row of fixture.emitter) it('emits the measured candidate for ' + row.address, () => {
    const raw = row.raw;
    const model: ExtractedFunction = {
      ...raw, decompiled: row.model.decompiled, compareSites: row.model.compareSites,
      parameters: raw.parameters.map((p: { dataType: string; resolvedType?: string }) => ({ ...p, dataType: withResolvedType(p.dataType, p.resolvedType) })),
      localVariables: raw.localVariables.map((v: { dataType: string; resolvedType?: string }) => ({ ...v, dataType: withResolvedType(v.dataType, v.resolvedType) })),
    };
    const before = getParseErrorCount();
    const code = generateFunctionImplementation(model, undefined, fixture.options, {});
    assert.equal(getParseErrorCount(), before);
    assert.equal(code, row.candidate);
    assert.ok(code.includes('nComparison = nUpper1 - nUpper2;'), code);
    assert.ok(code.includes('(nComparison > 0)'), code);
  });
});
