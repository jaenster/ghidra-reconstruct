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
  body: string;
}

const sites: Site[] = [
  {
    name: 'Skills_CltDoFunc_Mon_MeleeRepeat', address: '0x004e2410', nativeSub: '0x004e2491',
    size: 190, namespace: 'D2Client::SKILLS::SkillsMon', local: 'nTargetGUID', type: 'int32_t',
    body: 'nTargetGUID = get(); use(nTargetGUID); if (ready()) { nTargetGUID = next(); if (0 < nTargetGUID + -1) { set(nTargetGUID + -1); } } return 0;',
  },
  {
    name: 'Skills_CltDoFunc_Ass_Blade_DecrementCharge', address: '0x004f2160', nativeSub: '0x004f2188',
    size: 76, namespace: 'D2Client::SKILLS::SkillsAss', local: 'nChargeCount', type: 'int32_t',
    body: 'nChargeCount = get(); if (0 < nChargeCount + -1) { set(nChargeCount + -1); } return 1;',
  },
  {
    name: 'Skills_SrvDoFunc_048_BladeFury', address: '0x005d68a0', nativeSub: '0x005d68ea',
    size: 266, namespace: 'D2Game::SKILLS::SkillAss', local: 'nChargeCalcVal', type: 'uint32_t',
    body: 'nChargeCalcVal = get(); if (0 < (int)(nChargeCalcVal - 1)) { if (ready()) set(frame() + (nChargeCalcVal - 1)); } return 0;',
  },
];

function source(site: Site, tagged: boolean, stale = false): string {
  const decompiled = `int __fastcall ${site.namespace}::${site.name}() { ${site.type} ${site.local}; ${site.body} }`;
  const tag = `dec(${site.local},1);ev=0123456789;bh=${site.size}-89abcdef;dh=${stale ? '00000000' : vc8formBodyHash(decompiled)}`;
  const fn: ExtractedFunction = {
    name: site.name, address: site.address,
    signature: `int ${site.name}()`, returnType: 'int', parameters: [],
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
