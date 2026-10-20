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

describe('placeholderTypesUsedIn: names are not types', () => {
  it('a member or a declarator called `code` is not a use of the code type', () => {
    const used = placeholderTypesUsedIn([
      { path: 'a.h', content: 'struct T { char code[4]; int code2; };\nstruct U { int code; };' },
      { path: 'b.cpp', content: 'int f(T *p, U u) { return p->code[0] + u.code; }\nconst char *s = "code";' },
    ]);
    assert.ok(!used.has('code'), [...used].join(','));
  });

  it('a cast or a declaration through it still is', () => {
    for (const content of ['void f(void *p) { (*(code *)p)(); }', 'code *pfn;', 'code **pp = 0;']) {
      assert.ok(placeholderTypesUsedIn([{ path: 'a.cpp', content }]).has('code'), content);
    }
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
  it('a body that declares a byte array names uint8_t; no placeholder typedef is left', () => {
    const fn = {
      name: 'Send', address: '0052b780', signature: 'void Send(void)', returnType: 'void',
      parameters: [], localVariables: [], callingConvention: '__cdecl', size: 16,
      isThunk: false, isExternal: false, hasVarArgs: false, namespace: 'D2Net',
      decompiled: 'void Send(void)\n{\n  byte aPacket [4];\n  aPacket[0] = 0xaf;\n  Use((char *)aPacket);\n  return;\n}\n',
      calledFunctions: [],
    } as unknown as ExtractedFunction;
    const project = generateProject('T', [fn], [], [], [], [], options);
    const h = project.files.get('d2_platform.h')!.content;
    assert.ok(!/typedef unsigned char byte;/.test(h));
    const cpp = [...project.files.values()].find(f => f.content.includes('aPacket'))!.content;
    assert.match(cpp, /uint8_t aPacket\[4\];/);
    assert.ok(!/typedef long double float10;/.test(h));
    assert.ok(!/typedef uint32_t undefined4;/.test(h));
  });
});
