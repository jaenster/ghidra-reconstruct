/**
 * Redivivus Windows 1.14d functions, read from Ghidra at the addresses below.
 * Exercise measured vc8form tags through generateProject, including the
 * decompile-hash gate, parser, transform, and emitted implementation.
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
  returnType: string; parameters: Array<[string, string]>; locals: Array<[string, string]>;
  form: string; decompiled: string;
};

const cases: Case[] = [
  {
    address: '00434700', name: 'StorePreferedRealmAgain', namespace: 'D2Launch::MainMenus', size: 90,
    returnType: 'BOOL', parameters: [['pControlMsg', 'D2ControlMsg *']],
    locals: [['pGatewayAccess', 'D2BNetGatewayAccessStr *'], ['nSelectedLine', 'int32_t'], ['pszRealmName', 'char *']],
    form: 'opas(nSelectedLine,+,1)',
    decompiled: `BOOL D2Launch::MainMenus::StorePreferedRealmAgain(D2ControlMsg *pControlMsg)
{
  D2BNetGatewayAccessStr *pGatewayAccess;
  int32_t nSelectedLine;
  char *pszRealmName;
  pGatewayAccess = (*D2Launch::Launcher::gpBNetCallbacks->pfnBnetLoadAndReturn)();
  nSelectedLine = D2Win::Src::D2WinTextBox::D2WINTEXTBOX_GetSelectedLine(gpMainMenuGatewayListTextBox);
  if (nSelectedLine != -1) {
    Bnclient::BNGatewayAccess::SetCurGateway(pGatewayAccess,nSelectedLine + 1);
    pszRealmName = Bnclient::BNGatewayAccess::Realm(pGatewayAccess,nSelectedLine + 1);
    Storm::Source::SReg::SRegSaveString("Diablo II","Preferred Realm",0,pszRealmName);
  }
  D2Launch::MainMenus::FORMS_DestroyLists();
  D2Launch::MainMenus::UIMENU_MainMenu();
  return 1;
}`,
  },
  {
    address: '0054e090', name: 'MONSTER_SpawnMonsterGroup', namespace: 'D2Game::Monsters::Monsters::Spawn', size: 241,
    returnType: 'D2UnitStrc *', parameters: [
      ['pGame', 'SGAMEDATA *'], ['pRoom', 'D2RoomStrc *'], ['nClassId', 'int32_t'], ['nX', 'int32_t'], ['nY', 'int32_t'],
    ],
    locals: [
      ['pMonStatLine', 'D2MonStatsTxt *'], ['pCoordList', 'D2RoomCoordListStrc *'], ['pUnit', 'D2UnitStrc *'],
      ['nMinionCount', 'uint32_t'], ['nMinionIdx', 'int32_t'], ['byMinGrp', 'byte'], ['byMaxGrp', 'byte'],
    ],
    form: 'opas(byMinGrp,-,1)',
    decompiled: `D2UnitStrc * D2Game::Monsters::Monsters::Spawn::MONSTER_SpawnMonsterGroup(SGAMEDATA *pGame,D2RoomStrc *pRoom,int32_t nClassId,int32_t nX,int32_t nY)
{
  D2MonStatsTxt *pMonStatLine;
  D2RoomCoordListStrc *pCoordList;
  D2UnitStrc *pUnit;
  uint32_t nMinionCount;
  int32_t nMinionIdx;
  byte byMinGrp;
  byte byMaxGrp;
  if ((nClassId < 0) || (D2Common::ITEMS::Items::sgptDataTable->nTxtMonStatsSize <= nClassId)) {
    pMonStatLine = (D2MonStatsTxt *)0x0;
  }
  else {
    pMonStatLine = D2Common::ITEMS::Items::sgptDataTable->pTxtMonStats + nClassId;
  }
  byMinGrp = pMonStatLine->MinGrp;
  byMaxGrp = pMonStatLine->MaxGrp;
  if (((byMinGrp != 0) && (byMaxGrp != 0)) && (byMinGrp <= byMaxGrp)) {
    pCoordList = D2Common::DUNGEON::Dungeon::DRLGROOM_GetCoordListFromSubtilePos(pRoom,nX,nY);
    if ((pCoordList != (D2RoomCoordListStrc *)0x0) &&
       (pUnit = D2Game::Monster::Monster::Create::SpawnMonsterInRoomCoordList
                          (pGame,pRoom,pCoordList,nX,nY,nClassId,Neutral,-1,0),
       pUnit != (D2UnitStrc *)0x0)) {
      nMinionCount = D2Common::Seed::RANDOM_RandomNumberSelector
                               (&pUnit->sSeed,
                                ((uint)(byte)(byMaxGrp - 1) - (uint)(byte)(byMinGrp - 1)) + 1);
      for (nMinionIdx = nMinionCount + (byte)(byMinGrp - 1); 0 < nMinionIdx;
          nMinionIdx = nMinionIdx + -1) {
        D2Game::Monster::Monster::Create::SpawnMonsterAtCoordList
                  (pGame,pCoordList,pUnit,nClassId,Neutral,3,0);
      }
      return pUnit;
    }
    return (D2UnitStrc *)0x0;
  }
  return (D2UnitStrc *)0x0;
}`,
  },
  {
    address: '00648b00', name: 'SetSP1Shifted', namespace: 'D2Common::PATH::DynamicPath', size: 43,
    returnType: 'void', parameters: [
      ['pDynamicPath', 'D2DynamicPathStrc *'], ['nX', 'int32_t'], ['nY', 'int32_t'],
    ], locals: [], form: 'opas(nX,>>,0xb,nY,>>,0xb)',
    decompiled: `void D2Common::PATH::DynamicPath::SetSP1Shifted(D2DynamicPathStrc *pDynamicPath,int32_t nX,int32_t nY)
{
  D2Common::Drlg::Drlg::Transform::DRLG_WorldToScreenNoShift(&nX,&nY);
  pDynamicPath->nTargetX = (short)(nX >> 0xb);
  pDynamicPath->nTargetY = (short)(nY >> 0xb);
  return;
}`,
  },
];

function extract(c: Case, tag: 'current' | 'stale' | 'none'): ExtractedFunction {
  const params = c.parameters.map(([name, dataType], ordinal) => ({ name, dataType, size: 4, ordinal }));
  return {
    name: c.name, address: c.address, namespace: c.namespace, size: c.size,
    signature: `${c.returnType} ${c.name}(${c.parameters.map(([name, type]) => `${type} ${name}`).join(', ')})`,
    returnType: c.returnType, parameters: params,
    localVariables: c.locals.map(([name, dataType]) => ({ name, dataType, size: dataType === 'byte' ? 1 : 4, storage: 'EAX:4' })),
    callingConvention: '__stdcall', isThunk: false, isExternal: false, hasVarArgs: false,
    decompiled: c.decompiled, calledFunctions: [],
    tags: tag === 'none' ? [] : [{
      type: 'vc8form',
      data: `${c.form};ev=0123456789;bh=${c.size}-00000000;dh=${tag === 'current' ? vc8formBodyHash(c.decompiled) : '00000000'}`,
    }],
  };
}

function implementations(tag: 'current' | 'stale' | 'none'): Map<string, string> {
  const functions = cases.map(c => extract(c, tag));
  const namespaces: ExtractedNamespace[] = cases.map(c => ({
    name: c.namespace.split('::').at(-1)!, fullPath: c.namespace, functionCount: 1, isClass: false,
  }));
  const project = generateProject('opas-redivivus', functions, [], [], [], namespaces, options, programInfo);
  const byFunction = new Map<string, string>();
  for (const c of cases) {
    const file = [...project.files.values()].find(f => f.type === 'implementation' && f.content.includes(`${c.name}(`));
    assert.ok(file, `implementation for ${c.address} ${c.name}`);
    byFunction.set(c.name, file.content);
  }
  return byFunction;
}

describe('Redivivus opas codegen', () => {
  it('applies each measured tag through project emission', () => {
    const tagged = implementations('current');
    const plain = implementations('none');
    for (const c of cases) assert.notEqual(tagged.get(c.name), plain.get(c.name), c.name);
    assert.match(tagged.get('StorePreferedRealmAgain')!, /nSelectedLine \+= 1;[\s\S]*SetCurGateway\(pGatewayAccess, nSelectedLine\);[\s\S]*Realm\(pGatewayAccess, nSelectedLine\)/);
    assert.match(tagged.get('MONSTER_SpawnMonsterGroup')!, /byMinGrp -= 1;[\s\S]*\(uint8_t\)byMinGrp[\s\S]*\(uint8_t\)byMinGrp/);
    assert.match(tagged.get('SetSP1Shifted')!, /DRLG_WorldToScreenNoShift\(&nX, &nY\);[\s\S]*nX >>= 0xb;[\s\S]*nY >>= 0xb;[\s\S]*nTargetX = \(short int\)nX;[\s\S]*nTargetY = \(short int\)nY/);
  });

  it('leaves untagged and stale-tagged output identical', () => {
    const plain = implementations('none');
    const stale = implementations('stale');
    for (const c of cases) assert.equal(stale.get(c.name), plain.get(c.name), c.name);
  });
});
