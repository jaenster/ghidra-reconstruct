/** Live Windows Redivivus 00450520 pseudocode and metadata, 2026-11-11.
 * Callee bodies and HASHKEY_NONE are minimal context fixtures, not a full snapshot. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateProject } from '../codegen/index.js';
import { vc8formBodyHash, vc8FormSpec } from '../codegen/vc8form-spec.js';
import type { ExtractedDataType, ExtractedFunction, ExtractedNamespace, ProgramInfo, ReconstructOptions } from '../types.js';

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

const form = 'cache(&this->tSlotListArray,pArray,TSGrowableArray<TSExplicitList<SGAMEDATA, -572662307>>*,@call)';
// With the template registry present, dh is the exact live token hash. ev remains
// fixture-only until a positive native check is attached to a durable evidence row.
const bodyHash = '211b70bd';
const probeTag = { type: 'vc8form', data: `${form};ev=0000000000;bh=40-8561c9a1;dh=${bodyHash}` };
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
  projectConfig: {
    version: 1, project: 'cache250-context',
    modules: { D2Client: { namespaces: ['D2Client'] } },
    moduleRuns: [{ module: 'D2Client', start: '00440000', end: '00460000' }],
    templates: {
      header: '3rdparty/Storm/H/stpl.h', implPrefix: 'stpl_',
      families: {
        TSExplicitList: { key: 'class', params: [{ name: 'T', kind: 'type' }, { name: 'OFFSET', kind: 'int' }] },
        TSGrowableArray: { key: 'class', params: [{ name: 'T', kind: 'type' }] },
        TSHashTable: { key: 'class', params: [{ name: 'T', kind: 'type' }, { name: 'TKey', kind: 'type' }] },
      },
      classes: { HASHKEY_NONE: { key: 'class' } },
    },
  } as never,
};
const programInfo: ProgramInfo = {
  name: 'Game.exe', path: '/Redivivus/Game.exe', format: 'PE', architecture: 'x86',
  compiler: 'msvc', imageBase: '0x400000', languageId: 'x86:LE:32:default',
  endianness: 'little', pointerSize: 4,
};
const namespaces: ExtractedNamespace[] = [
  { name: 'TSHashTable<SGAMEDATA,HASHKEY_NONE>', fullPath: 'TSHashTable<SGAMEDATA,HASHKEY_NONE>', functionCount: 1, isClass: true },
  { name: 'TSGrowableArray<TSExplicitList<SGAMEDATA,-572662307>>', fullPath: 'TSGrowableArray<TSExplicitList<SGAMEDATA,-572662307>>', functionCount: 1, isClass: false },
];
const dataTypes: ExtractedDataType[] = [
  { kind: 'STRUCTURE', name: 'HASHKEY_NONE', category: '/', size: 1, fields: [] } as ExtractedDataType,
];

const internalClear: ExtractedFunction = {
  name: 'InternalClear', address: '0x0044fa00',
  signature: 'void InternalClear(TSHashTable<SGAMEDATA,HASHKEY_NONE> * this, int32_t bUnlinkOnly)', returnType: 'void',
  parameters: [
    { name: 'this', dataType: 'TSHashTable<SGAMEDATA,HASHKEY_NONE> *', size: 4, ordinal: 0, storage: 'ECX:4 (auto)' },
    { name: 'bUnlinkOnly', dataType: 'int32_t', size: 4, ordinal: 1, storage: 'Stack[0x4]:4' },
  ], localVariables: [], callingConvention: '__thiscall', size: 142, isThunk: false, isExternal: false,
  hasVarArgs: false, namespace: 'TSHashTable<SGAMEDATA,HASHKEY_NONE>',
  decompiled: 'void __thiscall TSHashTable<SGAMEDATA,HASHKEY_NONE>::InternalClear(TSHashTable<SGAMEDATA,HASHKEY_NONE> *this,int32_t bUnlinkOnly)\n{\n return;\n}\n',
  tags: [], calledFunctions: [],
};
const arrayDestructor: ExtractedFunction = {
  name: 'Destructor', address: '0x0044ff60',
  signature: 'void Destructor(TSGrowableArray<TSExplicitList<SGAMEDATA,-572662307>> * this)', returnType: 'void',
  parameters: [{ name: 'this', dataType: 'TSGrowableArray<TSExplicitList<SGAMEDATA,-572662307>> *', size: 4, ordinal: 0, storage: 'ECX:4 (auto)' }],
  localVariables: [], callingConvention: '__thiscall', size: 128, isThunk: false, isExternal: false,
  hasVarArgs: false, namespace: 'TSGrowableArray<TSExplicitList<SGAMEDATA,-572662307>>',
  decompiled: 'void __thiscall TSGrowableArray<TSExplicitList<SGAMEDATA,-572662307>>::Destructor(TSGrowableArray<TSExplicitList<SGAMEDATA,-572662307>> *this)\n{\n return;\n}\n',
  tags: [], calledFunctions: [],
};

function emitted(tags: ExtractedFunction['tags']): string {
  const project = generateProject('cache-250-destroy', structuredClone([{ ...base, tags }, internalClear, arrayDestructor]), [], structuredClone(dataTypes), [], structuredClone(namespaces), options, programInfo);
  return [...project.files.values()].filter(f => f.type === 'implementation').map(f => f.content).join('\n');
}

describe('Redivivus issue #250 live Destroy cache with template context', () => {
  it('uses the exact live body hash', () => {
    assert.equal(vc8formBodyHash(decompiled), bodyHash);
    assert.equal(vc8FormSpec({ ...base, tags: [probeTag] })?.forms.length, 1);
  });

  it('emits the address cache and preserves member calls in template context', () => {
    const absent = emitted(base.tags);
    const tagged = emitted([...(base.tags ?? []), probeTag]);
    const staleTag = { ...probeTag, data: probeTag.data.replace(`dh=${bodyHash}`, 'dh=ffffffff') };
    const stale = emitted([...(base.tags ?? []), staleTag]);
    assert.equal(stale, absent);
    assert.notEqual(tagged, absent);
    assert.match(tagged, /pArray = &this->tSlotListArray;/);
    assert.match(tagged, /pArray->TSGrowableArray<TSExplicitList<SGAMEDATA, -572662307>>::Destructor\(\)/);
    assert.match(tagged, /pArray->m_alloc = 0;\n    pArray->m_count = 0;\n    pArray->m_data = 0;/);
    assert.match(tagged, /this->InternalClear\(1\)/);
  });
});
