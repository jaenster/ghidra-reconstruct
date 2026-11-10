/**
 * Rule 3 of Redivivus #241 through generateProject. Each body contains the live
 * Windows 1.14d Ghidra difference reads; wrappers keep the test focused on the
 * native site, rather than claiming a full-function regeneration.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateProject } from '../codegen/index.js';
import { vc8formBodyHash } from '../codegen/vc8form-spec.js';
import type { ExtractedFunction, ProgramInfo, ReconstructOptions } from '../types.js';

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

interface Site {
  name: string;
  address: string;
  nativeSub: string;
  size: number;
  namespace: string;
  local: string;
  type: string;
  params: string;
  parameters: ExtractedFunction['parameters'];
  otherLocals: string;
  body: string;
}

const clientParameters: ExtractedFunction['parameters'] = [
  { name: 'pUnit', dataType: 'D2UnitStrc *', size: 4, ordinal: 0, storage: 'ECX:4' },
  { name: 'eSkill', dataType: 'eD2Skills', size: 4, ordinal: 1, storage: 'EDX:4' },
  { name: 'nSkillLvl', dataType: 'int32_t', size: 4, ordinal: 2, storage: 'Stack[0x4]:4' },
];
const serverParameters: ExtractedFunction['parameters'] = [
  { name: 'pGame', dataType: 'SGAMEDATA *', size: 4, ordinal: 0, storage: 'ECX:4' },
  { name: 'pUnit', dataType: 'D2UnitStrc *', size: 4, ordinal: 1, storage: 'EDX:4' },
  { name: 'eSkill', dataType: 'eD2Skills', size: 4, ordinal: 2, storage: 'Stack[0x4]:4' },
  { name: 'nSkillLvl', dataType: 'int32_t', size: 4, ordinal: 3, storage: 'Stack[0x8]:4' },
];

const sites: Site[] = [
  {
    name: 'Skills_CltDoFunc_Mon_MeleeRepeat', address: '0x004e2410', nativeSub: '0x004e2491',
    size: 190, namespace: 'D2Client::SKILLS::SkillsMon', local: 'nTargetGUID', type: 'int32_t',
    params: 'D2UnitStrc *pUnit,eD2Skills eSkill,int32_t nSkillLvl', parameters: clientParameters,
    otherLocals: 'D2SkillStrc *pSkill; D2UnitStrc *pTarget; eD2UnitType eUnitType; BOOL bInRange;',
    body: 'pSkill = D2Common::Units::Units::GetCurrentSkill(pUnit); eUnitType = D2Common::Skills::Skills::SKILL_GetParam3(pSkill); nTargetGUID = D2Common::Skills::Skills::SKILL_GetParam2(pSkill); pTarget = D2Client::UNIT::Player::UNITS_FindClientSideUnit(nTargetGUID,eUnitType); if (pTarget != (D2UnitStrc *)0x0) { bInRange = D2Common::Units::Units::IsInMeleeRange(pUnit,pTarget,0); if (bInRange != 0) { nTargetGUID = D2Common::Skills::Skills::SKILL_GetParam1(pSkill); if (0 < nTargetGUID + -1) { D2Common::Skills::Skills::SKILL_SetParam1(pSkill,nTargetGUID + -1); } } } return 0;',
  },
  {
    name: 'Skills_CltDoFunc_Ass_Blade_DecrementCharge', address: '0x004f2160', nativeSub: '0x004f2188',
    size: 76, namespace: 'D2Client::SKILLS::SkillsAss', local: 'nChargeCount', type: 'int32_t',
    params: 'D2UnitStrc *pUnit,eD2Skills eSkill,int32_t nSkillLvl', parameters: clientParameters,
    otherLocals: 'D2SkillStrc *pSkill; D2UnitStrc *pTarget;',
    body: 'pSkill = D2Common::Units::Units::GetCurrentSkill(pUnit); if (pSkill != (D2SkillStrc *)0x0) { pTarget = D2Client::UNIT::CUnit::GetConfirmedTargetUnit(pUnit); if (pTarget != (D2UnitStrc *)0x0) { nChargeCount = D2Common::Skills::Skills::SKILL_GetParam1(pSkill); if (0 < nChargeCount + -1) { D2Common::Skills::Skills::SKILL_SetParam1(pSkill,nChargeCount + -1); D2Client::SKILLS::Skills::SKILLS_ApplyDamageReduction(pUnit,100); } return 1; } } return 0;',
  },
  {
    name: 'Skills_SrvDoFunc_048_BladeFury', address: '0x005d68a0', nativeSub: '0x005d68ea',
    size: 266, namespace: 'D2Game::SKILLS::SkillAss', local: 'nChargeCalcVal', type: 'uint32_t',
    params: 'SGAMEDATA *pGame,D2UnitStrc *pUnit,eD2Skills eSkill,int32_t nSkillLvl', parameters: serverParameters,
    otherLocals: 'D2SkillStrc *pSkill; eMissilesId eChargeMissile; int32_t nNextFireFrame; BOOL bHasTarget; uint32_t nCursorX; uint32_t nCursorY;',
    body: 'pSkill = D2Common::Skills::Skills::SKILLS_GetSkillByEnum(pUnit,eSkill); eChargeMissile = D2Game::SKILLS::SkillAss::SKILLASS_GetChargeUpMissile(pUnit,eSkill); nChargeCalcVal = D2Game::SKILLS::SkillAss::SKILLASS_GetChargeUpCalcValue(pUnit,eSkill,nSkillLvl); if (0 < (int)(nChargeCalcVal - 1)) { bHasTarget = D2Game::SKILLS::SkillsServer::SKILLS_GetTargetOrCursorPos(pGame,pUnit,&nCursorX,&nCursorY); if (bHasTarget != 0) { nNextFireFrame = D2Common::Skills::Skills::SKILL_GetParam1(pSkill); if (nNextFireFrame < pGame->dwGameFrame) { D2Common::Skills::Skills::SKILL_SetParam1(pSkill,pGame->dwGameFrame + (nChargeCalcVal - 1)); } } } return 0;',
  },
];

function source(site: Site, tagged: boolean, stale = false): string {
  const decompiled = `BOOL __fastcall ${site.namespace}::${site.name}(${site.params}) { ${site.otherLocals} ${site.type} ${site.local}; ${site.body} }`;
  const tag = `dec(${site.local},1);ev=0123456789;bh=${site.size}-89abcdef;dh=${stale ? '00000000' : vc8formBodyHash(decompiled)}`;
  const fn: ExtractedFunction = {
    name: site.name, address: site.address,
    signature: `BOOL ${site.name}(${site.params})`, returnType: 'BOOL', parameters: site.parameters,
    localVariables: [{ name: site.local, dataType: site.type, size: 4, storage: 'EAX:4' }],
    callingConvention: '__fastcall', size: site.size, isThunk: false,
    isExternal: false, hasVarArgs: false, namespace: site.namespace,
    calledFunctions: [], decompiled,
    tags: tagged ? [{ type: 'vc8form', data: tag }] : [],
  };
  const project = generateProject('rule3', [fn], [], [], [], [], options, programInfo);
  return [...project.files.values()].filter(file => file.type === 'implementation').map(file => file.content).join('\n');
}

describe('Redivivus Rule 3 decrement full codegen', () => {
  for (const site of sites) {
    it(`${site.name} ${site.nativeSub} changes only under a current tag`, () => {
      const baseline = source(site, false);
      const tagged = source(site, true);
      const stale = source(site, true, true);
      assert.equal(stale, baseline, 'stale decompile hash leaves source alone');
      assert.match(baseline, new RegExp(`${site.local} - 1`));
      assert.match(tagged, new RegExp(`${site.local} -= 1`));
      assert.doesNotMatch(tagged, new RegExp(`${site.local} - 1`));
    });
  }
});
