/**
 * A byte is a byte, whatever sign Ghidra read it with.
 *
 * Ghidra prints an initialized datum against the type IT modelled, and for the
 * one-byte slots that came out of the array-extent typing pass that reading is
 * SIGNED: the palette byte 0xA0 arrives as `-0x60`. The emitted slot is
 * `undefined1` (`uint8_t`), and C++ refuses a negative inside a braced
 * initializer outright — `narrowing conversion of '-96' from 'int' to
 * 'undefined1'` — which takes the whole translation unit, and with
 * `globals.D2Client.cpp` the thousands of definitions it holds.
 *
 * The value is not in dispute. The same eight bits are stored either way; only
 * the spelling is wrong, and the slot's declared type is what settles it. So
 * the rule is: for an unsigned slot of width N, spell the datum as the bit
 * pattern it is — reduced modulo 2^N, in hex, because the neighbouring elements
 * of these binary blobs are hex and a byte reads as a byte that way.
 *
 * What is NOT done matters as much:
 * - a SIGNED slot keeps its negative, because there -96 is the value;
 * - a slot whose width the emitted tree does not fix is refused, rather than
 *   guessed at — reducing modulo the wrong width invents a byte pattern, and
 *   nothing downstream would report it;
 * - a magnitude that does not fit the slot's signed range is refused for the
 *   same reason: the datum and the declared width disagree, and the disagreement
 *   is the bug.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { negativeBytePatternInUnsignedSlot } from '../codegen/sentinel-literal.js';
import { emitDataValue, setGlobalInitializerTypes } from '../codegen/globals-header.js';
import type { DataValue } from '../types.js';

const scalar = (value: string): DataValue => ({ kind: 'scalar', value } as DataValue);

const ctx = {
  isEnumType: (n: string) => n === 'eD2UnitStat',
  isFuncDefTypedef: (n: string) => n.startsWith('fn'),
};

describe('negativeBytePatternInUnsignedSlot', () => {
  it('spells a negative byte as the byte it is', () => {
    assert.strictEqual(negativeBytePatternInUnsignedSlot('-0x60', 'undefined1', ctx), '0xa0');
    assert.strictEqual(negativeBytePatternInUnsignedSlot('-96', 'uint8_t', ctx), '0xa0');
    assert.strictEqual(negativeBytePatternInUnsignedSlot('-0x5f', 'byte', ctx), '0xa1');
    assert.strictEqual(negativeBytePatternInUnsignedSlot('-1', 'unsigned char', ctx), '0xff');
  });

  it('takes the width from the declared type, at every width', () => {
    assert.strictEqual(negativeBytePatternInUnsignedSlot('-1', 'ushort', ctx), '0xffff');
    assert.strictEqual(negativeBytePatternInUnsignedSlot('-0x1000', 'uint16_t', ctx), '0xf000');
    assert.strictEqual(negativeBytePatternInUnsignedSlot('-1', 'uint32_t', ctx), '0xffffffff');
    assert.strictEqual(negativeBytePatternInUnsignedSlot('-13', 'uint', ctx), '0xfffffff3');
    assert.strictEqual(negativeBytePatternInUnsignedSlot('-1', 'undefined8', ctx), '0xffffffffffffffff');
  });

  it('reduces modulo the SLOT width, never the value width', () => {
    // -96 is 0xa0 in a byte and 0xffffffa0 in a dword. Same datum, two slots,
    // two bit patterns — which is exactly why the width may not come from the
    // literal.
    assert.strictEqual(negativeBytePatternInUnsignedSlot('-96', 'byte', ctx), '0xa0');
    assert.strictEqual(negativeBytePatternInUnsignedSlot('-96', 'dword', ctx), '0xffffffa0');
  });

  it('reaches an element type that still carries its array dimensions', () => {
    assert.strictEqual(negativeBytePatternInUnsignedSlot('-0x60', 'undefined1[6920]', ctx), '0xa0');
  });

  describe('refusals — where the negative is the value, or the width is unknown', () => {
    it('leaves a signed slot alone', () => {
      for (const slot of ['int8_t', 'char', 'short', 'int', 'int32_t', 'BOOL', 'longlong']) {
        assert.strictEqual(negativeBytePatternInUnsignedSlot('-96', slot, ctx), undefined, slot);
      }
    });

    it('leaves a non-negative datum alone', () => {
      assert.strictEqual(negativeBytePatternInUnsignedSlot('0xa0', 'uint8_t', ctx), undefined);
      assert.strictEqual(negativeBytePatternInUnsignedSlot('160', 'uint8_t', ctx), undefined);
    });

    it('refuses a pointer, a funcdef typedef and an enum', () => {
      assert.strictEqual(negativeBytePatternInUnsignedSlot('-1', 'uint8_t *', ctx), undefined);
      assert.strictEqual(negativeBytePatternInUnsignedSlot('-1', 'fnD2Callback', ctx), undefined);
      assert.strictEqual(negativeBytePatternInUnsignedSlot('-1', 'eD2UnitStat', ctx), undefined);
    });

    it('refuses the pointer-width unsigned slots the sentinel rule also refuses', () => {
      // The width itself is the defect there; a spelling would hide it.
      assert.strictEqual(negativeBytePatternInUnsignedSlot('-1', 'size_t', ctx), undefined);
      assert.strictEqual(negativeBytePatternInUnsignedSlot('-1', 'uintptr_t', ctx), undefined);
    });

    it('refuses a slot whose emitted width is not the Ghidra width', () => {
      // `undefined3` is 3 bytes in Ghidra and `uint8_t` in the emitted header.
      // No width is trustworthy here, so no rewrite.
      assert.strictEqual(negativeBytePatternInUnsignedSlot('-1', 'undefined3', ctx), undefined);
      assert.strictEqual(negativeBytePatternInUnsignedSlot('-1', 'D2UnitStrc', ctx), undefined);
    });

    it('refuses a magnitude that does not fit the slot it is declared in', () => {
      // -200 cannot have been read out of one signed byte. The datum and the
      // declared width disagree; inventing a pattern would bury that.
      assert.strictEqual(negativeBytePatternInUnsignedSlot('-200', 'uint8_t', ctx), undefined);
      assert.strictEqual(negativeBytePatternInUnsignedSlot('-0x80', 'byte', ctx), '0x80');
      assert.strictEqual(negativeBytePatternInUnsignedSlot('-0x81', 'byte', ctx), undefined);
    });
  });
});

describe('emitDataValue — the slot decides the spelling', () => {
  it('emits an unsigned byte array as bytes', () => {
    setGlobalInitializerTypes(undefined);
    const array: DataValue = {
      kind: 'array',
      elements: [scalar('-0x60'), scalar('0xd'), scalar('0x0'), scalar('-0x5f')],
    } as DataValue;
    const out = emitDataValue(array, 0, 'undefined1[4]');
    assert.strictEqual(out, '{ 0xa0, 0xd, 0x0, 0xa1 }');
  });

  it('keeps the negative where the element type is signed', () => {
    setGlobalInitializerTypes(undefined);
    const array: DataValue = {
      kind: 'array',
      elements: [scalar('-0x60'), scalar('-0x5f')],
    } as DataValue;
    const out = emitDataValue(array, 0, 'int8_t[2]');
    assert.match(out, /-0x60/);
    assert.match(out, /-0x5f/);
  });

  it('spells a 16-bit and a 32-bit unsigned slot at their own width', () => {
    setGlobalInitializerTypes(undefined);
    assert.strictEqual(emitDataValue(scalar('-0x30'), 0, 'ushort'), '0xffd0');
    assert.strictEqual(emitDataValue(scalar('-0xd'), 0, 'uint32_t'), '0xfffffff3');
  });

  describe('a char datum in a byte slot the emitter itself declares', () => {
    it('types a GUID field by field, so its bytes stay bytes', () => {
      // Ghidra hands GUID back as BUILT_IN with no fields, so nothing typed
      // `Data4` — and a code unit above 0x7f fell through to `'\x89'`, a
      // NEGATIVE char, which is what gcc reported as
      // `narrowing conversion of ''\37777777611'' from 'char' to 'unsigned char'`.
      // The layout is not unknown: this generator writes the struct out itself.
      setGlobalInitializerTypes(undefined);
      const guid: DataValue = {
        kind: 'struct',
        fields: [
          { name: 'Data1', value: scalar('0x93281502') },
          { name: 'Data2', value: scalar('0x8cf8') },
          { name: 'Data3', value: scalar('0x11d0') },
          {
            name: 'Data4',
            value: {
              kind: 'array',
              elements: ['\x89', '\xab', '\x00', '\xa0', '\xc9', '\x05', 'A', ')'].map(scalar),
            } as DataValue,
          },
        ],
      } as DataValue;
      const out = emitDataValue(guid, 0, 'GUID');
      assert.ok(!out.includes('\\x89'), `char escape survived into a BYTE slot:\n${out}`);
      assert.match(out, /0x89/);
      assert.match(out, /0xab/);
      assert.match(out, /0xa0/);
      assert.match(out, /0xc9/);
      // Below 0x80 a char literal is not negative and narrows into nothing.
      assert.match(out, /'A'/);
    });
  });
});
