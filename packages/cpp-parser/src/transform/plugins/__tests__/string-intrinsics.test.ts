/**
 * string-intrinsics: MSVC's inline strcat put back as the call. The loop form is compiled
 * as the decompiler printed it and the lowered form beside it, and both run over source
 * strings of length 0..9 (every dword/byte remainder of the rep movsd / rep movsb copy);
 * the buffers must come out identical.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { pseudoOpLowerPlugin } from '../builtins/pseudo-op-lower.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const native = { skip: !hasNativeGpp() };

/** GetItemName's frame: wszAffixWork (198 bytes) immediately before szUtf8Buf. */
const OPTIONS = {
  stackSlots: [
    { name: 'wszAffixWork', offset: -786, size: 198 },
    { name: 'szUtf8Buf', offset: -588, size: 512 },
  ],
  structFields: { D2MagicAffixTxt: { name: 'char[32]', wNameStr: 'ushort' } },
  structFieldOffsets: { D2MagicAffixTxt: { name: 0, wNameStr: 32 } },
  aggregateSizes: { D2MagicAffixTxt: 36 },
};

function lower(code: string, options: Record<string, unknown> = OPTIONS): string {
  return emit(pseudoOpLowerPlugin.createTransformer(options)(parse(code)) as AnyNode).trim();
}

/** GetItemName 0048c627-0048c687, trimmed: "(" + affix name + ")". */
const GET_ITEM_NAME = `void f(D2MagicAffixTxt *pPrefixAffix, char *pOut) {
  WCHAR wszAffixWork [99];
  byte szUtf8Buf [512];
  D2MagicAffixTxt *pAffixNameTail; char *pwSuffixLocale; char *pcNameSrc; D2MagicAffixTxt *pAffixCopyPtr;
  uint nCopyLen; ushort *pwCloseParenPtr; int i;
  szUtf8Buf[0] = 0x28;
  szUtf8Buf[1] = 0;
  pAffixNameTail = pPrefixAffix;
  do {
    pwSuffixLocale = pAffixNameTail->name;
    pAffixNameTail = (D2MagicAffixTxt *)(pAffixNameTail->name + 1);
  } while (*pwSuffixLocale != '\\0');
  pwSuffixLocale = (char *)((int)wszAffixWork + 0xc5);
  do {
    pcNameSrc = pwSuffixLocale + 1;
    pwSuffixLocale = pwSuffixLocale + 1;
  } while (*pcNameSrc != '\\0');
  pAffixCopyPtr = pPrefixAffix;
  for (nCopyLen = (uint)((int)pAffixNameTail - (int)pPrefixAffix) >> 2; nCopyLen != 0; nCopyLen = nCopyLen - 1) {
    *(undefined4 *)pwSuffixLocale = *(undefined4 *)pAffixCopyPtr->name;
    pAffixCopyPtr = (D2MagicAffixTxt *)(pAffixCopyPtr->name + 4);
    pwSuffixLocale = pwSuffixLocale + 4;
  }
  for (nCopyLen = (int)pAffixNameTail - (int)pPrefixAffix & 3; nCopyLen != 0; nCopyLen = nCopyLen - 1) {
    *pwSuffixLocale = pAffixCopyPtr->name[0];
    pAffixCopyPtr = (D2MagicAffixTxt *)(pAffixCopyPtr->name + 1);
    pwSuffixLocale = pwSuffixLocale + 1;
  }
  pwCloseParenPtr = (ushort *)((int)wszAffixWork + 0xc5);
  do {
    pwSuffixLocale = (char *)((int)pwCloseParenPtr + 1);
    pwCloseParenPtr = (ushort *)((int)pwCloseParenPtr + 1);
  } while (*pwSuffixLocale != '\\0');
  *pwCloseParenPtr = 0x29;
  for (i = 0; i < 512; i = i + 1) { pOut[i] = szUtf8Buf[i]; }
  return; }`;

