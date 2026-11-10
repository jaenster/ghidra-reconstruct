import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { generateProject } from '../codegen/index.js';
import { organizeByNamespace } from '../codegen/namespace.js';
import { loadProjectConfigFromFile } from '../config/loader.js';
import type { ExtractedFunction, ExtractedNamespace, ProgramInfo, ReconstructOptions } from '../types.js';

const functionAt = (name: string, address: string, namespace: string, body: string,
  parameter?: { name: string; dataType: string; size: number; ordinal: number; storage: string },
): ExtractedFunction => ({
  name, address, namespace,
  signature: `int ${name}(${parameter ? `int ${parameter.name}` : 'void'})`, returnType: 'int',
  parameters: parameter ? [parameter] : [], localVariables: [], callingConvention: '__stdcall', size: 32,
  isThunk: false, isExternal: false, hasVarArgs: false,
  decompiled: `int __stdcall ${name}(${parameter ? `int ${parameter.name}` : 'void'}) { ${body} }`,
} as ExtractedFunction);

const helper = () => functionAt('Helper', '00401000', 'Engine', 'return nValue + 1;',
  { name: 'nValue', dataType: 'int', size: 4, ordinal: 0, storage: 'ESI:4' });
const caller = () => functionAt('Caller', '00401100', 'Player', 'return Engine::Helper(1);');
const placement = { address: '0x00401000', unit: 'Player', evidence: 'verified object-file placement for test fixture' };
const namespaces: ExtractedNamespace[] = [
  { name: 'Engine', fullPath: 'Engine', functionCount: 1, isClass: false },
  { name: 'Player', fullPath: 'Player', functionCount: 1, isClass: false },
];
const options = (): ReconstructOptions => ({
  outputDir: './out', format: 'cpp', organization: 'namespace',
  generateCMake: false, generateSourceMaps: true, transformPreset: 'quick',
  includeAddressComments: false, promoteStaticGlobals: false,
  projectConfig: { version: 1, project: 'mixed-tu', functionPlacements: [placement] },
});
const programInfo: ProgramInfo = {
  name: 'Mixed.exe', path: '/tmp/Mixed.exe', format: 'PE', architecture: 'x86', compiler: 'msvc',
  imageBase: '0x400000', languageId: 'x86:LE:32:default', endianness: 'little', pointerSize: 4,
};

