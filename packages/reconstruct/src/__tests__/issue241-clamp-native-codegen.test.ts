/** Full Win 1.14d Ghidra decompiles, captured by address from Redivivus on 2026-11-10. */
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateProject } from '../codegen/index.js';
import { vc8formBodyHash } from '../codegen/vc8form-spec.js';
import type { ExtractedFunction, ExtractedNamespace, ProgramInfo, ReconstructOptions } from '../types.js';

type NativeCase = Pick<ExtractedFunction, 'address' | 'name' | 'namespace' | 'signature' | 'returnType' | 'callingConvention' | 'size' | 'decompiled'>;
const native = JSON.parse(readFileSync(new URL('./fixtures/issue241-clamp-native.json', import.meta.url), 'utf8')) as NativeCase[];
const names = ['nEndLine', 'nValue', 'nMissileRange'];
const options: ReconstructOptions = {
  outputDir: './out', format: 'cpp', organization: 'namespace',
  generateCMake: false, generateSourceMaps: false, transformPreset: 'full',
  includeAddressComments: false, promoteStaticGlobals: false,
};
const programInfo: ProgramInfo = {
  name: 'Game.exe', path: '/Redivivus/Game.exe', format: 'PE', architecture: 'x86', compiler: 'msvc',
  imageBase: '0x400000', languageId: 'x86:LE:32:default', endianness: 'little', pointerSize: 4,
};
const namespaces: ExtractedNamespace[] = native.map(f => ({
  name: f.namespace!.split('::').at(-1)!, fullPath: f.namespace!, functionCount: 1, isClass: false,
}));

function project(tagged: boolean, stale = false) {
  const functions: ExtractedFunction[] = native.map((f, i) => ({
    ...f, parameters: i === 0 ? [] : i === 1
      ? [{ name: 'nHealAmount', dataType: 'int32_t', size: 4, ordinal: 0 }, { name: 'pUnit', dataType: 'D2UnitStrc *', size: 4, ordinal: 1 }]
      : [{ name: 'pGame', dataType: 'SGAMEDATA *', size: 4, ordinal: 0 }, { name: 'pUnit', dataType: 'D2UnitStrc *', size: 4, ordinal: 1 }],
    localVariables: [], isThunk: false, isExternal: false, hasVarArgs: false, calledFunctions: [],
    tags: tagged ? [{
      type: 'vc8form',
      // Synthetic evidence/byte tokens exercise the tag gate; only the decompile hash
      // and native body are real here. Production tags need measured evidence and bytes.
      data: `clamp(${names[i]});ev=0000000000;bh=${f.size}-00000000;dh=${stale ? 'ffffffff' : vc8formBodyHash(f.decompiled!)}`,
    }] : [],
  }));
  const result = generateProject('issue241-clamp-native', functions, [], [], [], namespaces, options, programInfo);
  return [...result.files.values()].filter(file => file.type === 'implementation').map(file => file.content).join('\n');
}

describe('issue #241 Rule 2 native full-codegen fixture', () => {
  it('is inert without a vc8form tag and re-forms all three named clamps when tagged', () => {
    const baseline = project(false);
    const candidate = project(true);
    const guards = [
      /if \(gnLadderListRowCount <= nEndLine\)/,
      /if \(nMaxHp <= nValue\)/,
      /if \(nMissileRange < 100\)/,
    ];
    for (const guard of guards) {
      assert.match(baseline, guard);
      assert.doesNotMatch(candidate, guard);
    }
    assert.equal(project(true, true), baseline, 'a stale body hash must leave all three functions unchanged');
    assert.match(candidate, /nEndLine\s*=\s*nVisibleLines \+ nScrollPos < gnLadderListRowCount \? nVisibleLines \+ nScrollPos : gnLadderListRowCount/);
    assert.match(candidate, /nValue\s*=\s*nCurHp \+ nHealAmount < nMaxHp \? nCurHp \+ nHealAmount : nMaxHp/);
    assert.match(candidate, /nMissileRange\s*=\s*pDVar2->Range - 100 >= 100 \? pDVar2->Range - 100 : 100/);
  });
});