describe('string-intrinsics: inline strcat', () => {
  it('GetItemName: both inline strcats become calls, and the frame address names szUtf8Buf (C3-16)', () => {
    const out = lower(GET_ITEM_NAME);
    assert.match(out, /strcat\(\(char\*\)szUtf8Buf, pPrefixAffix->name\);/);
    assert.match(out, /strcat\(\(char\*\)szUtf8Buf, "\)"\);/);
    assert.doesNotMatch(out, /0xc5|pAffixNameTail|pwCloseParenPtr|nCopyLen/);
  });

  it('runs the same as the loops for names of length 0..9', native, () => {
    const lowered = lower(GET_ITEM_NAME);
    // The loop form relies on the frame layout (szUtf8Buf right after wszAffixWork); one
    // object holding both buffers makes it real. The lowered code does not depend on it.
    // Ghidra's (int)/(uint) pointer casts are 4-byte on the target; the host is 64-bit.
    const ref = GET_ITEM_NAME.replace('WCHAR wszAffixWork [99];\n  byte szUtf8Buf [512];',
      'struct { WCHAR wszAffixWork_[99]; byte szUtf8Buf_[512]; } fr;')
      .replace(/\(int\)/g, '(intptr_t)').replace(/\(uint\)/g, '(uintptr_t)');
    const prelude = [
      'typedef unsigned int uint; typedef unsigned short ushort; typedef unsigned char byte; typedef uint16_t WCHAR; typedef uint32_t undefined4;',
      'struct D2MagicAffixTxt { char name[32]; ushort wNameStr; };',
      '#define wszAffixWork fr.wszAffixWork_',
      '#define szUtf8Buf fr.szUtf8Buf_',
      `namespace ref { ${ref} }`,
      '#undef wszAffixWork',
      '#undef szUtf8Buf',
      `namespace low { ${lowered} }`,
    ].join('\n');
    const body = [
      'const char *names[] = {"", "a", "ab", "abc", "abcd", "abcde", "abcdef", "abcdefg", "abcdefgh", "abcdefghi"};',
      'int bad = 0;',
      'for (const char *n : names) {',
      '  D2MagicAffixTxt t; memset(&t, 0x5a, sizeof t); strcpy(t.name, n);',
      '  char a[512], b[512]; memset(a, 0, 512); memset(b, 0, 512);',
      '  ref::f(&t, a); low::f(&t, b);',
      '  if (strcmp(a, b) != 0) bad++;',
      '  char want[64]; snprintf(want, sizeof want, "(%s)", n); if (strcmp(b, want) != 0) bad++;',
      '}',
      'printf("%d\\n", bad);',
    ].join('\n');
    assert.strictEqual(compileAndRun(prelude, body).trim(), '0', lowered);
  });
});

describe('string-intrinsics: what is left alone', () => {
  it('a temporary read after the group (the second scan\'s pointer is used again)', () => {
    // pwSuffixLocale is last set by the ")" group's end scan, so that group may not go;
    // the first group's definitions of it are dead (the second scan redefines it).
    const out = lower(GET_ITEM_NAME.replace('  return; }', '  *pwSuffixLocale = 0;\n  return; }'));
    assert.match(out, /strcat\(\(char\*\)szUtf8Buf, pPrefixAffix->name\)/);
    assert.doesNotMatch(out, /strcat\(\(char\*\)szUtf8Buf, "\)"\)/);
  });
  it('a destination that is not a frame object (it could overlap the source)', () => {
    const out = lower(GET_ITEM_NAME, { ...OPTIONS, stackSlots: [] });
    assert.doesNotMatch(out, /strcat/);
  });
  it('a call between the scans', () => {
    const out = lower(GET_ITEM_NAME.replace('  pAffixCopyPtr = pPrefixAffix;', '  Touch(szUtf8Buf);\n  pAffixCopyPtr = pPrefixAffix;'));
    assert.doesNotMatch(out, /strcat\(\(char\*\)szUtf8Buf, pPrefixAffix->name\)/);
  });
});

/** ClientInit_CharName 0044d890 and SOUND_DetectLegacySoundDrivers: repe cmpsb against a literal. */
const CMPSB = (lit: string, n: number) => `int f(const char *pszCharName) {
  char *pszCur; int nCmpRemaining; char *pszZero; bool bIsZero;
  nCmpRemaining = ${n};
  bIsZero = true;
  pszCur = (char *)pszCharName;
  pszZero = (char *)"${lit}";
  do {
    if (nCmpRemaining == 0) break;
    nCmpRemaining = nCmpRemaining + -1;
    bIsZero = *pszCur == *pszZero;
    pszCur = pszCur + 1;
    pszZero = pszZero + 1;
  } while (bIsZero);
  return bIsZero ? 7 : 3; }`;

