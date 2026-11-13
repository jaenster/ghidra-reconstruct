import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

import { generateProject } from '../codegen/index.js';
import { vc8formBodyHash, vc8FormSpec } from '../codegen/vc8form-spec.js';
import type { ExtractedFunction, ExtractedNamespace, ExtractedStruct, ProgramInfo, ReconstructOptions } from '../types.js';

// Fog::BitBuffer::GetNextPositon, Windows Game.exe 00410e90, as Ghidra currently decompiles it.
const { decompiled } = JSON.parse(readFileSync(new URL('./fixtures/branchret-live-00410e90.json', import.meta.url), 'utf8')) as { decompiled: string };

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
  // Evidence and byte seals below are fixture placeholders, not live proposal data.
  const seal = `;ev=0123456789;bh=22-00000000;dh=${dh}`;
  return {
    name: 'GetNextPositon', address: '00410e90', namespace: 'Fog::BitBuffer', size: 22,
    signature: 'int32_t GetNextPositon(D2BitBufferStrc * pBitBuffer)', returnType: 'int32_t',
    parameters: [{ name: 'pBitBuffer', dataType: 'D2BitBufferStrc *', size: 4,
      ordinal: 0, storage: 'Stack[0x4]:4' }],
    localVariables: [{ name: 'nNextPos', dataType: 'undefined4', resolvedType: 'size_t',
      size: 4, storage: 'EAX:4' } as never],
    callingConvention: '__stdcall', isThunk: false, isExternal: false, hasVarArgs: false,
    decompiled, calledFunctions: [],
    tags: [
      { type: 'method', data: 'D2BitBufferStrc' },
      ...(tag === 'none' ? [] : [{ type: 'vc8form', data: `branchret(nNextPos)${seal}` }]),
    ],
  };
}

export function implementation(tag: 'current' | 'stale' | 'none'): string {
  const types: ExtractedStruct[] = [{ kind: 'STRUCTURE', name: 'D2BitBufferStrc', category: '/', size: 20, alignment: 1, packed: true,
    fields: [{ name: 'pBuffer', dataType: 'byte *', offset: 0, size: 4 },
      { name: 'nBitsInBuffer', dataType: 'size_t', offset: 4, size: 4 },
      { name: 'nCurrentPos', dataType: 'size_t', offset: 8, size: 4 },
      { name: 'nBitsAtPos', dataType: 'size_t', offset: 12, size: 4 },
      { name: 'bEnd', dataType: 'BOOL', offset: 16, size: 4 }] }];
  const project = generateProject('bitbuffer-retval-fold', [func(tag)], [], types, [],
    namespaces, options, programInfo);
  const file = [...project.files.values()].find(f =>
    f.type === 'implementation' && f.content.includes('GetNextPositon('));
  assert.ok(file, 'GetNextPositon implementation');
  if (process.env.BRANCHRET_EMIT_PATH && tag === 'current') writeFileSync(process.env.BRANCHRET_EMIT_PATH, file.content);
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
    assert.match(out, /return \(size_t\)\(\(size_t\)pBitBuffer->nCurrentPos \+ 1\);/);
    assert.match(out, /return \(size_t\)pBitBuffer->nCurrentPos;/);
    assert.doesNotMatch(out, /nNextPos/);
  });

  it('leaves absent and stale tags byte-identical', () => {
    assert.equal(implementation('stale'), implementation('none'));
  });
});
