import { describe, it } from 'node:test';
import assert from 'node:assert';
import { accessorShape, accessorTwins } from '../codegen/accessor-twins.js';
import type { ExtractedFunction } from '../types.js';

const ENUMS = { UNIT_COUNT: 6, Death: 0 };

describe('accessor twins', () => {
  it('reads the guard-and-return shape (GetGUID 00451f50, GetAnimMode 00451f70)', () => {
    assert.deepStrictEqual(
      accessorShape('{\n  if (pUnit == (D2UnitStrc *)0x0) {\n    return -1;\n  }\n  return pUnit->nUnitGUID;\n}', 'pUnit', ENUMS),
      { path: ['nUnitGUID'], dflt: -1n });
    assert.deepStrictEqual(
      accessorShape('{\n  if (pUnit == (D2UnitStrc *)0x0) {\n    return Death;\n  }\n  return (pUnit->eAnimMode).ePlayerMode;\n}', 'pUnit', ENUMS),
      { path: ['eAnimMode', 'ePlayerMode'], dflt: 0n });
  });

  it('reads the one-variable shape (GetType 0044be50)', () => {
    assert.deepStrictEqual(
      accessorShape('{\n  eD2UnitType eUnitType;\n  \n  eUnitType = UNIT_COUNT;\n  if (pUnit != (D2UnitStrc *)0x0) {\n    eUnitType = pUnit->eUnitType;\n  }\n  return eUnitType;\n}', 'pUnit', ENUMS),
      { path: ['eUnitType'], dflt: 6n });
  });

  it('refuses a body that does more, or reads through another pointer', () => {
    assert.strictEqual(accessorShape('{ if (pUnit == 0) { return -1; } g = 1; return pUnit->nUnitGUID; }', 'pUnit', ENUMS), undefined);
    assert.strictEqual(accessorShape('{ if (pUnit == 0) { return -1; } return pOther->nUnitGUID; }', 'pUnit', ENUMS), undefined);
    assert.strictEqual(accessorShape('{ if (pUnit == 0) { return nUnknown; } return pUnit->nUnitGUID; }', 'pUnit', ENUMS), undefined);
  });

  it('gives an inline header accessor a two-return twin of the field type, and drops a field two accessors read', () => {
    const fn = (name: string, address: string, body: string, tags = [{ type: 'inline-host' }]): ExtractedFunction => ({
      name, address, namespace: 'D2Common::Units', returnType: 'int32_t', callingConvention: '__fastcall',
      parameters: [{ name: 'pUnit', dataType: 'D2UnitStrc *', size: 4, ordinal: 0, storage: 'ECX:4' }],
      localVariables: [], decompiled: `int32_t __fastcall D2Common::Units::${name}(D2UnitStrc *pUnit)\n\n${body}\n`, tags,
    }) as unknown as ExtractedFunction;
    const guid = '{\n  if (pUnit == (D2UnitStrc *)0x0) {\n    return -1;\n  }\n  return pUnit->nUnitGUID;\n}';
    const cls = '{\n  if (pUnit == (D2UnitStrc *)0x0) {\n    return -1;\n  }\n  return pUnit->nClassId;\n}';
    const tables = { structFields: { D2UnitStrc: { nUnitGUID: 'int', nClassId: 'int' } }, enumValues: ENUMS };
    const one = accessorTwins([fn('GetGUID', '00451f50', guid), fn('Plain', '00451f90', guid, [])], tables);
    assert.strictEqual(one.length, 1);
    assert.deepStrictEqual({ ...one[0], definition: undefined }, { struct: 'D2UnitStrc', path: ['nUnitGUID'], call: 'GetGUIDInline', dflt: -1n, definition: undefined });
    assert.ok(one[0].definition.includes('static inline int GetGUIDInline(D2UnitStrc * pUnit) {'), one[0].definition);
    assert.ok(one[0].definition.includes('        return pUnit->nUnitGUID;\n    }\n    return (int)(-1);'), one[0].definition);
    const two = accessorTwins([fn('GetGUID', '00451f50', guid), fn('GetGUID2', '00451f80', guid), fn('GetClassId', '00451f60', cls)], tables);
    assert.deepStrictEqual(two.map(t => t.call), ['GetClassIdInline']);
  });
});