describe('string-intrinsics: repe cmpsb is strcmp', () => {
  it('ClientInit_CharName: the loop is strcmp(name, "0") == 0', () => {
    const out = lower(CMPSB('0', 2));
    assert.match(out, /bIsZero = strcmp\(\(?char \*\)?pszCharName, "0"\) == 0;|bIsZero = strcmp\(\(char\*\)pszCharName, "0"\) == 0;/);
    assert.doesNotMatch(out, /nCmpRemaining|pszZero|pszCur/);
  });
  it('agrees with the loop on equal, shorter, longer and different strings', native, () => {
    const cases = [['0', 2], ['YDSXG.VXD', 10], ['bas', 4]] as const;
    for (const [lit, n] of cases) {
      const src = CMPSB(lit, n);
      const lowered = lower(src);
      assert.match(lowered, /strcmp/);
      const inputs = ['', '0', '00', '0a', 'a', 'YDSXG.VXD', 'YDSXG.VX', 'YDSXG.VXDX', 'ydsxg.vxd', 'bas', 'ba', 'bass', 'b'];
      const body = [
        `const char *in[] = {${inputs.map(s => JSON.stringify(s)).join(', ')}}; int bad = 0;`,
        'for (const char *s : in) { char buf[32]; memset(buf, 0x55, sizeof buf); strcpy(buf, s); if (ref::f(buf) != low::f(buf)) bad++; }',
        'printf("%d\\n", bad);',
      ].join('\n');
      const res = compileAndRun(`typedef unsigned char byte;\nnamespace ref {\n${src}\n}\nnamespace low {\n${lowered}\n}`, body);
      assert.strictEqual(res.trim(), '0', `${lit}: ${lowered}`);
    }
  });
  it('a length that is not the literal plus its NUL is a memcmp, not this strcmp: left alone', () => {
    assert.doesNotMatch(lower(CMPSB('0', 1)), /strcmp/);
  });
  it('the cursor read after the loop keeps the loop', () => {
    assert.doesNotMatch(lower(CMPSB('0', 2).replace('return bIsZero ? 7 : 3;', 'return *pszCur;')), /strcmp/);
  });
});

// ============================================
// The inline strcmp loop (two bytes per iteration, -1/0/1)
// ============================================

/** CHATDLG_HandleChatListClick 004403f0: the do-while with a break and an exit label. */
const F1 = (use: string) => `int f(byte *pA, byte *pB) {
  byte *pbName; byte *pbScan; byte byCur; bool bCmpLess; int nCmp; int nOut;
  pbScan = pB;
  pbName = pA;
  do {
    byCur = *pbName;
    bCmpLess = byCur < (byte)*pbScan;
    if (byCur != *pbScan) {
LAB_00440551:
      nCmp = (1 - (uint)bCmpLess) - (uint)(bCmpLess != 0);
      goto LAB_00440556;
    }
    if (byCur == 0) break;
    byCur = pbName[1];
    bCmpLess = byCur < (byte)pbScan[1];
    if (byCur != pbScan[1]) goto LAB_00440551;
    pbName = pbName + 2;
    pbScan = pbScan + 2;
  } while (byCur != 0);
  nCmp = 0;
LAB_00440556:
  ${use}
}`;
const SIGN_USE = 'if (nCmp < 0) { nOut = 1; } else if (nCmp == 0) { nOut = 2; } else { nOut = 3; }\n  return nOut;';

