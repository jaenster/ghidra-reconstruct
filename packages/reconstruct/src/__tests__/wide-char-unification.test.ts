/**
 * Diablo II's 16-bit character has one spelling in the emitted tree: uint16_t.
 *
 * Ghidra carries the game's wide strings as `ushort` in decompiled bodies (which
 * type-normalize rewrites to `uint16_t`) but as `WCHAR`, `wchar_t`, `wchar16` or
 * `unicode` in the hand-typed prototypes and struct layouts. On i686-w64-mingw32
 * `wchar_t` is a 16-bit unsigned type, so those are layout-identical — but they
 * are DISTINCT C++ types, so every call across the boundary was an error.
 *
 * Signatures and struct fields therefore converge on `uint16_t`, the one spelling
 * the bodies can produce. The real Win32/CRT `WCHAR`/`wchar_t` must survive
 * untouched in d2_platform.h — wcslen, MessageBoxW and CreateFileW need the true
 * wchar_t.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  normalizeWideCharType,
  normalizeSignatureType,
  generatePlatformHeader,
} from '../codegen/platform-types.js';
import { generateHeader } from '../codegen/header.js';
import type {
  ExtractedDataType,
  ExtractedFunction,
  ExtractedParameter,
  ExtractedStruct,
  ReconstructOptions,
} from '../types.js';

const defaultOptions: ReconstructOptions = {
  outputDir: '/tmp/test',
  format: 'cpp',
  organization: 'flat',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
  promoteStaticGlobals: false,
};

function makeParam(name: string, dataType: string, ordinal: number): ExtractedParameter {
  return { name, dataType, size: 4, ordinal, storage: 'register' };
}

// ── the unifier itself ───────────────────────────────────────────────

describe('normalizeWideCharType', () => {
  it('unifies every Ghidra spelling of D2 wide chars on uint16_t', () => {
    assert.strictEqual(normalizeWideCharType('WCHAR'), 'uint16_t');
    assert.strictEqual(normalizeWideCharType('wchar_t'), 'uint16_t');
    assert.strictEqual(normalizeWideCharType('wchar16'), 'uint16_t');
    assert.strictEqual(normalizeWideCharType('unicode'), 'uint16_t');
  });

  it('rewrites the base type inside pointer and array decoration', () => {
    assert.strictEqual(normalizeWideCharType('WCHAR *'), 'uint16_t *');
    assert.strictEqual(normalizeWideCharType('wchar_t * *'), 'uint16_t * *');
    assert.strictEqual(normalizeWideCharType('const WCHAR *'), 'const uint16_t *');
    assert.strictEqual(normalizeWideCharType('WCHAR[16]'), 'uint16_t[16]');
  });

  it('leaves unrelated types alone, including near-misses', () => {
    for (const t of ['char *', 'CHAR', 'TCHAR', 'uint16_t', 'D2UnitStrc *', 'WCHARFoo', 'my_wchar_t']) {
      assert.strictEqual(normalizeWideCharType(t), t);
    }
  });
});

// ── the signature path ───────────────────────────────────────────────

describe('normalizeSignatureType wide-char unification', () => {
  it('unifies wide-char params and returns', () => {
    assert.strictEqual(normalizeSignatureType('WCHAR *'), 'uint16_t *');
    assert.strictEqual(normalizeSignatureType('wchar_t * *'), 'uint16_t * *');
  });

  it('still applies the undefined/array/code normalizations', () => {
    assert.strictEqual(normalizeSignatureType('undefined4'), 'uint32_t');
    assert.strictEqual(normalizeSignatureType('undefined4 *'), 'uint32_t *');
    assert.strictEqual(normalizeSignatureType('code'), 'void');
    assert.strictEqual(normalizeSignatureType('WCHAR[64]'), 'uint16_t *');
  });
});

// ── end to end through the header emitter ────────────────────────────

describe('generateHeader emits one wide-char spelling', () => {
  it('unifies wide-char function params, returns and struct fields on uint16_t', () => {
    const strc: ExtractedStruct = {
      name: 'D2WideTextStrc',
      category: '/Diablo2',
      size: 40,
      kind: 'STRUCTURE',
      fields: [
        { name: 'wszName', dataType: 'WCHAR[16]', offset: 0, size: 32 },
        { name: 'pwszNext', dataType: 'wchar_t *', offset: 32, size: 4 },
        { name: 'pwszAlt', dataType: 'unicode *', offset: 36, size: 4 },
      ],
    };

    const fn: ExtractedFunction = {
      name: 'STRING_CopyWide',
      address: '0x00aa0000',
      signature: 'WCHAR * STRING_CopyWide(WCHAR *, wchar_t * *, D2WideTextStrc *)',
      returnType: 'WCHAR *',
      parameters: [
        makeParam('wszDest', 'WCHAR *', 0),
        makeParam('ppwszSrc', 'wchar_t * *', 1),
        makeParam('pText', 'D2WideTextStrc *', 2),
      ],
      localVariables: [],
      callingConvention: '__stdcall',
      size: 64,
      isThunk: false,
      isExternal: false,
      hasVarArgs: false,
    };

    const dataTypes: ExtractedDataType[] = [strc];
    const header = generateHeader(
      'D2WideText',
      [fn],
      undefined,
      dataTypes,
      [],
      defaultOptions,
      undefined,
      undefined,
      new Set(['D2WideTextStrc'])
    );

    // Drop the evidence/annotation comments — Ghidra's original spelling is
    // allowed to survive there, it is what the storage annotation recorded.
    const code = header
      .split('\n')
      .filter(l => !l.trim().startsWith('//'))
      .join('\n');

    assert.ok(
      !/\bWCHAR\b|\bwchar_t\b|\bwchar16\b|\bunicode\b/.test(code),
      `No wide-char spelling other than uint16_t may reach declarations:\n${code}`
    );
    assert.ok(code.includes('uint16_t * STRING_CopyWide(uint16_t * wszDest, uint16_t * * ppwszSrc'),
      `Wide params/return must be uint16_t:\n${code}`);
    assert.ok(code.includes('uint16_t wszName[16]'), `Wide array field must be uint16_t:\n${code}`);
    assert.ok(code.includes('uint16_t * pwszNext'), `wchar_t* field must be uint16_t*:\n${code}`);
    assert.ok(code.includes('uint16_t * pwszAlt'), `unicode* field must be uint16_t*:\n${code}`);
  });
});

// ── the Win32 side must NOT be loosened ──────────────────────────────

describe('d2_platform.h keeps the real Win32 wide char', () => {
  const platform = generatePlatformHeader();

  it('still pulls in windows.h on Windows, where WCHAR is the true wchar_t', () => {
    assert.ok(/#\s*include\s*<windows\.h>/.test(platform),
      'Win32 declarations (MessageBoxW, CreateFileW) must come from windows.h');
  });

  it('defines WCHAR only for the non-Windows fallback, never as a global #define', () => {
    assert.ok(platform.includes('typedef uint16_t WCHAR;'),
      'non-Windows fallback still needs a WCHAR typedef');
    assert.ok(!/#\s*define\s+WCHAR\b/.test(platform),
      'WCHAR must never be #defined away — that would break real Win32 declarations');
    assert.ok(!/#\s*define\s+wchar_t\b/.test(platform),
      'wchar_t must never be #defined away — wcslen and friends need the true type');
    // The fallback typedef must sit in the #else (non-_WIN32) arm.
    const winArm = platform.indexOf('#ifdef _WIN32');
    const elseArm = platform.indexOf('#else', winArm);
    assert.ok(winArm >= 0 && elseArm > winArm, 'platform header must be _WIN32-branched');
    assert.ok(platform.indexOf('typedef uint16_t WCHAR;') > elseArm,
      'the WCHAR fallback typedef must live in the non-Windows arm only');
  });
});
