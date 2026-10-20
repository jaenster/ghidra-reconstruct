/**
 * G2 (TXT_ParseDataAndPutIntoStructure 006bd780): once Ghidra types the two dispatch
 * locals as pointers to named funcdefs, the tree must carry those funcdefs - never
 * collapse them to the generic `code *` - and the stores from the `void *` fpLinker
 * field keep their cast to the funcdef.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { transformGhidraCode } from '../../../index.js';

const OPTS = {
  usePluginRegistry: true as const,
  preset: 'full' as const,
  pluginOptions: { pluginOptions: { 'funcdef-cast-collapse': { funcdefTypedefs: ['PFN_TxtKeyToWord', 'PFN_TxtFieldLinker'] } } },
};

const SRC = `void f(D2BinFieldInputStrc *pBinFieldInput, int i, char *aFieldParseBuf, void *pRecord, int nOffset, int nSize) {
  PFN_TxtKeyToWord *pfnKeyToWord;
  PFN_TxtFieldLinker *pfnLinker;
  ushort w;
  pfnKeyToWord = (PFN_TxtKeyToWord *)pBinFieldInput[i].fpLinker;
  if (pfnKeyToWord != (PFN_TxtKeyToWord *)0x0) {
    w = (*pfnKeyToWord)(aFieldParseBuf);
    Use(w);
  }
  pfnLinker = (PFN_TxtFieldLinker *)pBinFieldInput[i].fpLinker;
  if (pfnLinker != (PFN_TxtFieldLinker *)0x0) {
    (*pfnLinker)(aFieldParseBuf,pRecord,nOffset,nSize,1,2);
  }
}`;

describe('a funcdef-pointer local stays its funcdef', () => {
  it('declares, casts and calls through the funcdef, with no code token', () => {
    const r = transformGhidraCode(SRC, OPTS);
    assert.ok(r.success, r.error);
    assert.match(r.code, /PFN_TxtKeyToWord pfnKeyToWord/, r.code);
    assert.match(r.code, /PFN_TxtFieldLinker pfnLinker/, r.code);
    assert.match(r.code, /pfnKeyToWord = \(PFN_TxtKeyToWord\)pBinFieldInput\[i\]\.fpLinker;/, r.code);
    assert.match(r.code, /\(\*pfnLinker\)\(aFieldParseBuf, pRecord, nOffset, nSize, 1, 2\)/, r.code);
    assert.doesNotMatch(r.code, /\bcode\b/, r.code);
  });
});
