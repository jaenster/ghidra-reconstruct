/**
 * string-intrinsics: a lone MSVC strlen scan whose cursor is kept, folded to strlen()
 * with every local left as the loop leaves it. Each shape is compiled as the decompiler
 * printed it and as folded, run over strings of length 0..9 and over buffers holding two
 * strings back to back, and every local compared.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { pseudoOpLowerPlugin } from '../builtins/pseudo-op-lower.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const native = { skip: !hasNativeGpp() };

function lower(code: string): string {
  return emit(pseudoOpLowerPlugin.createTransformer({})(parse(code)) as AnyNode).trim();
}

/** BnSend 0x12 (SID_LOCALEINFO): three GetLocaleInfoA strings appended by cursor. */
const CURSOR_CHAIN = `uintptr_t f(char *szLocaleInfo, char *pOut) {
  char *pszLocaleCursor;
  char cCur;
  pszLocaleCursor = szLocaleInfo;
  do {
    cCur = *pszLocaleCursor;
    pszLocaleCursor = pszLocaleCursor + 1;
  } while (cCur != '\\0');
  *pOut = cCur;
  do {
    cCur = *pszLocaleCursor;
    pszLocaleCursor = pszLocaleCursor + 1;
  } while (cCur != '\\0');
  return (uintptr_t)(pszLocaleCursor - szLocaleInfo);
}`;

/** BnSend 0x0a: the address form, both pointers used after the loop. */
const ADDRESS_FORM = `uintptr_t f(char *szPacketBuf, char *pOut) {
  char *pszCursor;
  char *pszText2End;
  pszCursor = szPacketBuf;
  do {
    pszText2End = pszCursor;
    pszCursor = pszText2End + 1;
  } while (*pszText2End != '\\0');
  *pOut = *pszText2End;
  return (uintptr_t)(pszCursor - szPacketBuf) * 0x10000 + (uintptr_t)(pszText2End - szPacketBuf);
}`;

/** A byte cursor typed `byte *`, the loop byte read once more after the loop. */
const BYTE_CURSOR = `uintptr_t f(byte *pbParam, char *pOut) {
  byte *pbScan;
  byte byCurChar;
  pbScan = pbParam;
  do {
    byCurChar = *pbScan;
    pbScan++;
  } while (byCurChar);
  *pOut = (char)byCurChar;
  return (uintptr_t)(pbScan - pbParam);
}`;

describe('string-intrinsics: strlen scan with the cursor kept', () => {
  it('folds the cursor chain; the byte temporary is read after the first loop', () => {
    const out = lower(CURSOR_CHAIN);
    assert.doesNotMatch(out, /do \{/);
    assert.match(out, /pszLocaleCursor = pszLocaleCursor \+ strlen\(pszLocaleCursor\) \+ 1;\s*cCur = 0;\s*\*pOut = cCur;/);
    // The second scan's byte is dead, so no store of it.
    assert.match(out, /pszLocaleCursor = pszLocaleCursor \+ strlen\(pszLocaleCursor\) \+ 1;\s*return/);
  });

  it('folds the address form into the NUL pointer and the cursor past it', () => {
    const out = lower(ADDRESS_FORM);
    assert.match(out, /pszText2End = pszCursor \+ strlen\(pszCursor\);\s*pszCursor = pszText2End \+ 1;/);
  });

  it('casts a byte cursor for strlen', () => {
    const out = lower(BYTE_CURSOR);
    assert.match(out, /pbScan = pbScan \+ strlen\(\(char\*\)pbScan\) \+ 1;\s*byCurChar = 0;/);
  });

  it('runs the same as the loops', native, () => {
    const prelude = (src: string) => [
      'typedef unsigned char byte;',
      `namespace ref { ${src} }`,
      `namespace low { ${lower(src)} }`,
    ].join('\n');
    for (const [src, arg] of [[CURSOR_CHAIN, 'buf'], [ADDRESS_FORM, 'buf'], [BYTE_CURSOR, '(byte*)buf']] as const) {
      const body = [
        'int bad = 0;',
        'for (int a = 0; a < 10; a++) for (int b = 0; b < 10; b++) {',
        '  char buf[64]; memset(buf, 0x5a, sizeof buf);',
        '  for (int k = 0; k < a; k++) buf[k] = (char)(0x41 + k); buf[a] = 0;',
        '  for (int k = 0; k < b; k++) buf[a + 1 + k] = (char)(0x61 + k); buf[a + 1 + b] = 0;',
        '  char o1 = 7, o2 = 7;',
        `  uintptr_t r1 = ref::f(${arg}, &o1), r2 = low::f(${arg}, &o2);`,
        '  if (r1 != r2 || o1 != o2) bad++;',
        '}',
        'printf("%d\\n", bad);',
      ].join('\n');
      assert.strictEqual(compileAndRun(prelude(src), body).trim(), '0', lower(src));
    }
  });
});

describe('string-intrinsics: strlen scans left alone', () => {
  it('a two-byte cursor', () => {
    const out = lower(CURSOR_CHAIN.replace(/char \*pszLocaleCursor;/, 'ushort *pszLocaleCursor;'));
    assert.match(out, /do \{/);
  });

  it('a four-byte read', () => {
    const out = lower(BYTE_CURSOR.replace('byCurChar = *pbScan;', 'byCurChar = *(uint *)pbScan;'));
    assert.match(out, /do \{/);
  });

  it('an escaped cursor', () => {
    const out = lower(BYTE_CURSOR.replace('*pOut = (char)byCurChar;', '*pOut = (char)byCurChar;\n  g(&pbScan);'));
    assert.match(out, /do \{/);
  });

  it('a byte temporary read after the loop that is not the tested byte', () => {
    const src = `uintptr_t f(char *s, char *pOut) {
  char *p; char c; char d;
  p = s;
  do {
    c = *p;
    p = p + 1;
  } while (d != '\\0');
  *pOut = c;
  return (uintptr_t)(p - s);
}`;
    assert.match(lower(src), /do \{/);
  });
});
