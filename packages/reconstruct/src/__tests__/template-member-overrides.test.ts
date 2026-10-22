/**
 * project.json `overrides` on a registered template's members, and the patch engine's
 * exactly-once rule.
 *
 * A member of a registered class template is emitted as an explicit specialization in
 * a `stpl_<element>.cpp` unit (templates/placement.ts), not as a free function in its
 * namespace's unit; an override is keyed by address and must reach that body the same
 * way. The four TSHashTable<..>::GrowListArray instantiations are fixed this way: the
 * decompiler folds the node the rehash loop saved into a fresh read of the pending
 * list's head, which Ghidra cannot be told otherwise.
 *
 * A patch's find must match exactly once in the text it is applied to. Zero is a fix
 * that silently stopped applying; two rewrites whichever occurrence comes first.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateProject, writeProject } from '../codegen/index.js';
import { setTemplateRegistry } from '../codegen/templates/registry.js';
import { applyPatches } from '../overrides/patches.js';
import type { OverrideEntry, TemplatesConfig } from '../config/schema.js';
import type {
  ExtractedDataType,
  ExtractedFunction,
  ExtractedNamespace,
  ExtractedString,
  ProgramInfo,
  ReconstructOptions,
} from '../types.js';

const programInfo: ProgramInfo = {
  name: 'T.exe', path: '/tmp/T.exe', format: 'PE', architecture: 'x86', compiler: 'msvc',
  imageBase: '0x400000', languageId: 'x86:LE:32:default', endianness: 'little', pointerSize: 4,
};

const TEMPLATES: TemplatesConfig = {
  header: 'Storm/H/stpl.h',
  implPrefix: 'stpl_',
  families: {
    TSLink: { key: 'class', params: [{ name: 'T', kind: 'type' }] },
    TSExplicitList: { key: 'class', params: [{ name: 'T', kind: 'type' }, { name: 'OFFSET', kind: 'int' }] },
  },
  classes: {},
};

const LIST = 'TSExplicitList<ELEM,-572662307>';
const MEMBER = '00401100';

function options(overrides: OverrideEntry[], projectDir?: string): ReconstructOptions {
  return {
    outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false,
    generateSourceMaps: false, transformPreset: 'full', includeAddressComments: false,
    promoteStaticGlobals: false, projectDir,
    projectConfig: {
      version: 1, project: 't', modules: { Mod: { namespaces: ['Mod'] } }, templates: TEMPLATES,
      moduleRuns: [{ module: 'Mod', start: '00401000', end: '00402000' }],
      overrides,
    } as never,
  } as ReconstructOptions;
}

function model() {
  const dataTypes: ExtractedDataType[] = [
    { kind: 'STRUCTURE', name: 'ELEM', category: '/', size: 12, fields: [
      { name: 'm_link', dataType: 'TSLink<ELEM>', offset: 0, size: 8 },
      { name: 'nValue', dataType: 'int', offset: 8, size: 4 },
    ] } as ExtractedDataType,
    { kind: 'STRUCTURE', name: 'TSLink<ELEM>', category: '/', size: 8, fields: [
      { name: 'm_prevlink', dataType: 'TSLink<ELEM> *', offset: 0, size: 4 },
      { name: 'm_next', dataType: 'int', offset: 4, size: 4 },
    ] } as ExtractedDataType,
    { kind: 'STRUCTURE', name: LIST, category: '/', size: 12, fields: [
      { name: 'm_linkoffset', dataType: 'int', offset: 0, size: 4 },
      { name: 'm_terminator', dataType: 'TSLink<ELEM>', offset: 4, size: 8 },
    ] } as ExtractedDataType,
  ];
  const functions: ExtractedFunction[] = [
    {
      name: 'Caller', address: '00401000', namespace: 'Mod::File', returnType: 'void',
      signature: `void Caller(${LIST} * pList)`, localVariables: [], callingConvention: '__cdecl',
      parameters: [{ name: 'pList', dataType: `${LIST} *`, size: 4, ordinal: 0, storage: 'Stack[0x4]:4' }],
      size: 0x10, isThunk: false, isExternal: false, hasVarArgs: false, calledFunctions: ['Relink'],
      decompiled: `void Mod::File::Caller(${LIST} *pList)\n\n{\n  ${LIST}::Relink(pList);\n  return;\n}\n`,
    } as ExtractedFunction,
    {
      // The GrowListArray shape in small: the head is read twice where the binary saved it once.
      name: 'Relink', address: MEMBER, namespace: LIST, returnType: 'void',
      signature: `void Relink(${LIST} * this)`,
      parameters: [{ name: 'this', dataType: `${LIST} *`, size: 4, ordinal: 0, storage: 'ECX:4 (auto)' }],
      localVariables: [{ name: 'nSlot', dataType: 'int', size: 4, storage: 'Stack[-0x10]:4' }],
      callingConvention: '__thiscall', size: 0x20,
      isThunk: false, isExternal: false, hasVarArgs: false, calledFunctions: [],
      decompiled:
        `void __thiscall\n${LIST}::Relink(${LIST} *this)\n\n{\n  int nSlot;\n  \n` +
        '  (this->m_terminator).m_prevlink->m_next = (this->m_terminator).m_next;\n' +
        '  nSlot = (this->m_terminator).m_next;\n  return;\n}\n',
    } as ExtractedFunction,
  ];
  const namespaces: ExtractedNamespace[] = [
    { name: 'File', fullPath: 'Mod::File', isClass: false, functionCount: 1 },
    { name: LIST, fullPath: LIST, isClass: false, functionCount: 1 },
  ];
  const strings: ExtractedString[] = [
    { address: '00600000', value: '.?AV?$TSExplicitList@UELEM@@$0?CCCCCCCD@@@', length: 40, encoding: 'char', xrefCount: 0 },
  ];
  return { dataTypes, functions, namespaces, strings };
}

function generate(overrides: OverrideEntry[], projectDir?: string) {
  const m = model();
  try {
    return generateProject('t', m.functions, [], m.dataTypes, [], m.namespaces, options(overrides, projectDir), programInfo, m.strings);
  } finally {
    setTemplateRegistry(undefined);
  }
}

const UNIT = 'Mod/stpl_ELEM.cpp';
const DEF = 'template<> void TSExplicitList<ELEM, -572662307>::Relink() {';

/** The emitted definition of the member, from its signature to its closing brace. */
function definition(unit: string): string {
  const at = unit.indexOf(DEF);
  assert.ok(at >= 0, `no specialization definition in:\n${unit}`);
  return unit.slice(at, unit.indexOf('\n}', at) + 2);
}

