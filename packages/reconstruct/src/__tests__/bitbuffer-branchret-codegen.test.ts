import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateProject } from '../codegen/index.js';
import { vc8formBodyHash, vc8FormSpec } from '../codegen/vc8form-spec.js';
import type { ExtractedFunction, ExtractedNamespace, ProgramInfo, ReconstructOptions } from '../types.js';

// Fog::BitBuffer::GetNextPositon, Windows Game.exe 00410e90, as Ghidra currently decompiles it.
const decompiled = `int32_t Fog::BitBuffer::GetNextPositon(D2BitBufferStrc *pBitBuffer)

{
  size_t nNextPos;

  nNextPos = pBitBuffer->nCurrentPos;
  if (pBitBuffer->nBitsAtPos != 0) {
    nNextPos = nNextPos + 1;
  }
  return nNextPos;
}`;

const options: ReconstructOptions = {
  outputDir: './out', format: 'cpp', organization: 'namespace',
  generateCMake: false, generateSourceMaps: false, transformPreset: 'full',
  includeAddressComments: false, promoteStaticGlobals: false,
};
const programInfo: ProgramInfo = {
  name: 'Game.exe', path: '/Redivivus/Game.exe', format: 'PE',
  architecture: 'x86', compiler: 'msvc', imageBase: '0x400000',
  languageId: 'x86:LE:32:default', endianness: 'little', pointerSize: 4,
};
const namespaces: ExtractedNamespace[] = [
  { name: 'BitBuffer', fullPath: 'Fog::BitBuffer', functionCount: 1, isClass: false },
];

function func(tag: 'current' | 'stale' | 'none'): ExtractedFunction {
  const dh = tag === 'stale' ? '00000000' : vc8formBodyHash(decompiled);
  const seal = `;ev=0123456789;bh=22-00000000;dh=${dh}`;
  return {
    name: 'GetNextPositon', address: '00410e90', namespace: 'Fog::BitBuffer', size: 22,
    signature: 'int32_t GetNextPositon(D2BitBufferStrc * pBitBuffer)', returnType: 'int32_t',
    parameters: [{ name: 'pBitBuffer', dataType: 'D2BitBufferStrc *', size: 4,
      ordinal: 0, storage: 'Stack[0x4]:4' }],
    localVariables: [{ name: 'nNextPos', dataType: 'size_t',
      size: 4, storage: 'EAX:4' }],
    callingConvention: '__stdcall', isThunk: false, isExternal: false, hasVarArgs: false,
    decompiled, calledFunctions: [],
    tags: [
      { type: 'method', data: 'D2BitBufferStrc' },
      ...(tag === 'none' ? [] : [{ type: 'vc8form', data: `branchret(nNextPos)${seal}` }]),
    ],
  };
}

export function implementation(tag: 'current' | 'stale' | 'none'): string {
  const project = generateProject('bitbuffer-retval-fold', [func(tag)], [], [], [],
    namespaces, options, programInfo);
  const file = [...project.files.values()].find(f =>
    f.type === 'implementation' && f.content.includes('GetNextPositon('));
  assert.ok(file, 'GetNextPositon implementation');
  return file.content;
}

describe('Fog BitBuffer branch-return codegen', () => {
  it('accepts the current body-sealed branchret tag', () => {
    const spec = vc8FormSpec(func('current'));
    assert.deepEqual(spec?.forms.map(f => f.form.op), ['branchret']);
  });

  it('emits branch returns from the live Ghidra local/assignment shape', () => {
    const out = implementation('current');
    assert.match(out, /if \(pBitBuffer->nBitsAtPos\)/);
    assert.match(out, /return pBitBuffer->nCurrentPos \+ 1;/);
    assert.match(out, /return pBitBuffer->nCurrentPos;/);
    assert.doesNotMatch(out, /nNextPos/);
  });

  it('leaves absent and stale tags byte-identical', () => {
    assert.equal(implementation('stale'), implementation('none'));
  });
});
