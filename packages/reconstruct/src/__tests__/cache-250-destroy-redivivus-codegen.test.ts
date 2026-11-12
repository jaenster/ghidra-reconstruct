/** Exact live Windows Redivivus 00450520 pseudocode and function metadata, 2026-11-11. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateProject } from '../codegen/index.js';
import { vc8formBodyHash, vc8FormSpec } from '../codegen/vc8form-spec.js';
import type { ExtractedFunction, ExtractedNamespace, ProgramInfo, ReconstructOptions } from '../types.js';

const decompiled = `
/* WARNING: Enum "eCollisionFlags": Some values do not have unique names */
/* WARNING: Enum "eD2TimerType": Some values do not have unique names */
/* WARNING: Enum "eD2TimerTypeDWORD": Some values do not have unique names */
/* @function TSHashTable<SGAMEDATA,HASHKEY_NONE>::Destroy
   @address Game.exe.ram:00450520
   @date 2026.02.26
   @calling __thiscall
   @description Diablo 2 1.14d reverse team
   https://blizzhackers.dev
   @blizzard TSHashTable<SGAMEDATA,HASHKEY_NONE>::Destroy (STORM.H) */

void __thiscall
TSHashTable<SGAMEDATA,HASHKEY_NONE>::Destroy(TSHashTable<SGAMEDATA,HASHKEY_NONE> *this)

{
  TSHashTable<SGAMEDATA,HASHKEY_NONE>::InternalClear(this,1);
  this->nFullnessIndicator = 0;
  this->nSlotMask = 0;
  TSGrowableArray<TSExplicitList<SGAMEDATA,-572662307>>::Destructor(&this->tSlotListArray);
  (this->tSlotListArray).m_alloc = 0;
  (this->tSlotListArray).m_count = 0;
  (this->tSlotListArray).m_data = (TSExplicitList<SGAMEDATA,_572662307> *)0x0;
  return;
}

`;

const form = 'cache(&pThis->tSlotListArray,pArray,TSGrowableArray<TSExplicitList<SGAMEDATA, -572662307>>*,@call)';
// flattenTemplateNames rewrites the live decompile before vc8FormSpec checks dh.
// This is a codegen probe seal, not a proposed live tag.
const normalizedHash = '24218596';
const probeTag = { type: 'vc8form', data: `${form};ev=0000000000;bh=40-8561c9a1;dh=${normalizedHash}` };
const base: ExtractedFunction = {
  name: 'Destroy', address: '0x00450520',
  signature: 'void Destroy(TSHashTable<SGAMEDATA,HASHKEY_NONE> * this)', returnType: 'void',
  parameters: [{ name: 'this', dataType: 'TSHashTable<SGAMEDATA,HASHKEY_NONE> *', size: 4, ordinal: 0, storage: 'ECX:4 (auto)' }],
  localVariables: [], callingConvention: '__thiscall', size: 40, isThunk: false, isExternal: false,
  hasVarArgs: false, namespace: 'TSHashTable<SGAMEDATA,HASHKEY_NONE>', decompiled,
  tags: [{ type: 'blizzard-name' }], calledFunctions: ['InternalClear', 'Destructor'],
};
const options: ReconstructOptions = {
  outputDir: './out', format: 'cpp', organization: 'namespace',
  generateCMake: false, generateSourceMaps: false, transformPreset: 'full',
  includeAddressComments: false, promoteStaticGlobals: false,
};
const programInfo: ProgramInfo = {
  name: 'Game.exe', path: '/Redivivus/Game.exe', format: 'PE', architecture: 'x86',
  compiler: 'msvc', imageBase: '0x400000', languageId: 'x86:LE:32:default',
  endianness: 'little', pointerSize: 4,
};
const namespaces: ExtractedNamespace[] = [
  { name: 'TSHashTable<SGAMEDATA,HASHKEY_NONE>', fullPath: 'TSHashTable<SGAMEDATA,HASHKEY_NONE>', functionCount: 1, isClass: true },
];

function emitted(tags: ExtractedFunction['tags']): string {
  const project = generateProject('cache-250-destroy', [{ ...base, tags }], [], [], [], namespaces, options, programInfo);
  return [...project.files.values()].filter(f => f.type === 'implementation').map(f => f.content).join('\n');
}

describe('Redivivus issue #250 live Destroy cache', () => {
  it('records the live body hash and normalized probe hash separately', () => {
    assert.equal(vc8formBodyHash(decompiled), '211b70bd');
    assert.equal(vc8FormSpec({ ...base, tags: [probeTag] })?.stale.length, 1);
  });

  it('emits the address cache but retains the static call in this minimal fixture', () => {
    const absent = emitted(base.tags);
    const tagged = emitted([...(base.tags ?? []), probeTag]);
    const staleTag = { ...probeTag, data: probeTag.data.replace(`dh=${normalizedHash}`, 'dh=ffffffff') };
    const stale = emitted([...(base.tags ?? []), staleTag]);
    assert.equal(stale, absent);
    assert.notEqual(tagged, absent);
    assert.match(tagged, /pArray = &pThis->tSlotListArray;/);
    assert.match(tagged, /TSGrowableArray<TSExplicitList<SGAMEDATA, -572662307>>::Destructor\(&\*pArray\)/);
    assert.match(tagged, /pArray->m_alloc = 0;\n    pArray->m_count = 0;\n    pArray->m_data = 0;/);
    assert.doesNotMatch(tagged, /pArray->Destructor\(\)/);
  });
});
