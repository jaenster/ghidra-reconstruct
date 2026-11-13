/** Exact-live Windows pseudocode for the remaining issue #250 §9 Destroy sites. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { generateProject } from '../codegen/index.js';
import { vc8formBodyHash, vc8FormSpec } from '../codegen/vc8form-spec.js';
import type { ExtractedDataType, ExtractedFunction, ExtractedNamespace, ProgramInfo, ReconstructOptions } from '../types.js';

interface Case { address: string; element: string; key: string; module: string; clear: string; arrayDestructor: string; dh: string }
const cases: Case[] = [
  { address: '00603780', element: 'CELLIST', key: 'HASHKEY_NONE', module: 'D2CMP', clear: '00602800', arrayDestructor: '00603060', dh: 'f0050322' },
  { address: '00610020', element: 'StringEntryNode', key: 'HASHKEY_STRI', module: 'D2Common', clear: '0060eb70', arrayDestructor: '0060f610', dh: 'a9645b72' },
  { address: '006107d0', element: 'MappingEntryNode', key: 'HASHKEY_STRI', module: 'D2Common', clear: '0060ee60', arrayDestructor: '0060f950', dh: '7f7fd55f' },
];
const programInfo: ProgramInfo = { name: 'Game.exe', path: '/Redivivus/Game.exe', format: 'PE', architecture: 'x86',
  compiler: 'msvc', imageBase: '0x400000', languageId: 'x86:LE:32:default', endianness: 'little', pointerSize: 4 };

function fixture(c: Case) {
  const hashTable = `TSHashTable<${c.element},${c.key}>`;
  const array = `TSGrowableArray<TSExplicitList<${c.element},-572662307>>`;
  const decompiled = readFileSync(new URL(`./live-${c.address}.txt`, import.meta.url), 'utf8');
  const bodyHash = vc8formBodyHash(decompiled);
  assert.equal(bodyHash, c.dh, `${c.address} live decompile changed`);
  const form = `cache(&this->tSlotListArray,pArray,TSGrowableArray<TSExplicitList<${c.element}, -572662307>>*,@call)`;
  // ev is a fixture placeholder; bh is the oracle-masked live reference hash.
  const probeTag = { type: 'vc8form', data: `${form};ev=0000000000;bh=40-8561c9a1;dh=${bodyHash}` };
  const target: ExtractedFunction = {
    name: 'Destroy', address: `0x${c.address}`,
    signature: `void Destroy(${hashTable} * this)`, returnType: 'void',
    parameters: [{ name: 'this', dataType: `${hashTable} *`, size: 4, ordinal: 0, storage: 'ECX:4 (auto)' }],
    localVariables: [], callingConvention: '__thiscall', size: 40, isThunk: false, isExternal: false,
    hasVarArgs: false, namespace: hashTable, decompiled,
    tags: [{ type: 'blizzard-name' }], calledFunctions: ['InternalClear', 'Destructor'],
  };
  const internalClear: ExtractedFunction = {
    name: 'InternalClear', address: `0x${c.clear}`,
    signature: `void InternalClear(${hashTable} * this, int32_t bUnlinkOnly)`, returnType: 'void',
    parameters: [
      { name: 'this', dataType: `${hashTable} *`, size: 4, ordinal: 0, storage: 'ECX:4 (auto)' },
      { name: 'bUnlinkOnly', dataType: 'int32_t', size: 4, ordinal: 1, storage: 'Stack[0x4]:4' },
    ], localVariables: [], callingConvention: '__thiscall', size: 142, isThunk: false, isExternal: false,
    hasVarArgs: false, namespace: hashTable,
    decompiled: `void __thiscall ${hashTable}::InternalClear(${hashTable} *this,int32_t bUnlinkOnly)\n{\n return;\n}\n`,
    tags: [], calledFunctions: [],
  };
  const arrayDestructor: ExtractedFunction = {
    name: 'Destructor', address: `0x${c.arrayDestructor}`,
    signature: `void Destructor(${array} * this)`, returnType: 'void',
    parameters: [{ name: 'this', dataType: `${array} *`, size: 4, ordinal: 0, storage: 'ECX:4 (auto)' }],
    localVariables: [], callingConvention: '__thiscall', size: 128, isThunk: false, isExternal: false,
    hasVarArgs: false, namespace: array,
    decompiled: `void __thiscall ${array}::Destructor(${array} *this)\n{\n return;\n}\n`,
    tags: [], calledFunctions: [],
  };
  const options: ReconstructOptions = {
    outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false,
    generateSourceMaps: false, transformPreset: 'full', includeAddressComments: false, promoteStaticGlobals: false,
    projectConfig: { version: 1, project: 'cache250-destroy-siblings',
      modules: { [c.module]: { namespaces: [c.module] } },
      moduleRuns: [{ module: c.module, start: '00600000', end: '00620000' }],
      templates: { header: '3rdparty/Storm/H/stpl.h', implPrefix: 'stpl_',
        families: {
          TSExplicitList: { key: 'class', params: [{ name: 'T', kind: 'type' }, { name: 'OFFSET', kind: 'int' }] },
          TSGrowableArray: { key: 'class', params: [{ name: 'T', kind: 'type' }] },
          TSHashTable: { key: 'class', params: [{ name: 'T', kind: 'type' }, { name: 'TKey', kind: 'type' }] },
        }, classes: { [c.key]: { key: 'class' } } },
    } as never,
  };
  const namespaces: ExtractedNamespace[] = [
    { name: hashTable, fullPath: hashTable, functionCount: 1, isClass: true },
    { name: array, fullPath: array, functionCount: 1, isClass: false },
  ];
  const dataTypes: ExtractedDataType[] = c.key === 'HASHKEY_NONE'
    ? [{ kind: 'STRUCTURE', name: c.key, category: '/', size: 1, fields: [] } as ExtractedDataType]
    : [{ kind: 'STRUCTURE', name: c.key, category: '/', size: 4,
        fields: [{ name: 'szString', offset: 0, size: 4, dataType: 'char *' }] } as ExtractedDataType];
  const emit = (tags: ExtractedFunction['tags']) => {
    const project = generateProject('cache-250-destroy-siblings',
      structuredClone([{ ...target, tags }, internalClear, arrayDestructor]), [],
      structuredClone(dataTypes), [], structuredClone(namespaces), options, programInfo);
    return [...project.files.values()].filter(f => f.type === 'implementation').map(f => f.content).join('\n');
  };
  return { bodyHash, form, probeTag, target, emit };
}

for (const c of cases) describe(`Redivivus issue #250 ${c.address} live Destroy cache`, () => {
  it('accepts the exact-live hash and emits member calls with a typed pArray', () => {
    const { bodyHash, probeTag, target, emit } = fixture(c);
    assert.equal(vc8FormSpec({ ...target, tags: [probeTag] })?.forms.length, 1);
    const absent = emit(target.tags);
    const tagged = emit([...(target.tags ?? []), probeTag]);
    const stale = emit([...(target.tags ?? []), { ...probeTag, data: probeTag.data.replace(`dh=${bodyHash}`, 'dh=ffffffff') }]);
    assert.equal(stale, absent);
    assert.notEqual(tagged, absent);
    assert.match(absent, /this->InternalClear\(1\)/);
    assert.doesNotMatch(absent, /pArray/);
    assert.match(tagged, /this->InternalClear\(1\)/);
    assert.match(tagged, /pArray = &this->tSlotListArray;/);
    assert.match(tagged, /pArray->TSGrowableArray<TSExplicitList<[^\n]+>>::Destructor\(\)/);
    assert.match(tagged, /pArray->m_alloc = 0;\n    pArray->m_count = 0;\n    pArray->m_data = 0;/);
    console.log(`${c.address} dh=${bodyHash} absent/tagged/stale passed`);
  });
});
