/**
 * A template member one unit's own code alone names is the COMDAT that unit's
 * object compiled: it is defined in that unit, at root scope (an explicit
 * specialization), `inline` and never inlined, and declared so in the template
 * header. A member two units name, or a datum holds, stays with the
 * instantiation and is an ordinary definition.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { generateProject, templateMemberKey } from '../codegen/index.js';
import { setTemplateRegistry, templateRegistry } from '../codegen/templates/registry.js';
import type { AnalyzedDataSymbol, ExtractedDataType, ExtractedFunction, ExtractedNamespace, ProgramInfo, ReconstructOptions } from '../types.js';
import type { TemplatesConfig } from '../config/schema.js';

const GPP = 'i686-w64-mingw32-g++';
function haveGpp(): boolean {
  try { execFileSync(GPP, ['--version'], { stdio: 'pipe' }); return true; } catch { return false; }
}

const programInfo: ProgramInfo = {
  name: 'T.exe', path: '/tmp/T.exe', format: 'PE', architecture: 'x86', compiler: 'msvc',
  imageBase: '0x400000', languageId: 'x86:LE:32:default', endianness: 'little', pointerSize: 4,
};

const TEMPLATES: TemplatesConfig = {
  header: 'Storm/H/stpl.h',
  implPrefix: 'stpl_',
  families: {
    TSLink: { key: 'class', params: [{ name: 'T', kind: 'type' }] },
    TSGetLink: { key: 'class', params: [{ name: 'T', kind: 'type' }] },
    TSList: { key: 'class', params: [{ name: 'T', kind: 'type' }, { name: 'TGetLink', kind: 'type' }] },
  },
};

const LIST = (el: string) => `TSList<${el},TSGetLink<${el}>>`;

function options(): ReconstructOptions {
  return {
    outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false,
    generateSourceMaps: false, transformPreset: 'full', includeAddressComments: false,
    promoteStaticGlobals: false,
    projectConfig: {
      version: 1, project: 't', modules: { Mod: { namespaces: ['Mod'] } }, templates: TEMPLATES,
      moduleRuns: [{ module: 'Mod', start: '00401000', end: '00402000' }],
    } as never,
  } as ReconstructOptions;
}

function member(el: string, name: string, address: string): ExtractedFunction {
  const ns = LIST(el);
  return {
    name, address, namespace: ns, returnType: 'void',
    signature: `void ${name}(${ns} * this)`,
    parameters: [{ name: 'this', dataType: `${ns} *`, size: 4, ordinal: 0, storage: 'ECX:4' }],
    localVariables: [], callingConvention: '__thiscall', size: 0x20,
    isThunk: false, isExternal: false, hasVarArgs: false, calledFunctions: [],
    decompiled: `void __thiscall\n${ns}::${name}(${ns} *this)\n\n{\n  (this->m_terminator).m_next = 0;\n  return;\n}\n`,
  } as ExtractedFunction;
}

function caller(ns: string, name: string, address: string, body: string): ExtractedFunction {
  return {
    name, address, namespace: ns, returnType: 'void',
    signature: `void ${name}(void)`, parameters: [], localVariables: [], callingConvention: '__cdecl',
    size: 0x10, isThunk: false, isExternal: false, hasVarArgs: false, calledFunctions: [],
    decompiled: `void ${ns}::${name}(void)\n\n{\n${body}\n  return;\n}\n`,
  } as ExtractedFunction;
}

function model() {
  const dataTypes: ExtractedDataType[] = ['ELEM', 'PEER', 'HELD'].flatMap(el => [
    { kind: 'STRUCTURE', name: el, category: '/', size: 8, fields: [
      { name: 'm_link', dataType: `TSLink<${el}>`, offset: 0, size: 8 },
    ] } as ExtractedDataType,
    { kind: 'STRUCTURE', name: `TSLink<${el}>`, category: '/', size: 8, fields: [
      { name: 'm_prevlink', dataType: `TSLink<${el}> *`, offset: 0, size: 4 },
      { name: 'm_next', dataType: 'int', offset: 4, size: 4 },
    ] } as ExtractedDataType,
    { kind: 'STRUCTURE', name: LIST(el), category: '/', size: 12, fields: [
      { name: 'm_linkoffset', dataType: 'int', offset: 0, size: 4 },
      { name: 'm_terminator', dataType: `TSLink<${el}>`, offset: 4, size: 8 },
    ] } as ExtractedDataType,
  ]);
  const call = (el: string, arg: string, name = 'UnlinkAll') => `  ${LIST(el)}::${name}\n            ((${LIST(el)} *)${arg});`;
  const functions: ExtractedFunction[] = [
    // Two functions of Mod::File alone name ELEM's UnlinkAll; it sits between them.
    caller('Mod::File', 'Close', '00401000', call('ELEM', '&gElemList')),
    member('ELEM', 'UnlinkAll', '00401040'),
    caller('Mod::File', 'Fini', '00401080', `  /* ${LIST('PEER')}::UnlinkAll is not a use */\n${call('ELEM', '&gElemList')}`),
    // ELEM's Peek, used by Mod::File alone, sits in one run with PEER's UnlinkAll,
    // which two units name: the run came from one object and stays together.
    member('ELEM', 'Peek', '004010c0'),
    caller('Mod::File', 'Look', '00401160', call('ELEM', '&gElemList', 'Peek')),
    member('PEER', 'UnlinkAll', '00401100'),
    caller('Mod::Other', 'Flush', '00401140', call('PEER', '&gPeerList')),
    caller('Mod::Third', 'Drain', '00401180', call('PEER', '&gPeerList')),
    // HELD's Clear is held by a datum as well.
    member('HELD', 'Clear', '00401200'),
    caller('Mod::Fourth', 'Purge', '00401240', call('HELD', '&gHeldList', 'Clear')),
  ];
  const list = (name: string, el: string, address: string) => ({
    name, address, dataType: LIST(el), size: 12, namespace: null, isInitialized: false, xrefCount: 1,
    referencingFunctions: [], scope: 'global',
  });
  const globals = [
    list('gElemList', 'ELEM', '00500000'),
    list('gPeerList', 'PEER', '00500010'),
    list('gHeldList', 'HELD', '00500020'),
    {
      name: 'vftable', address: '00500100', dataType: 'pointer[1]', size: 4, namespace: LIST('HELD'),
      isInitialized: true, xrefCount: 0, referencingFunctions: [], scope: 'global',
      initializedData: { kind: 'array', elements: [{ kind: 'pointer', value: `${LIST('HELD')}::Clear` }] },
    },
  ] as unknown as AnalyzedDataSymbol[];
  const namespaces: ExtractedNamespace[] = [
    ...['File', 'Other', 'Third', 'Fourth'].map(n => ({ name: n, fullPath: `Mod::${n}`, isClass: false, functionCount: 1 })),
    ...['ELEM', 'PEER', 'HELD'].map(el => ({ name: LIST(el), fullPath: LIST(el), isClass: false, functionCount: 1 })),
  ];
  return { dataTypes, functions, globals, namespaces };
}

describe('template members as COMDATs', () => {
  const m = model();
  let keys: Record<string, string | undefined> = {};
  let project: ReturnType<typeof generateProject>;
  try {
    project = generateProject('t', m.functions, [], m.dataTypes, m.globals, m.namespaces, options(), programInfo, []);
    keys = Object.fromEntries(['00401040', '00401100', '00401200', '00401000'].map(a => [a, templateMemberKey(a)]));
    assert.ok(templateRegistry());
  } finally {
    setTemplateRegistry(undefined);
  }
  const file = (path: string) => project.files.get(path)?.content ?? '';

  it('defines a member one unit alone names in that unit, at root scope, inline and never inlined', () => {
    const impl = file('Mod/File.cpp');
    assert.match(impl, /\} \/\/ namespace Mod::File\n\n[\s\S]*template<> __attribute__\(\(noinline\)\) inline void TSList<ELEM, TSGetLink<ELEM>>::UnlinkAll\(\) \{[\s\S]*\nnamespace Mod::File \{/);
    // In address order, between its two users.
    assert.ok(impl.indexOf('void Close()') < impl.indexOf('::UnlinkAll() {') && impl.indexOf('::UnlinkAll() {') < impl.indexOf('void Fini()'), impl);
    // Declared once, in the template header, as the COMDAT it is; never in the unit's header.
    assert.match(file('Storm/H/stpl.h'), /template<> __attribute__\(\(noinline\)\) inline void TSList<ELEM, TSGetLink<ELEM>>::UnlinkAll\(\);/);
    assert.doesNotMatch(file('Mod/File.h'), /UnlinkAll/);
  });

  it('moves a run of members only as a whole', () => {
    assert.match(file('Mod/stpl_ELEM.cpp'), /\ntemplate<> void TSList<ELEM, TSGetLink<ELEM>>::Peek\(\) \{/);
    assert.doesNotMatch(file('Mod/File.cpp'), /::Peek\(\) \{/);
  });

  it('leaves a member two units name, or a datum holds, with its instantiation and not inline', () => {
    assert.match(file('Mod/stpl_PEER.cpp'), /\ntemplate<> void TSList<PEER, TSGetLink<PEER>>::UnlinkAll\(\) \{/);
    assert.match(file('Mod/stpl_HELD.cpp'), /\ntemplate<> void __thiscall TSList<HELD, TSGetLink<HELD>>::Clear\(/);
    assert.doesNotMatch(file('Storm/H/stpl.h'), /inline void TSList<(PEER|HELD)/);
  });

  it('keys each member in its unit\'s statics, with whether it is a COMDAT', () => {
    assert.deepStrictEqual(keys, { '00401040': 'M:00401040:comdat', '00401100': 'M:00401100', '00401200': 'M:00401200', '00401000': undefined });
  });

  it('compiles', { skip: !haveGpp() && 'mingw g++ not installed' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'comdat-'));
    try {
      for (const [path, f] of project.files) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), f.content);
      }
      for (const unit of [...project.files.keys()].filter(p => p.endsWith('.cpp'))) {
        execFileSync(GPP, ['-std=c++17', '-fsyntax-only', '-w', '-fms-extensions', '-include', 'd2_platform.h',
          '-I.', '-IMod', '-IStorm/H', unit], { cwd: dir, stdio: 'pipe' });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
