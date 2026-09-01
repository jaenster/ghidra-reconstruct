/**
 * Ghidra can hold a NAMED parameter list whose storage was never committed to
 * the decompiler (`storage: <UNASSIGNED>`). The symbol table then says
 * `(char *szUsername, char *szPassword)` while the body it decompiled still says
 * `param_1`/`param_2`, so the emitted function uses identifiers it never
 * declares:
 *
 *   D2Client/BnSend.cpp: error: 'param_1' was not declared in this scope
 *
 * The two lists are paired positionally and the body is renamed to the names the
 * emitted signature actually declares.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateImplementation, decompiledParameterNames } from '../codegen/impl.js';
import type { ExtractedFunction, ReconstructOptions } from '../types.js';

const options: ReconstructOptions = {
  outputDir: '/tmp/test',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
  promoteStaticGlobals: false,
};

const FUNC: ExtractedFunction = {
  name: 'BNCLIENT_SendLogonRequest',
  address: '0x0051c240',
  signature: 'int BNCLIENT_SendLogonRequest(char * szUsername, char * szPassword)',
  returnType: 'int',
  parameters: [
    { name: 'szUsername', dataType: 'char *', size: 4, ordinal: 0 },
    { name: 'szPassword', dataType: 'char *', size: 4, ordinal: 1 },
  ],
  localVariables: [],
  callingConvention: '__fastcall',
  size: 64,
  isThunk: false,
  isExternal: false,
  hasVarArgs: false,
  decompiled: [
    'int __fastcall BNCLIENT_SendLogonRequest(char *param_1,char *param_2)',
    '',
    '{',
    '  return NET_SID_CLIENT_Send(param_1,param_2);',
    '}',
  ].join('\n'),
};

describe('parameter names the decompiler never saw', () => {
  it('renames the body to the names the signature declares', () => {
    const impl = generateImplementation(
      'D2Client/BnSend', [FUNC], undefined, 'D2Client/BnSend.h',
      options, {}, undefined, new Set<string>(),
    );
    assert.match(impl, /NET_SID_CLIENT_Send\(szUsername, szPassword\)/);
    assert.ok(!/\bparam_1\b/.test(impl), `param_1 is never declared — got:\n${impl}`);
  });

  it('leaves the body alone when the symbol table has no names either', () => {
    const unnamed: ExtractedFunction = {
      ...FUNC,
      parameters: [
        { name: 'param_1', dataType: 'char *', size: 4, ordinal: 0 },
        { name: 'param_2', dataType: 'char *', size: 4, ordinal: 1 },
      ],
    };
    const impl = generateImplementation(
      'D2Client/BnSend', [unnamed], undefined, 'D2Client/BnSend.h',
      options, {}, undefined, new Set<string>(),
    );
    assert.match(impl, /NET_SID_CLIENT_Send\(param_1, param_2\)/);
  });
});

describe('decompiledParameterNames', () => {
  it('reads the prototype the decompiler emitted', () => {
    assert.deepStrictEqual(
      decompiledParameterNames('void f(int a,char *b)\n{\n}'),
      ['a', 'b'],
    );
  });

  it('returns an empty list for a void prototype', () => {
    assert.deepStrictEqual(decompiledParameterNames('void f(void)\n{\n}'), []);
  });

  it('gives up on a function-pointer parameter rather than mispair', () => {
    assert.strictEqual(
      decompiledParameterNames('void f(int a,void (*cb)(int))\n{\n}'),
      undefined,
    );
  });
});
