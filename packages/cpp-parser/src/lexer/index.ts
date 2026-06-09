/**
 * Lexer module - C++ tokenization with trivia preservation
 */

export * from './token.js';
export * from './trivia.js';
export * from './keywords.js';
export * from './literals.js';
export * from './ghidra-types.js';
export { Lexer, LexerError, reconstructSource } from './lexer.js';
export type { LexerOptions } from './lexer.js';