/** INI_FindConfigValueIndex 00405570: the head label on the enclosing do-while. */
const F2 = `int f(byte *pA, byte *pB) {
  byte *pbEntry; byte *pbArgCursor; byte byEntryChar; bool bLess; int nCmp; int nIndex;
  nIndex = 0;
  pbEntry = pA;
  pbArgCursor = pB;
LAB_00405585:
  do {
    byEntryChar = *pbEntry;
    bLess = byEntryChar < *pbArgCursor;
    if (byEntryChar == *pbArgCursor) {
      if (byEntryChar != 0) {
        byEntryChar = pbEntry[1];
        bLess = byEntryChar < pbArgCursor[1];
        if (byEntryChar != pbArgCursor[1]) goto LAB_004055a5;
        pbEntry = pbEntry + 2;
        pbArgCursor = pbArgCursor + 2;
        if (byEntryChar != 0) goto LAB_00405585;
      }
      nCmp = 0;
    }
    else {
LAB_004055a5:
      nCmp = (1 - (uint)bLess) - (uint)(bLess != 0);
    }
    if (nCmp < 0) return nIndex + 1;
    if (nCmp == 0) return nIndex;
    nIndex = nIndex + 10;
    pbEntry = pB;
    pbArgCursor = pA;
  } while (nIndex < 20);
  return -1;
}`;

/** SOUND_PlaySoundEffect 00514ec0: the head label on the region's first statement. */
const F2_HEAD = F2.replace('LAB_00405585:\n  do {\n    byEntryChar = *pbEntry;', '  do {\nLAB_00405585:\n    byEntryChar = *pbEntry;');

/** Every pair of strings up to length 4 over {1, 2, 0x80, 0xff}: ref::f and low::f agree. */
function strcmpAgrees(ref: string, low: string): string {
  const prelude = `typedef unsigned char byte; typedef unsigned int uint;\nnamespace ref {\n${ref}\n}\nnamespace low {\n${low}\n}`;
  const body = [
    'static const byte al[] = {1, 2, 0x80, 0xff};',
    'static byte s[400][8]; int ns = 0;',
    'for (int len = 0; len <= 4; len++) {',
    '  int total = 1; for (int k = 0; k < len; k++) total *= 4;',
    '  for (int m = 0; m < total; m++) { int x = m; memset(s[ns], 0, 8); for (int k = 0; k < len; k++) { s[ns][k] = al[x % 4]; x /= 4; } ns++; }',
    '}',
    'long bad = 0;',
    'for (int i = 0; i < ns; i++) for (int j = 0; j < ns; j++) {',
    '  byte a[8], b[8]; memcpy(a, s[i], 8); memcpy(b, s[j], 8);',
    '  if (ref::f(a, b) != low::f(a, b)) bad++;',
    '}',
    'printf("%ld\\n", bad);',
  ].join('\n');
  return compileAndRun(prelude, body).trim();
}

