/**
 * A registered class template end to end: project.json `templates` -> the
 * template header with the primary templates and one explicit specialization
 * declared per member, the members defined in a unit beside the module code
 * they were linked with, a caller spelling the template-id, and the whole set
 * compiling under the mingw the tree is built with.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  assertNoShardPlaceholders,
  generateProject,
  generateProjectStage1,
  generateProjectStage2,
  mergeShardOutput,
  takeShardOutput,
  type ShardOutput,
} from '../codegen/index.js';
import { setTemplateRegistry } from '../codegen/templates/registry.js';
import type {
  AnalyzedDataSymbol,
  ExtractedDataType,
  ExtractedFunction,
  ExtractedNamespace,
  ExtractedString,
  ProgramInfo,
  ReconstructOptions,
} from '../types.js';
import type { TemplatesConfig } from '../config/schema.js';

const GPP = 'i686-w64-mingw32-g++';
function haveGpp(): boolean {
  try { execFileSync(GPP, ['--version'], { stdio: 'pipe' }); return true; } catch { return false; }
}

const programInfo: ProgramInfo = {
  name: 'T.exe', path: '/tmp/T.exe', format: 'PE', architecture: 'x86', compiler: 'msvc',
  imageBase: '0x400000', languageId: 'x86:LE:32:default', endianness: 'little', pointerSize: 4,
};

export const TEMPLATES: TemplatesConfig = {
  header: 'Storm/H/stpl.h',
  implPrefix: 'stpl_',
  families: {
    TSLink: { key: 'class', params: [{ name: 'T', kind: 'type' }] },
    TSExplicitList: { key: 'class', params: [{ name: 'T', kind: 'type' }, { name: 'OFFSET', kind: 'int' }] },
    TSSync: { key: 'class', params: [{ name: 'T', kind: 'type' }, { name: 'TSync', kind: 'type' }] },
    // An element's base, and a class with a base, as Storm's TSHashObject and TSHashTableReuse.
    TSObject: { key: 'class', params: [{ name: 'T', kind: 'type' }] },
    TSTable: { key: 'class', params: [{ name: 'T', kind: 'type' }] },
    TSTableEx: { key: 'class', params: [{ name: 'T', kind: 'type' }], base: 'TSTable<T>' },
  },
  classes: { KEY: { key: 'class' } },
};

function options(templates: TemplatesConfig | undefined): ReconstructOptions {
  return {
    outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false,
    generateSourceMaps: false, transformPreset: 'full', includeAddressComments: false,
    promoteStaticGlobals: false, excludeNamespaces: ['Ext'],
    projectConfig: {
      version: 1, project: 't', modules: { Mod: { namespaces: ['Mod'] } }, templates,
      moduleRuns: [{ module: 'Mod', start: '00401000', end: '00402000' }],
      // A class a template holds by value, in a header of its own.
      typeOwnership: [{ type: 'SYNC', header: 'Lib/SYNC.h' }, { type: 'AWAITER', header: 'Lib/SYNC.h' }],
    } as never,
  } as ReconstructOptions;
}

function thiscall(ns: string, name: string, address: string, body: string, ret = 'void'): ExtractedFunction {
  return {
    name, address, namespace: ns, returnType: ret,
    signature: `${ret} ${name}(${ns} * this)`,
    parameters: [{ name: 'this', dataType: `${ns} *`, size: 4, ordinal: 0, storage: 'ECX:4 (auto)' }],
    localVariables: [], callingConvention: '__thiscall', size: 0x20,
    isThunk: false, isExternal: false, hasVarArgs: false, calledFunctions: [],
    decompiled: `${ret} __thiscall\n${ns}::${name}(${ns} *this)\n\n{\n${body}\n}\n`,
  } as ExtractedFunction;
}

function model() {
  const list = (el: string) => `TSExplicitList<${el},-572662307>`;
  const dataTypes: ExtractedDataType[] = [
    { kind: 'STRUCTURE', name: 'ELEM', category: '/', size: 12, fields: [
      { name: 'm_link', dataType: 'TSLink<ELEM>', offset: 0, size: 8 },
      { name: 'nValue', dataType: 'int', offset: 8, size: 4 },
    ] } as ExtractedDataType,
    { kind: 'STRUCTURE', name: 'KEY', category: '/', size: 4, fields: [
      { name: 'szString', dataType: 'char *', offset: 0, size: 4 },
    ] } as ExtractedDataType,
    { kind: 'STRUCTURE', name: 'SYNC', category: '/', size: 12, fields: [
      { name: 'm_lock', dataType: 'int', offset: 0, size: 4 },
      { name: 'm_waiter', dataType: 'AWAITER', offset: 4, size: 4 },
      { name: 'pfnWake', dataType: 'fpWake', offset: 8, size: 4 },
    ] } as ExtractedDataType,
    // Beside SYNC in its header: held by it, so defined first, and naming it by pointer.
    { kind: 'STRUCTURE', name: 'AWAITER', category: '/', size: 4, fields: [
      { name: 'pSync', dataType: 'SYNC *', offset: 0, size: 4 },
    ] } as ExtractedDataType,
    // A callback type over SYNC that SYNC's header uses.
    { kind: 'FUNCTION_DEFINITION', name: 'fpWake', category: '/', size: 4, returnType: 'void',
      parameters: [{ name: 'pSync', dataType: 'SYNC *', ordinal: 0 }] } as ExtractedDataType,
    // A class element: RTTI records `class PEER`.
    { kind: 'STRUCTURE', name: 'PEER', category: '/', size: 8, fields: [
      { name: 'm_link', dataType: 'TSLink<PEER>', offset: 0, size: 8 },
    ] } as ExtractedDataType,
    { kind: 'STRUCTURE', name: 'TSLink<PEER>', category: '/', size: 8, fields: [
      { name: 'm_prevlink', dataType: 'TSLink<PEER> *', offset: 0, size: 4 },
      { name: 'm_next', dataType: 'int', offset: 4, size: 4 },
    ] } as ExtractedDataType,
    // Held by two instantiations, as CCritSect is: no one container claims it.
    ...['ELEM', 'OTHER'].map(el => ({ kind: 'STRUCTURE', name: `TSSync<${el},SYNC>`, category: '/', size: 16, fields: [
      { name: 'm_count', dataType: 'int', offset: 0, size: 4 },
      { name: 'm_sync', dataType: 'SYNC', offset: 4, size: 12 },
    ] }) as ExtractedDataType),
    // NODE derives from TSObject<NODE>; TSTableEx<NODE> from TSTable<NODE>. Ghidra models
    // each base as the first member, `super_<Class>`.
    { kind: 'STRUCTURE', name: 'NODE', category: '/', size: 12, fields: [
      { name: 'super_TSObject', dataType: 'TSObject<NODE>', offset: 0, size: 8 },
      { name: 'nValue', dataType: 'int', offset: 8, size: 4 },
    ] } as ExtractedDataType,
    { kind: 'STRUCTURE', name: 'TSObject<NODE>', category: '/', size: 8, fields: [
      { name: 'm_hashval', dataType: 'uint', offset: 0, size: 4 },
      { name: 'm_link', dataType: 'TSLink<NODE>', offset: 4, size: 8 },
    ] } as ExtractedDataType,
    { kind: 'STRUCTURE', name: 'TSLink<NODE>', category: '/', size: 8, fields: [
      { name: 'm_prevlink', dataType: 'TSLink<NODE> *', offset: 0, size: 4 },
      { name: 'm_next', dataType: 'int', offset: 4, size: 4 },
    ] } as ExtractedDataType,
    { kind: 'STRUCTURE', name: 'TSTable<NODE>', category: '/', size: 4, fields: [
      { name: 'm_count', dataType: 'int', offset: 0, size: 4 },
    ] } as ExtractedDataType,
    { kind: 'STRUCTURE', name: 'TSTableEx<NODE>', category: '/', size: 8, fields: [
      { name: 'super_TSTable', dataType: 'TSTable<NODE>', offset: 0, size: 4 },
      { name: 'm_extra', dataType: 'int', offset: 4, size: 4 },
    ] } as ExtractedDataType,
    { kind: 'STRUCTURE', name: 'OTHER', category: '/', size: 8, fields: [
      { name: 'm_link', dataType: 'TSLink<OTHER>', offset: 0, size: 8 },
    ] } as ExtractedDataType,
    ...['ELEM', 'OTHER'].flatMap(el => [
      { kind: 'STRUCTURE', name: `TSLink<${el}>`, category: '/', size: 8, fields: [
        { name: 'm_prevlink', dataType: `TSLink<${el}> *`, offset: 0, size: 4 },
        { name: 'm_next', dataType: 'int', offset: 4, size: 4 },
      ] } as ExtractedDataType,
      { kind: 'STRUCTURE', name: list(el), category: '/', size: 12, fields: [
        { name: 'm_linkoffset', dataType: 'int', offset: 0, size: 4 },
        { name: 'm_terminator', dataType: `TSLink<${el}>`, offset: 4, size: 8 },
      ] } as ExtractedDataType,
    ]),
  ];
  const body = (el: string) => `  (this->m_terminator).m_prevlink = &this->m_terminator;\n  (this->m_terminator).m_next = ~(uint)&this->m_terminator;\n  return;`;
  const functions: ExtractedFunction[] = [
    {
      name: 'Caller', address: '00401000', namespace: 'Mod::File', returnType: 'void',
      signature: `void Caller(${list('ELEM')} * pList)`, localVariables: [], callingConvention: '__cdecl',
      parameters: [{ name: 'pList', dataType: `${list('ELEM')} *`, size: 4, ordinal: 0, storage: 'Stack[0x4]:4' }],
      size: 0x10, isThunk: false, isExternal: false, hasVarArgs: false, calledFunctions: ['UnlinkAll'],
      decompiled: `void Mod::File::Caller(${list('ELEM')} *pList)\n\n{\n  ${list('ELEM')}::UnlinkAll(&gList);\n  ${list('ELEM')}::UnlinkAll(pList);\n  return;\n}\n`,
    } as ExtractedFunction,
    {
      // A template-id in the body alone.
      name: 'Body', address: '00401080', namespace: 'Mod::Other', returnType: 'void',
      signature: 'void Body(void)', parameters: [], localVariables: [], callingConvention: '__cdecl',
      size: 0x10, isThunk: false, isExternal: false, hasVarArgs: false, calledFunctions: [],
      decompiled: `void Mod::Other::Body(void)\n\n{\n  ((${list('ELEM')} *)0x10)->m_linkoffset = 0;\n  return;\n}\n`,
    } as ExtractedFunction,
    {
      // An address literal that lands on a class's datum.
      name: 'Literal', address: '00401088', namespace: 'Mod::Third', returnType: 'void',
      signature: 'void Literal(void)', parameters: [], localVariables: [], callingConvention: '__cdecl',
      size: 0x10, isThunk: false, isExternal: false, hasVarArgs: false, calledFunctions: [],
      decompiled: `void Mod::Third::Literal(void)\n\n{\n  ((${list('OTHER')} *)0x500100)->m_linkoffset = 0;\n  return;\n}\n`,
    } as ExtractedFunction,
    // A class namespace of the element's name: inside any `namespace Class::...` the
    // name ELEM is that namespace, so a template argument has to say `::ELEM`.
    {
      name: 'Release', address: '00401090', namespace: 'ELEM', returnType: 'void',
      signature: 'void Release(void)', parameters: [], localVariables: [], callingConvention: '__cdecl',
      size: 0x10, isThunk: false, isExternal: false, hasVarArgs: false, calledFunctions: [],
      decompiled: 'void ELEM::Release(void)\n\n{\n  return;\n}\n',
    } as ExtractedFunction,
    {
      // A class by pointer, in a header that does not define it.
      name: 'UseSync', address: '004010a0', namespace: 'Mod::Third', returnType: 'void',
      signature: 'void UseSync(SYNC * pSync)', localVariables: [], callingConvention: '__cdecl',
      parameters: [{ name: 'pSync', dataType: 'SYNC *', size: 4, ordinal: 0, storage: 'Stack[0x4]:4' }],
      size: 0x10, isThunk: false, isExternal: false, hasVarArgs: false, calledFunctions: [],
      decompiled: 'void Mod::Third::UseSync(SYNC *pSync)\n\n{\n  pSync->m_lock = 0;\n  SyncWait(pSync);\n  gSync_cur = pSync;\n  gpExtSync = pSync;\n  return;\n}\n',
    } as ExtractedFunction,
    {
      name: 'GetSync', address: '004010b0', namespace: 'Mod::Third', returnType: 'SYNC *',
      signature: 'SYNC * GetSync(NOSTRUCT * pOpaque)', localVariables: [], callingConvention: '__cdecl',
      // A class RTTI names that the program has no structure for.
      parameters: [{ name: 'pOpaque', dataType: 'NOSTRUCT *', size: 4, ordinal: 0, storage: 'Stack[0x4]:4' }],
      size: 0x10, isThunk: false, isExternal: false, hasVarArgs: false, calledFunctions: [],
      decompiled: 'SYNC * Mod::Third::GetSync(NOSTRUCT *pOpaque)\n\n{\n  return (SYNC *)0x0;\n}\n',
    } as ExtractedFunction,
    {
      // In a namespace the build excludes: its callers get a declaration only.
      name: 'SyncWait', address: '00403000', namespace: 'Ext', returnType: 'void',
      signature: 'void SyncWait(SYNC * pSync)', localVariables: [], callingConvention: '__cdecl',
      parameters: [{ name: 'pSync', dataType: 'SYNC *', size: 4, ordinal: 0, storage: 'Stack[0x4]:4' }],
      size: 0x10, isThunk: false, isExternal: false, hasVarArgs: false, calledFunctions: [],
      decompiled: 'void Ext::SyncWait(SYNC *pSync)\n\n{\n  return;\n}\n',
    } as ExtractedFunction,
    {
      name: 'Release', address: '004010c0', namespace: 'PEER', returnType: 'void',
      signature: 'void Release(void)', parameters: [], localVariables: [], callingConvention: '__cdecl',
      size: 0x10, isThunk: false, isExternal: false, hasVarArgs: false, calledFunctions: [],
      decompiled: 'void PEER::Release(void)\n\n{\n  return;\n}\n',
    } as ExtractedFunction,
    thiscall('TSLink<PEER>', 'Clear', '00401240', '  this->m_next = 0;\n  return;'),
    // A body that reseats its receiver, as Ghidra's register reuse writes it.
    thiscall('TSLink<PEER>', 'Reseat', '00401260', '  this->m_next = 1;\n  this = this->m_prevlink;\n  this->m_next = 2;\n  return;'),
    thiscall(list('ELEM'), 'UnlinkAll', '00401100', body('ELEM')),
    // Ghidra tags a COMDAT copy no member owns.
    { ...thiscall(list('ELEM'), 'UnlinkAll_Unreferenced', '00401140', body('ELEM')), tags: [{ type: 'ORPHAN_COPY' }] },
    // Named like one, but untagged: a member like any other.
    thiscall(list('OTHER'), 'UnlinkAll_Unreferenced', '004011a0', body('OTHER')),
    thiscall(list('OTHER'), 'UnlinkAll', '00401180', body('OTHER')),
    thiscall('KEY', 'Clear', '004011c0', '  this->szString = (char *)0x0;\n  return;'),
    thiscall('TSSync<ELEM,SYNC>', 'Lock', '00401200', '  this->m_count = 1;\n  return;'),
    thiscall('TSObject<NODE>', 'Destroy', '00401300', '  this->m_hashval = 0;\n  return;'),
    thiscall('TSTable<NODE>', 'Clear', '00401340', '  this->m_count = 0;\n  return;'),
    thiscall('TSTable<NODE>', 'Count', '00401350', '  this->m_count = this->m_count + 1;\n  return;'),
    // The derived class's own Count hides the base's.
    thiscall('TSTableEx<NODE>', 'Count', '00401360', '  TSTable<NODE>::Count((TSTable<NODE> *)this);\n  return;'),
    // A JMP thunk Ghidra left beside the members, forwarding to one.
    { ...thiscall('TSTable<NODE>', 'thunk_Clear', '00401370', ''), isThunk: true, decompiled: '', tags: [{ type: 'ORPHAN_COPY' }],
      thunkTarget: { address: '00401340', name: 'Clear', namespace: 'TSTable<NODE>', isExternal: false } },
    // A thunk on the derived class to the base's Count, which the derived class's own Count hides.
    { ...thiscall('TSTableEx<NODE>', 'thunk_Count', '00401374', ''), isThunk: true, decompiled: '', tags: [{ type: 'ORPHAN_COPY' }],
      thunkTarget: { address: '00401350', name: 'Count', namespace: 'TSTable<NODE>', isExternal: false } },
    // A thunk that is a member itself: its receiver is its `this`.
    { ...thiscall('TSTable<NODE>', 'CountThunk', '00401378', ''), isThunk: true, decompiled: '',
      thunkTarget: { address: '00401350', name: 'Count', namespace: 'TSTable<NODE>', isExternal: false } },
    // Ghidra reaches the base through its component, and casts the receiver to it.
    thiscall('TSTableEx<NODE>', 'Reset', '00401380',
      '  TSTable<NODE>::Clear((TSTable<NODE> *)this);\n  (this->super_TSTable).m_count = 1;\n  this->m_extra = 2;\n  TSTableEx<NODE>::Count(this);\n  return;'),
    {
      name: 'UseNode', address: '004013c0', namespace: 'Mod::Third', returnType: 'void',
      signature: 'void UseNode(NODE * pNode)', localVariables: [], callingConvention: '__cdecl',
      parameters: [{ name: 'pNode', dataType: 'NODE *', size: 4, ordinal: 0, storage: 'Stack[0x4]:4' }],
      size: 0x10, isThunk: false, isExternal: false, hasVarArgs: false, calledFunctions: ['Destroy'],
      decompiled: 'void Mod::Third::UseNode(NODE *pNode)\n\n{\n  TSObject<NODE>::Destroy(&pNode->super_TSObject);\n  (pNode->super_TSObject).m_hashval = 3;\n  TSTable<NODE>::Clear((TSTable<NODE> *)&gTable);\n  TSTable<NODE>::Count((TSTable<NODE> *)&gTable);\n  TSObject<NODE>::Destroy((TSObject<NODE> *)gpNode);\n  return;\n}\n',
    } as ExtractedFunction,
    // The element's own namespace declares a Destroy: it hides the base's.
    thiscall('NODE', 'Destroy', '004013e0', '  return;'),
    // An element's orphan copy: no member of the element, a free function beside the members.
    { ...thiscall('ELEM', 'Release_Unreferenced', '004013f0', '  return;'), tags: [{ type: 'ORPHAN_COPY' }] },
  ];
  const globals = [{
    name: 'gList', address: '00500000', dataType: list('ELEM'), size: 12, namespace: 'Mod::File',
    isInitialized: false, xrefCount: 1, referencingFunctions: ['Mod::File::Caller'], scope: 'global',
  }, {
    name: 'gpSync', address: '00500010', dataType: 'SYNC *', size: 4, namespace: null,
    isInitialized: false, xrefCount: 1, referencingFunctions: ['Mod::Third::UseSync'], scope: 'global',
  }, {
    // A name globals.h cannot spell: declared by the closure under the body's spelling.
    name: 'gSync.cur', address: '00500020', dataType: 'SYNC *', size: 4, namespace: null,
    isInitialized: false, xrefCount: 1, referencingFunctions: ['Mod::Third::UseSync'], scope: 'global',
  }, {
    // Data of the excluded namespace a kept body uses: declared by the closure.
    name: 'gpExtSync', address: '00500030', dataType: 'SYNC *', size: 4, namespace: 'Ext',
    isInitialized: false, xrefCount: 1, referencingFunctions: ['Mod::Third::UseSync'], scope: 'global',
  }, {
    // A class's datum in its scope: a static data member, initialized with a member's address.
    name: 'vftable', address: '00500100', dataType: 'pointer[1]', size: 4, namespace: list('ELEM'),
    isInitialized: true, xrefCount: 0, referencingFunctions: [], scope: 'global',
    initializedData: { kind: 'array', elements: [{ kind: 'pointer', value: `${list('ELEM')}::UnlinkAll` }] },
  }, {
    name: 'gpNode', address: '00500040', dataType: 'NODE *', size: 4, namespace: 'Mod::Third',
    isInitialized: false, xrefCount: 1, referencingFunctions: ['Mod::Third::UseNode'], scope: 'global',
  }, {
    // A class with a base, initialized: the base subobject comes first.
    name: 'gTable', address: '00500200', dataType: 'TSTableEx<NODE>', size: 8, namespace: 'Mod::Third',
    isInitialized: true, xrefCount: 1, referencingFunctions: ['Mod::Third::UseNode'], scope: 'global',
    initializedData: { kind: 'struct', fields: [
      { name: 'super_TSTable', value: { kind: 'struct', fields: [{ name: 'm_count', value: { kind: 'scalar', value: '4' } }] } },
      { name: 'm_extra', value: { kind: 'scalar', value: '5' } },
    ] },
  }, {
    // A class with a base, all zero: C++03 has no list initialization for it.
    name: 'gTableZero', address: '00500300', dataType: 'TSTableEx<NODE>', size: 8, namespace: 'Mod::Third',
    isInitialized: true, xrefCount: 1, referencingFunctions: ['Mod::Third::UseNode'], scope: 'global',
    initializedData: { kind: 'struct', fields: [
      { name: 'super_TSTable', value: { kind: 'struct', fields: [{ name: 'm_count', value: { kind: 'scalar', value: '0' } }] } },
      { name: 'm_extra', value: { kind: 'scalar', value: '0' } },
    ] },
  }] as unknown as AnalyzedDataSymbol[];
  const namespaces: ExtractedNamespace[] = [
    { name: 'File', fullPath: 'Mod::File', isClass: false, functionCount: 1 },
    { name: 'Other', fullPath: 'Mod::Other', isClass: false, functionCount: 1 },
    { name: 'Third', fullPath: 'Mod::Third', isClass: false, functionCount: 1 },
    { name: 'ELEM', fullPath: 'ELEM', isClass: true, functionCount: 1 },
    { name: list('ELEM'), fullPath: list('ELEM'), isClass: false, functionCount: 2 },
    { name: list('OTHER'), fullPath: list('OTHER'), isClass: false, functionCount: 1 },
    { name: 'KEY', fullPath: 'KEY', isClass: true, functionCount: 1 },
    { name: 'PEER', fullPath: 'PEER', isClass: true, functionCount: 1 },
    { name: 'TSLink<PEER>', fullPath: 'TSLink<PEER>', isClass: false, functionCount: 1 },
    { name: 'TSSync<ELEM,SYNC>', fullPath: 'TSSync<ELEM,SYNC>', isClass: false, functionCount: 1 },
    { name: 'NODE', fullPath: 'NODE', isClass: true, functionCount: 1 },
    { name: 'TSObject<NODE>', fullPath: 'TSObject<NODE>', isClass: false, functionCount: 1 },
    { name: 'TSTable<NODE>', fullPath: 'TSTable<NODE>', isClass: false, functionCount: 1 },
    { name: 'TSTableEx<NODE>', fullPath: 'TSTableEx<NODE>', isClass: false, functionCount: 1 },
  ];
  const strings: ExtractedString[] = [
    { address: '00600000', value: '.?AV?$TSExplicitList@UELEM@@$0?CCCCCCCD@@@', length: 40, encoding: 'char', xrefCount: 0 },
    { address: '00600040', value: '.?AV?$TSSync@UELEM@@VSYNC@@@@', length: 28, encoding: 'char', xrefCount: 0 },
    { address: '00600060', value: '.?AV?$TSLink@VPEER@@@@', length: 22, encoding: 'char', xrefCount: 0 },
    { address: '00600080', value: '.?AV?$TSSync@UOTHER@@VNOSTRUCT@@@@', length: 33, encoding: 'char', xrefCount: 0 },
  ];
  return { dataTypes, functions, globals, namespaces, strings };
}

function generate(templates: TemplatesConfig | undefined) {
  const m = model();
  try {
    return generateProject('t', m.functions, [], m.dataTypes, m.globals, m.namespaces, options(templates), programInfo, m.strings);
  } finally {
    setTemplateRegistry(undefined);
  }
}

describe('registered class templates', () => {
  const project = generate(TEMPLATES);
  const file = (path: string) => project.files.get(path)?.content ?? '';

  it('defines the primary templates and declares each member specialization in the template header', () => {
    const stpl = file('Storm/H/stpl.h');
    assert.match(stpl, /template<class T, int OFFSET>\nclass TSExplicitList \{\npublic:/);
    assert.match(stpl, /TSLink<T> m_terminator;/);
    assert.match(stpl, /static void __thiscall UnlinkAll\(TSExplicitList<T, OFFSET>\* pThis\);/);
    assert.match(stpl, /template<> void __thiscall TSExplicitList<ELEM, -572662307>::UnlinkAll\(/);
    assert.match(stpl, /template<> void __thiscall TSExplicitList<OTHER, -572662307>::UnlinkAll\(/);
    // An orphan copy is no member: a free function behind its marker.
    assert.doesNotMatch(stpl, /TSExplicitList<ELEM, -572662307>::UnlinkAll_Unreferenced/);
    assert.match(stpl, /\/\/ stpl-orphan: [^\n]*\nvoid __thiscall UnlinkAll_Unreferenced\(TSExplicitList<::ELEM, -572662307>\* pThis\);/);
  });

  it('defines a key class in the template header, its members declared in it and qualified by it', () => {
    assert.match(file('Storm/H/stpl.h'), /\nclass KEY \{\npublic:\n[^}]*char \* szString;\n\n    void Clear\(\);\n\};/);
    const impl = file('Mod/stpl_KEY.cpp');
    assert.match(impl, /\nvoid KEY::Clear\(\) \{\n    this->szString = 0;/);
    assert.doesNotMatch(impl, /namespace KEY/);
  });

  it('makes a member with a receiver a non-static member: declared and defined without it, its body saying `this`', () => {
    const stpl = file('Storm/H/stpl.h');
    assert.match(stpl, /class TSLink \{\npublic:\n[^}]*\n    void Clear\(\);\n    void Reseat\(\);\n\};/);
    assert.match(stpl, /\ntemplate<> void TSLink<PEER>::Clear\(\); \/\/ 1\.14d: 00401240/);
    assert.match(file('Mod/stpl_PEER.cpp'), /\ntemplate<> void TSLink<PEER>::Clear\(\) \{\n    this->m_next = 0;\n\}/);
    // The element named only by the class a specialization is qualified by is still declared.
    assert.match(stpl, /^class PEER;$/m);
  });

  it('keeps a member static while the program holds its address as a plain pointer, for every instantiation', () => {
    const stpl = file('Storm/H/stpl.h');
    // The vftable holds TSExplicitList<ELEM,..>::UnlinkAll; OTHER's is the same member of the template.
    assert.match(stpl, /\n    static void __thiscall UnlinkAll\(TSExplicitList<T, OFFSET>\* pThis\);\n    void UnlinkAll_Unreferenced\(\);\n/);
    assert.match(stpl, /template<> void __thiscall TSExplicitList<OTHER, -572662307>::UnlinkAll\(TSExplicitList<OTHER, -572662307> \* pThis\);/);
    assert.match(file('Mod/File.cpp'), /TSExplicitList<::ELEM, -572662307>::UnlinkAll\(&gList\);/);
  });

  it('keeps a receiver the body reseats as a local copy of `this`', () => {
    assert.match(file('Mod/stpl_PEER.cpp'), /TSLink<PEER>::Reseat\(\) \{\n    TSLink<::PEER>\* pThis = this;\n    pThis->m_next = 1;\n    pThis = pThis->m_prevlink;/);
  });

  it('calls a member on its object, naming its class where the receiver\'s class or one between declares the name', () => {
    const use = file('Mod/Third.cpp');
    // NODE's own namespace declares a Destroy; TSTableEx declares a Count of its own.
    assert.match(use, /void UseNode\(::NODE \* pNode\) \{\n    pNode->TSObject<::NODE>::Destroy\(\);\n    pNode->m_hashval = 3;\n    gTable\.Clear\(\);\n    gTable\.TSTable<::NODE>::Count\(\);\n    gpNode->TSObject<::NODE>::Destroy\(\);\n\}/);
    const own = file('Mod/stpl_NODE.cpp');
    // Within the class: its own Count is this one, the base's is named.
    assert.match(own, /TSTableEx<NODE>::Count\(\) \{\n    this->TSTable<::NODE>::Count\(\);\n\}/);
    assert.match(own, /TSTableEx<NODE>::Reset\(\) \{\n    this->Clear\(\);\n    this->m_count = 1;\n    this->m_extra = 2;\n    this->Count\(\);\n\}/);
  });

  it('forwards a thunk to a non-static member by calling it on the thunk\'s receiver', () => {
    assert.match(file('Mod/stpl_NODE.cpp'), /JMP thunk\nvoid __thiscall thunk_Clear\(TSTable<::NODE>\* pThis\) \{\n    pThis->Clear\(\);\n\}/);
  });

  it('names the target\'s class in a thunk where the receiver\'s class hides the name, and calls a member thunk\'s target on `this`', () => {
    const unit = file('Mod/stpl_NODE.cpp');
    // TSTableEx declares a Count of its own: unqualified, the thunk would call that one.
    assert.match(unit, /JMP thunk\nvoid __thiscall thunk_Count\(TSTableEx<::NODE>\* pThis\) \{\n    pThis->TSTable<NODE>::Count\(\);\n\}/);
    assert.match(unit, /JMP thunk\ntemplate<> void TSTable<NODE>::CountThunk\(\) \{\n    this->Count\(\);\n\}/);
  });

  it('includes the header of a class a template holds by value, which declares it with its RTTI class key', () => {
    const stpl = file('Storm/H/stpl.h');
    assert.match(stpl, /#include "Lib\/SYNC.h"/);
    assert.doesNotMatch(stpl, /(struct|class) SYNC( \{|;)/);
    assert.match(stpl, /template<> void TSSync<ELEM, SYNC>::Lock\(/);
    assert.match(stpl, /TSync m_sync;/);
    assert.match(file('Lib/SYNC.h'), /\nclass SYNC \{\npublic:\n[\s\S]*?\/\* 0x00 \*\/ int m_lock;/);
    assert.doesNotMatch(file('Lib/SYNC.h'), /stpl\.h/);
    // Every other declaration of it says `class` too.
    assert.match(file('Mod/Third.h'), /^class SYNC;$/m);
    assert.match(file('Mod/Third.h'), /void UseSync\(class SYNC \* pSync\);/);
    assert.match(file('Mod/Third.h'), /^class SYNC \* GetSync\(class NOSTRUCT \* pOpaque\);/m);
    assert.match(file('Mod/Third.h'), /^class NOSTRUCT;$/m);
    assert.match(file('globals/globals.h'), /\/\/ Declaration closure[\s\S]*\nclass SYNC;\nvoid SyncWait\(SYNC \* pSync\);/);
    assert.match(file('globals/globals.h'), /\/\/ Declaration closure[\s\S]*\nclass SYNC;\nextern SYNC \* gpExtSync;/);
    assert.match(file('Lib/SYNC.h'), /^class SYNC;\n[\s\S]*struct AWAITER \{[\s\S]*class SYNC \{/m);
    assert.match(file('Lib/SYNC.h'), /\/\/ Forward declarations\nclass SYNC;\n#ifndef RECON_FPTD_fpWake\n/);
    assert.match(file('globals/globals.h'), /^class SYNC;$/m);
    const all = [...project.files.values()].map(f => f.content).join('\n');
    assert.doesNotMatch(all, /struct SYNC\b/);
  });

  it('declares a class element where the template header names it, with its RTTI class key', () => {
    assert.match(file('Storm/H/stpl.h'), /^class PEER;$/m);
    assert.match(file('PEER/PEER.h'), /^class PEER \{\npublic:\n/m);
  });

  it('makes a class datum a static data member, defined beside the members', () => {
    assert.match(file('Storm/H/stpl.h'), /static void \* vftable\[1\];[\s\S]*template<> void \* TSExplicitList<ELEM, -572662307>::vftable\[1\];/);
    assert.match(file('Mod/stpl_ELEM.cpp'), /template<> void \* TSExplicitList<ELEM, -572662307>::vftable\[1\] = \{ [^}]*&TSExplicitList<ELEM, -572662307>::UnlinkAll/);
  });

  it('includes the template header wherever a template-id is named', () => {
    assert.match(file('Mod/File.h'), /#include "Storm\/H\/stpl.h"/);
    assert.match(file('globals/globals.h'), /#include "Storm\/H\/stpl.h"/);
    assert.match(file('Mod/Other.cpp'), /#include "Storm\/H\/stpl.h"/);
    assert.match(file('Mod/Other.cpp'), /\(\(TSExplicitList<::ELEM, -572662307>\*\)0x10\)->m_linkoffset = 0;/);
    // An address the body holds of a class's datum is spelled through the class.
    assert.match(file('Mod/Third.cpp'), /\(TSExplicitList<OTHER, -572662307>\*\)&TSExplicitList<ELEM, -572662307>::vftable\)->m_linkoffset = 0;/);
  });

  it('defines the members beside the module code below them, not in a unit per instantiation', () => {
    const impl = file('Mod/stpl_ELEM.cpp');
    assert.match(impl, /template<> void __thiscall TSExplicitList<ELEM, -572662307>::UnlinkAll\(TSExplicitList<::ELEM, -572662307>\* pThis\) \{/);
    assert.match(impl, /\nvoid __thiscall UnlinkAll_Unreferenced\(/);
    assert.ok(project.files.has('Mod/stpl_OTHER.cpp'));
    for (const path of project.files.keys()) assert.doesNotMatch(path, /TSExplicitList|stpl\//, path);
  });

  it('spells the template-id where it is used, with no flattened name and no Class:: scope', () => {
    const caller = file('Mod/File.cpp');
    assert.match(caller, /TSExplicitList<::ELEM, -572662307>::UnlinkAll\(&gList\);/);
    assert.match(caller, /void Caller\(TSExplicitList<::ELEM, -572662307>\* pList\)/);
    const all = [...project.files.values()].map(f => f.content).join('\n');
    assert.doesNotMatch(all, /TSExplicitList_|TSLink_|Class::TS/);
  });

  it('compiles', { skip: !haveGpp() && 'mingw g++ not installed' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'stpl-'));
    try {
      for (const [path, f] of project.files) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), f.content);
      }
      const units = [...project.files.keys()].filter(p => p.endsWith('.cpp'));
      assert.ok(units.includes('Mod/stpl_ELEM.cpp') && units.includes('Mod/File.cpp'));
      for (const unit of units) {
        execFileSync(GPP, ['-std=c++17', '-fsyntax-only', '-w', '-fms-extensions', '-include', 'd2_platform.h',
          '-I.', '-IMod', '-IStorm/H', unit], { cwd: dir, stdio: 'pipe' });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('declares a registered base for real: the template\'s and the element\'s', () => {
    const stpl = file('Storm/H/stpl.h');
    assert.match(stpl, /template<class T>\nclass TSTableEx : public TSTable<T> \{\npublic:\n    \/\* 0x04 \*\/ int m_extra;\n/);
    assert.doesNotMatch(stpl, /super_/);
    assert.match(file('NODE/NODE.h'), /\nstruct NODE : public TSObject<NODE> \{\n    \/\* 0x08 \*\/ int nValue;\n\};/);
  });

  it('reads inherited members and passes derived pointers where Ghidra went through the base component', () => {
    const reset = file('Mod/stpl_NODE.cpp');
    assert.match(reset, /this->Clear\(\);\n    this->m_count = 1;\n    this->m_extra = 2;/);
    const use = file('Mod/Third.cpp');
    assert.match(use, /pNode->TSObject<::NODE>::Destroy\(\);\n    pNode->m_hashval = 3;\n    gTable\.Clear\(\);/);
    const all = [...project.files.values()].map(f => f.content).join('\n');
    assert.doesNotMatch(all, /super_TS/);
  });

  it('initializes the base subobject first, without a member designator', () => {
    assert.match(file('globals/Mod.cpp'), /TSTableEx<NODE> gTable = \{\n    \/\* base TSTable<NODE> \*\/ \{\n        \/\* \.m_count = \*\/ 4\n    \},\n    \/\* \.m_extra = \*\/ 5\n\};/);
    // All zero: no initializer, which C++03 accepts for a class with a base and which
    // leaves the same zero bytes as the C++17 `= {}`.
    assert.match(file('globals/Mod.cpp'), /^TSTableEx<NODE> gTableZero;/m);
  });

  it('emits an element\'s orphan copy as a free function with the members, not in the element\'s namespace', () => {
    assert.match(file('Storm/H/stpl.h'), /\/\/ stpl-orphan: a COMDAT copy in ELEM that no member owns\nvoid __thiscall Release_Unreferenced\(::ELEM \* pThis\);/);
    assert.match(file('Mod/stpl_ELEM.cpp'), /\/\/ stpl-orphan: a COMDAT copy in ELEM that no member owns\n\/\/ 1\.14d: 004013f0\nvoid __thiscall Release_Unreferenced\(::ELEM \* pThis\) \{/);
    assert.doesNotMatch(file('ELEM/ELEM.h'), /Release_Unreferenced/);
    // Ghidra's name alone makes no orphan.
    assert.match(file('Storm/H/stpl.h'), /template<> void TSExplicitList<OTHER, -572662307>::UnlinkAll_Unreferenced\(/);
  });

  it('refuses an RTTI descriptor whose class key disagrees with project.json', () => {
    const m = model();
    const struct = { ...TEMPLATES, families: { ...TEMPLATES.families, TSExplicitList: { ...TEMPLATES.families.TSExplicitList, key: 'struct' as const } } };
    assert.throws(
      () => generateProject('t', m.functions, [], m.dataTypes, m.globals, m.namespaces, options(struct), programInfo, m.strings),
      /RTTI \.\?AV\?\$TSExplicitList@UELEM@@\$0\?CCCCCCCD@@@: TSExplicitList is a class, project.json says struct/,
    );
    setTemplateRegistry(undefined);
  });

  it('leaves a project that registers no templates flattening them as before', () => {
    const flat = generate(undefined);
    const all = [...flat.files.values()].map(f => f.content).join('\n');
    assert.match(all, /TSExplicitList_ELEM__572662307_/);
    assert.ok(!flat.files.has('Storm/H/stpl.h'));
  });
});

describe('registered class templates across generation shards', () => {
  // Each shard is its own worker in a real run; here they run one after the
  // other, the workers first and the coordinator last, as the merge needs.
  function sharded(count: number): { project: ReturnType<typeof generateProject>; fromWorkers: string[] } {
    const outputs: ShardOutput[] = [];
    try {
      for (let index = 1; index < count; index++) {
        const m = model();
        outputs.push(takeShardOutput(generateProjectStage1('t', m.functions, [], m.dataTypes, m.globals, m.namespaces,
          options(TEMPLATES), programInfo, m.strings, { index, count })));
      }
      const m = model();
      const state = generateProjectStage1('t', m.functions, [], m.dataTypes, m.globals, m.namespaces,
        options(TEMPLATES), programInfo, m.strings, { index: 0, count });
      for (const out of outputs) mergeShardOutput(state, out);
      assertNoShardPlaceholders(state);
      return { project: generateProjectStage2(state), fromWorkers: outputs.flatMap(o => o.files.map(([path]) => path)) };
    } finally {
      setTemplateRegistry(undefined);
    }
  }

  it('emits the template header and the member units byte-identical to a serial run', () => {
    const serial = generate(TEMPLATES);
    const emitted = new Set<string>();
    // 8 is run-regen's default; at 4 a shard other than the coordinator writes the header.
    for (const count of [2, 4, 8]) {
      const { project, fromWorkers } = sharded(count);
      fromWorkers.forEach(path => emitted.add(path));
      assert.deepStrictEqual([...project.files.keys()], [...serial.files.keys()], `${count} shards`);
      for (const [path, f] of serial.files) assert.strictEqual(project.files.get(path)?.content, f.content, `${path}, ${count} shards`);
    }
    // The template pieces really were written by shards other than the coordinator.
    assert.ok(emitted.has('Storm/H/stpl.h'), [...emitted].join(', '));
    assert.ok([...emitted].some(path => /\/stpl_\w+\.cpp$/.test(path)), [...emitted].join(', '));
  });
});
