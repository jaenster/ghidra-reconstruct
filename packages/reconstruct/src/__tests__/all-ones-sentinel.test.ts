/**
 * The all-ones sentinel: which slots get `-1`, and - the part that matters -
 * which slots keep their bit pattern.
 *
 * D2 spells "none / invalid" as -1 everywhere. Ghidra prints it against the
 * declared type of the slot it found it in, so a signed field arrives as `-1`
 * and an unsigned or pointer field as `0xffffffff`. The two are the same 32
 * bits today and different objects on a 64-bit rebuild, where `(void*)0xffffffff`
 * is `0x00000000FFFFFFFF` and every `== (void*)-1` test silently stops matching.
 *
 * The refusals below are the real subject. A pass that cannot tell a mask, a
 * colour, or a byte of binary data from a sentinel is worse than no pass, and
 * the tree contains 2,582 `byte` slots holding 0xff to prove it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { allOnesSentinel, parseDataValueNumber } from '../codegen/sentinel-literal.js';

const ENUMS = new Set(['eD2UnitStat', 'eD2Sounds']);
const ctx = {
  isEnumType: (n: string) => ENUMS.has(n),
  isFuncDefTypedef: (n: string) => n.startsWith('fn') || n.startsWith('fp'),
};

describe('allOnesSentinel', () => {
  describe('rewrites - where the spelling is wrong at 64 bits', () => {
    it('spells a pointer slot with -1, which is all-ones at any width', () => {
      assert.strictEqual(allOnesSentinel('ffffffff', 'void *', ctx), '(void*)-1');
      assert.strictEqual(allOnesSentinel('0xffffffff', 'D2UnitStrc *', ctx), '(D2UnitStrc*)-1');
      assert.strictEqual(allOnesSentinel('ffffffff', 'LONG *', ctx), '(LONG*)-1');
    });

    it('uses the SDK name for HANDLE, which the SDK already writes width-correctly', () => {
      // INVALID_HANDLE_VALUE is ((HANDLE)(LONG_PTR)-1) precisely for this reason.
      assert.strictEqual(allOnesSentinel('ffffffff', 'HANDLE', ctx), 'INVALID_HANDLE_VALUE');
    });

    it('reaches a funcdef typedef, which is pointer-shaped without a star', () => {
      assert.strictEqual(
        allOnesSentinel('ffffffff', 'fnD2InitUIFlagFunction', ctx),
        '(fnD2InitUIFlagFunction)-1'
      );
    });

    it('reads the decimal spelling an enum slot arrives in', () => {
      // `OBJECTSHRINEFUNCTION.eStat` is handed over as 4294967295, and gcc
      // rejects it: narrowing conversion to 'eD2UnitStat' {aka 'int'}.
      assert.strictEqual(allOnesSentinel('4294967295', 'eD2UnitStat', ctx), '-1');
    });

    it('generalises down the widths, because the argument does', () => {
      assert.strictEqual(allOnesSentinel('0xffff', 'int16_t', ctx), '-1');
      assert.strictEqual(allOnesSentinel('0xff', 'int8_t', ctx), '-1');
      assert.strictEqual(allOnesSentinel('0xffffffffffffffff', 'int64_t', ctx), '-1');
    });

    it('takes the width from the type, never from the value', () => {
      // 0xff in a 4-byte slot is 255. It is all-ones for SOME width, which is
      // exactly the reasoning that must not be allowed.
      assert.strictEqual(allOnesSentinel('0xff', 'int', ctx), undefined);
      assert.strictEqual(allOnesSentinel('0xffff', 'int32_t', ctx), undefined);
      assert.strictEqual(allOnesSentinel('0xffffffff', 'int64_t', ctx), undefined);
    });

    it('spells a signed pointer-width slot -1, correct at both widths', () => {
      assert.strictEqual(allOnesSentinel('0xffffffff', 'LONG_PTR', ctx), '-1');
      assert.strictEqual(allOnesSentinel('0xffffffff', 'intptr_t', ctx), '-1');
    });
  });

  describe('refusals - where the bit pattern is the value', () => {
    it('leaves a raw byte alone: 2,582 of these are binary data, not sentinels', () => {
      assert.strictEqual(allOnesSentinel('0xff', 'byte', ctx), undefined);
      assert.strictEqual(allOnesSentinel('0xff', 'uint8_t', ctx), undefined);
      assert.strictEqual(allOnesSentinel('0xff', 'BYTE', ctx), undefined);
    });

    it('leaves a mask alone', () => {
      // gdwQuestDataIntialMask is uint[6]; the slot is 32 bits at any target,
      // so there is nothing here to fix and a -1 would be a sign conversion.
      assert.strictEqual(allOnesSentinel('0xffffffff', 'uint', ctx), undefined);
      assert.strictEqual(allOnesSentinel('0xffffffff', 'uint[6]', ctx), undefined);
    });

    it('leaves a colour alone', () => {
      assert.strictEqual(allOnesSentinel('0xffffffff', 'COLORREF', ctx), undefined);
      assert.strictEqual(allOnesSentinel('0xffffffff', 'uint32_t', ctx), undefined);
    });

    it('leaves an unsigned error code alone', () => {
      // dwTlsIndex_00749e94 holds TLS_OUT_OF_INDEXES, which IS 0xFFFFFFFF and
      // is genuinely unsigned. Re-signing it changes what it is called.
      assert.strictEqual(allOnesSentinel('0xffffffff', 'DWORD', ctx), undefined);
      assert.strictEqual(allOnesSentinel('0xffffffff', 'dword', ctx), undefined);
      assert.strictEqual(allOnesSentinel('0xffffffff', 'ULONG', ctx), undefined);
    });

    it('refuses an unsigned pointer-width slot rather than papering over it', () => {
      // D2NET_CLIENT_D2GS_ServerToClient.nExpectedSize is `size_t` on a 4-byte
      // binary field: rebuilding at 64 bits changes the record's stride. That
      // is a layout defect and the type is what is wrong, so it goes in the
      // Ghidra work order and SIZE_MAX must not hide it here.
      assert.strictEqual(allOnesSentinel('0xffffffff', 'size_t', ctx), undefined);
      assert.strictEqual(allOnesSentinel('0xffffffff', 'ULONG_PTR', ctx), undefined);
      assert.strictEqual(allOnesSentinel('0xffffffff', 'WPARAM', ctx), undefined);
    });

    it('refuses plain char, whose signedness is the target\'s to decide', () => {
      assert.strictEqual(allOnesSentinel('0xff', 'char', ctx), undefined);
      assert.strictEqual(allOnesSentinel('0xff', 'CHAR', ctx), undefined);
    });

    it('refuses an unknown or absent slot type', () => {
      assert.strictEqual(allOnesSentinel('0xffffffff', undefined, ctx), undefined);
      assert.strictEqual(allOnesSentinel('0xffffffff', 'D2SomeStructNobodyDeclared', ctx), undefined);
      assert.strictEqual(allOnesSentinel('0xffffffff', 'undefined4', ctx), undefined);
    });

    it('refuses anything that is not all ones', () => {
      assert.strictEqual(allOnesSentinel('0xfffffffe', 'int32_t', ctx), undefined);
      assert.strictEqual(allOnesSentinel('0x7fffffff', 'int32_t', ctx), undefined);
      assert.strictEqual(allOnesSentinel('0x0', 'void *', ctx), undefined);
      assert.strictEqual(allOnesSentinel('gSomeSymbol', 'void *', ctx), undefined);
    });
  });

  describe('parseDataValueNumber', () => {
    it('reads the three spellings Ghidra hands over', () => {
      assert.strictEqual(parseDataValueNumber('0xffffffff'), 0xffffffffn);
      assert.strictEqual(parseDataValueNumber('ffffffff'), 0xffffffffn);
      assert.strictEqual(parseDataValueNumber('4294967295'), 0xffffffffn);
    });

    it('reads an all-digit value as decimal, not as hex', () => {
      // `10` is ten. Reading unprefixed digits as hex would make it sixteen.
      assert.strictEqual(parseDataValueNumber('10'), 10n);
    });

    it('does not read a symbol name as a number', () => {
      assert.strictEqual(parseDataValueNumber('DAT_006e3598'), undefined);
      assert.strictEqual(parseDataValueNumber(undefined), undefined);
    });
  });
});
