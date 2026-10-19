/**
 * A body that never reached the AST skipped every pass, so it is still Ghidra's notation.
 * It used to have `&stack0xNNNN` rewritten to `0` - a silent read of address 0. It is now
 * emitted as written (an unbound frame address then fails to compile), and in strict mode
 * the body is an #error that names the function.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { generateFunctionImplementation } from '../codegen/impl.js';
import type { ExtractedFunction, ReconstructOptions } from '../types.js';

const options: ReconstructOptions = {
  outputDir: './out',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
  promoteStaticGlobals: false,
};

/** The `@@` makes the body unparsable, so it takes the fallback path. */
const unparsable: ExtractedFunction = {
  name: 'UnparsedFrameRead',
  address: '0x00401230',
  signature: 'int UnparsedFrameRead(void)',
  returnType: 'int',
  parameters: [],
  localVariables: [],
  callingConvention: '__cdecl',
  size: 16,
  isThunk: false,
  isExternal: false,
  hasVarArgs: false,
  decompiled: 'int UnparsedFrameRead(void)\n{\n  int x = *(int *)&stack0xfffffffc;\n  @@ bad;\n  return x;\n}',
};

describe('unparsed body fallback', () => {
  afterEach(() => { delete process.env.RECON_ARTIFACT_LOWERING; });

  it('keeps the frame address instead of rewriting it to 0', () => {
    const out = generateFunctionImplementation(unparsable, undefined, options);
    assert.ok(out.includes('&stack0xfffffffc'), out);
    assert.ok(!out.includes('*(int *)0'), out);
  });

  it('is a hard error naming the function in strict mode', () => {
    process.env.RECON_ARTIFACT_LOWERING = 'strict';
    const out = generateFunctionImplementation(unparsable, undefined, options);
    assert.match(out, /#error "body of UnparsedFrameRead @ 0x00401230 was not transformed/);
  });
});
