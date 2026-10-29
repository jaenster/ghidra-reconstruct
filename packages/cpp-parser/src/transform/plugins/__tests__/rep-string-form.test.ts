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

  it('leaves a fill larger than the array, and one without `p = a;` right before', () => {
    const small = FILL().replace('wszText [100]', 'wszText [50]');
    assert.match(run(small, [STOS]).out, /pSourceStr\[1\]/);
    const noInit = FILL().replace('  pSourceStr = wszText;\n', '  pSourceStr = wszText;\n  h();\n');
    assert.match(run(noInit, [STOS]).out, /pSourceStr\[1\]/);
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
    const viaPointer = '  pSrc = pAny;\n  pDst = aTable;';
    const code = COPY(viaPointer).replace('void f() {', 'void f(uint *pAny) {');
    assert.match(run(code, [MOVS], globals).out, /\*pDst = \*pSrc/);
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
    assert.match(run(code('  pBytes++;\n'), ops).out, /\*pDst = \*pBytes/);
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

  it('leaves a copy whose pointers continue after it (a movsw tail), or without the fact', () => {
    assert.match(run(COPY(SEPARATE, '  *(ushort *)pDst = *(ushort *)pSrc;'), [MOVS], globals).out, /\*pDst = \*pSrc/);
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
