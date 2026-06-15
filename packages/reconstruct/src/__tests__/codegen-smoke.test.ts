/**
 * Offline codegen smoke test.
 *
 * Drives the real `generateProject(...)` over a small but representative
 * in-memory dataset and asserts it produces files without throwing. The whole
 * point is fast feedback: codegen used to only be exercised by a ~34-minute
 * live regen, so crashes (e.g. a STRUCTURE arriving with `fields: undefined`)
 * surfaced slowly and blindly. This test deliberately includes those edge
 * cases so the crash classes are caught in `npm test` in seconds.
 *
 * `generateProject` runs buildBitfieldCatalog AND computeTypeOwnership over the
 * `dataTypes` array internally, so a struct with undefined/empty/bitfield
 * fields here drives both historically-crashing paths.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateProject } from '../codegen/index.js';
import type {
  ExtractedFunction,
  ExtractedDataType,
  ExtractedStruct,
  AnalyzedDataSymbol,
  DetectedClass,
  ExtractedNamespace,
  ProgramInfo,
  ReconstructOptions,
} from '../types.js';

const options: ReconstructOptions = {
  outputDir: './out',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'quick',
  includeAddressComments: false,
  promoteStaticGlobals: false,
};

const programInfo: ProgramInfo = {
  name: 'Smoke.exe',
  path: '/tmp/Smoke.exe',
  format: 'PE',
  architecture: 'x86',
  compiler: 'msvc',
  imageBase: '0x400000',
  languageId: 'x86:LE:32:default',
  endianness: 'little',
  pointerSize: 4,
};

function func(
  name: string,
  address: string,
  returnType: string,
  body: string,
  ns?: string
): ExtractedFunction {
  return {
    name,
    address,
    signature: `${returnType} ${name}(void)`,
    returnType,
    parameters: [],
    localVariables: [],
    callingConvention: '__cdecl',
    size: 0x20,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    namespace: ns,
    decompiled: body,
    calledFunctions: [],
  };
}

describe('codegen smoke', () => {
  it('generates a project from a representative dataset without throwing', () => {
    const dataTypes: ExtractedDataType[] = [
      // 1. STRUCTURE with `fields` undefined — the exact shape that crashed
      //    buildBitfieldCatalog + computeTypeOwnership. Cast through `as any`.
      {
        kind: 'STRUCTURE',
        name: 'D2BrokenStrc',
        category: '/D2Common',
        size: 4,
        fields: undefined,
      } as any,

      // 2. Empty struct.
      {
        kind: 'STRUCTURE',
        name: 'D2EmptyStrc',
        category: '/D2Common',
        size: 0,
        fields: [],
      } as ExtractedStruct,

      // 3. Struct with a byte[20] array field and a pointer field.
      {
        kind: 'STRUCTURE',
        name: 'D2NameStrc',
        category: '/D2Common',
        size: 24,
        fields: [
          { name: 'szName', dataType: 'byte[20]', offset: 0, size: 20 },
          { name: 'pNext', dataType: 'D2NameStrc *', offset: 20, size: 4 },
        ],
      } as ExtractedStruct,

      // 4. Struct with single-bit bitfield members sharing a byte.
      {
        kind: 'STRUCTURE',
        name: 'D2FlagsStrc',
        category: '/D2Common',
        size: 4,
        fields: [
          { name: 'isActive', dataType: 'byte:1', offset: 0, size: 1 },
          { name: 'isDirty', dataType: 'byte:1', offset: 0, size: 1 },
        ],
      } as ExtractedStruct,

      // 5. An enum.
      {
        kind: 'ENUM',
        name: 'D2Color',
        category: '/D2Common',
        size: 4,
        values: [
          { name: 'COLOR_RED', value: 0 },
          { name: 'COLOR_BLUE', value: 1 },
        ],
      } as ExtractedDataType,

      // 6. ENUM with `values` undefined — shallow-mapped enum whose detail fetch
      //    was skipped (same class as the struct-fields crash).
      {
        kind: 'ENUM',
        name: 'D2BrokenEnum',
        category: '/D2Common',
        size: 4,
        values: undefined,
      } as any,

      // 7. FUNCTION_DEFINITION (fn-ptr typedef) with `parameters` undefined —
      //    the shape that crashed generateFunctionDefinitionDeclaration.
      {
        kind: 'FUNCTION_DEFINITION',
        name: 'D2CallbackFn',
        category: '/D2Common',
        size: 4,
        returnType: 'int',
        parameters: undefined,
      } as any,
    ];

    const functions: ExtractedFunction[] = [
      func('D2_Init', '0x401000', 'void', 'void D2_Init(void)\n{\n  return;\n}\n', 'D2Common'),
      func(
        'D2_GetName',
        '0x401100',
        'D2NameStrc *',
        'D2NameStrc * D2_GetName(void)\n{\n  return (D2NameStrc *)0x0;\n}\n',
        'D2Common'
      ),
    ];

    const classes: DetectedClass[] = [];
    const globals: AnalyzedDataSymbol[] = [];
    const namespaces: ExtractedNamespace[] = [
      { name: 'D2Common', fullPath: 'D2Common', functionCount: functions.length, isClass: false },
    ];

    let project!: ReturnType<typeof generateProject>;
    assert.doesNotThrow(() => {
      project = generateProject(
        'smoke',
        functions,
        classes,
        dataTypes,
        globals,
        namespaces,
        options,
        programInfo
      );
    });

    // Produced a non-empty file set.
    assert.ok(project.files.size > 0, 'expected at least one generated file');

    // The undefined-fields struct was normalized in place to a real array.
    const broken = project.dataTypes.find(d => d.name === 'D2BrokenStrc') as ExtractedStruct;
    assert.ok(Array.isArray(broken.fields), 'D2BrokenStrc.fields must be normalized to an array');

    // A header somewhere mentions a struct name we fed in (output is real).
    const allHeaders = [...project.files.values()]
      .filter(f => f.type === 'header')
      .map(f => f.content)
      .join('\n');
    assert.match(allHeaders, /D2NameStrc/, 'expected D2NameStrc to appear in a generated header');
  });
});