describe('overrides on a registered template member', () => {
  const plain = definition(generate([]).files.get(UNIT)?.content ?? '');

  it('emits the member as an explicit specialization in its stpl unit, the decompiler\'s body unchanged', () => {
    assert.match(plain, /\{\n    this->m_terminator\.m_prevlink->m_next = this->m_terminator\.m_next;\n    int nSlot = this->m_terminator\.m_next;\n\}/);
  });

  it('applies a patch override to that specialization\'s body', () => {
    const patched = generate([{
      address: MEMBER, action: 'patch', reason: 'test',
      patches: [
        { find: '\n    int nSlot = this->m_terminator.m_next;', replace: '' },
        { find: 'this->m_terminator.m_prevlink->m_next = this->m_terminator.m_next;',
          replace: 'int nSlot = this->m_terminator.m_next;\n    this->m_terminator.m_prevlink->m_next = nSlot;' },
      ],
    }]);
    const unit = patched.files.get(UNIT)?.content ?? '';
    assert.match(unit, /\/\/ \[override: patch\]\ntemplate<> void TSExplicitList<ELEM, -572662307>::Relink\(\) \{/);
    assert.match(definition(unit), /\{\n    int nSlot = this->m_terminator\.m_next;\n    this->m_terminator\.m_prevlink->m_next = nSlot;\n\}/);
  });

  it('applies a replace override to that specialization, with the body file\'s content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stpl-ov-'));
    try {
      writeFileSync(join(dir, 'Relink.cpp'), 'this->m_terminator.m_next = 0;\n');
      const project = generate([{ address: MEMBER, action: 'replace', sourceFile: 'Relink.cpp', reason: 'test' }], dir);
      await writeProject(project, join(dir, 'out'), options([{ address: MEMBER, action: 'replace', sourceFile: 'Relink.cpp' }], dir));
      const unit = readFileSync(join(dir, 'out', UNIT), 'utf-8');
      assert.match(unit, /\/\/ \[override: replace\]\ntemplate<> void TSExplicitList<ELEM, -572662307>::Relink\(\) \{\n    this->m_terminator\.m_next = 0;\n\}/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops the generation, naming the address, when a template member\'s patch does not match', () => {
    assert.throws(
      () => generate([{ address: MEMBER, name: 'Relink', action: 'patch', patches: [{ find: 'nNoSuchLocal = 1;', replace: '' }] }]),
      /override 00401100 Relink: Patch 0: find string matched 0 times/,
    );
  });
});

describe('a patch\'s find matches exactly once', () => {
  it('applies a find that occurs once', () => {
    assert.strictEqual(applyPatches('a = b;\nc = d;\n', [{ find: 'c = d;', replace: 'c = e;' }]).code, 'a = b;\nc = e;\n');
  });

  it('refuses a find that occurs nowhere', () => {
    assert.throws(() => applyPatches('a = b;\n', [{ find: 'c = d;', replace: '' }]), /Patch 0: find string matched 0 times/);
  });

  it('refuses a find that occurs twice, rather than rewriting the first', () => {
    assert.throws(() => applyPatches('x = h;\ny = h;\n', [{ find: ' = h;', replace: ' = s;' }]), /Patch 0: find string matched 2 times/);
  });

  it('counts each patch against the text the patches before it left', () => {
    // Once in the input, then once more in what patch 0 wrote.
    const patches = [{ find: 'p = 1;', replace: 'q = 1;' }, { find: 'q = 1;', replace: 'r = 1;' }];
    assert.strictEqual(applyPatches('p = 1;\n', patches).code, 'r = 1;\n');
    assert.throws(() => applyPatches('p = 1;\nq = 1;\n', patches), /Patch 1: find string matched 2 times/);
  });

  it('holds a fuzzy find to the same rule', () => {
    assert.strictEqual(applyPatches('a  =\n b;', [{ find: 'a = b;', replace: 'ok', fuzzy: true }]).code, 'ok');
    assert.throws(() => applyPatches('a = b; a =  b;', [{ find: 'a = b;', replace: '', fuzzy: true }]), /matched 2 times \(fuzzy\)/);
  });

  it('refuses an empty find', () => {
    assert.throws(() => applyPatches('a', [{ find: '', replace: 'x' }]), /matched 0 times/);
  });
});
