import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  KEYWORDS,
  isKeywordString,
  getKeywordKind,
  DIGRAPHS,
  getDigraphCanonical,
} from '../keywords.js';
import { TokenKind } from '../token.js';

describe('Keywords', () => {
  describe('KEYWORDS map', () => {
    it('contains all basic C++ keywords', () => {
      const basics = [
        'if', 'else', 'while', 'for', 'do', 'switch', 'case', 'default',
        'break', 'continue', 'return', 'goto',
        'int', 'char', 'float', 'double', 'void', 'bool',
        'class', 'struct', 'enum', 'union', 'namespace',
        'public', 'private', 'protected',
        'const', 'static', 'extern', 'volatile',
        'new', 'delete', 'this', 'true', 'false', 'nullptr',
      ];

      for (const keyword of basics) {
        assert.ok(KEYWORDS.has(keyword), `Missing keyword: ${keyword}`);
      }
    });

    it('contains C++11 keywords', () => {
      const cpp11 = ['constexpr', 'nullptr', 'decltype', 'noexcept', 'override', 'final', 'static_assert'];
      for (const keyword of cpp11) {
        assert.ok(KEYWORDS.has(keyword), `Missing C++11 keyword: ${keyword}`);
      }
    });

    it('contains C++20 keywords', () => {
      const cpp20 = ['concept', 'requires', 'consteval', 'constinit', 'co_await', 'co_return', 'co_yield'];
      for (const keyword of cpp20) {
        assert.ok(KEYWORDS.has(keyword), `Missing C++20 keyword: ${keyword}`);
      }
    });

    it('contains template keywords', () => {
      assert.ok(KEYWORDS.has('template'));
      assert.ok(KEYWORDS.has('typename'));
    });

    it('contains cast keywords', () => {
      const casts = ['const_cast', 'dynamic_cast', 'reinterpret_cast', 'static_cast'];
      for (const cast of casts) {
        assert.ok(KEYWORDS.has(cast), `Missing cast keyword: ${cast}`);
      }
    });
  });

  describe('isKeywordString', () => {
    it('returns true for keywords', () => {
      assert.strictEqual(isKeywordString('int'), true);
      assert.strictEqual(isKeywordString('return'), true);
      assert.strictEqual(isKeywordString('class'), true);
    });

    it('returns false for non-keywords', () => {
      assert.strictEqual(isKeywordString('foo'), false);
      assert.strictEqual(isKeywordString('main'), false);
      assert.strictEqual(isKeywordString('printf'), false);
    });

    it('is case-sensitive', () => {
      assert.strictEqual(isKeywordString('INT'), false);
      assert.strictEqual(isKeywordString('Return'), false);
    });
  });

  describe('getKeywordKind', () => {
    it('returns correct TokenKind for keywords', () => {
      assert.strictEqual(getKeywordKind('int'), TokenKind.Int);
      assert.strictEqual(getKeywordKind('return'), TokenKind.Return);
      assert.strictEqual(getKeywordKind('class'), TokenKind.Class);
      assert.strictEqual(getKeywordKind('nullptr'), TokenKind.Nullptr);
    });

    it('returns undefined for non-keywords', () => {
      assert.strictEqual(getKeywordKind('foo'), undefined);
      assert.strictEqual(getKeywordKind('main'), undefined);
    });
  });

  describe('DIGRAPHS map', () => {
    it('contains all standard digraphs', () => {
      assert.ok(DIGRAPHS.has('<:'));
      assert.ok(DIGRAPHS.has(':>'));
      assert.ok(DIGRAPHS.has('<%'));
      assert.ok(DIGRAPHS.has('%>'));
      assert.ok(DIGRAPHS.has('%:'));
      assert.ok(DIGRAPHS.has('%:%:'));
    });
  });

  describe('getDigraphCanonical', () => {
    it('maps digraphs to canonical tokens', () => {
      assert.strictEqual(getDigraphCanonical(TokenKind.DiLeftBracket), TokenKind.LeftBracket);
      assert.strictEqual(getDigraphCanonical(TokenKind.DiRightBracket), TokenKind.RightBracket);
      assert.strictEqual(getDigraphCanonical(TokenKind.DiLeftBrace), TokenKind.LeftBrace);
      assert.strictEqual(getDigraphCanonical(TokenKind.DiRightBrace), TokenKind.RightBrace);
      assert.strictEqual(getDigraphCanonical(TokenKind.DiHash), TokenKind.Hash);
      assert.strictEqual(getDigraphCanonical(TokenKind.DiHashHash), TokenKind.HashHash);
    });

    it('returns non-digraph tokens unchanged', () => {
      assert.strictEqual(getDigraphCanonical(TokenKind.LeftBracket), TokenKind.LeftBracket);
      assert.strictEqual(getDigraphCanonical(TokenKind.Identifier), TokenKind.Identifier);
    });
  });
});
