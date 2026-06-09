import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  parseIntegerLiteral,
  parseFloatingLiteral,
  parseCharLiteral,
  parseStringLiteral,
  parseEscapeSequence,
} from '../literals.js';

describe('Literal parsing', () => {
  describe('parseIntegerLiteral', () => {
    it('parses decimal integers', () => {
      const result = parseIntegerLiteral('42');
      assert.strictEqual(result.type, 'integer');
      assert.strictEqual(result.value, 42n);
      assert.strictEqual(result.base, 10);
      assert.strictEqual(result.suffix, '');
    });

    it('parses hex integers', () => {
      const result = parseIntegerLiteral('0xFF');
      assert.strictEqual(result.value, 255n);
      assert.strictEqual(result.base, 16);
    });

    it('parses binary integers', () => {
      const result = parseIntegerLiteral('0b1010');
      assert.strictEqual(result.value, 10n);
      assert.strictEqual(result.base, 2);
    });

    it('parses octal integers', () => {
      const result = parseIntegerLiteral('0755');
      assert.strictEqual(result.value, 493n);
      assert.strictEqual(result.base, 8);
    });

    it('handles digit separators', () => {
      const result = parseIntegerLiteral("1'000'000");
      assert.strictEqual(result.value, 1000000n);
    });

    it('parses suffixes', () => {
      assert.strictEqual(parseIntegerLiteral('42u').suffix, 'u');
      assert.strictEqual(parseIntegerLiteral('42ul').suffix, 'ul');
      assert.strictEqual(parseIntegerLiteral('42ULL').suffix, 'ull');
    });
  });

  describe('parseFloatingLiteral', () => {
    it('parses simple floats', () => {
      const result = parseFloatingLiteral('3.14');
      assert.strictEqual(result.type, 'floating');
      assert.strictEqual(result.value, 3.14);
      assert.strictEqual(result.suffix, '');
    });

    it('parses scientific notation', () => {
      const result = parseFloatingLiteral('1e10');
      assert.strictEqual(result.value, 1e10);
    });

    it('parses float suffix', () => {
      assert.strictEqual(parseFloatingLiteral('1.0f').suffix, 'f');
      assert.strictEqual(parseFloatingLiteral('1.0L').suffix, 'l');
    });

    it('handles digit separators', () => {
      const result = parseFloatingLiteral("1'000.5");
      assert.strictEqual(result.value, 1000.5);
    });
  });

  describe('parseEscapeSequence', () => {
    it('parses simple escapes', () => {
      assert.strictEqual(parseEscapeSequence('\\n', 0).value, 0x0A);
      assert.strictEqual(parseEscapeSequence('\\t', 0).value, 0x09);
      assert.strictEqual(parseEscapeSequence('\\r', 0).value, 0x0D);
      assert.strictEqual(parseEscapeSequence('\\0', 0).value, 0x00);
    });

    it('parses hex escapes', () => {
      assert.strictEqual(parseEscapeSequence('\\x41', 0).value, 0x41);
      assert.strictEqual(parseEscapeSequence('\\xFF', 0).value, 0xFF);
    });

    it('parses octal escapes', () => {
      assert.strictEqual(parseEscapeSequence('\\101', 0).value, 65);
    });

    it('parses unicode escapes', () => {
      assert.strictEqual(parseEscapeSequence('\\u0041', 0).value, 0x41);
    });

    it('returns correct length', () => {
      assert.strictEqual(parseEscapeSequence('\\n', 0).length, 2);
      assert.strictEqual(parseEscapeSequence('\\x41', 0).length, 4);
      assert.strictEqual(parseEscapeSequence('\\101', 0).length, 4);
    });
  });

  describe('parseCharLiteral', () => {
    it('parses simple chars', () => {
      const result = parseCharLiteral("'a'");
      assert.strictEqual(result.type, 'char');
      assert.strictEqual(result.value, 97);
      assert.strictEqual(result.prefix, '');
    });

    it('parses escape sequences', () => {
      const result = parseCharLiteral("'\\n'");
      assert.strictEqual(result.value, 0x0A);
    });

    it('parses prefixed chars', () => {
      assert.strictEqual(parseCharLiteral("L'a'").prefix, 'L');
      assert.strictEqual(parseCharLiteral("u'a'").prefix, 'u');
      assert.strictEqual(parseCharLiteral("U'a'").prefix, 'U');
      assert.strictEqual(parseCharLiteral("u8'a'").prefix, 'u8');
    });
  });

  describe('parseStringLiteral', () => {
    it('parses simple strings', () => {
      const result = parseStringLiteral('"hello"');
      assert.strictEqual(result.type, 'string');
      assert.strictEqual(result.value, 'hello');
      assert.strictEqual(result.prefix, '');
      assert.strictEqual(result.isRaw, false);
    });

    it('parses escape sequences', () => {
      const result = parseStringLiteral('"hello\\nworld"');
      assert.strictEqual(result.value, 'hello\nworld');
    });

    it('parses prefixed strings', () => {
      assert.strictEqual(parseStringLiteral('L"wide"').prefix, 'L');
      assert.strictEqual(parseStringLiteral('u"utf16"').prefix, 'u');
      assert.strictEqual(parseStringLiteral('U"utf32"').prefix, 'U');
      assert.strictEqual(parseStringLiteral('u8"utf8"').prefix, 'u8');
    });

    it('parses raw strings', () => {
      const result = parseStringLiteral('R"(hello\\nworld)"');
      assert.strictEqual(result.value, 'hello\\nworld');
      assert.strictEqual(result.isRaw, true);
    });

    it('parses raw strings with delimiter', () => {
      const result = parseStringLiteral('R"delim(has ) in it)delim"');
      assert.strictEqual(result.value, 'has ) in it');
      assert.strictEqual(result.isRaw, true);
    });

    it('parses prefixed raw strings', () => {
      const result = parseStringLiteral('LR"(wide raw)"');
      assert.strictEqual(result.prefix, 'LR');
      assert.strictEqual(result.isRaw, true);
      assert.strictEqual(result.value, 'wide raw');
    });
  });
});
