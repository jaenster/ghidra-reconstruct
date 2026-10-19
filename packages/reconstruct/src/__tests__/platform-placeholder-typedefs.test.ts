/**
 * d2_platform.h typedefs a Ghidra placeholder type (byte, uint, undefined4, float10,
 * code, vtable, ...) only while the generated tree spells it, so a tree that no longer
 * names one does not carry the name at all.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generatePlatformHeader, placeholderTypesUsedIn, PLACEHOLDER_TYPE_NAMES } from '../codegen/platform-types.js';
import { generateProject } from '../codegen/index.js';
import type { ExtractedFunction, ReconstructOptions } from '../types.js';

describe('placeholderTypesUsedIn', () => {
  it('counts code tokens, not comments, strings or the platform header defining the name', () => {
    const used = placeholderTypesUsedIn([
      { path: 'a.cpp', content: 'byte b[4]; // float10 here is prose\nconst char *s = "undefined4";' },
      { path: 'd2_platform.h', content: 'typedef unsigned char byte;\ntypedef long double float10;\ntypedef uint ulong_alias;\ntypedef unsigned int uint;' },
    ]);
    assert.deepStrictEqual([...used].sort(), ['byte', 'uint']);
  });
});

describe('generatePlatformHeader: placeholder gating', () => {
  it('emits exactly the used placeholders', () => {
    const h = generatePlatformHeader({ placeholderTypesUsed: new Set(['byte', 'code']) });
    assert.match(h, /typedef unsigned char byte;/);
    assert.match(h, /typedef int code\(\.\.\.\);/);
    for (const n of PLACEHOLDER_TYPE_NAMES.filter(x => x !== 'byte' && x !== 'code')) {
      assert.ok(!new RegExp(`typedef [^;]*\\b${n}\\b[^;]*;`).test(h.replace(/\/\/.*$/gm, '')), `${n} emitted`);
    }
  });
});

describe('generateProject: d2_platform.h follows the tree', () => {
  const options: ReconstructOptions = {
    outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false,
    generateSourceMaps: false, transformPreset: 'quick', includeAddressComments: false,
    promoteStaticGlobals: false,
  };
  it('keeps byte for a body that declares a byte array, drops float10 and undefined4', () => {
    const fn = {
      name: 'Send', address: '0052b780', signature: 'void Send(void)', returnType: 'void',
      parameters: [], localVariables: [], callingConvention: '__cdecl', size: 16,
      isThunk: false, isExternal: false, hasVarArgs: false, namespace: 'D2Net',
      decompiled: 'void Send(void)\n{\n  byte aPacket [4];\n  aPacket[0] = 0xaf;\n  Use((char *)aPacket);\n  return;\n}\n',
      calledFunctions: [],
    } as unknown as ExtractedFunction;
    const project = generateProject('T', [fn], [], [], [], [], options);
    const h = project.files.get('d2_platform.h')!.content;
    assert.match(h, /typedef unsigned char byte;/);
    assert.ok(!/typedef long double float10;/.test(h));
    assert.ok(!/typedef uint32_t undefined4;/.test(h));
  });
});
