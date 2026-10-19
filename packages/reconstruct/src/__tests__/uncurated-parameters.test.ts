/**
 * A function whose prototype was never committed (`undefined X(void)`) is decompiled
 * against the prototype the decompiler infers, so its body names `param_1`, `param_2`.
 * v1096: the nine zlib leaves, e.g. gf2_matrix_times @0042d9f0 and deflateSetHeader
 * @00427200, emitted as `uint gf2_matrix_times()` over a body that reads param_1.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { decompiledParameters } from '../codegen/impl.js';
import { generateProject } from '../codegen/index.js';
import type { ExtractedFunction, ReconstructOptions } from '../types.js';

const GF2 = `
/* @function gf2_matrix_times */

uint __fastcall Storm::_3rdparty::zlib::crc32::gf2_matrix_times(uint param_1,uint *param_2)

{
  uint uVar1;
  
  uVar1 = 0;
  for (; param_1 != 0; param_1 = param_1 >> 1) {
    if ((param_1 & 1) != 0) {
      uVar1 = uVar1 ^ *param_2;
    }
    param_2 = param_2 + 1;
  }
  return uVar1;
}
`;

describe('decompiledParameters', () => {
  it('reads type and name pairs, pointers included', () => {
    assert.deepStrictEqual(decompiledParameters(GF2), [
      { name: 'param_1', dataType: 'uint' },
      { name: 'param_2', dataType: 'uint *' },
    ]);
  });
  it('declines a function-pointer or variadic parameter', () => {
    assert.strictEqual(decompiledParameters('void f(int (*cb)(int),int a)\n{\n}\n'), undefined);
    assert.strictEqual(decompiledParameters('void f(char *fmt,...)\n{\n}\n'), undefined);
  });
  it('reads (void) as no parameters', () => {
    assert.deepStrictEqual(decompiledParameters('void f(void)\n{\n}\n'), []);
  });
});

describe('uncurated prototype: the definition declares what the body uses', () => {
  const options: ReconstructOptions = {
    outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false,
    generateSourceMaps: false, transformPreset: 'quick', includeAddressComments: false,
    promoteStaticGlobals: false,
  };
  const fn = (returnType: string, parameters: ExtractedFunction['parameters']): ExtractedFunction => ({
    name: 'gf2_matrix_times', address: '0042d9f0',
    signature: `${returnType} gf2_matrix_times(void)`, returnType, parameters,
    localVariables: [], callingConvention: '__fastcall', size: 23, isThunk: false,
    isExternal: false, hasVarArgs: false, namespace: 'Storm::_3rdparty::zlib::crc32',
    decompiled: GF2, calledFunctions: [],
  } as ExtractedFunction);
  const definition = (f: ExtractedFunction): string => {
    const project = generateProject('T', [f], [], [], [], [], options);
    const cpp = [...project.files.values()].find(x => x.path.endsWith('.cpp') && x.content.includes('gf2_matrix_times('));
    assert.ok(cpp, 'no file defines gf2_matrix_times');
    return cpp!.content.split('\n').find(l => /gf2_matrix_times\(.*\)\s*\{/.test(l)) ?? '';
  };

  it('an undefined (void) function takes the decompiler parameters', () => {
    const line = definition(fn('undefined', []));
    assert.match(line, /gf2_matrix_times\(uint32_t param_1, uint32_t \* ?param_2\)/, line);
  });

  it('a curated return type leaves the stored (empty) list alone', () => {
    const line = definition(fn('uint', []));
    assert.match(line, /gf2_matrix_times\(\)/, line);
  });
});
