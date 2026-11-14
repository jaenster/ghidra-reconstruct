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

it('passes the existing field type context to the stride escape proof', () => {
  const fixture = JSON.parse(readFileSync(new URL(
    '../../../cpp-parser/src/transform/plugins/__tests__/fixtures/loop-stride-missiles.json', import.meta.url,
  ), 'utf8')).liveEmitterExample;
  const fn = { ...fixture.fn, name: 'f', address: '00401000', namespace: '', returnType: 'void',
    signature: 'void f(int step, Limits * p)', callingConvention: '__cdecl',
    decompiled: `void f(int step, Limits *p) { int copy = step + p->limit;
      int offset = 0; do { visit(offset); offset += step * 4; } while (offset < 256); }`,
    parameters: [{ name: 'step', dataType: 'int', ordinal: 0 }, { name: 'p', dataType: 'Limits *', ordinal: 1 }],
    localVariables: [{ name: 'copy', dataType: 'int' }, { name: 'offset', dataType: 'int' }],
  };
  const emit = (type?: string) => generateFunctionImplementation(fn, undefined, fixture.options,
    type ? { funcPtrArgCasts: { paramFuncdefs: {}, funcdefSignatures: {}, functionSignatures: {},
      variableNames: [], voidPointerFunctions: [], rootQualifiedTypedefs: [],
      structFields: { Limits: { limit: type } } } } : {});
  assert.doesNotMatch(emit(), /nByteStride/);
  assert.doesNotMatch(emit('StepRef'), /nByteStride/);
  assert.match(emit('int'), /nByteStride/);
  assert.equal(getParseErrorCount(), 0);
});
