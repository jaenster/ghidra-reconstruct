import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseVc8Form } from '@ghidra-mcp/cpp-parser';

import { generateProject } from '../codegen/index.js';
import { vc8formBodyHash, vc8FormSpec } from '../codegen/vc8form-spec.js';
import type { ExtractedDataType, ExtractedFunction, ExtractedStruct, ProgramInfo, ReconstructOptions } from '../types.js';

const decompiled = `
/* WARNING: Enum "eCollisionFlags": Some values do not have unique names */
/* WARNING: Enum "eD2TimerType": Some values do not have unique names */
/* WARNING: Enum "eD2TimerTypeDWORD": Some values do not have unique names */
/* Diablo 2 1.14d reverse team
   https://blizzhackers.dev

   @Date: 2022.08.23
   @Author: jaenster
   @Function: GetField0x38OfMonsterData_AiRelated2
   @Address: Game.0x0058f000
   @description:  */

D2MapAIStrc ** D2Game::Ai::AiGeneral::GetMonsterMapAi(D2UnitStrc *pMonster)

{
  if (((pMonster != (D2UnitStrc *)0x0) && (pMonster->eUnitType == UNIT_MONSTER)) &&
     ((pMonster->pUnitData).pUnitDataMonster != (D2UnitDataMonsterStrc *)0x0)) {
    return &((pMonster->pUnitData).pUnitDataMonster)->pAiGeneral->pMapAi;
  }
  return (D2MapAIStrc **)0x38;
}`;

const target: ExtractedFunction = {
  name: 'GetMonsterMapAi', address: '0x0058f000',
  signature: 'D2MapAIStrc * * GetMonsterMapAi(D2UnitStrc * pMonster)', returnType: 'D2MapAIStrc * *',
  parameters: [{ name: 'pMonster', dataType: 'D2UnitStrc *', size: 4, ordinal: 0, storage: 'Stack[0x4]:4' }],
  localVariables: [], callingConvention: '__stdcall', size: 43, isThunk: false, isExternal: false,
  hasVarArgs: false, namespace: 'D2Game::Ai::AiGeneral', decompiled, tags: [], calledFunctions: [],
};

const programInfo: ProgramInfo = {
  name: 'Game.exe', path: '/Redivivus/Game.exe', format: 'PE', architecture: 'x86',
  compiler: 'msvc', imageBase: '0x400000', languageId: 'x86:LE:32:default',
  endianness: 'little', pointerSize: 4,
};

const dataTypes: ExtractedDataType[] = [
  { kind: 'STRUCTURE', name: 'D2AiGeneralStrc', category: '/Diablo2/UNIT/Union_0x14/MONSTER', size: 64,
    fields: [{ name: 'pMapAi', dataType: 'D2MapAIStrc *32', offset: 56, size: 4 }] } as ExtractedDataType,
  { kind: 'STRUCTURE', name: 'D2UnitDataMonsterStrc', category: '/Diablo2/UNIT/Union_0x14/MONSTER', size: 96,
    fields: [{ name: 'pAiGeneral', dataType: 'D2AiGeneralStrc *', offset: 40, size: 4 }] } as ExtractedDataType,
  { kind: 'UNION', name: 'D2UnitDataUnion', category: '/', size: 4,
    fields: [{ name: 'pUnitDataMonster', dataType: 'D2UnitDataMonsterStrc *', offset: 0, size: 4 }] } as ExtractedDataType,
  { kind: 'STRUCTURE', name: 'D2UnitStrc', category: '/', size: 244,
    fields: [{ name: 'eUnitType', dataType: 'eD2UnitType', offset: 0, size: 4 },
      { name: 'pUnitData', dataType: 'D2UnitDataUnion', offset: 20, size: 4 }] } as ExtractedDataType,
];

function emitted(overrides?: object[], func: ExtractedFunction = target, types: ExtractedDataType[] = dataTypes,
  info: ProgramInfo = programInfo): string {
  const options: ReconstructOptions = {
    outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false,
    generateSourceMaps: false, transformPreset: 'full', includeAddressComments: false,
    promoteStaticGlobals: false,
    projectConfig: {
      version: 1, project: 'cache250-mapai',
      modules: { D2Game: { namespaces: ['D2Game'] } },
      moduleRuns: [{ module: 'D2Game', start: '00580000', end: '00590000' }],
      overrides,
    } as never,
  };
  const project = generateProject('cache250-mapai', structuredClone([func]), [], structuredClone(types), [], [], options, info);
  return [...project.files.values()].filter(f => f.type === 'implementation').map(f => f.content).join('\n');
}

