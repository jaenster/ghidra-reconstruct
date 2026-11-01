import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildWriteEffects } from './write-effects-table.js';
import type { ExtractedFunction, ExtractedGlobal } from '../types.js';

const fn = (name: string, address: string, body: string): ExtractedFunction => ({
  name, address, signature: `void ${name}(void)`, returnType: 'void', parameters: [], localVariables: [],
  callingConvention: '__cdecl', size: 1, isThunk: false, isExternal: false, hasVarArgs: false,
  decompiled: `\nvoid ${name}(void)\n\n{\n${body}\n}\n`,
} as unknown as ExtractedFunction);

const global = (name: string, extra: Partial<ExtractedGlobal> = {}): ExtractedGlobal => ({
  name, address: '00841da0', dataType: 'pfnCallback *', size: 4, isInitialized: true,
  referencingFunctions: ['Init', 'Use'], ...extra,
} as ExtractedGlobal);

describe('buildWriteEffects through a global function pointer', () => {
  const functions = [
    fn('CbA', '00401000', '  return;'),
    fn('CbB', '00401010', '  gnCount = 1;'),
    fn('Init', '00401020', '  gpfnCallback = CbA;\n  gpfnCallback = CbB;'),
    fn('Use', '00401030', '  (*gpfnCallback)();'),
  ];
  const types = { gpfnCallback: 'pfnCallback *', gnCount: 'int' };

  it('resolves to the functions stored into it, its null initial value aside', () => {
    const fx = buildWriteEffects(functions, types, undefined, { globals: [global('gpfnCallback'), global('gnCount', { address: '00841da4', dataType: 'int' })] });
    assert.deepStrictEqual(fx.Use.globals, ['gnCount']);
    assert.ok(!fx.Use.unknown);
  });

  it('adds the function its initial value points at', () => {
    const more = [...functions, fn('CbC', '00401040', '  gnOther = 2;')];
    const fx = buildWriteEffects(more, { ...types, gnOther: 'int' }, undefined, { globals: [global('gpfnCallback', { value: '00401040' })] });
    assert.deepStrictEqual(fx.Use.globals, ['gnCount', 'gnOther']);
  });

  it('is unknown when a datum holds its address, a referencing body does not parse, or no globals are given', () => {
    const table = { ...global('gaTable', { address: '00841e00', dataType: 'void *[1]' }), initializedData: { kind: 'array' as const, elements: [{ kind: 'pointer' as const, value: 'gpfnCallback' }] } };
    assert.ok(buildWriteEffects(functions, types, undefined, { globals: [global('gpfnCallback'), table] }).Use.unknown);
    assert.ok(buildWriteEffects(functions, types, undefined, { globals: [global('gpfnCallback', { referencingFunctions: ['Init', 'Use', 'Lost'] })] }).Use.unknown);
    assert.ok(buildWriteEffects(functions, types, undefined, { globals: [global('gpfnCallback', { value: '00409999' })] }).Use.unknown);
    assert.ok(buildWriteEffects(functions, types).Use.unknown);
  });
});
