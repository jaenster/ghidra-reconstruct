/**
 * A REP STOS fill as the index loop VC8 compiles to it, a REP MOVS copy as memcpy
 * (rep-string-form), only where the instruction fact ties the printed loop to one string
 * instruction and the rewrite keeps every value. The shapes are the decompiler's for
 * GAMEDATA_GetCenteredTextX 0044d390 (`rep stosd`, ECX 0x32) and
 * NET_SERVER_SentPacketLog_Clear 0040b0c0 (`rep movsd`, ECX 0x1fe).
 *
 * Also the passes that must leave such a loop alone or keep their own counts honest:
 * array-fill-collapse (an unrolled fill over 32 bytes is an index loop, not a memset call) and
 * memory-patterns (memset/memcpy count bytes, a loop counts elements).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createRepStringFormTransformer, type RepStringOp, type RepStringFormOptions } from '../builtins/rep-string-form.js';
import { arrayFillCollapsePlugin } from '../builtins/array-fill-collapse.js';
import { memoryPatternsPlugin } from '../builtins/memory-patterns.js';

function run(code: string, ops: RepStringOp[], extra: Partial<RepStringFormOptions> = {}) {
  let census: { fills: number; copies: number; untied: number } | undefined;
  const out = emit(createRepStringFormTransformer({ ops, onCensus: c => { census = c; }, ...extra } as RepStringFormOptions)(parse(code)) as AnyNode).trim();
  return { out, census };
}

const FILL = (after = '  pSourceStr = g(nStringId);\n  return pSourceStr[0];') => `int32_t f(uint16_t nStringId) {
  WCHAR *pSourceStr;
  int iClear;
  WCHAR wszText [100];
  pSourceStr = wszText;
  for (iClear = 0x32; iClear != 0; iClear = iClear + -1) {
    pSourceStr[0] = L'\\0';
    pSourceStr[1] = L'\\0';
    pSourceStr = pSourceStr + 2;
  }
${after}
}`;
const STOS: RepStringOp = { op: 'stos', unit: 4, count: 0x32, fill: 0, names: ['iClear', 'pSourceStr'], address: '0044d3ac' };

describe('rep-string-form: fills', () => {
  it('GAMEDATA_GetCenteredTextX: 0x32 dwords over WCHAR[100] are 0x64 elements', () => {
    const { out, census } = run(FILL(), [STOS]);
    assert.match(out, /for \(iClear = 0; iClear < 0x64; iClear = iClear \+ 1\) \{\n\s*wszText\[iClear\] = L'\\0';\n\s*\}/);
    assert.doesNotMatch(out, /pSourceStr = wszText/);
    assert.deepStrictEqual(census, { fills: 1, copies: 0, untied: 0 });
  });

  it('a dword pointer over a byte array: K * 4 elements', () => {
    const code = `void f() {
  uint *p;
  uint n;
  char sz [0x40];
  p = sz;
  for (n = 0x10; n != 0; n = n - 1) {
    *p = 0;
    p = p + 1;
  }
  g(sz);
}`;
    const { out } = run(code, [{ op: 'stos', unit: 4, count: 0x10, fill: 0, names: ['n', 'p'] }]);
    assert.match(out, /for \(n = 0; n < 0x40; n = n \+ 1\) \{\n\s*sz\[n\] = 0;/);
  });

  it('a global array, sized from the global tables', () => {
    const code = `void f() {
  uint16_t *pBuf;
  int nLeft;
  pBuf = gBuffer;
  for (nLeft = 0x80; nLeft != 0; nLeft = nLeft + -1) {
    pBuf[0] = 0;
    pBuf[1] = 0;
    pBuf = pBuf + 2;
  }
}`;
    const ops: RepStringOp[] = [{ op: 'stos', unit: 4, count: 0x80, fill: 0, names: ['nLeft', 'pBuf'] }];
    assert.match(run(code, ops, { globalSizes: { gBuffer: 0x200 }, globalElementSizes: { gBuffer: 2 } }).out, /gBuffer\[nLeft\] = 0/);
    // Without the tables the extent is unknown.
    assert.match(run(code, ops).out, /pBuf\[1\] = 0/);
    // A fill past the end of the global is not a loop over it.
    assert.match(run(code, ops, { globalSizes: { gBuffer: 0x100 }, globalElementSizes: { gBuffer: 2 } }).out, /pBuf\[1\] = 0/);
  });

  it('needs the instruction: no fact, another count, a nonzero EAX, another counter', () => {
    for (const ops of [
      [],
      [{ ...STOS, count: 0x31 }],
      [{ ...STOS, fill: 0xffffffff }],
      [{ ...STOS, names: ['i', 'pSourceStr'] }],
      [{ ...STOS, op: 'movs' as const }],
    ]) {
      assert.match(run(FILL(), ops).out, /pSourceStr\[1\] = L'\\0'/);
    }
    assert.strictEqual(run(FILL(), [{ ...STOS, count: 0x31 }]).census?.untied, 1);
  });

  it('leaves the loop when the pointer or the counter is read after it', () => {
    assert.match(run(FILL('  return pSourceStr[0];'), [STOS]).out, /pSourceStr\[1\]/);
    assert.match(run(FILL('  return iClear;'), [STOS]).out, /pSourceStr\[1\]/);
    // Read only after a whole assignment: dead.
    assert.match(run(FILL('  iClear = 3;\n  return iClear;'), [STOS]).out, /wszText\[iClear\]/);
  });

  it('leaves a fill larger than the array, and one whose start something between reads', () => {
    const small = FILL().replace('wszText [100]', 'wszText [50]');
    assert.match(run(small, [STOS]).out, /pSourceStr\[1\]/);
    const read = FILL().replace('  pSourceStr = wszText;\n', '  pSourceStr = wszText;\n  h(pSourceStr);\n');
    assert.match(run(read, [STOS]).out, /pSourceStr\[1\]/);
    const escaped = FILL().replace('  pSourceStr = wszText;\n', '  k(&pSourceStr);\n  pSourceStr = wszText;\n  h();\n');
    assert.match(run(escaped, [STOS]).out, /pSourceStr\[1\]/);
  });

  it('BuildKillMessage 0049eb10: a statement between the start and the loop stays before the fill', () => {
    const code = FILL().replace('  pSourceStr = wszText;\n', '  pSourceStr = wszText;\n  pMsgCtxSaved = pMessageCtx;\n');
    const { out, census } = run(code, [STOS]);
    assert.match(out, /pMsgCtxSaved = pMessageCtx;\n\s*for \(iClear = 0; iClear < 0x64; iClear = iClear \+ 1\) \{\n\s*wszText\[iClear\] = L'\\0';/);
    assert.deepStrictEqual(census, { fills: 1, copies: 0, untied: 0 });
  });

  it('UNITDRAW_DrawHoverUnitLabel 00454ad0: the label on the start moves to the fill', () => {
    const code = FILL().replace('  pSourceStr = wszText;\n', '  if (nStringId) goto draw_label;\n  h();\ndraw_label:\n  pSourceStr = wszText;\n');
    const { out, census } = run(code, [STOS]);
    assert.match(out, /draw_label:\s*for \(iClear = 0; iClear < 0x64;/);
    assert.deepStrictEqual(census, { fills: 1, copies: 0, untied: 0 });
  });

  it('leaves stores that do not cover one unit exactly', () => {
    const gap = FILL().replace("    pSourceStr[1] = L'\\0';\n", "    pSourceStr[2] = L'\\0';\n");
    assert.match(run(gap, [STOS]).out, /pSourceStr\[2\]/);
    const nonzero = FILL().replace("    pSourceStr[1] = L'\\0';", "    pSourceStr[1] = L'a';");
    assert.match(run(nonzero, [STOS]).out, /pSourceStr\[1\] = L'a'/);
  });
});

describe('rep-string-form: copies', () => {
  const COPY = (init: string, after = '') => `void f() {
  uint *pSrc;
  uint *pDst;
  int nCopyCount;
  uint aTable [0x200];
${init}
  for (nCopyCount = 0x1fe; nCopyCount != 0; nCopyCount = nCopyCount + -1) {
    *pDst = *pSrc;
    pSrc = pSrc + 1;
    pDst = pDst + 1;
  }
${after}
}`;
  const MOVS: RepStringOp = { op: 'movs', unit: 4, count: 0x1fe, names: ['nCopyCount', 'pDst', 'pSrc'] };
  const SEPARATE = '  pSrc = (uint *)(gaServerSentPacketByteCounts + 1);\n  pDst = aTable;';
  const globals = { globalSizes: { gaServerSentPacketByteCounts: 0x800 } };

  it('rep movsd of 0x1fe dwords between two objects is memcpy of 0x7f8 bytes', () => {
    const { out, census } = run(COPY(SEPARATE), [MOVS], globals);
    assert.match(out, /pDst = aTable;\n\s*memcpy\(pDst, pSrc, 0x7f8\);/);
    assert.deepStrictEqual(census, { fills: 0, copies: 1, untied: 0 });
  });

  it('NET_SERVER_SentPacketLog_Clear 0040b0c0: an array copied onto itself one element up is not a memcpy', () => {
    const overlap = '  pSrc = (uint *)gaServerSentPacketByteCounts;\n  pDst = (uint *)(gaServerSentPacketByteCounts + 1);';
    assert.match(run(COPY(overlap), [MOVS], globals).out, /\*pDst = \*pSrc/);
  });

  it('a pointer that could point anywhere is no proof of separate objects', () => {
    const viaPointer = '  pSrc = pAny;\n  pDst = (uint *)gaServerSentPacketByteCounts;';
    const code = COPY(viaPointer).replace('void f() {', 'void f(uint *pAny) {');
    assert.match(run(code, [MOVS], globals).out, /\*pDst = \*pSrc/);
    // A frame array nothing named before the loop: no pointer from outside reaches into it.
    const frame = COPY('  pSrc = pAny;\n  pDst = aTable;').replace('void f() {', 'void f(uint *pAny) {');
    assert.match(run(frame, [MOVS], globals).out, /memcpy\(pDst, pSrc, 0x7f8\);/);
    const named = COPY('  h(aTable);\n  pSrc = pAny;\n  pDst = aTable;').replace('void f() {', 'void f(uint *pAny) {');
    assert.match(run(named, [MOVS], globals).out, /\*pDst = \*pSrc/);
  });

  it('NET_D2GS_CLIENT_Incoming0x5A: a local packet filled from the untouched packet parameter', () => {
    const code = (extra = '') => `void f(uint *pBytes) {
  uint *pDst;
  int nWords;
  D2Packet0x5a packet;
${extra}  pDst = (uint *)&packet;
  for (nWords = 10; nWords != 0; nWords = nWords + -1) {
    *pDst = *pBytes;
    pBytes = pBytes + 1;
    pDst = pDst + 1;
  }
  g(&packet);
}`;
    const ops: RepStringOp[] = [{ op: 'movs', unit: 4, count: 10, names: ['nWords', 'pDst', 'pBytes'] }];
    assert.match(run(code(), ops).out, /memcpy\(pDst, pBytes, 40\);/);
    // Once the parameter is reassigned it may point anywhere, the frame included.
    assert.match(run(code('  pBytes = (uint *)&packet + 1;\n'), ops).out, /\*pDst = \*pBytes/);
    // Stepped, it still points where the caller's pointer did: never into this frame's packet,
    // which nothing named before the copy.
    assert.match(run(code('  pBytes++;\n'), ops).out, /memcpy\(pDst, pBytes, 40\);/);
  });

  it('a byte pointer advanced by four under a dword cast', () => {
    const code = `void f() {
  char *pDst;
  char *pBasename;
  int nCopyCount;
  char szName [0x100];
  pBasename = szName;
  pDst = gPath;
  for (nCopyCount = 0x40; nCopyCount != 0; nCopyCount = nCopyCount + -1) {
    *(undefined4 *)pDst = *(undefined4 *)pBasename;
    pBasename = pBasename + 4;
    pDst = pDst + 4;
  }
}`;
    const ops: RepStringOp[] = [{ op: 'movs', unit: 4, count: 0x40, names: ['nCopyCount', 'pDst', 'pBasename'] }];
    assert.match(run(code, ops, { globalSizes: { gPath: 0x104 } }).out, /memcpy\(pDst, pBasename, 0x100\);/);
  });

  it('a movsw tail continues the copy: memcpy of 0x7fa bytes', () => {
    const { out, census } = run(COPY(SEPARATE, '  *(ushort *)pDst = *(ushort *)pSrc;\n  g(aTable);'), [MOVS], globals);
    assert.match(out, /memcpy\(pDst, pSrc, 0x7fa\);\n\s*g\(aTable\);/);
    assert.doesNotMatch(out, /ushort/);
    assert.deepStrictEqual(census, { fills: 0, copies: 1, untied: 0 });
  });

  it('DecodeCpuModelName 0040e300: a string literal into a pointer parameter, with a movsw and a movsb tail', () => {
    const code = `void f(char *pOutName) {
  int nCopyCount;
  char *pSrcName;
  pSrcName = "Pentium III (no brand)";
  for (nCopyCount = 5; nCopyCount != 0; nCopyCount = nCopyCount + -1) {
    *(undefined4 *)pOutName = *(undefined4 *)pSrcName;
    pSrcName = pSrcName + 4;
    pOutName = pOutName + 4;
  }
  *(undefined2 *)pOutName = *(undefined2 *)pSrcName;
  pOutName[2] = pSrcName[2];
  return;
}`;
    const op: RepStringOp = { op: 'movs', unit: 4, count: 5, names: ['nCopyCount', 'pOutName', 'pSrcName'] };
    const { out, census } = run(code, [op]);
    assert.match(out, /memcpy\(pOutName, pSrcName, 23\);\n\s*return;/);
    assert.deepStrictEqual(census, { fills: 0, copies: 1, untied: 0 });
  });

  it('SKILLS_ApplyDamageCallback 0056ba90: a frame object nothing named before is apart from any source', () => {
    const code = `void f(D2SkillCallbackStrc *pContext) {
  int iVar1;
  uint32_t *pDamageSrc;
  uint32_t *pDamageDstCopy;
  D2DamageStrc sDamage;
  pDamageSrc = pContext->pCallbackArg;
  pDamageDstCopy = (uint32_t *)&sDamage;
  for (iVar1 = 0x10; iVar1 != 0; iVar1 = iVar1 + -1) {
    *pDamageDstCopy = *pDamageSrc;
    pDamageSrc = pDamageSrc + 1;
    pDamageDstCopy = pDamageDstCopy + 1;
  }
  g(&sDamage);
}`;
    const op: RepStringOp = { op: 'movs', unit: 4, count: 0x10, names: ['iVar1', 'pDamageDstCopy', 'pDamageSrc'] };
    assert.match(run(code, [op]).out, /memcpy\(pDamageDstCopy, pDamageSrc, 0x40\);/);
    // Named before the loop (its address could have gone anywhere): left as printed.
    assert.match(run(code.replace('  pDamageSrc = pContext', '  h(&sDamage);\n  pDamageSrc = pContext'), [op]).out, /\*pDamageDstCopy = \*pDamageSrc/);
  });

  it('leaves a copy whose pointers continue after the tail, or without the fact', () => {
    assert.match(run(COPY(SEPARATE, '  *(ushort *)pDst = *(ushort *)pSrc;\n  g(pDst);'), [MOVS], globals).out, /\*pDst = \*pSrc/);
    assert.match(run(COPY(SEPARATE), [], globals).out, /\*pDst = \*pSrc/);
    assert.match(run(COPY(SEPARATE), [{ ...MOVS, count: 0x1ff }], globals).out, /\*pDst = \*pSrc/);
  });
});

describe('array-fill-collapse: an unrolled fill over 32 bytes', () => {
  const tx = (code: string, opts = {}) => emit(arrayFillCollapsePlugin.createTransformer(opts)(parse(code) as AnyNode) as AnyNode).trim();
  const stores = (n: number, v = "L'\\0'") => Array.from({ length: n }, (_, i) => `wszKeyLine[${i}] = ${v};`).join(' ');

  it('HELP_DrawHelpButtonTooltip: thirty WCHARs are the index loop', () => {
    const out = tx(`void f() { WCHAR wszKeyLine [30]; int i; ${stores(30)} g(wszKeyLine); }`);
    assert.match(out, /for \(int iFill = 0; iFill < 30; iFill\+\+\) \{\n\s*wszKeyLine\[iFill\] = L'\\0';\n\s*\}/);
  });

  it('stays memset at 32 bytes or less, and where the element size is unknown', () => {
    assert.match(tx(`void f() { WCHAR wszKeyLine [16]; ${stores(16)} }`), /memset\(wszKeyLine, 0, 16 \* sizeof\(wszKeyLine\[0\]\)\)/);
    assert.match(tx(`void f() { ${stores(30)} }`), /memset\(wszKeyLine, 0, 30 \* sizeof/);
    assert.match(tx(`void f() { ${stores(30)} }`, { globalElementSizes: { wszKeyLine: 2 } }), /for \(int iFill = 0; iFill < 30/);
  });

  it('a fresh counter name, never one the function uses', () => {
    assert.match(tx(`void f() { WCHAR wszKeyLine [30]; int iFill; ${stores(30)} }`), /for \(int iFill2 = 0;/);
  });
});

describe('memory-patterns: memset and memcpy count bytes', () => {
  const tx = (code: string) => emit(memoryPatternsPlugin.createTransformer({})(parse(code) as AnyNode) as AnyNode).trim();

  it('folds a byte loop, leaves a wider one', () => {
    assert.match(tx('void f() { char sz [64]; int i; for (i = 0; i < 64; i++) { sz[i] = 0; } }'), /memset\(sz, 0, 64\)/);
    assert.match(tx('void f() { WCHAR wsz [64]; int i; for (i = 0; i < 64; i++) { wsz[i] = 0; } }'), /wsz\[i\] = 0/);
    assert.match(tx('void f() { uint a [8]; uint b [8]; int i; for (i = 0; i < 8; i++) { a[i] = b[i]; } }'), /a\[i\] = b\[i\]/);
  });

  it('leaves `i <= n`, which runs n + 1 times', () => {
    assert.match(tx('void f() { char sz [64]; int i; for (i = 0; i <= 63; i++) { sz[i] = 0; } }'), /sz\[i\] = 0/);
  });

  it('leaves a loop marked as the source form of its instructions', () => {
    const fill = `void f() {
  uint *p;
  uint n;
  char sz [0x100];
  p = sz;
  for (n = 0x40; n != 0; n = n + -1) {
    *p = 0;
    p = p + 1;
  }
  g(sz);
}`;
    const ops: RepStringOp[] = [{ op: 'stos', unit: 4, count: 0x40, fill: 0, names: ['n', 'p'] }];
    const marked = createRepStringFormTransformer({ ops } as RepStringFormOptions)(parse(fill));
    assert.match(emit(memoryPatternsPlugin.createTransformer({})(marked) as AnyNode), /sz\[n\] = 0/);
    // The same loop without the mark (and with the `n++` increment-simplify makes of it) is
    // an ordinary byte loop and folds.
    assert.match(tx(emit(marked as AnyNode).replace('n = n + 1', 'n++')), /memset\(sz, 0, 0x100\)/);
  });
});

// NET_D2GS_CLIENT_Incoming0x91_WELCOME_BACK 0045e580 (`mov ecx, 6; lea edi, [packet]; rep movsd;
// movsw`) and Unreferenced_00402c30 (`mov ecx, 0x8a; rep movsd`): a struct assignment, printed
// as the first dword's members and an advance to the member one dword in.
const PACKET91 = [
  { name: 'nPacketId', offset: 0, size: 1, type: 'byte' },
  { name: 'nAct', offset: 1, size: 1, type: 'byte' },
  { name: 'nNpcID', offset: 2, size: 24, type: 'ushort[12]' },
];
const MODULE_ENTRY = [
  { name: 'pImageBase', offset: 0, size: 4, type: 'void *' },
  { name: 'nImageSize', offset: 4, size: 4, type: 'uint32_t' },
  { name: 'szModuleName', offset: 8, size: 256, type: 'char[256]' },
  { name: 'szImagePath', offset: 264, size: 256, type: 'char[256]' },
  { name: 'dwRest', offset: 520, size: 32, type: 'uint32_t[8]' },
];
const LAYOUTS = {
  structLayouts: { D2GSPacketSrv0x91: PACKET91, D2FogDebugModuleEntryStrc: MODULE_ENTRY },
  aggregateSizes: { D2GSPacketSrv0x91: 26, D2FogDebugModuleEntryStrc: 0x228 },
};
const WELCOME_BACK = (after = '  NPCMENU_MarkNpcSpeechesUpdated(&packet);') => `void __fastcall f(D2GSPacketSrv0x91 *pBytes) {
  ushort uVar1;
  int nCount;
  D2GSPacketSrv0x91 *pDst;
  D2GSPacketSrv0x91 packet;
  byte cAct;
  pDst = &packet;
  for (nCount = 6; nCount != 0; nCount = nCount + -1) {
    cAct = pBytes->nAct;
    uVar1 = pBytes->nNpcID[0];
    pDst->nPacketId = pBytes->nPacketId;
    pDst->nAct = cAct;
    pDst->nNpcID[0] = uVar1;
    pBytes = (D2GSPacketSrv0x91 *)(pBytes->nNpcID + 1);
    pDst = (D2GSPacketSrv0x91 *)(pDst->nNpcID + 1);
  }
  cAct = pBytes->nAct;
  pDst->nPacketId = pBytes->nPacketId;
  pDst->nAct = cAct;
${after}
  return;
}`;
const MOVS91: RepStringOp = { op: 'movs', unit: 4, count: 6, names: ['nCount', 'cAct', 'pBytes', 'uVar1', 'pDst'], address: '0045e592' };

describe('rep-string-form: struct copies', () => {
  it('WELCOME_BACK: six dwords and a word of a 26-byte packet are `packet = *pBytes`', () => {
    const { out, census } = run(WELCOME_BACK(), [MOVS91], LAYOUTS);
    assert.match(out, /packet = \*pBytes;\n\s*NPCMENU_MarkNpcSpeechesUpdated\(&packet\);/);
    assert.doesNotMatch(out, /for \(|pDst = &packet|cAct = /);
    assert.deepStrictEqual(census, { fills: 0, copies: 1, untied: 0 });
  });

  it('Unreferenced_00402c30: 0x8a dwords of a 0x228-byte entry are `*pDVar2 = *pSrcEntry`', () => {
    const code = `bool __fastcall f(D2FogDebugModuleEntryStrc *pSrcEntry, D2FogDebugModuleTableStrc *pTable) {
  int iVar1;
  D2FogDebugModuleEntryStrc *pDVar2;
  pDVar2 = pTable->aEntries + pTable->nCount;
  for (iVar1 = 0x8a; iVar1 != 0; iVar1 = iVar1 + -1) {
    pDVar2->pImageBase = pSrcEntry->pImageBase;
    pSrcEntry = (D2FogDebugModuleEntryStrc *)&pSrcEntry->nImageSize;
    pDVar2 = (D2FogDebugModuleEntryStrc *)&pDVar2->nImageSize;
  }
  pTable->nCount = pTable->nCount + 1;
  return pTable->nCount < 0x100;
}`;
    const op: RepStringOp = { op: 'movs', unit: 4, count: 0x8a, names: ['iVar1', 'pDVar2', 'pSrcEntry'] };
    const { out, census } = run(code, [op], LAYOUTS);
    assert.match(out, /pDVar2 = pTable->aEntries \+ pTable->nCount;\n\s*\*pDVar2 = \*pSrcEntry;\n\s*pTable->nCount = pTable->nCount \+ 1;/);
    assert.deepStrictEqual(census, { fills: 0, copies: 1, untied: 0 });
  });

  it('fewer bytes than the struct holds are memcpy, into a frame object nothing named before', () => {
    const { out } = run(WELCOME_BACK().replace(/  cAct = pBytes->nAct;\n  pDst->nPacketId = pBytes->nPacketId;\n  pDst->nAct = cAct;\n/, ''), [MOVS91], LAYOUTS);
    assert.match(out, /pDst = &packet;\n\s*memcpy\(pDst, pBytes, 24\);/);
  });

  it('NET_D2GS_CLIENT_Incoming0x5A 0045e070: a byte source into a struct pointer stepped through (int)&p->f + 1', () => {
    const code = `void f(char *pBytes) {
  int nWords;
  D2GSPacketSrv0x91 *pDst;
  D2GSPacketSrv0x91 packet;
  pDst = &packet;
  for (nWords = 10; nWords != 0; nWords = nWords + -1) {
    *(undefined4 *)pDst = *(undefined4 *)pBytes;
    pBytes = pBytes + 4;
    pDst = (D2GSPacketSrv0x91 *)((int)&pDst->nAct + 3);
  }
  g(&packet);
  return;
}`;
    const op: RepStringOp = { op: 'movs', unit: 4, count: 10, names: ['nWords', 'pDst', 'pBytes'] };
    const { out, census } = run(code, [op], LAYOUTS);
    assert.match(out, /memcpy\(pDst, pBytes, 40\);\n\s*g\(&packet\);/);
    assert.deepStrictEqual(census, { fills: 0, copies: 1, untied: 0 });
  });

  it('leaves the copy when a pointer is read after it', () => {
    const { out } = run(WELCOME_BACK('  g(pBytes);\n  NPCMENU_MarkNpcSpeechesUpdated(&packet);'), [MOVS91], LAYOUTS);
    assert.match(out, /for \(nCount = 6/);
  });

  it('leaves the copy without the instruction fact', () => {
    const { out, census } = run(WELCOME_BACK(), [], LAYOUTS);
    assert.match(out, /for \(nCount = 6/);
    assert.deepStrictEqual(census, undefined);
  });

  it('keeps the pointer when the object escaped before the copy', () => {
    const { out } = run(WELCOME_BACK().replace('  pDst = &packet;', '  h(&packet);\n  pDst = &packet;'), [MOVS91], LAYOUTS);
    assert.match(out, /pDst = &packet;\n\s*\*pDst = \*pBytes;/);
  });
});

// SaveQuests 00569320 (`mov ecx, 0x4a; rep movsd; movsw`): the frame record copied out to the
// save buffer, whose pointer was read from the caller before anything named the record.
const QUESTS = [
  { name: 'nMagic', offset: 0, size: 4, type: 'uint32_t' },
  { name: 'nVersion', offset: 4, size: 4, type: 'uint32_t' },
  { name: 'nSize', offset: 8, size: 2, type: 'uint16_t' },
  { name: 'pActQuests', offset: 10, size: 288, type: 'char[288]' },
];
const SAVE_QUESTS = (head = '  pDst = *pStartAddress;') => `int32_t f(uint8_t **pStartAddress, D2BitBufferStrc **ppQuestBuf) {
  uint8_t *pDst;
  uint8_t *pEnd;
  int i;
  D2SaveFileQuestsStrc *pSrc;
  D2SaveFileQuestsStrc pSaveQuests;
${head}
  pEnd = pDst + 0x12a;
  memset(&pSaveQuests,0,0x12a);
  pSaveQuests.nMagic = 0x216f6f57;
  CopyQuestBitBuffer(*ppQuestBuf,pSaveQuests.pActQuests,0x60,1);
  pSrc = &pSaveQuests;
  for (i = 0x4a; i != 0; i = i + -1) {
    *(int *)pDst = pSrc->nMagic;
    pSrc = (D2SaveFileQuestsStrc *)&pSrc->nVersion;
    pDst = pDst + 4;
  }
  *(short *)pDst = (short)pSrc->nMagic;
  *pStartAddress = pEnd;
  return 0;
}`;
const MOVS_QUESTS: RepStringOp = { op: 'movs', unit: 4, count: 0x4a, names: ['i', 'pDst', 'pSrc'] };
const QUEST_LAYOUTS = { structLayouts: { D2SaveFileQuestsStrc: QUESTS }, aggregateSizes: { D2SaveFileQuestsStrc: 0x12a } };

describe('rep-string-form: a copy out of a frame record', () => {
  it('SaveQuests 00569320: a pointer set before the record was named, with a narrowed movsw tail', () => {
    const { out, census } = run(SAVE_QUESTS(), [MOVS_QUESTS], QUEST_LAYOUTS);
    assert.match(out, /pSrc = &pSaveQuests;\n\s*memcpy\(pDst, pSrc, 0x12a\);\n\s*\*pStartAddress = pEnd;/);
    assert.deepStrictEqual(census, { fills: 0, copies: 1, untied: 0 });
  });

  it('leaves it when the pointer is set after the record was named', () => {
    const code = SAVE_QUESTS('').replace('  pSrc = &pSaveQuests;', '  pDst = *pStartAddress;\n  pSrc = &pSaveQuests;');
    assert.match(run(code.replace('  pEnd = pDst + 0x12a;\n', ''), [MOVS_QUESTS], QUEST_LAYOUTS).out, /for \(i = 0x4a/);
    assert.match(run(SAVE_QUESTS('  pDst = *pStartAddress;\n  pDst = g(pDst);'), [MOVS_QUESTS], QUEST_LAYOUTS).out, /for \(i = 0x4a/);
  });
});