describe('accessor twins in the emitted unit', () => {
  it('writes the twin once, ahead of the first function whose acc tag calls it', async () => {
    const { generateProject } = await import('../codegen/index.js');
    const { vc8formBodyHash } = await import('../codegen/vc8form-spec.js');
    const unitStrc = { name: 'D2UnitStrc', kind: 'STRUCTURE', size: 16, category: '/', fields: [
      { name: 'eUnitType', dataType: 'int', offset: 0, size: 4 }, { name: 'nClassId', dataType: 'int', offset: 4, size: 4 },
      { name: 'pMemory', dataType: 'void *', offset: 8, size: 4 }, { name: 'nUnitGUID', dataType: 'int', offset: 12, size: 4 },
    ] };
    const mk = (name: string, address: string, ns: string, body: string, tags: Array<{ type: string; data?: string }> = []) => {
      const decompiled = `int __stdcall ${name}(D2UnitStrc *pUnit)\n{\n${body}\n}\n`;
      return {
        name, address, namespace: ns, returnType: 'int', callingConvention: '__stdcall', size: 0x20, isThunk: false, isExternal: false, hasVarArgs: false,
        signature: `int ${name}(D2UnitStrc * pUnit)`, parameters: [{ name: 'pUnit', dataType: 'D2UnitStrc *', size: 4, ordinal: 0, storage: 'Stack[0x4]:4' }],
        localVariables: [], decompiled,
        tags: tags.map(t => t.type === 'vc8form' ? { type: 'vc8form', data: `${t.data};ev=0000000000;bh=32-00000000;dh=${vc8formBodyHash(decompiled)}` } : t),
      } as unknown as ExtractedFunction;
    };
    const guid = mk('GetGUID', '00401000', 'Units', '  if (pUnit == (D2UnitStrc *)0x0) {\n    return -1;\n  }\n  return pUnit->nUnitGUID;', [{ type: 'inline-host' }]);
    const a = mk('StoreA', '00402000', 'Quest', '  g_a = pUnit->nUnitGUID;\n  return 0;', [{ type: 'vc8form', data: 'acc(pUnit->nUnitGUID)' }]);
    const b = mk('StoreB', '00402100', 'Quest', '  g_b = pUnit->nUnitGUID;\n  return 1;', [{ type: 'vc8form', data: 'acc(pUnit->nUnitGUID)' }]);
    const c = mk('Plain', '00402200', 'Quest', '  return pUnit->nUnitGUID;');
    const namespaces = ['Units', 'Quest'].map(n => ({ name: n, fullPath: n, functionCount: 2, isClass: false }));
    const options = { outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false, generateSourceMaps: false, transformPreset: 'quick' } as never;
    const programInfo = { name: 'T.exe', path: '/tmp/T.exe', format: 'PE', architecture: 'x86', compiler: 'msvc', imageBase: '0x400000', languageId: 'x86:LE:32:default', endianness: 'little', pointerSize: 4 } as never;
    const project = generateProject('acc', [guid, a, b, c], [], [unitStrc as never], [], namespaces as never, options, programInfo);
    const impl = [...project.files.values()].find(f => f.path.endsWith('Quest.cpp'))!.content;
    const def = 'static inline int GetGUIDInline(D2UnitStrc * pUnit) {';
    assert.strictEqual(impl.split(def).length - 1, 1, `one twin:\n${impl}`);
    assert.ok(impl.indexOf(def) < impl.indexOf('StoreA('), 'ahead of its first caller');
    assert.ok(/g_a = GetGUIDInline\(pUnit\);/.test(impl) && /g_b = GetGUIDInline\(pUnit\);/.test(impl), impl);
    assert.ok(/return pUnit->nUnitGUID;/.test(impl.slice(impl.indexOf('Plain('))), 'an untagged read stays');
  });
});
