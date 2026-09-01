/**
 * Regression test: a typedef whose target is `<FunctionDefinition> *` must be
 * emitted as a self-contained function-pointer typedef.
 *
 * Ghidra models e.g. QUESTCALLBACKFN as a typedef to `QUESTCALLBACK *`, where
 * QUESTCALLBACK is a function-signature datatype with no standalone C definition.
 * Emitting `typedef QUESTCALLBACK * QUESTCALLBACKFN;` leaves QUESTCALLBACK
 * undefined, which breaks QUESTCALLBACKFN and cascades into every TU that
 * includes the struct using it (D2QuestDataStrc.fpQuestStateHandler[15]).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateHeader, setKnownFuncDefs } from '../codegen/header.js';
import type {
  ExtractedFunctionDefinition,
  ExtractedTypedef,
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

describe('typedef targeting a FunctionDefinition pointer', () => {
  it('inlines the funcdef signature into a self-contained fp typedef', () => {
    const questCallback: ExtractedFunctionDefinition = {
      name: 'QUESTCALLBACK',
      category: '/Diablo2/SERVER/QUEST/CALLBACK',
      kind: 'FUNCTION_DEFINITION',
      size: 4,
      returnType: 'void',
      parameters: [
        { name: 'pQuestData', dataType: 'D2QuestDataStrc *', ordinal: 0 },
        { name: 'pQuestArgs', dataType: 'D2QuestArgStrc *', ordinal: 1 },
      ],
    };

    const questCallbackFn: ExtractedTypedef = {
      name: 'QUESTCALLBACKFN',
      category: '/Diablo2/SERVER/QUEST',
      kind: 'TYPEDEF',
      size: 4,
      underlyingType: 'QUESTCALLBACK *',
    };

    // Mirror generateProject's registration step.
    setKnownFuncDefs([questCallback]);

    const header = generateHeader(
      'A1Q4',
      [],                                       // functions
      undefined,                                // classInfo
      [questCallbackFn],                        // dataTypes — only the typedef is owned/emitted here
      [],                                       // globals
      defaultOptions,
      undefined, undefined,
      new Set(['QUESTCALLBACKFN']),             // ownedTypes
    );

    assert.ok(
      header.includes('typedef void (*QUESTCALLBACKFN)(D2QuestDataStrc * pQuestData, D2QuestArgStrc * pQuestArgs);'),
      `Expected inlined fp typedef for QUESTCALLBACKFN:\n${header}`,
    );
    assert.ok(
      !/typedef\s+QUESTCALLBACK\s*\*\s*QUESTCALLBACKFN/.test(header),
      `Must not emit the dangling pointer-to-funcdef typedef:\n${header}`,
    );
  });

  it('inlines a STRUCT FIELD typed `<FuncDef> *` as a function pointer', () => {
    const fnCloseGame: ExtractedFunctionDefinition = {
      name: 'fnCloseGame',
      category: '/Diablo2',
      kind: 'FUNCTION_DEFINITION',
      size: 4,
      returnType: 'void',
      parameters: [
        { name: 'nSpawnedPlayers', dataType: 'int', ordinal: 0 },
        { name: 'nGameFrameDiv', dataType: 'int', ordinal: 1 },
      ],
    };
    const callbackTable: ExtractedStruct = {
      name: 'D2BattleNetEventCallbackTable',
      category: '/',
      kind: 'STRUCTURE',
      size: 4,
      fields: [
        // Ghidra delivers a pointer-to-funcdef as `<name> *32` (32-bit pointer).
        { name: 'fpCloseGame', dataType: 'fnCloseGame *32', offset: 0, size: 4 },
      ],
    } as ExtractedStruct;

    setKnownFuncDefs([fnCloseGame]);

    const header = generateHeader(
      'Net', [], undefined,
      [callbackTable],
      [], defaultOptions, undefined, undefined,
      new Set(['D2BattleNetEventCallbackTable']),
    );

    assert.ok(
      /void\s*\(\*fpCloseGame\)\(int, int\);/.test(header),
      `Expected inline fn-ptr field, not void*:\n${header}`,
    );
    assert.ok(
      !/void\s*\*\s*fpCloseGame/.test(header),
      `Must not fall back to void* for a funcdef-pointer field:\n${header}`,
    );
  });
});