describe('string-intrinsics: the inline strcmp loop is strcmp', () => {
  it('F1 (do-while, break, exit label): R = strcmp(A, B), the cursors and the labels gone', () => {
    const out = lower(F1(SIGN_USE), {});
    assert.match(out, /nCmp = strcmp\(\(char\*\)pA, \(char\*\)pB\);/, out);
    assert.doesNotMatch(out, /goto|LAB_|pbName|pbScan|bCmpLess|byCur/, out);
  });
  it('F1: compiled, agrees with the loop on every pair of strings', native, () => {
    assert.strictEqual(strcmpAgrees(F1(SIGN_USE), lower(F1(SIGN_USE), {})), '0');
  });
  it('F2 (head label on the enclosing do): the back edge goes with the loop', () => {
    const out = lower(F2, {});
    assert.match(out, /do \{\s*nCmp = strcmp\(\(char\*\)pbEntry, \(char\*\)pbArgCursor\);/, out);
    assert.doesNotMatch(out, /goto|LAB_|bLess|byEntryChar/, out);
  });
  it('F2: compiled, agrees with the loop on every pair of strings', native, () => {
    assert.strictEqual(strcmpAgrees(F2, lower(F2, {})), '0');
  });
  it('F2 (head label on the first statement): compiled, agrees', native, () => {
    const out = lower(F2_HEAD, {});
    assert.match(out, /strcmp/, out);
    assert.doesNotMatch(out, /goto/, out);
    assert.strictEqual(strcmpAgrees(F2_HEAD, out), '0');
  });
  it('ROSTER_SortByName 004795f0: a cursor stored and re-read inside one later test is dead', native, () => {
    const src = F2.replace('    pbEntry = pB;\n    pbArgCursor = pA;', '    if (nIndex > 30 || (pbArgCursor = pA, pbEntry = pbArgCursor, nIndex > 25)) return -2;\n    pbEntry = pB;');
    assert.notStrictEqual(src, F2);
    const out = lower(src, {});
    assert.match(out, /strcmp/, out);
    assert.strictEqual(strcmpAgrees(src, out), '0');
  });
  it('the check catches a strcmp with its arguments swapped', native, () => {
    const out = lower(F1(SIGN_USE), {}).replace('strcmp((char*)pA, (char*)pB)', 'strcmp((char*)pB, (char*)pA)');
    assert.notStrictEqual(strcmpAgrees(F1(SIGN_USE), out), '0');
  });
  it('GetRosterByGuidOrName 00479360: the second byte in its own variable: compiled, agrees', native, () => {
    const src = F1(SIGN_USE).replace('bool bCmpLess;', 'bool bCmpLess; byte byCur2;')
      .replace('byCur = pbName[1];', 'byCur2 = pbName[1];')
      .replace('bCmpLess = byCur < (byte)pbScan[1];', 'bCmpLess = byCur2 < (byte)pbScan[1];')
      .replace('if (byCur != pbScan[1])', 'if (byCur2 != pbScan[1])')
      .replace('} while (byCur != 0);', '} while (byCur2 != 0);');
    const out = lower(src, {});
    assert.match(out, /strcmp/, out);
    assert.doesNotMatch(out, /byCur2/, out);
    assert.strictEqual(strcmpAgrees(src, out), '0');
  });
  it('`R < 1` and `R > -1` are sign tests too: compiled, agrees', native, () => {
    const use = 'if (nCmp < 1) { nOut = nCmp > -1 ? 2 : 1; } else { nOut = 3; }\n  return nOut;';
    const out = lower(F1(use), {});
    assert.match(out, /strcmp/, out);
    assert.strictEqual(strcmpAgrees(F1(use), out), '0');
  });
  it('ROSTER_SortByName 004795f0: a struct cursor reads its char array field', () => {
    const src = `struct D2RosterStrc { char szRosterName[16]; int nRosterGUID; };
int f(D2RosterStrc *pA, byte *pB) {
  D2RosterStrc *pNameCursor; byte *pInputCursor; char cNameChar; bool bLess; int nCmp;
  pNameCursor = pA;
  pInputCursor = pB;
  do {
    cNameChar = pNameCursor->szRosterName[0];
    bLess = (byte)cNameChar < *pInputCursor;
    if (cNameChar != *pInputCursor) {
LAB_004793a0:
      nCmp = (1 - (uint)bLess) - (uint)(bLess != 0);
      goto LAB_004793a5;
    }
    if (cNameChar == '\\0') break;
    cNameChar = pNameCursor->szRosterName[1];
    bLess = (byte)cNameChar < pInputCursor[1];
    if (cNameChar != pInputCursor[1]) goto LAB_004793a0;
    pNameCursor = (D2RosterStrc *)(pNameCursor->szRosterName + 2);
    pInputCursor = pInputCursor + 2;
  } while (cNameChar != '\\0');
  nCmp = 0;
LAB_004793a5:
  if (nCmp == 0) return 1;
  return 0;
}`;
    const out = lower(src, {
      structFields: { D2RosterStrc: { szRosterName: 'char[16]', nRosterGUID: 'int' } },
      structFieldOffsets: { D2RosterStrc: { szRosterName: 0, nRosterGUID: 16 } },
      aggregateSizes: { D2RosterStrc: 20 },
    });
    assert.match(out, /nCmp = strcmp\(pA->szRosterName, \(char\*\)pB\);/, out);
    assert.doesNotMatch(out, /goto/, out);
  });
  it('declines a use of the value itself (a library strcmp has only its sign)', () => {
    assert.doesNotMatch(lower(F1('return nCmp;'), {}), /strcmp/);
  });
  it('declines when a cursor is read after the loop', () => {
    assert.doesNotMatch(lower(F1('return nCmp == 0 ? *pbName : 0;'), {}), /strcmp/);
  });
  it('declines a result narrower than 32 bits (-1 and -256 differ as a char)', () => {
    assert.doesNotMatch(lower(F1(SIGN_USE).replace('int nCmp;', 'char nCmp;'), {}), /strcmp/);
  });
});
