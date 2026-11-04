/**
 * D2FILE_GetSignerOrganization (00517c30) and its `__finally` block D2FILE_CleanupCryptHandles
 * (00517df5), as Ghidra v1908 decompiles them: the block reads the parent's locals through
 * EBP, and the parent passes `&stack0xfffffffc`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { inlineFrameFunclets } from '../codegen/frame-funclet-inline.js';
import type { ExtractedFunction } from '../types.js';

const FUNCLET_TEXT = `
void __cdecl D2Hell::D2FILE_CleanupCryptHandles(DWORD dwNull,int32_t nFrameBase)

{
  if (*(DWORD *)(nFrameBase + -0x2c) != dwNull) {
                    /* HLOCAL hMem for LocalFree */
    LocalFree(*(HLOCAL *)(nFrameBase + -0x2c));
  }
  if (*(DWORD *)(nFrameBase + -0x28) != dwNull) {
    CertFreeCertificateContext(*(PCCERT_CONTEXT *)(nFrameBase + -0x28));
  }
  if (*(DWORD *)(nFrameBase + -0x30) != dwNull) {
    CertCloseStore(*(HCERTSTORE *)(nFrameBase + -0x30),dwNull);
  }
  if (*(DWORD *)(nFrameBase + -0x24) != dwNull) {
    CryptMsgClose(*(HCRYPTMSG *)(nFrameBase + -0x24));
  }
  return;
}
`;

const PARENT_TEXT = `
bool __fastcall
D2Hell::D2FILE_GetSignerOrganization(LPCSTR szFilePath,LPSTR szOrgOut,int32_t nOrgMaxLen)

{
  HCERTSTORE hCertStore;
  HLOCAL hMsgInfo;
  PCCERT_CONTEXT pCertContext;
  HCRYPTMSG hCryptMsg;
  bool bGotOrg;
  byte *local_8;

  bGotOrg = false;
  local_8 = (byte *)0xfffffffe;
  D2Hell::D2FILE_CleanupCryptHandles(0,(int32_t)&stack0xfffffffc);
  return bGotOrg;
}
`;

function fn(over: Partial<ExtractedFunction>): ExtractedFunction {
  return {
    name: '', address: '', signature: '', returnType: 'void', parameters: [], localVariables: [],
    callingConvention: '__cdecl', size: 64, isThunk: false, isExternal: false, hasVarArgs: false,
    namespace: 'D2Hell', decompiled: '', ...over,
  } as unknown as ExtractedFunction;
}

const funclet = () => fn({
  name: 'D2FILE_CleanupCryptHandles', address: '00517df5', decompiled: FUNCLET_TEXT,
  parameters: [
    { name: 'dwNull', dataType: 'DWORD', size: 4, ordinal: 0, storage: 'EBX:4' },
    { name: 'nFrameBase', dataType: 'int32_t', size: 4, ordinal: 1, storage: 'EBP:4' },
  ] as ExtractedFunction['parameters'],
});

const parent = (text = PARENT_TEXT) => fn({
  name: 'D2FILE_GetSignerOrganization', address: '00517c30', returnType: 'bool', decompiled: text,
  localVariables: [
    { name: 'local_8', dataType: 'byte *', storage: 'Stack[-0x8]:4' },
    { name: 'hCryptMsg', dataType: 'HCRYPTMSG', storage: 'Stack[-0x28]:4' },
    { name: 'pCertContext', dataType: 'PCCERT_CONTEXT', storage: 'Stack[-0x2c]:4' },
    { name: 'hMsgInfo', dataType: 'HLOCAL', storage: 'Stack[-0x30]:4' },
    { name: 'hCertStore', dataType: 'HCERTSTORE', storage: 'Stack[-0x34]:4' },
  ] as unknown as ExtractedFunction['localVariables'],
});

describe('frame-funclet-inline', () => {
  it('puts the __finally block back at its call, on the parent locals', () => {
    const r = inlineFrameFunclets([parent(), funclet()]);
    assert.deepStrictEqual(r.refusals, []);
    assert.strictEqual(r.functions.length, 1, 'the funclet is no longer a function');
    assert.deepStrictEqual(r.inlined[0]!.slots, { 0x24: 'hCryptMsg', 0x28: 'pCertContext', 0x2c: 'hMsgInfo', 0x30: 'hCertStore' });
    const text = r.functions[0]!.decompiled!;
    assert.ok(!text.includes('D2FILE_CleanupCryptHandles(0'), text);
    assert.ok(!text.includes('nFrameBase'), text);
    // The order of the original: LocalFree, CertFreeCertificateContext, CertCloseStore, CryptMsgClose.
    const order = ['LocalFree(hMsgInfo)', 'CertFreeCertificateContext(pCertContext)', 'CertCloseStore(hCertStore, 0)', 'CryptMsgClose(hCryptMsg)']
      .map(s => text.indexOf(s));
    assert.ok(order.every(i => i > 0) && order.every((v, i) => i === 0 || v > order[i - 1]!), text);
    // A DWORD read of a handle keeps its width; EBX (the parent's zero) is 0.
    assert.ok(text.includes('*(DWORD*)&hMsgInfo != 0'), text);
    // Before the return, after the try-level store.
    assert.ok(text.indexOf('local_8 = (byte *)0xfffffffe') < text.indexOf('LocalFree') && text.indexOf('LocalFree') < text.indexOf('return bGotOrg'), text);
  });

  it('folds an early return into the condition of what follows', () => {
    const early = FUNCLET_TEXT.replace(`  if (*(DWORD *)(nFrameBase + -0x24) != dwNull) {
    CryptMsgClose(*(HCRYPTMSG *)(nFrameBase + -0x24));
  }
  return;`, `  if (*(DWORD *)(nFrameBase + -0x24) == dwNull) {
    return;
  }
  CryptMsgClose(*(HCRYPTMSG *)(nFrameBase + -0x24));
  return;`);
    const r = inlineFrameFunclets([parent(), { ...funclet(), decompiled: early }]);
    const text = r.functions[0]!.decompiled!;
    assert.ok(/if \(!\(\*\(DWORD\*\)&hCryptMsg == 0\)\) \{\s*CryptMsgClose\(hCryptMsg\);/.test(text), text);
    assert.ok(!/\breturn;/.test(text), text);
  });

  it('leaves a funclet another function also calls', () => {
    const other = fn({ name: 'Other', address: '00400000', decompiled: 'void Other(void)\n{\n  D2Hell::D2FILE_CleanupCryptHandles(0,(int32_t)&stack0xfffffffc);\n  return;\n}\n' });
    const r = inlineFrameFunclets([parent(), funclet(), other]);
    assert.strictEqual(r.inlined.length, 0);
    assert.strictEqual(r.functions.length, 3);
  });

  it('leaves a frame offset that is not one local', () => {
    const p = parent();
    p.localVariables = p.localVariables.filter(v => v.name !== 'hCertStore');
    const r = inlineFrameFunclets([p, funclet()]);
    assert.strictEqual(r.inlined.length, 0);
    assert.ok(r.refusals.some(x => x.includes('[EBP-0x30]')), r.refusals.join('\n'));
  });

  it('leaves a frame argument that is not the frame address', () => {
    const r = inlineFrameFunclets([parent(PARENT_TEXT.replace('(int32_t)&stack0xfffffffc', 'nBase')), funclet()]);
    assert.strictEqual(r.inlined.length, 0);
  });

  it('leaves a funclet in another namespace', () => {
    const r = inlineFrameFunclets([parent(), { ...funclet(), namespace: 'Fog' }]);
    assert.strictEqual(r.inlined.length, 0);
  });
});