describe('Redivivus 0058f000 nullfield form', () => {
  it('probes guarded nullfield form against the live positive branch', () => {
    const form = 'nullfield(pMonster->pUnitData.pUnitDataMonster->pAiGeneral,D2AiGeneralStrc,pMapAi)';
    const func = { ...target, branchLayout: {
      lineCount: 22,
      lines: [[19, [22, 25, 28, 29]], [21, [32, 34, 39, 40]]] as [number, number[]][],
      ifs: [[17, 20]] as [number, number][],
    } } as ExtractedFunction;
    assert.equal(vc8formBodyHash(decompiled), '481af176');
    const tag = { type: 'vc8form', data: `${form};ev=0000000000;bh=43-56c90b2e;dh=481af176` };
    assert.equal(parseVc8Form('nullfield(E,T)'), undefined);
    assert.equal(parseVc8Form('nullfield(E,T,F,@x)'), undefined);
    assert.deepEqual(vc8FormSpec({ ...func, tags: [
      { type: 'vc8form', data: 'acc(pMonster);ev=0000000000;bh=43-56c90b2e;dh=481af176' }, tag,
    ] })?.forms.map(x => x.form.op), ['nullfield', 'acc']);
    const absent = emitted(undefined, func);
    const current = emitted(undefined, { ...func, tags: [tag] });
    const stale = emitted(undefined, { ...func, tags: [{ ...tag, data: tag.data.replace(/dh=[0-9a-f]{8}/, 'dh=ffffffff') }] });
    assert.equal(stale, absent);
    assert.notEqual(current, absent);
    assert.match(absent, /if \(pMonster && pMonster->eUnitType == UNIT_MONSTER && pMonster->pUnitData\.pUnitDataMonster\)/);
    assert.match(absent, /return &pMonster->pUnitData\.pUnitDataMonster->pAiGeneral->pMapAi/);
    assert.match(current, /offsetof\(D2AiGeneralStrc, pMapAi\)/);
    assert.doesNotMatch(current, /return \(D2MapAIStrc\*\*\)0x38/);
    assert.ok(current.includes('    return (D2MapAIStrc**)((uint32_t)(pMonster && pMonster->eUnitType == UNIT_MONSTER && pMonster->pUnitData.pUnitDataMonster ? pMonster->pUnitData.pUnitDataMonster->pAiGeneral : 0) + offsetof(D2AiGeneralStrc, pMapAi));'));

    const changed = (oldText: string, newText: string) => {
      const next = decompiled.replace(oldText, newText);
      assert.notEqual(next, decompiled);
      return { ...func, decompiled: next,
        tags: [{ ...tag, data: tag.data.replace(/dh=[0-9a-f]{8}/, `dh=${vc8formBodyHash(next)}`) }] } as ExtractedFunction;
    };
    const wrongOffset = structuredClone(dataTypes);
    ((wrongOffset[0] as ExtractedStruct).fields[0]).offset = 60;
    assert.doesNotMatch(emitted(undefined, { ...func, tags: [tag] }, wrongOffset), /offsetof\(D2AiGeneralStrc, pMapAi\)/);
    const wrongType = structuredClone(dataTypes);
    ((wrongType[0] as ExtractedStruct).fields[0]).dataType = 'D2UnitStrc *';
    assert.doesNotMatch(emitted(undefined, { ...func, tags: [tag] }, wrongType), /offsetof\(D2AiGeneralStrc, pMapAi\)/);
    const wrongBase = structuredClone(dataTypes);
    ((wrongBase[1] as ExtractedStruct).fields[0]).dataType = 'D2UnitStrc *';
    assert.doesNotMatch(emitted(undefined, { ...func, tags: [tag] }, wrongBase), /offsetof\(D2AiGeneralStrc, pMapAi\)/);
    assert.doesNotMatch(emitted(undefined, { ...func, tags: [tag] }, dataTypes,
      { ...programInfo, pointerSize: 8 }), /offsetof\(D2AiGeneralStrc, pMapAi\)/);
    assert.doesNotMatch(emitted(undefined, changed('0x38;', '0x3c;')), /offsetof\(D2AiGeneralStrc, pMapAi\)/);
    assert.doesNotMatch(emitted(undefined, changed('(D2MapAIStrc **)0x38;', 'gpFallback;')), /offsetof\(D2AiGeneralStrc, pMapAi\)/);
    assert.doesNotMatch(emitted(undefined, changed('pMonster != (D2UnitStrc *)0x0', 'Touch() && pMonster != (D2UnitStrc *)0x0')), /offsetof\(D2AiGeneralStrc, pMapAi\)/);
  });
});
