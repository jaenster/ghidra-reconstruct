/**
 * Full-codegen smoke for the second state-color branch of the real Windows
 * 1.14d AITHINK_Fn1_ClawViperEx decompile (005f1de0). The body lines below
 * are the contiguous Ghidra excerpt at its 005f1fff-005f2017 native site;
 * the function wrapper and declarations retain the extracted types. The
 * branch and PUSH facts are the corresponding native offsets, relative to
 * the function entry. This exercises plugin registration/order through
 * generateProject, beyond the switch-chain plugin's isolated tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateProject } from '../codegen/index.js';
import type {
  ExtractedEnum, ExtractedFunction, ExtractedNamespace, ProgramInfo, ReconstructOptions,
} from '../types.js';

const options: ReconstructOptions = {
  outputDir: './out', format: 'cpp', organization: 'namespace',
  generateCMake: false, generateSourceMaps: false, transformPreset: 'full',
  includeAddressComments: false, promoteStaticGlobals: false,
};

const programInfo: ProgramInfo = {
  name: 'Game.exe', path: '/tmp/Game.exe', format: 'PE',
  architecture: 'x86', compiler: 'msvc', imageBase: '0x400000',
  languageId: 'x86:LE:32:default', endianness: 'little', pointerSize: 4,
};

const decompileLines = [
  'void __fastcall',
  'D2Game::Monster::AI::AITHINK_Fn1_ClawViperEx',
  '          (SGAMEDATA *pGame,D2UnitStrc *pUnit,D2AiParamStrc *pAiParam)',
  '',
  '{',
  '  eD2States eStateColor;',
  '  short nStateType;',
  '  D2MonStatsTxt *pMonStats;',
  '  pMonStats = pAiParam->pMonStats;',
  '  nStateType = pMonStats->aip[5][pGame->nDifficulty];',
  '  if (nStateType != 0) {',
  '    if (nStateType == 2) {',
  '      eStateColor = STATE_red;',
  '    }',
  '    else {',
  '      eStateColor = STATE_blue;',
  '    }',
  '    D2Common::DATATBLS::ItemStats::SetState(pUnit,eStateColor,1);',
  '  }',
  '}',
];
const decompiled = decompileLines.join('\n');
const line = (needle: string) => decompileLines.findIndex(s => s.includes(needle)) + 1;
const outer = line('if (nStateType != 0)');
const inner = line('if (nStateType == 2)');
const red = line('eStateColor = STATE_red');
const blue = line('eStateColor = STATE_blue');
const call = line('ItemStats::SetState');

const functionFixture: ExtractedFunction = {
  name: 'AITHINK_Fn1_ClawViperEx', address: '0x005f1de0',
  signature: 'void AITHINK_Fn1_ClawViperEx(SGAMEDATA * pGame, D2UnitStrc * pUnit, D2AiParamStrc * pAiParam)',
  returnType: 'void',
  parameters: [
    { name: 'pGame', dataType: 'SGAMEDATA *', size: 4, ordinal: 0, storage: 'ECX:4' },
    { name: 'pUnit', dataType: 'D2UnitStrc *', size: 4, ordinal: 1, storage: 'EDX:4' },
    { name: 'pAiParam', dataType: 'D2AiParamStrc *', size: 4, ordinal: 2, storage: 'Stack[0x4]:4' },
  ],
  localVariables: [
    { name: 'eStateColor', dataType: 'undefined4', size: 4, storage: 'HASH:3fd27953b0:4' },
    { name: 'nStateType', dataType: 'undefined2', size: 2, storage: 'HASH:5f47edcbda:2' },
    { name: 'pMonStats', dataType: 'undefined4', size: 4, storage: 'HASH:5f6de4599c:4' },
  ],
  callingConvention: '__fastcall', size: 0x300, isThunk: false,
  isExternal: false, hasVarArgs: false, namespace: 'D2Game::Monster::AI',
  calledFunctions: ['D2Common::DATATBLS::ItemStats::SetState'], decompiled,
  branchLayout: {
    lineCount: decompileLines.length,
    lines: [[outer, [0x224]], [inner, [0x229]], [red, [0x234]], [blue, [0x230]], [call, [0x236]]],
    ifs: [[outer, 0x227], [inner, 0x22e]],
    tests: [
      [outer, { op: '!=', mnemonic: 'SUB', reg: 'EAX', delta: 0, k: 0, size: 4, at: 0x224 }],
      [inner, { op: '==', mnemonic: 'SUB', reg: 'EAX', delta: 2, k: 2, size: 4, at: 0x229 }],
    ],
    pushes: [
      { at: 0x230, value: 0x5a, reach: 0x236, jumps: true, run: 1 },
      { at: 0x234, value: 0x5b, reach: 0x236, jumps: false, run: 1 },
    ],
  },
};

const states: ExtractedEnum = {
  name: 'eD2States', category: '/Diablo2/UNIT', kind: 'ENUM', size: 4,
  values: [{ name: 'STATE_blue', value: 90 }, { name: 'STATE_red', value: 91 }],
};
const namespaces: ExtractedNamespace[] = [
  { name: 'D2Game::Monster::AI', fullPath: 'D2Game::Monster::AI', functionCount: 1, isClass: false },
];

describe('Claw Viper arm-call full codegen', () => {
  it('spells the native subtraction run as a switch with color calls in both arms', () => {
    const project = generateProject(
      'claw-viper', [functionFixture], [], [states], [], namespaces, options, programInfo,
    );
    const body = [...project.files.values()]
      .filter(file => file.type === 'implementation')
      .map(file => file.content).join('\n');
    assert.match(body, /switch \(nStateType\)/);
    assert.match(body, /case 2:[\s\S]*SetState\(pUnit, STATE_red, 1\)/);
    assert.match(body, /default:[\s\S]*SetState\(pUnit, STATE_blue, 1\)/);
    assert.match(body, /case 0:/);
    assert.equal(body.match(/SetState\(pUnit, STATE_(?:red|blue), 1\)/g)?.length, 2);
    assert.doesNotMatch(body, /eStateColor/);
  });
});
