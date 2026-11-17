import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateProject } from '../codegen/index.js';
import { vc8formBodyHash } from '../codegen/vc8form-spec.js';
import type { ExtractedFunction, ExtractedGlobal, ProgramInfo, ReconstructOptions } from '../types.js';

const options: ReconstructOptions = { outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false,
  generateSourceMaps: false, transformPreset: 'full', includeAddressComments: false, promoteStaticGlobals: false };
const program: ProgramInfo = { name: 'bounds-fixture', path: '/fixture', format: 'PE', architecture: 'x86', compiler: 'msvc',
  imageBase: '0x400000', languageId: 'x86:LE:32:default', endianness: 'little', pointerSize: 4 };
function source(tagged: boolean, stale = false, alias = false): string {
  const decompiled = 'void BoundsTest::Rebuild(int x,int y) { a=x-24; b=y-24; c=x+24; d=y+24; }';
  const fn: ExtractedFunction = { name: 'Rebuild', address: '00401000', signature: 'void Rebuild(int x,int y)', returnType: 'void',
    parameters: [{ name: 'x', dataType: 'int', size: 4, ordinal: 0, storage: 'Stack[0x4]:4' },
      { name: 'y', dataType: 'int', size: 4, ordinal: 1, storage: 'Stack[0x8]:4' }],
    localVariables: [], callingConvention: '__cdecl', size: 80, isThunk: false, isExternal: false, hasVarArgs: false,
    namespace: 'BoundsTest', calledFunctions: [], decompiled,
    tags: tagged ? [{ type: 'vc8form', data: `bounds(a,b,c,d);ev=0123456789;bh=80-89abcdef;dh=${stale ? '00000000' : vc8formBodyHash(decompiled)}` }] : [] };
  const globals: ExtractedGlobal[] = ['a', 'b', 'c', 'd'].map((name, i) => ({ name, namespace: 'BoundsTest',
    address: (alias && i === 2 ? 0x402000 : 0x402000 + i * 4).toString(16), dataType: 'int', size: 4,
    scope: 'global', isInitialized: true, value: '0', xrefCount: 1 }));
  const project = generateProject('bounds', [fn], [], [], globals, [], options, program);
  return [...project.files.values()].filter(f => f.type === 'implementation').map(f => f.content).join('\n');
}
describe('bounds through production project generation', () => {
  it('uses real global type/address/size tables only under a current tag', () => {
    const baseline = source(false), tagged = source(true);
    assert.match(baseline, /c = x \+ 24/); assert.match(tagged, /c = a \+ 48/); assert.match(tagged, /d = b \+ 48/);
    assert.equal(source(true, true), baseline, 'stale tags leave the source unchanged');
  });
  it('refuses distinct names that identify the same original object', () => {
    assert.equal(source(true, false, true), source(false, false, true));
  });
});
