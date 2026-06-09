import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  TriviaKind,
  hasComments,
  extractCommentText,
  isGhidraAddressComment,
  extractGhidraAddress,
  Trivia,
} from '../trivia.js';

function makeTrivia(kind: TriviaKind, text: string): Trivia {
  return {
    kind,
    text,
    location: {
      file: '<test>',
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: text.length + 1, offset: text.length },
    },
  };
}

describe('Trivia utilities', () => {
  describe('hasComments', () => {
    it('returns false for empty trivia', () => {
      assert.strictEqual(hasComments([]), false);
    });

    it('returns false for only whitespace', () => {
      assert.strictEqual(hasComments([
        makeTrivia(TriviaKind.Whitespace, '  '),
        makeTrivia(TriviaKind.Newline, '\n'),
      ]), false);
    });

    it('returns true for line comments', () => {
      assert.strictEqual(hasComments([
        makeTrivia(TriviaKind.LineComment, '// comment'),
      ]), true);
    });

    it('returns true for block comments', () => {
      assert.strictEqual(hasComments([
        makeTrivia(TriviaKind.BlockComment, '/* comment */'),
      ]), true);
    });
  });

  describe('extractCommentText', () => {
    it('extracts text from line comment', () => {
      const trivia = makeTrivia(TriviaKind.LineComment, '// hello world');
      assert.strictEqual(extractCommentText(trivia), 'hello world');
    });

    it('extracts text from block comment', () => {
      const trivia = makeTrivia(TriviaKind.BlockComment, '/* hello world */');
      assert.strictEqual(extractCommentText(trivia), 'hello world');
    });

    it('returns null for non-comments', () => {
      const trivia = makeTrivia(TriviaKind.Whitespace, '  ');
      assert.strictEqual(extractCommentText(trivia), null);
    });
  });

  describe('isGhidraAddressComment', () => {
    it('detects hex address with 0x prefix', () => {
      const trivia = makeTrivia(TriviaKind.BlockComment, '/* 0x00401000 */');
      assert.strictEqual(isGhidraAddressComment(trivia), true);
    });

    it('detects hex address without prefix', () => {
      const trivia = makeTrivia(TriviaKind.BlockComment, '/* 00401000 */');
      assert.strictEqual(isGhidraAddressComment(trivia), true);
    });

    it('detects Address: prefix format', () => {
      const trivia = makeTrivia(TriviaKind.LineComment, '// Address: 0x401000');
      assert.strictEqual(isGhidraAddressComment(trivia), true);
    });

    it('returns false for non-address comments', () => {
      const trivia = makeTrivia(TriviaKind.LineComment, '// This is a comment');
      assert.strictEqual(isGhidraAddressComment(trivia), false);
    });

    it('returns false for short hex numbers', () => {
      const trivia = makeTrivia(TriviaKind.BlockComment, '/* 0xFF */');
      assert.strictEqual(isGhidraAddressComment(trivia), false);
    });
  });

  describe('extractGhidraAddress', () => {
    it('extracts and normalizes address with 0x prefix', () => {
      const trivia = makeTrivia(TriviaKind.BlockComment, '/* 0x00401000 */');
      assert.strictEqual(extractGhidraAddress(trivia), '0x00401000');
    });

    it('normalizes address without 0x prefix', () => {
      const trivia = makeTrivia(TriviaKind.BlockComment, '/* 00401000 */');
      assert.strictEqual(extractGhidraAddress(trivia), '0x00401000');
    });

    it('extracts address with Address: prefix', () => {
      const trivia = makeTrivia(TriviaKind.LineComment, '// Address: 0x401000');
      assert.strictEqual(extractGhidraAddress(trivia), '0x401000');
    });

    it('returns null for non-address comments', () => {
      const trivia = makeTrivia(TriviaKind.LineComment, '// hello');
      assert.strictEqual(extractGhidraAddress(trivia), null);
    });
  });
});
