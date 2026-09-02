/**
 * A digit in a character initializer is a CHARACTER, not its own value.
 *
 * Ghidra renders a `char` datum as the character it holds, so the five bytes at
 * 006e3590 - `2e 64 63 36 00`, ".dc6" - arrive as the scalars `.`, `d`, `c`, `6`,
 * NUL. The emitter quoted the first three and passed the fourth through as a
 * number, so the array was defined `{ '.', 'd', 'c', 6, '\x00' }` and the
 * extension the sprite cache appends became ".dc\x06". Nothing diagnoses that:
 * it compiles, it links, and the fonts simply never load.
 *
 * The discriminator is NOT "does it look like a number". A numeric byte comes
 * back `0x`-prefixed - `0x36`, `0xff`, `-0x1` - in every byte table in the
 * image, so a BARE `1`..`9` in a character slot can only be the character.
 *
 * `0` alone is ambiguous, and both readings occur: 162909 of them are the
 * zero-fill of an uninitialised buffer (`g_aLightingTable`,
 * `szCustomSymbolSearchPath`) where the byte really is 0x00, and seven are the
 * character. It is decided by the NEIGHBOURS, because the datum as a whole
 * cannot decide it: `gszFogCrashReportCustomMessage` is one `char[4096]` whose
 * first 1976 bytes render `'\x00'` and whose remaining 2120 render `0`, so any
 * rule reading "this array holds text" would have written 0x30 over the tail.
 * A character 0 has a character on both sides; a zero-fill 0 has a 0 on at
 * least one.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { emitDataValue } from '../codegen/globals-header.js';
import type { DataValue } from '../types.js';

const NUL = '\u0000';

const scalars = (...values: string[]): DataValue => ({
  kind: 'array',
  value: null,
  elements: values.map(v => ({ kind: 'scalar', value: v, elements: null, fields: null })),
  fields: null,
} as unknown as DataValue);

/** The bytes a `{ ... }` initializer body actually defines. */
function bytesOf(initializer: string): number[] {
  const body = initializer.replace(/^\s*\{/, '').replace(/\}\s*$/, '');
  return body.split(',').map(raw => {
    const t = raw.trim();
    const hex = t.match(/^0x([0-9a-fA-F]+)$/);
    if (hex) return Number.parseInt(hex[1], 16);
    if (/^-?\d+$/.test(t)) return Number(t) & 0xff;
    const lit = t.match(/^'(.*)'$/);
    assert.ok(lit, `not a byte: ${t}`);
    const text = lit![1];
    const esc = text.match(/^\\x([0-9a-fA-F]{1,2})$/);
    if (esc) return Number.parseInt(esc[1], 16);
    if (text === '\\\\') return 0x5c;
    if (text === "\\'") return 0x27;
    if (text === '\\0') return 0;
    assert.strictEqual(text.length, 1, `not one character: ${t}`);
    return text.charCodeAt(0);
  });
}

describe('a digit in a character initializer keeps its byte', () => {
  it('emits the real record for gszExtDc6 as ".dc6"', () => {
    // Verbatim from the codegen snapshot: char[5] @006e3590, value ".dc6".
    const dv = scalars('.', 'd', 'c', '6', NUL);
    assert.deepStrictEqual(bytesOf(emitDataValue(dv, 0, 'char[5]')), [0x2e, 0x64, 0x63, 0x36, 0x00]);
  });

  it('round-trips every ASCII digit', () => {
    const dv = scalars('#', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', NUL);
    assert.deepStrictEqual(
      bytesOf(emitDataValue(dv, 0, 'char[12]')),
      [0x23, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x00],
    );
  });

  it('reads a `0` between two characters as the character', () => {
    // `$0?` - the array bound in every MSVC RTTI name this image carries.
    const dv = scalars('@', '$', '0', '?', 'C', NUL);
    assert.deepStrictEqual(
      bytesOf(emitDataValue(dv, 0, 'char[6]')),
      [0x40, 0x24, 0x30, 0x3f, 0x43, 0x00],
    );
  });

  it('leaves the undefined tail of a half-defined buffer at zero', () => {
    // gszFogCrashReportCustomMessage, char[4096]: defined text and terminator,
    // then bytes Ghidra never typed, which come back `0` and ARE zero.
    const dv = scalars('h', 'i', NUL, NUL, '0', '0', '0', '0');
    assert.deepStrictEqual(
      bytesOf(emitDataValue(dv, 0, 'char[8]')),
      [0x68, 0x69, 0, 0, 0, 0, 0, 0],
    );
  });

  it('keeps a quote, a backslash and a high-bit byte', () => {
    const dv = scalars("'", '\\', '"', 'ÿ', '7', NUL);
    assert.deepStrictEqual(
      bytesOf(emitDataValue(dv, 0, 'char[6]')),
      [0x27, 0x5c, 0x22, 0xff, 0x37, 0x00],
    );
  });

  it('spells the address the realm connects to', () => {
    // string_IpAddressTcpIp, char[24], "207.82.87.243": every digit became a
    // byte below 0x0a, so the emitted table held 02 00 07 2e 08 02 ...
    const dv = scalars(...'207.82.87.243'.split(''), NUL);
    assert.strictEqual(
      Buffer.from(bytesOf(emitDataValue(dv, 0, 'char[14]'))).toString('latin1'),
      `207.82.87.243${NUL}`,
    );
  });

  it('leaves a zero-filled buffer as zero bytes', () => {
    // szCustomSymbolSearchPath is 32768 uninitialised bytes, every one rendered
    // `0`. Read as the character, that is 0x30 thirty-two thousand times.
    const dv = scalars('0', '0', '0', '0');
    assert.deepStrictEqual(bytesOf(emitDataValue(dv, 0, 'char[4]')), [0, 0, 0, 0]);
    assert.deepStrictEqual(bytesOf(emitDataValue(dv, 0, 'uint8_t[4]')), [0, 0, 0, 0]);
  });

  it('leaves a numeric slot numeric', () => {
    // sinTable_f32 holds 1.0 at a quarter turn, rendered `1`. It is not `'1'`.
    const dv = scalars('0', '1', '0');
    assert.deepStrictEqual(bytesOf(emitDataValue(dv, 0, 'float[3]')), [0, 1, 0]);
  });

  it('gives a wide slot the code unit, not a narrow char literal', () => {
    // CharacterLookupTable is WCHAR[256] holding the characters themselves.
    const dv = scalars('A', '7', 'ÿ');
    assert.strictEqual(emitDataValue(dv, 0, 'uint16_t[3]'), '{ 0x41, 0x37, 0xff }');
  });
});
