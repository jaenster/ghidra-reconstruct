import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { generateFunctionImplementation, getParseErrorCount } from '../codegen/impl.js';
import { withResolvedType } from '../extract/functions.js';

it('runs stride recovery in the full emitter on the live radial-burst model', () => {
  const fixture = JSON.parse(readFileSync(new URL(
    '../../../cpp-parser/src/transform/plugins/__tests__/fixtures/loop-stride-missiles.json', import.meta.url,
  ), 'utf8')).liveEmitterExample;
  const raw = fixture.fn;
  const variable = (v: { dataType: string; resolvedType?: string }) => ({
    ...v, dataType: withResolvedType(v.dataType, v.resolvedType),
  });
  const fn = { ...raw, parameters: raw.parameters.map(variable), localVariables: raw.localVariables.map(variable) };
  const code = generateFunctionImplementation(fn, undefined, fixture.options, {});
  assert.equal(getParseErrorCount(), 0);
  assert.equal((code.match(/const uint32_t nByteStride/g) ?? []).length, 2);
  assert.match(code, /nStep < 1/);
  assert.match(code, /nStep = 1/);
  assert.equal((code.match(/MakeMissile\(/g) ?? []).length, 2);
});
