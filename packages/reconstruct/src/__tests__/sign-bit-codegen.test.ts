/**
 * Drive the sign-bit spelling through the real project codegen entry point.
 * The plugin's AST tests alone cannot detect a missing codegen registration or
 * missing type facts at the point the generated function body is transformed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateProject } from '../codegen/index.js';
import type {
  ExtractedFunction, ExtractedNamespace, ProgramInfo, ReconstructOptions,
} from '../types.js';

const options: ReconstructOptions = {
  outputDir: './out', format: 'cpp', organization: 'namespace',
  generateCMake: false, generateSourceMaps: false, transformPreset: 'full',
  includeAddressComments: false, promoteStaticGlobals: false,
};

const programInfo: ProgramInfo = {
  name: 'SignBits.exe', path: '/tmp/SignBits.exe', format: 'PE',
  architecture: 'x86', compiler: 'msvc', imageBase: '0x400000',
  languageId: 'x86:LE:32:default', endianness: 'little', pointerSize: 4,
};

const functions: ExtractedFunction[] = [
  {
    name: 'TEST_ByteSign', address: '0x401000',
    signature: 'void TEST_ByteSign(unsigned int dwFlags)', returnType: 'void',
    parameters: [{ name: 'dwFlags', dataType: 'unsigned int', size: 4, ordinal: 0 }], localVariables: [],
    callingConvention: '__cdecl', size: 0x30, isThunk: false,
    isExternal: false, hasVarArgs: false, namespace: 'TEST', calledFunctions: [],
    decompiled: [
      'void __cdecl TEST_ByteSign(unsigned int dwFlags)',
      '{',
      "  if ((char)dwFlags < '\\0') {",
      '    return;',
      '  }',
      '}',
    ].join('\n'),
  },
  {
    name: 'TEST_KeySign', address: '0x401100',
    signature: 'void TEST_KeySign(void)', returnType: 'void',
    parameters: [], localVariables: [], callingConvention: '__cdecl',
    size: 0x30, isThunk: false, isExternal: false, hasVarArgs: false,
    namespace: 'TEST', calledFunctions: ['GetKeyState'],
    decompiled: [
      'void __cdecl TEST_KeySign(void)',
      '{',
      '  SHORT nKeyState;',
      '  nKeyState = GetKeyState(0x11);',
      '  if (nKeyState < 0) {',
      '    return;',
      '  }',
      '}',
    ].join('\n'),
  },
];

const namespaces: ExtractedNamespace[] = [
  { name: 'TEST', fullPath: 'TEST', functionCount: functions.length, isClass: false },
];

describe('sign-bit codegen integration', () => {
  it('emits byte and key-state masks after branch layout', () => {
    const project = generateProject(
      'sign-bits', functions, [], [], [], namespaces, options, programInfo,
    );
    const implementations = [...project.files.values()]
      .filter(file => file.type === 'implementation')
      .map(file => file.content)
      .join('\n');
    // Branch layout reverses both original `< 0` guards before the late
    // sign-bit pass, so the masks must retain the reversed predicate.
    assert.match(implementations, /if \(!\(dwFlags & 0x80\)\)/);
    assert.match(implementations, /if \(!\(nKeyState & 0x8000\)\)/);
    assert.doesNotMatch(implementations, /\(char\)dwFlags\s*<\s*'\\0'/);
    assert.doesNotMatch(implementations, /nKeyState\s*<\s*0/);
  });
});
