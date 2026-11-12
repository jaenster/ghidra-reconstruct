import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateProject } from '../codegen/index.js';
import { vc8formBodyHash } from '../codegen/vc8form-spec.js';
import type { ExtractedFunction, ExtractedNamespace, ProgramInfo, ReconstructOptions } from '../types.js';

const native = JSON.parse(readFileSync(new URL('./fixtures/issue28-partyinvite-native.json', import.meta.url), 'utf8')) as ExtractedFunction;
const options: ReconstructOptions = {
  outputDir: './out', format: 'cpp', organization: 'namespace',
  generateCMake: false, generateSourceMaps: false, transformPreset: 'full',
  includeAddressComments: false, promoteStaticGlobals: false,
};
const programInfo: ProgramInfo = {
  name: 'Game.exe', path: '/Redivivus/Game.exe', format: 'PE', architecture: 'x86', compiler: 'msvc',
  imageBase: '0x400000', languageId: 'x86:LE:32:default', endianness: 'little', pointerSize: 4,
};
const namespace: ExtractedNamespace = {
  name: 'PlayerScreen', fullPath: 'D2Game::PLAYER::PlayerScreen', functionCount: 1, isClass: false,
};

function project(forms: string[], stale = false) {
  const f: ExtractedFunction = {
    ...native,
    parameters: [
      { name: 'pGame', dataType: 'SGAMEDATA *', size: 4, ordinal: 0, storage: 'ECX:4' },
      { name: 'pUnit', dataType: 'D2UnitStrc *', size: 4, ordinal: 1, storage: 'EDX:4' },
      { name: 'pTarget', dataType: 'D2UnitStrc *', size: 4, ordinal: 2, storage: 'Stack[0x4]:4' },
      { name: 'dwUnused1', dataType: 'undefined4', size: 4, ordinal: 3, storage: 'Stack[0x8]:4' },
      { name: 'dwUnused2', dataType: 'undefined4', size: 4, ordinal: 4, storage: 'Stack[0xc]:4' },
    ],
    localVariables: [], isThunk: false, isExternal: false, hasVarArgs: false, calledFunctions: [],
    // Synthetic tag evidence exercises regeneration; no live Ghidra tag is added by this test.
    tags: forms.map(form => ({ type: 'vc8form',
      data: `${form};ev=0000000000;bh=129-00000000;dh=${stale ? 'ffffffff' : vc8formBodyHash(native.decompiled!)}`,
    })),
  };
  const result = generateProject('issue28-partyinvite-native', [f], [], [], [], [namespace], options, programInfo);
  return [...result.files.values()].filter(file => file.type === 'implementation').map(file => file.content).join('\n');
}

describe('issue #28 PartyInvite native codegen probe', () => {
  it('re-forms the complete native body only with current tags', () => {
    const baseline = project([]);
    const tailguardOnly = project(['tailguard(!uVar1)']);
    const eventFoldOnly = project(['fold(bEventType)', 'tailguard(!uVar1)']);
    const clientFoldOnly = project(['fold(pClient)', 'tailguard(!uVar1)']);
    const candidate = project(['fold(pClient)', 'fold(bEventType)', 'tailguard(!uVar1)']);
    assert.match(baseline, /if \(!uVar1\)/);
    assert.equal(project(['fold(pClient)', 'fold(bEventType)', 'tailguard(!uVar1)'], true), baseline, 'stale tags must preserve the baseline');
    assert.match(tailguardOnly, /SendPlayerEvent\(pClient, nInviterGUID, bEventType\)/);
    assert.match(eventFoldOnly, /SendPlayerEvent\(pClient, nInviterGUID, '\\x05'\)/);
    assert.match(clientFoldOnly, /SendPlayerEvent\(UNIT::SUnit::SUNIT_GetClient\(pTarget, [\s\S]*?\), nInviterGUID, bEventType\)/);
    const actualFunction = candidate.slice(candidate.indexOf('void __fastcall PARTYSCREEN_SendPartyInvite('), candidate.indexOf('\n}\n\n} // namespace') + 2);
    const expectedFunction = String.raw`void __fastcall PARTYSCREEN_SendPartyInvite(SGAMEDATA * pGame, D2UnitStrc * pUnit, D2UnitStrc * pTarget, uint32_t dwUnused1, uint32_t dwUnused2) {
      UNIT::PlayerList::PLAYERLIST_AddPlayerEntry(pGame, pUnit, pTarget);
      UNIT::PlayerList::PLAYERLIST_AddPlayerEntry(pGame, pTarget, pUnit);
      uint16_t uVar1 = UNIT::PlayerList::PLAYERLIST_IsPartied(pUnit, pTarget);
      if (uVar1) {
        UNIT::PlayerList::Send0x8bRelationshipStatus(pUnit, pTarget);
        UNIT::PlayerList::Send0x8bRelationshipStatus(pTarget, pUnit);
        return;
      }
      {
        uint32_t nInviterGUID;
        UNIT::PlayerList::SetPlayerRelationship(pUnit, pTarget, 4);
        UNIT::PlayerList::SetPlayerRelationship(pTarget, pUnit, 2);
        if (!pUnit) {
          nInviterGUID = -1;
        } else {
          nInviterGUID = pUnit->nUnitGUID;
        }
        SendPlayerEvent(UNIT::SUnit::SUNIT_GetClient(pTarget, ".\\PLAYER\\PartyScreen.cpp", 0x132), nInviterGUID, '\x05');
      }
      UNIT::PlayerList::Send0x8bRelationshipStatus(pUnit, pTarget);
      UNIT::PlayerList::Send0x8bRelationshipStatus(pTarget, pUnit);
    }`;
    assert.equal(actualFunction.replace(/\s+/g, ' ').trim(), expectedFunction.replace(/\s+/g, ' ').trim());
  });
});
