/**
 * Golden tests from D2Lang: 1.14d Ghidra output in, the shape of the original
 * source out. Reference: seperaGG/d2hausos (1.00 source, byte-identical build),
 * whose functions D2Lang barely changed by 1.14d.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { transformGhidraCode } from '../ghidra.js';

const run = (input: string) =>
  transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false }).code;

describe('Golden D2Lang: loop-carried load hoist', () => {
  // 1.14d 005264f0. Original: while (p1->wUnit && p2->wUnit && p1->wUnit == p2->wUnit) { p1++; p2++; }
  const input = `int32_t __fastcall STRING_CompareWideStrings(WCHAR *wszText1,WCHAR *wszText2)
{
  WCHAR *pWNext;
  WCHAR wCurChar;

  wCurChar = *wszText1;
  while (((wCurChar != L'\\0' && (*wszText2 != L'\\0')) && (wCurChar == *wszText2))) {
    pWNext = wszText1 + 1;
    wszText1 = wszText1 + 1;
    wszText2 = wszText2 + 1;
    wCurChar = *pWNext;
  }
  if ((ushort)*wszText1 < (ushort)*wszText2) {
    return -1;
  }
  return (uint)((ushort)*wszText2 < (ushort)*wszText1);
}`;

  it('reads through the pointer in the loop condition', { todo: 'pipeline fix pending' }, () => {
    const out = run(input);
    assert.ok(!/pWNext/.test(out), `hoisted next-pointer survived:\n${out}`);
    assert.ok(!/wCurChar\s*=\s*\*/.test(out), `loop-carried load survived:\n${out}`);
    assert.match(out, /while\s*\(\s*\*wszText1/, `condition should read *wszText1:\n${out}`);
  });
});

describe('Golden D2Lang: keep a combined loop condition', () => {
  // 1.14d 00526540. Ghidra already gives one while with a combined condition;
  // the pipeline must not split it into while(true) + breaks.
  const input = `int32_t __fastcall UNICODE_CompareWideStringsN(ushort *wszFirst,ushort *wszSecond,int32_t nMaxChars)
{
  ushort wChar1;
  ushort wChar2;

  wChar1 = *wszFirst;
  while (((wChar1 != 0 && (wChar2 = *wszSecond, wChar2 != 0)) && (nMaxChars != 0))) {
    wszFirst = wszFirst + 1;
    wszSecond = wszSecond + 1;
    if (wChar1 != wChar2) {
      return (-(uint)(wChar1 < wChar2) & 0xfffffffe) + 1;
    }
    wChar1 = *wszFirst;
    nMaxChars = nMaxChars + -1;
  }
  return 0;
}`;

  it('does not turn the loop into while(true) with breaks', () => {
    const out = run(input);
    assert.ok(!/while\s*\(\s*(true|1)\s*\)/.test(out), `loop condition was split:\n${out}`);
    assert.ok(!/\bbreak\s*;/.test(out), `breaks introduced:\n${out}`);
  });
});

describe('Golden D2Lang: loop exit to a shared tail, not a copied return', () => {
  // 1.14d 00526590. Original (d2hausos stricmp):
  //   while (p1->wUnit && p2->wUnit) { ...; if (u1 != u2) return u1 < u2 ? -1 : 1; p1++; p2++; }
  //   if (p1->wUnit) return 1;
  //   return p2->wUnit ? -1 : 0;
  // The goto is VC's merged tail; the source had one loop condition and one tail.
  const input = `int32_t __fastcall UNICODE_CompareWideStringsNoCase(ushort *pwszText1,ushort *pwszText2)
{
  WCHAR wChar2;
  WCHAR wChar1;

  wChar1 = *pwszText1;
  do {
    if (wChar1 == L'\\0') {
LAB_005265e4:
      return -(uint)(*pwszText2 != L'\\0');
    }
    wChar2 = *pwszText2;
    if (wChar2 == L'\\0') {
      if (*pwszText1 != 0) {
        return 1;
      }
      goto LAB_005265e4;
    }
    if ((ushort)wChar1 < 0x100) {
      wChar1 = CharacterLookupTable[(ushort)wChar1];
    }
    if ((ushort)wChar2 < 0x100) {
      wChar2 = CharacterLookupTable[(ushort)wChar2];
    }
    if (wChar1 != wChar2) {
      return (-(uint)((ushort)wChar1 < (ushort)wChar2) & 0xfffffffe) + 1;
    }
    wChar1 = pwszText1[1];
    pwszText1 = pwszText1 + 1;
    pwszText2 = pwszText2 + 1;
  } while( true );
}`;

  it('emits the not-equal-to-zero tail once', { todo: 'pipeline fix pending' }, () => {
    const out = run(input);
    const tails = out.match(/!=\s*(L'\\0'|0)\s*\)/g) ?? [];
    const copies = (out.match(/return\s+-\(uint32_t\)\(\*pwszText2/g) ?? []).length;
    assert.ok(copies <= 1, `tail copied ${copies}x:\n${out}`);
    assert.ok(!/while\s*\(\s*true\s*\)/.test(out), `loop has no condition:\n${out}`);
  });
});
