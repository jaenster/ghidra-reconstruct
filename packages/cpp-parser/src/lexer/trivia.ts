/**
 * Trivia - Non-semantic content preserved for source resurrection
 */

import type { SourceLocation } from './token.js';

export enum TriviaKind {
  Whitespace = 'Whitespace',      // Spaces and tabs
  Newline = 'Newline',            // Line breaks
  LineComment = 'LineComment',    // // comment
  BlockComment = 'BlockComment',  // /* comment */
  Directive = 'Directive',        // #include, #define, etc.
}

export interface Trivia {
  kind: TriviaKind;
  text: string;           // Original text verbatim
  location: SourceLocation;
}

/**
 * Token with attached trivia for full source preservation
 */
export interface TokenWithTrivia {
  leadingTrivia: Trivia[];   // Trivia before token
  token: import('./token.js').Token;
  trailingTrivia: Trivia[];  // Trivia after token (until next significant trivia or token)
}

/**
 * Check if trivia contains any comments
 */
export function hasComments(trivia: Trivia[]): boolean {
  return trivia.some(
    t => t.kind === TriviaKind.LineComment || t.kind === TriviaKind.BlockComment
  );
}

/**
 * Extract comment text from trivia (strips // or block comment markers)
 */
export function extractCommentText(trivia: Trivia): string | null {
  if (trivia.kind === TriviaKind.LineComment) {
    // Remove // prefix
    return trivia.text.slice(2).trim();
  }
  if (trivia.kind === TriviaKind.BlockComment) {
    // Remove /* prefix and */ suffix
    return trivia.text.slice(2, -2).trim();
  }
  return null;
}

/**
 * Check if a comment looks like a Ghidra address annotation
 * e.g., block comment with 0x00401000 or // Address: 0x401000
 */
export function isGhidraAddressComment(trivia: Trivia): boolean {
  const text = extractCommentText(trivia);
  if (!text) return false;
  // Match hex addresses like 0x00401000 or 00401000
  return /^(?:Address:\s*)?(?:0x)?[0-9a-fA-F]{6,16}$/.test(text);
}

/**
 * Extract Ghidra address from a comment
 */
export function extractGhidraAddress(trivia: Trivia): string | null {
  const text = extractCommentText(trivia);
  if (!text) return null;
  const match = text.match(/(?:Address:\s*)?((?:0x)?[0-9a-fA-F]{6,16})/);
  if (!match) return null;
  const addr = match[1];
  // Normalize to 0x format
  return addr.startsWith('0x') ? addr : `0x${addr}`;
}