describe('explicit cross-namespace translation-unit placement', () => {
  it('requires provenance and unique function addresses in project.json', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mixed-tu-config-'));
    const configPath = path.join(dir, 'project.json');
    try {
      const write = (functionPlacements: unknown) => fs.writeFile(configPath,
        JSON.stringify({ version: 1, project: 'mixed-tu', functionPlacements }));
      await write([{ ...placement, evidence: '' }]);
      await assert.rejects(loadProjectConfigFromFile(configPath), /nonempty "evidence"/);
      await write([placement, { ...placement, address: '00401000' }]);
      await assert.rejects(loadProjectConfigFromFile(configPath), /duplicate function placement/);
      await write([placement]);
      const loaded = await loadProjectConfigFromFile(configPath);
      assert.deepEqual(loaded.functionPlacements, [placement]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('separates symbol namespace from the existing destination unit and rejects unknown units', () => {
    const functions = [caller(), helper()];
    const original = organizeByNamespace(functions, [], namespaces);
    assert.deepEqual([...original.keys()], ['Player', 'Engine']);
    const placed = organizeByNamespace(functions, [], namespaces, [placement]);
    assert.deepEqual([...placed.keys()], ['Player']);
    assert.deepEqual(placed.get('Player')?.map(f => f.name), ['Caller', 'Helper']);
    assert.equal(functions[1].namespace, 'Engine', 'placement does not rewrite symbol identity');
    assert.throws(() => organizeByNamespace(functions, [], namespaces,
      [{ ...placement, unit: 'Missing' }]), /not an existing unit/);
    const stale = options();
    stale.projectConfig!.functionPlacements = [{ ...placement, address: '00409999' }];
    assert.throws(() => generateProject('mixed', functions, [], [], [], namespaces, stale, programInfo),
      /duplicate or missing function address/);
  });

  it('emits a moved static helper in its original namespace and before its first caller', () => {
    const project = generateProject('mixed', [caller(), helper()], [], [], [], namespaces, options(), programInfo);
    const file = (suffix: string) => [...project.files.values()].find(f => f.path.endsWith(suffix))?.content ?? '';
    const header = file('Player.h');
    const impl = file('Player.cpp');
    assert.ok(impl, 'destination implementation exists');
    assert.match(impl, /namespace Engine \{\s*static int __stdcall Helper\(int nValue\);/);
    assert.match(impl, /^static int __stdcall Helper\(int nValue\) \{$/m);
    assert.ok(impl.indexOf('static int __stdcall Helper(int nValue);') < impl.indexOf('Caller('));
    assert.match(impl, /^int __stdcall Caller\(/m);
    assert.doesNotMatch(header, /\bHelper\s*\(/, 'static helper has no public header declaration');
    assert.match(header, /namespace Player \{\s*\/\/ Function declarations\s*int __stdcall Caller\(/);
    assert.ok(!file('Engine.cpp'), 'no orphan source unit was generated');
  });

  it('keeps external linkage and the original namespace when another unit calls the helper', () => {
    const observer = functionAt('Observer', '00401200', 'Observer', 'return Engine::Helper(2);');
    const project = generateProject('mixed', [caller(), helper(), observer], [], [], [],
      [...namespaces, { name: 'Observer', fullPath: 'Observer', functionCount: 1, isClass: false }],
      options(), programInfo);
    const file = (suffix: string) => [...project.files.values()].find(f => f.path.endsWith(suffix))?.content ?? '';
    const header = file('Player.h');
    const impl = file('Player.cpp');
    assert.match(header, /namespace Engine \{\s*int __stdcall Helper\(int nValue\);/);
    assert.match(impl, /^int __stdcall Helper\(int nValue\) \{$/m);
    assert.doesNotMatch(impl, /static int __stdcall Helper/);
    assert.match(file('Observer.cpp'), /#include "[^"]*Player\.h"/);
  });

  it('also preserves a Player symbol placed in a CUnit translation unit', () => {
    const moved = functionAt('Iterate', '00402000', 'Player', 'return nValue + 2;',
      { name: 'nValue', dataType: 'int', size: 4, ordinal: 0, storage: 'ESI:4' });
    const using = functionAt('Walk', '00402100', 'CUnit', 'return Player::Iterate(3);');
    const configured = options();
    configured.projectConfig!.functionPlacements = [{
      address: moved.address, unit: 'CUnit', evidence: 'verified Player object-file placement',
    }];
    const project = generateProject('mixed', [using, moved], [], [], [], [
      { name: 'Player', fullPath: 'Player', functionCount: 1, isClass: false },
      { name: 'CUnit', fullPath: 'CUnit', functionCount: 1, isClass: false },
    ], configured, programInfo);
    const file = (suffix: string) => [...project.files.values()].find(f => f.path.endsWith(suffix))?.content ?? '';
    assert.match(file('CUnit.cpp'), /namespace Player \{\s*static int __stdcall Iterate\(int nValue\);/);
    assert.match(file('CUnit.cpp'), /^static int __stdcall Iterate\(int nValue\) \{$/m);
    assert.doesNotMatch(file('CUnit.h'), /\bIterate\s*\(/);
    assert.ok(!file('Player.cpp'));
  });

  it('does not deduplicate same-named declarations from different namespaces', () => {
    const engine = functionAt('Shared', '00403000', 'Engine', 'return 1;');
    const player = functionAt('Shared', '00403100', 'Player', 'return 2;');
    const configured = options();
    configured.projectConfig!.functionPlacements = [{
      address: engine.address, unit: 'Player', evidence: 'verified Engine object-file placement',
    }];
    const project = generateProject('mixed', [player, engine], [], [], [], namespaces, configured, programInfo);
    const header = [...project.files.values()].find(f => f.path.endsWith('Player.h'))?.content ?? '';
    assert.match(header, /namespace Player \{[\s\S]*?\bShared\(/);
    assert.match(header, /namespace Engine \{[\s\S]*?\bShared\(/);
  });

  it('includes both headers when qualified and bare calls share a leaf name in a mixed unit', () => {
    const functions = [
      functionAt('Caller', '00401100', 'Root::A', 'return Foo();'),
      functionAt('Other', '00401200', 'Player', 'return Engine::Foo();'),
      functionAt('Foo', '00402000', 'Root', 'return 1;'),
      functionAt('Foo', '00403000', 'Engine', 'return 2;'),
    ];
    const configured = options();
    configured.projectConfig!.functionPlacements = [{
      address: '00401100', unit: 'Player', evidence: 'verified fixture',
    }];
    const project = generateProject('mixed', functions, [], [], [], [
      { name: 'A', fullPath: 'Root::A', functionCount: 1, isClass: false },
      { name: 'Player', fullPath: 'Player', functionCount: 1, isClass: false },
      { name: 'Root', fullPath: 'Root', functionCount: 1, isClass: false },
      { name: 'Engine', fullPath: 'Engine', functionCount: 1, isClass: false },
    ], configured, programInfo);
    const impl = [...project.files.values()].find(f => f.path.endsWith('Player.cpp'))?.content ?? '';
    assert.match(impl, /#include "Root\/Root\.h"/);
    assert.match(impl, /#include "Engine\/Engine\.h"/);
    assert.match(impl, /namespace Root::A \{[\s\S]*?return Foo\(\);/);
    assert.match(impl, /namespace Player \{[\s\S]*?return Engine::Foo\(\);/);
  });
});
