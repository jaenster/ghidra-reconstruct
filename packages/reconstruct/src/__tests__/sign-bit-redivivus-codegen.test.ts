/**
 * Captured from Redivivus's read-only Windows 1.14d Ghidra database by address.
 * These are full decompiled function bodies, with comments removed, plus the
 * resolved local types that the extractor folds from get_function_info.
 * They exercise the issue #241 Rule 1 spellings through real project codegen.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateProject } from '../codegen/index.js';
import type {
  ExtractedFunction, ExtractedNamespace, ProgramInfo, ReconstructOptions,
} from '../types.js';

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

const functions: ExtractedFunction[] = [
  {
    name: 'SOUNDHDR_UpdateRegistryVersion', address: '0x00482ca0',
    signature: 'void SOUNDHDR_UpdateRegistryVersion(int32_t nSoundHeaderIndex)',
    returnType: 'void',
    parameters: [{ name: 'nSoundHeaderIndex', dataType: 'int32_t', size: 4, ordinal: 0 }],
    localVariables: [
      { name: 'bReadOk', dataType: 'int32_t', size: 4, storage: 'EAX:4' },
      { name: 'byCurrentVersionFlag', dataType: 'byte', size: 1, storage: 'CL:1' },
      { name: 'byRequiredVersionFlag', dataType: 'byte', size: 1, storage: 'AL:1' },
      { name: 'dwVersionBuild', dataType: 'uint', size: 4, storage: 'Stack[-0x8]:4' },
      { name: 'nVersionRevision', dataType: 'int', size: 4, storage: 'Stack[-0xc]:4' },
      { name: 'nVersionMinor', dataType: 'int', size: 4, storage: 'Stack[-0x10]:4' },
      { name: 'nVersionMajor', dataType: 'int', size: 4, storage: 'Stack[-0x14]:4' },
      { name: 'szVersionString', dataType: 'CHAR[100]', size: 100, storage: 'Stack[-0x78]:100' },
      { name: 'dwRequiredVersion', dataType: 'int', size: 4, storage: 'HASH:5f171e4b3a:4' },
    ],
    callingConvention: '__fastcall', size: 300, isThunk: false, isExternal: false,
    hasVarArgs: false, namespace: 'D2Client::Sound::SoundHdr',
    calledFunctions: ['SRegLoadString', 'SRegSaveString', 'sscanf', 'sprintf'],
    decompiled: String.raw`void __fastcall D2Client::Sound::SoundHdr::SOUNDHDR_UpdateRegistryVersion(int32_t nSoundHeaderIndex)
{
  byte byRequiredVersionFlag;
  int32_t bReadOk;
  byte byCurrentVersionFlag;
  CHAR szVersionString [100];
  int nVersionMajor;
  int nVersionMinor;
  int nVersionRevision;
  uint dwVersionBuild;
  int dwRequiredVersion;

  dwRequiredVersion = gdwSoundHeaderCacheIndex[nSoundHeaderIndex].nCutsceneId;
  dwVersionBuild = 0x22;
  bReadOk = Storm::Source::SReg::SRegLoadString("Diablo II","Aux Battle.net",0,szVersionString,100);
  if (bReadOk == 0) {
    byCurrentVersionFlag = 0x22;
  }
  else {
    compiler::sscanf(szVersionString,"%d.%d.%d.%d",&nVersionMajor,&nVersionMinor,&nVersionRevision,
                     (int *)&dwVersionBuild);
    if ((dwVersionBuild & 1) == 0) {
      if ((char)dwVersionBuild < '\0') {
        byCurrentVersionFlag = 6;
      }
      else if ((dwVersionBuild & 0x10) == 0) {
        if ((dwVersionBuild & 8) == 0) {
          if ((dwVersionBuild & 0x40) == 0) {
            byCurrentVersionFlag = ((dwVersionBuild & 4) != 0) + 1;
          }
          else {
            byCurrentVersionFlag = 3;
          }
        }
        else {
          byCurrentVersionFlag = 4;
        }
      }
      else {
        byCurrentVersionFlag = 5;
      }
    }
    else {
      byCurrentVersionFlag = 7;
    }
  }
  switch(dwRequiredVersion) {
  case 2:
    byRequiredVersionFlag = 2;
    break;
  case 3:
    byRequiredVersionFlag = 3;
    break;
  case 4:
    byRequiredVersionFlag = 4;
    break;
  case 5:
  case 6:
    byRequiredVersionFlag = 5;
    break;
  case 7:
    byRequiredVersionFlag = 7;
    break;
  default:
    byRequiredVersionFlag = 1;
  }
  if (byRequiredVersionFlag <= byCurrentVersionFlag) {
    return;
  }
  if (false) {
switchD_00482d60_caseD_6:
    dwVersionBuild = 0x22;
  }
  else {
    switch(byRequiredVersionFlag) {
    case 2:
      dwVersionBuild = 0x26;
      break;
    case 3:
      dwVersionBuild = 0x62;
      break;
    case 4:
      dwVersionBuild = 0x2a;
      break;
    case 5:
      dwVersionBuild = 0xb2;
      break;
    default:
      goto switchD_00482d60_caseD_6;
    case 7:
      dwVersionBuild = 0x23;
    }
  }
  compiler::sprintf(szVersionString,"%d.%d.%d.%d",0xd8,0x94,0xf6,dwVersionBuild);
  Storm::Source::SReg::SRegSaveString("Diablo II","Aux Battle.net",0,szVersionString);
  return;
}`,
  },
  {
    name: 'UNITSND_GetGroundMaterialType', address: '0x004cad60',
    signature: 'uint32_t UNITSND_GetGroundMaterialType(D2DrlgTileDataStrc * pUnit)',
    returnType: 'uint32_t',
    parameters: [{ name: 'pUnit', dataType: 'D2DrlgTileDataStrc *', size: 4, ordinal: 0 }],
    localVariables: [{ name: 'wTileFlags', dataType: 'ushort', size: 2, storage: 'HASH:5f83127178:2' }],
    callingConvention: '__cdecl', size: 77, isThunk: false, isExternal: false,
    hasVarArgs: false, namespace: 'D2Client::UNIT::UnitSnd', calledFunctions: [],
    decompiled: [
      'uint32_t __cdecl D2Client::UNIT::UnitSnd::UNITSND_GetGroundMaterialType(D2DrlgTileDataStrc *pUnit)',
      '{',
      '  ushort wTileFlags;',
      '  if (pUnit->pTileLibraryEntry != (D2TileLibraryEntryStrc *)0x0) {',
      '    wTileFlags = pUnit->pTileLibraryEntry->nFlags;',
      '    if ((wTileFlags & 0x20) != 0) {',
      '      return 1;',
      '    }',
      '    if ((wTileFlags & 8) != 0) {',
      '      return 2;',
      '    }',
      '    if ((wTileFlags & 0x10) != 0) {',
      '      return 3;',
      '    }',
      '    if ((wTileFlags & 0x40) != 0) {',
      '      return 4;',
      '    }',
      "    if ((char)wTileFlags < '\\0') {",
      '      return 6;',
      '    }',
      '    if ((wTileFlags & 0x400) != 0) {',
      '      return 5;',
      '    }',
      '  }',
      '  return 0;',
      '}',
    ].join('\n'),
  },
  {
    name: 'UpdateMouseModifierKeyState', address: '0x0044ce90',
    signature: 'void UpdateMouseModifierKeyState(void)', returnType: 'void',
    parameters: [],
    localVariables: [
      { name: 'keyCode', dataType: 'uint32_t', size: 4, storage: 'EAX:4' },
      { name: 'wVirtualKey', dataType: 'uint16_t', size: 2, storage: 'AX:2' },
      { name: 'nKeyState', dataType: 'SHORT', size: 2, storage: 'AX:2' },
    ],
    callingConvention: '__stdcall', size: 135, isThunk: false, isExternal: false,
    hasVarArgs: false, namespace: 'D2Client::GAME::Game',
    calledFunctions: ['CMD_IsCommandBound', 'CMD_GetKeyForCommand', 'GetAsyncKeyState'],
    decompiled: [
      'void D2Client::GAME::Game::UpdateMouseModifierKeyState(void)',
      '{',
      '  uint16_t wVirtualKey;',
      '  SHORT nKeyState;',
      '  uint32_t keyCode;',
      '  keyCode = D2Client::UI::CmdTbl::CMD_IsCommandBound(0x24,1);',
      '  if (((keyCode != 0) &&',
      '      (wVirtualKey = D2Client::UI::CmdTbl::CMD_GetKeyForCommand(0x24,1), wVirtualKey != 0xffff)) &&',
      '     (nKeyState = GetAsyncKeyState((uint)wVirtualKey), nKeyState < 0)) {',
      '    gClickModifierDown = 1;',
      '    return;',
      '  }',
      '  keyCode = D2Client::UI::CmdTbl::CMD_IsCommandBound(0x24,0);',
      '  if (((keyCode != 0) &&',
      '      (wVirtualKey = D2Client::UI::CmdTbl::CMD_GetKeyForCommand(0x24,0), wVirtualKey != 0xffff)) &&',
      '     (nKeyState = GetAsyncKeyState((uint)wVirtualKey), nKeyState < 0)) {',
      '    gClickModifierDown = 1;',
      '    return;',
      '  }',
      '  gClickModifierDown = 0;',
      '  return;',
      '}',
    ].join('\n'),
  },
];

const namespaces: ExtractedNamespace[] = [
  { name: 'SoundHdr', fullPath: 'D2Client::Sound::SoundHdr', functionCount: 1, isClass: false },
  { name: 'UnitSnd', fullPath: 'D2Client::UNIT::UnitSnd', functionCount: 1, isClass: false },
  { name: 'Game', fullPath: 'D2Client::GAME::Game', functionCount: 1, isClass: false },
];

describe('Redivivus issue #241 codegen', () => {
  it('uses bit masks for all three native Rule 1 gainers', () => {
    const project = generateProject('redivivus-sign-bits', functions, [], [], [], namespaces, options, programInfo);
    const implementations = [...project.files.values()]
      .filter(file => file.type === 'implementation')
      .map(file => file.content).join('\n');
    assert.equal((implementations.match(/wTileFlags & 0x80/g) ?? []).length, 1);
    assert.equal((implementations.match(/dwVersionBuild & 0x80/g) ?? []).length, 1);
    assert.equal((implementations.match(/nKeyState & 0x8000/g) ?? []).length, 2);
    assert.doesNotMatch(implementations, /\(char\)wTileFlags\s*<\s*'\\0'/);
    assert.doesNotMatch(implementations, /\(char\)dwVersionBuild\s*<\s*'\\0'/);
    assert.doesNotMatch(implementations, /nKeyState\s*<\s*0/);
  });
});
