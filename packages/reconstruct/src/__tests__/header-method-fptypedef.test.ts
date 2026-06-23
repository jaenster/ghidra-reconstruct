/**
 * Regression test: function-pointer typedefs referenced ONLY by a struct's
 * method parameters/return types must still get a forward declaration.
 *
 * Methods emitted into a struct body come from `allClasses` (a method-converted
 * struct that is not the primary `classInfo`). collectForwardDeclarations used to
 * scan only top-level function signatures, struct fields, and the primary class's
 * methods — so an `fpExecuteOnUnitFunction*` param on such a method produced
 * "'fpExecuteOnUnitFunction' has not been declared".
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateHeader } from '../codegen/header.js';
import type {
  DetectedClass,
  ExtractedFunction,
  ExtractedFunctionDefinition,
  ExtractedParameter,
  ExtractedStruct,
  ReconstructOptions,
} from '../types.js';

const defaultOptions: ReconstructOptions = {
  outputDir: '/tmp/test',
  format: 'cpp',
  organization: 'flat',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
  promoteStaticGlobals: false,
};

function makeParam(name: string, dataType: string, ordinal: number): ExtractedParameter {
  return { name, dataType, size: 4, ordinal, storage: 'register' };
}

describe('forward declarations for struct-method function-pointer params', () => {
  it('emits a guarded fp typedef for a type used only by a struct method param', () => {
    // The struct that owns the method (emitted as a class body because it has methods).
    const hostStruct: ExtractedStruct = {
      name: 'D2QuestDataStrc',
      category: '/Diablo2/SERVER/QUEST',
      size: 8,
      kind: 'STRUCTURE',
      fields: [{ name: 'pad', dataType: 'uint32_t', offset: 0, size: 4 }],
    };

    // The function-pointer type — a real FUNCTION_DEFINITION, but NOT owned by this
    // header, so it must come out as a (guarded) forward-decl typedef.
    const fpDef: ExtractedFunctionDefinition = {
      name: 'fpExecuteOnUnitFunction',
      category: '/Diablo2/SERVER/QUEST',
      kind: 'FUNCTION_DEFINITION',
      size: 4,
      returnType: 'void',
      parameters: [{ name: 'pUnit', dataType: 'struct D2UnitStrc*', ordinal: 0 }],
    };

    // Backing function whose method param uses the fp type.
    const method: ExtractedFunction = {
      name: 'QUEST_SetStateAndBroadcast',
      address: '0x00aa0000',
      signature:
        'void QUEST_SetStateAndBroadcast(D2QuestDataStrc*, byte, struct D2UnitStrc*, fpExecuteOnUnitFunction*, bool)',
      returnType: 'void',
      parameters: [
        makeParam('pThis', 'D2QuestDataStrc*', 0),
        makeParam('nState', 'byte', 1),
        makeParam('pUnit', 'struct D2UnitStrc*', 2),
        makeParam('fpFunction', 'fpExecuteOnUnitFunction*', 3),
        makeParam('bFlag', 'bool', 4),
      ],
      localVariables: [],
      callingConvention: '__thiscall',
      size: 64,
      isThunk: false,
      isExternal: false,
      hasVarArgs: false,
    };
    method.parentClass = 'D2QuestDataStrc';

    const hostClass: DetectedClass = {
      name: 'D2QuestDataStrc',
      namespace: '',
      methods: [{
        name: 'QUEST_SetStateAndBroadcast',
        address: '0x00aa0000',
        isVirtual: false,
        isStatic: false,
        isConstructor: false,
        isDestructor: false,
        visibility: 'public',
      }],
      fields: [],
      baseClasses: [],
    };

    const header = generateHeader(
      'D2QuestData',
      [],                                  // functions (top-level): none
      undefined,                           // classInfo: not the primary class
      [hostStruct, fpDef],                 // dataTypes
      [],                                  // globals
      defaultOptions,
      undefined,                           // methodConversions
      undefined,                           // extraIncludes
      new Set(['D2QuestDataStrc']),        // ownedTypes — fp type intentionally NOT owned
      undefined,                           // publicFunctions
      undefined,                           // classNames
      undefined,                           // includedTypes
      undefined,                           // headerPath
      undefined,                           // funcIncludes
      [method],                            // allFunctions
      [hostClass],                         // allClasses
    );

    // The method must have actually been emitted into the struct body.
    assert.ok(
      header.includes('fpExecuteOnUnitFunction'),
      `Method param type should appear in header:\n${header}`,
    );

    // The guarded forward-decl typedef must be present.
    assert.ok(
      header.includes('#ifndef RECON_FPTD_fpExecuteOnUnitFunction'),
      `Expected guarded fp typedef for fpExecuteOnUnitFunction:\n${header}`,
    );
    assert.ok(
      header.includes('#define RECON_FPTD_fpExecuteOnUnitFunction'),
      `Expected guard define for fpExecuteOnUnitFunction:\n${header}`,
    );
    // The typedef must declare fpExecuteOnUnitFunction as a type (real signature,
    // since the FUNCTION_DEFINITION is available in funcDefMap).
    assert.ok(
      /typedef[\s\S]*fpExecuteOnUnitFunction/.test(header),
      `Expected a typedef naming fpExecuteOnUnitFunction:\n${header}`,
    );
  });
});
