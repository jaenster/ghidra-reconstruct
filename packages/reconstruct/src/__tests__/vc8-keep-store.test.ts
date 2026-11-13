import { it } from 'node:test';
import assert from 'node:assert/strict';
import { generateFunctionImplementation, type ImplGenContext } from '../codegen/impl.js';
import { vc8formBodyHash } from '../codegen/vc8form-spec.js';
import type { ExtractedFunction, ReconstructOptions } from '../types.js';

// 00418470's live Windows decompile, source aa33ea4. The zero already exists.
const decompiled = `StormLinkedListStrc * __fastcall Storm::Source::SFile::Unreferenced_00418470(StormLinkedListStrc *param_1) {
  StormLinkStrc *pSVar1;
  pSVar1 = &param_1->head;
  pSVar1->pPrevLink = (StormLinkStrc *)0x0;
  (param_1->head).pNext = 0;
  pSVar1->pPrevLink = pSVar1;
  param_1->nLinkOffset = 0;
  (param_1->head).pNext = ~(uint)pSVar1;
  return param_1;
}`;
const options: ReconstructOptions = { outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false, generateSourceMaps: false, transformPreset: 'full', includeAddressComments: false, promoteStaticGlobals: false };
const context: ImplGenContext = { funcPtrArgCasts: {
  paramFuncdefs: {}, funcdefSignatures: {}, functionSignatures: {}, variableNames: [], voidPointerFunctions: [], rootQualifiedTypedefs: [],
  typedefTargets: { intptr_t: 'int', uint: 'unsigned int' },
  structFields: { StormLinkStrc: { pPrevLink: 'StormLinkStrc*', pNext: 'intptr_t' }, StormLinkedListStrc: { nLinkOffset: 'int32_t', head: 'StormLinkStrc' } },
  structLayouts: {
    StormLinkStrc: [{ name: 'pPrevLink', offset: 0, size: 4, type: 'StormLinkStrc*' }, { name: 'pNext', offset: 4, size: 4, type: 'intptr_t' }],
    StormLinkedListStrc: [{ name: 'head', offset: 4, size: 8, type: 'StormLinkStrc' }],
  },
} };
const fn: ExtractedFunction = {
  name: 'Unreferenced_00418470', address: '00418470', signature: 'StormLinkedListStrc* Unreferenced_00418470(StormLinkedListStrc* param_1)',
  returnType: 'StormLinkedListStrc*', callingConvention: '__fastcall',
  parameters: [{ name: 'param_1', dataType: 'StormLinkedListStrc*', size: 4, ordinal: 0, storage: 'ECX:4' }],
  localVariables: [], size: 32, isThunk: false, isExternal: false, hasVarArgs: false, decompiled,
};
it('passes the owning layout into a current, explicitly tagged keepstore form', () => {
  // Synthetic seals exercise tag plumbing only; no proposal/export is made by this test.
  const tags = [{ type: 'vc8form', data: `keepstore(pSVar1->pPrevLink);ev=0000000000;bh=32-00000000;dh=${vc8formBodyHash(decompiled)}` }];
  const out = generateFunctionImplementation({ ...fn, tags }, undefined, options, context);
  assert.match(out, /\(\(volatile StormLinkStrc\*\)pSVar1\)->pPrevLink = 0;/);
  const plain = generateFunctionImplementation(fn, undefined, options, context);
  assert.doesNotMatch(plain, /volatile/);
  assert.match(plain, /pSVar1->pPrevLink = 0;/);
  // Manually attested LEA EDX and MOV [EDX+4],0 at 00418472/0041847b.
  const lines = decompiled.split('\n');
  const storeBases: ExtractedFunction['storeBases'] = { lineCount: lines.length, lines: [
    [lines.findIndex(l => l.includes('pSVar1 = &')) + 1, [{ ord: 0, kind: 'l', reg: 'EDX', disp: 0 }]],
    [lines.findIndex(l => l.includes('(param_1->head).pNext = 0')) + 1, [{ ord: 0, kind: 's', reg: 'EDX', disp: 4 }]],
  ] };
  const withBases = generateFunctionImplementation({ ...fn, tags, storeBases }, undefined, options, context);
  assert.match(withBases, /\(\(volatile StormLinkStrc\*\)pSVar1\)->pPrevLink = 0;/);
  assert.match(withBases, /pSVar1->pNext = 0;/);
  assert.match(withBases, /param_1->head.pNext = ~/);
  const stale = generateFunctionImplementation({ ...fn, tags, decompiled: decompiled.replace('nLinkOffset = 0', 'nLinkOffset = 1') }, undefined, options, context);
  assert.doesNotMatch(stale, /volatile/);
});
