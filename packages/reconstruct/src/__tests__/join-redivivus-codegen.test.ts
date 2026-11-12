/**
 * Redivivus Windows 1.14d functions decompiled at these addresses. Their
 * declaration-then-assignment shape is intentional: a parser-only probe over
 * reconstructed source with initialized declarations misses this input path.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateProject } from '../codegen/index.js';
import { vc8formBodyHash } from '../codegen/vc8form-spec.js';
import type { ExtractedFunction, ExtractedNamespace, ProgramInfo, ReconstructOptions } from '../types.js';

const options: ReconstructOptions = {
  outputDir: './out', format: 'cpp', organization: 'namespace',
  generateCMake: false, generateSourceMaps: false, transformPreset: 'full',
  includeAddressComments: false, promoteStaticGlobals: false,
};
const programInfo: ProgramInfo = {
  name: 'Game.exe', path: '/Redivivus/Game.exe', format: 'PE',
  architecture: 'x86', compiler: 'msvc', imageBase: '0x400000',
  languageId: 'x86:LE:32:default', endianness: 'little', pointerSize: 4,
};

type Case = {
  address: string; name: string; namespace: string; size: number;
  returnType: string; callingConvention: string;
  parameters: Array<[string, string]>; locals: Array<[string, string, string]>;
  form: string; decompiled: string;
};

const cases: Case[] = [
  {
    address: '00588c50', name: 'Q32_GetRemainingPrisonersCount',
    namespace: 'D2Game::Quests::QUESTS::A5Q2', size: 67,
    returnType: 'int32_t', callingConvention: '__fastcall',
    parameters: [['pQuestData', 'D2QuestDataStrc *']],
    locals: [
      ['nCount', 'int', 'EAX:4'],
      ['nRemainingTotal', 'int32_t', 'EAX:4'],
      ['pSpecificData', 'D2QuestDataA5Q2Strc *', 'HASH:5fb275c4fd:4'],
    ],
    form: 'join(nRemainingTotal,nCount)',
    decompiled: `int32_t __fastcall
D2Game::Quests::QUESTS::A5Q2::Q32_GetRemainingPrisonersCount(D2QuestDataStrc *pQuestData)
{
  int nCount;
  int32_t nRemainingTotal;
  D2QuestDataA5Q2Strc *pSpecificData;

  pSpecificData = (pQuestData->pQuestSpecificData).pA5Q2;
  nCount = 0;
  if (pSpecificData->abGroupAllFreed[0] == 0) {
    nCount = 5;
  }
  if (pSpecificData->abGroupAllFreed[1] == 0) {
    nCount = nCount + 5;
  }
  if (pSpecificData->abGroupAllFreed[2] == 0) {
    nCount = nCount + 5;
  }
  nRemainingTotal =
       nCount + ((pSpecificData->nTotalPrisonersToFree - pSpecificData->nPrisonersFreed) -
                pSpecificData->nPrisonersKilledByMonsters);
  if (nRemainingTotal < 0) {
    nRemainingTotal = 0;
  }
  return nRemainingTotal;
}`,
  },
  {
    address: '004dcf70', name: 'WALL2_IsInDrawGrid',
    namespace: 'D2Client::GAME::Wall2', size: 41,
    returnType: 'BOOL', callingConvention: '__cdecl',
    parameters: [['nX', 'int'], ['nY', 'int'], ['pDrawList', 'D2Wall2DrawListStrc *']],
    // Ghidra's function-info locals list omits decompiler temporary iVar1.
    locals: [['nRelY', 'int', 'ECX:4']],
    form: 'join(iVar1,nX)',
    decompiled: `BOOL __cdecl D2Client::GAME::Wall2::WALL2_IsInDrawGrid(int nX,int nY,D2Wall2DrawListStrc *pDrawList)
{
  int iVar1;
  int nRelY;

  iVar1 = nX - pDrawList->nWall2GridOriginX;
  nRelY = nY - pDrawList->nWall2GridOriginY;
  if (((-1 < iVar1) && (-1 < nRelY)) && (iVar1 < pDrawList->nWall2GridDim)) {
    return (uint)(nRelY < pDrawList->nWall2GridDim);
  }
  return 0;
}`,
  },
];

function extract(c: Case, tag: 'current' | 'stale' | 'none'): ExtractedFunction {
  return {
    name: c.name, address: c.address, namespace: c.namespace, size: c.size,
    signature: `${c.returnType} ${c.name}(${c.parameters.map(([name, type]) => `${type} ${name}`).join(', ')})`,
    returnType: c.returnType,
    parameters: c.parameters.map(([name, dataType], ordinal) => ({ name, dataType, size: 4, ordinal })),
    localVariables: c.locals.map(([name, dataType, storage]) => ({ name, dataType, size: 4, storage })),
    callingConvention: c.callingConvention, isThunk: false, isExternal: false, hasVarArgs: false,
    decompiled: c.decompiled, calledFunctions: [],
    tags: tag === 'none' ? [] : [{
      type: 'vc8form',
      data: `${c.form};ev=0123456789;bh=${c.size}-00000000;dh=${tag === 'current' ? vc8formBodyHash(c.decompiled) : '00000000'}`,
    }],
  };
}

function implementations(tag: 'current' | 'stale' | 'none'): Map<string, string> {
  const namespaces: ExtractedNamespace[] = cases.map(c => ({
    name: c.namespace.split('::').at(-1)!, fullPath: c.namespace, functionCount: 1, isClass: false,
  }));
  const project = generateProject('join-redivivus', cases.map(c => extract(c, tag)), [], [], [],
    namespaces, options, programInfo);
  const byFunction = new Map<string, string>();
  for (const c of cases) {
    const file = [...project.files.values()].find(f => f.type === 'implementation' && f.content.includes(`${c.name}(`));
    assert.ok(file, `implementation for ${c.address} ${c.name}`);
    byFunction.set(c.name, file.content);
  }
  return byFunction;
}

describe('Redivivus join codegen', () => {
  it('applies each measured tag to the exact Ghidra declaration-then-assignment bodies', () => {
    const tagged = implementations('current');
    const plain = implementations('none');
    for (const c of cases) assert.notEqual(tagged.get(c.name), plain.get(c.name), c.name);
    assert.match(tagged.get('Q32_GetRemainingPrisonersCount')!, /nCount\s*=\s*nCount\s*\+/);
    assert.doesNotMatch(tagged.get('Q32_GetRemainingPrisonersCount')!, /nRemainingTotal/);
    assert.match(tagged.get('WALL2_IsInDrawGrid')!, /nX\s*=\s*nX\s*-/);
    assert.doesNotMatch(tagged.get('WALL2_IsInDrawGrid')!, /iVar1/);
  });

  it('leaves untagged and stale-tagged output identical', () => {
    const plain = implementations('none');
    const stale = implementations('stale');
    for (const c of cases) assert.equal(stale.get(c.name), plain.get(c.name), c.name);
  });
});
