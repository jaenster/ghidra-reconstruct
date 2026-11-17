import { it } from 'node:test';
import assert from 'node:assert/strict';
import { generateProject } from '../codegen/index.js';
import { vc8formBodyHash } from '../codegen/vc8form-spec.js';
import type { ExtractedFunction, ExtractedNamespace, ExtractedStruct, ProgramInfo, ReconstructOptions } from '../types.js';

it('supplies scoped return and parameter facts to tagged pointer nesting through project codegen', () => {
  // Synthetic metadata exercises the project-to-parser wiring. Evidence seals are placeholders.
  const decompiled = `void __cdecl Example::Player::SaveDeath(Unit* unit, int online) {
    Client* client;
    client = Example::Support::Lookup(unit, 1);
    Example::Support::Mark(client);
    if (online) { if (!Example::Support::Flags(client)) goto done; }
    int overwrite; overwrite = 0;
    client = Example::Support::Lookup(unit, 2);
    char* name;
    name = Example::Support::Name(client);
    Example::Support::Save(unit, name, overwrite);
  done:
    Example::Support::Finish(unit);
  }`;
  function fn(name: string, address: string, returnType: string, params: Array<[string, string]>, namespace: string): ExtractedFunction {
    return { name, address, returnType, namespace, size: 100, signature: `${returnType} ${name}(${params.map(([name, type]) => `${type} ${name}`).join(', ')})`,
      callingConvention: '__cdecl', isThunk: false, isExternal: true, hasVarArgs: false,
      parameters: params.map(([name, dataType], ordinal) => ({ name, dataType, ordinal, size: 4, storage: `Stack[0x${(4 + ordinal * 4).toString(16)}]:4` })),
      localVariables: [], decompiled: '', calledFunctions: [], tags: [] };
  }
  const target = { ...fn('SaveDeath', '00401000', 'void', [['unit', 'Unit*'], ['online', 'int']], 'Example::Player'),
    isExternal: false, decompiled,
    tags: ['nestcall(client,2)', 'nestcall(name)'].map((form, i) => ({ type: 'vc8form', data: `${form};ev=0000000000;bh=100-00000000;dh=${vc8formBodyHash(decompiled)};ord=${i + 1}` })),
  };
  const support = [
    fn('Lookup', '00401100', 'Client*', [['unit', 'Unit*'], ['line', 'int']], 'Example::Support'),
    fn('Mark', '00401200', 'void', [['client', 'Client*']], 'Example::Support'),
    fn('Flags', '00401300', 'int', [['client', 'Client*']], 'Example::Support'),
    fn('Name', '00401400', 'char*', [['client', 'Client*']], 'Example::Support'),
    fn('Save', '00401500', 'void', [['unit', 'Unit*'], ['name', 'char*'], ['overwrite', 'int']], 'Example::Support'),
    fn('Finish', '00401600', 'void', [['unit', 'Unit*']], 'Example::Support'),
  ];
  const types: ExtractedStruct[] = ['Unit', 'Client'].map(name => ({ kind: 'STRUCTURE', name, category: '/', size: 4, alignment: 4, packed: false,
    fields: [{ name: 'value', dataType: 'int', offset: 0, size: 4 }] }));
  const namespaces: ExtractedNamespace[] = ['Example::Player', 'Example::Support'].map(fullPath => ({ name: fullPath.split('::').at(-1)!, fullPath, functionCount: 1, isClass: false }));
  const options: ReconstructOptions = { outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false, generateSourceMaps: false, transformPreset: 'full', includeAddressComments: false, promoteStaticGlobals: false };
  const info: ProgramInfo = { name: 'SyntheticFixture.exe', path: '/fixture', format: 'PE', architecture: 'x86', compiler: 'msvc', imageBase: '0x400000', languageId: 'x86:LE:32:default', endianness: 'little', pointerSize: 4 };
  const project = generateProject('nestcall-label-fixture', [target, ...support], [], types, [], namespaces, options, info);
  const output = [...project.files.values()].filter(f => f.type === 'implementation').map(f => f.content).join('\n');
  assert.match(output, /Support::Save\(unit, Support::Name\(Support::Lookup\(unit, 2\)\), overwrite\)/);
  assert.match(output, /client = Support::Lookup\(unit, 1\)/);
  assert.match(output, /Support::Flags\(client\)/);
  assert.doesNotMatch(output, /char\* name/);
});
