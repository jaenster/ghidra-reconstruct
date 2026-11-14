import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { generateFunctionImplementation, getParseErrorCount } from '../codegen/impl.js';
import { withResolvedType } from '../extract/functions.js';
import { vc8formBodyHash } from '../codegen/vc8form-spec.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/unicode-postdec-live.json', import.meta.url), 'utf8'));
const variable = (v: { dataType: string; resolvedType?: string }) => ({ ...v, dataType: withResolvedType(v.dataType, v.resolvedType) });
const model = { ...fixture.raw, decompiled: fixture.fn.decompiled,
  parameters: fixture.raw.parameters.map(variable), localVariables: fixture.raw.localVariables.map(variable) };
function source(tag?: string, size = model.size) {
  return generateFunctionImplementation({ ...model, size, tags: [...(model.tags ?? []), ...(tag ? [{ type: 'vc8form', data: tag }] : [])] }, undefined, fixture.options, {});
}

it('applies the native-measured postdec form through full function codegen', () => {
  assert.equal(vc8formBodyHash(model.decompiled), '33cca0d0');
  assert.equal(createHash('sha256').update(fixture.evidence.row).digest('hex').slice(0, 10), fixture.evidence.ev);
  const before = getParseErrorCount();
  assert.equal(source(), fixture.rows[0].baseline);
  assert.equal(source(fixture.tag), fixture.rows[0].candidate);
  assert.equal(getParseErrorCount(), before);
});

it('leaves a stale decompile or size unchanged', () => {
  assert.equal(source(fixture.tag.replace('dh=33cca0d0', 'dh=00000000')), source());
  assert.equal(source(fixture.tag, model.size + 1), source(undefined, model.size + 1));
});
