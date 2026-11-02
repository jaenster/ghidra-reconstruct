/**
 * string-intrinsics: MSVC's inline strcpy, the two-cursor loop and the one-cursor loop that
 * stores through a fixed offset, folded to strcpy() where the cursors and the byte are dead
 * after it. Each shape is compiled as printed and as folded and run over strings of length
 * 0..9; the destination buffer is compared byte for byte.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { pseudoOpLowerPlugin } from '../builtins/pseudo-op-lower.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const native = { skip: !hasNativeGpp() };

function lower(code: string, stackSlots?: { name: string; offset: number; size: number }[]): string {
  const types = { structFieldOffsets: { Ini: { n: 0, szIp: 4 } }, structFields: { Ini: { n: 'int', szIp: 'char[32]' } } };
  return emit(pseudoOpLowerPlugin.createTransformer({ stackSlots, ...types } as never)(parse(code)) as AnyNode).trim();
}

/** UIMENU_ConnectToServerCallback 00434790: the frame buffer copied into a struct field. */
const TWO_CURSORS = `struct Ini { int n; char szIp[32]; };
void f(Ini *pIni, char *pszSrc) {
  char acBuf[64];
  char *pszCur;
  char *pszDst;
  char chCopy;
  acBuf[0] = 'x';
  pszCur = acBuf;
  pszDst = pIni->szIp;
  do {
    chCopy = *pszCur;
    *pszDst = chCopy;
    pszCur++;
    pszDst++;
  } while (chCopy != '\\0');
  acBuf[1] = pszSrc[0];
}`;

/** The same function: a returned string copied into the frame buffer through a fixed offset. */
const ONE_CURSOR = `void f(char *pszResolved, char *pOut) {
  char acBuf[64];
  int nDelta;
  char chCopy;
  nDelta = -(int)pszResolved;
  do {
    chCopy = *pszResolved;
    pszResolved[(int)(acBuf + nDelta)] = chCopy;
    pszResolved++;
  } while (chCopy != '\\0');
  for (int k = 0; k < 64; k++) pOut[k] = acBuf[k];
}`;

const SLOTS = [{ name: 'acBuf', offset: -0x44, size: 64 }];

describe('string-intrinsics: inline strcpy', () => {
  it('folds the two-cursor loop and its setup', () => {
    const out = lower(TWO_CURSORS, SLOTS);
    assert.doesNotMatch(out, /do \{/);
    assert.match(out, /strcpy\(pIni->szIp, acBuf\);/);
    assert.doesNotMatch(out, /pszCur =|pszDst =/);
  });

  it('folds the fixed-offset loop', () => {
    const out = lower(ONE_CURSOR, SLOTS);
    assert.doesNotMatch(out, /do \{/);
    assert.match(out, /strcpy\(acBuf, pszResolved\);/);
    assert.doesNotMatch(out, /nDelta =/);
  });

  it('leaves the loop when a cursor is read after it', () => {
    const out = lower(ONE_CURSOR.replace('for (int k', 'pOut[0] = *pszResolved;\n  for (int k'), SLOTS);
    assert.match(out, /do \{/);
  });

  it('leaves the loop when the two sides may overlap', () => {
    const src = `void f(char *a, char *b) {
  char c;
  do { c = *a; *b = c; a++; b++; } while (c != '\\0');
}`;
    assert.match(lower(src), /do \{/);
  });

  it('leaves a two-byte copy', () => {
    const out = lower(TWO_CURSORS.replace('char *pszCur;', 'unsigned short *pszCur;').replace('pszCur = acBuf;', 'pszCur = (unsigned short *)acBuf;'), SLOTS);
    assert.match(out, /do \{/);
  });

  it('runs the same as the loop', native, () => {
    const src = ONE_CURSOR;
    const prelude = [`namespace ref { ${src} }`, `namespace low { ${lower(src, SLOTS)} }`].join('\n');
    const body = [
      'int bad = 0;',
      'for (int a = 0; a < 10; a++) {',
      '  char s[16]; for (int k = 0; k < a; k++) s[k] = (char)(0x41 + k); s[a] = 0;',
      '  char o1[64], o2[64]; memset(o1, 0, 64); memset(o2, 0, 64);',
      '  ref::f(s, o1); low::f(s, o2);',
      '  if (memcmp(o1, o2, a + 1)) bad++;',
      '}',
      'printf("%d\\n", bad);',
    ].join('\n');
    assert.strictEqual(compileAndRun(prelude, body).trim(), '0', lower(src, SLOTS));
  });
});

/** BuildSymbolSearchPath 0040c290: the length read twice as a pointer difference. */
const LENGTH = `int f(char *szPath) {
  char *pszEnd;
  char cCur;
  pszEnd = szPath;
  do {
    cCur = *pszEnd;
    pszEnd = pszEnd + 1;
  } while (cCur != '\\0');
  if ((int)pszEnd - (int)(szPath + 1)) {
    szPath[(int)pszEnd - (int)(szPath + 1) - 1] = '\\0';
    return 1;
  }
  return 0;
}`;

describe('string-intrinsics: a scan kept as a length', () => {
  it('reads the length from one strlen', () => {
    const out = lower(LENGTH);
    assert.match(out, /int nLen;\s*nLen = \(int\)strlen\(szPath\);\s*if \(nLen\) \{\s*szPath\[nLen - 1\] = '\\0';/);
    assert.doesNotMatch(out, /pszEnd/);
  });

  it('stores the length straight into the one local that reads it', () => {
    const src = LENGTH.replace("if ((int)pszEnd - (int)(szPath + 1)) {", "int nDigits;\n  nDigits = (int)pszEnd - (int)(szPath + 1);\n  if (nDigits) {")
      .replace("szPath[(int)pszEnd - (int)(szPath + 1) - 1]", "szPath[nDigits - 1]");
    const out = lower(src);
    assert.match(out, /nDigits = \(int\)strlen\(szPath\);/);
    assert.doesNotMatch(out, /nLen|pszEnd/);
  });

  it('leaves it when the cursor is read otherwise', () => {
    const out = lower(LENGTH.replace('return 1;', 'return *pszEnd;'));
    assert.match(out, /pszEnd/);
  });

  it('leaves it when the string pointer changes before a read', () => {
    const out = lower(LENGTH.replace('if ((int)pszEnd', 'szPath++;\n  if ((int)pszEnd'));
    assert.match(out, /pszEnd/);
  });

  it('runs the same as the scan', native, () => {
    const prelude = [`namespace ref { ${LENGTH} }`, `namespace low { ${lower(LENGTH)} }`].join('\n');
    const body = [
      'int bad = 0;',
      'for (int a = 0; a < 10; a++) {',
      '  char s1[16], s2[16]; memset(s1, 7, 16); memset(s2, 7, 16); for (int k = 0; k < a; k++) s1[k] = s2[k] = (char)(0x41 + k); s1[a] = s2[a] = 0;',
      '  if (ref::f(s1) != low::f(s2) || memcmp(s1, s2, 16)) bad++;',
      '}',
      'printf("%d\\n", bad);',
    ].join('\n');
    assert.strictEqual(compileAndRun(prelude, body).trim(), '0', lower(LENGTH));
  });
});
