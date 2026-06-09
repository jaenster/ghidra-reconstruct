/**
 * @ghidra-mcp/cpp-parser
 *
 * C++ recursive descent parser with AST transformation support
 */

// Re-export all from lexer except isLiteral (which conflicts with ast/kinds)
export {
  // token.ts
  TokenKind,
  type Position,
  type SourceLocation,
  type Token,
  isKeyword as isTokenKeyword,
  isLiteral as isTokenLiteral,
  isAssignmentOperator,
  // trivia.ts
  TriviaKind,
  type Trivia,
  type TokenWithTrivia,
  hasComments,
  extractCommentText,
  isGhidraAddressComment,
  extractGhidraAddress,
  // keywords.ts
  KEYWORDS,
  isKeywordString,
  getKeywordKind,
  DIGRAPHS,
  getDigraphCanonical,
  // literals.ts
  type IntegerLiteralValue,
  type FloatingLiteralValue,
  type CharLiteralValue,
  type StringLiteralValue,
  type UserDefinedLiteralValue,
  type LiteralValue,
  parseIntegerLiteral,
  parseFloatingLiteral,
  parseEscapeSequence,
  parseCharLiteral,
  parseStringLiteral,
  isIntegerLiteral,
  isFloatingLiteral,
  isCharLiteral,
  isStringLiteral,
  // lexer.ts
  type LexerOptions,
  LexerError,
  Lexer,
  reconstructSource,
} from './lexer/index.js';

export * from './ast/index.js';
export * from './parser/index.js';
export * from './emit/index.js';
export * from './transform/index.js';

// High-level Ghidra integration API
export {
  preprocessGhidraCode,
  transformGhidraCode,
  analyzeGhidraCode,
  extractFunctions,
  createGhidraPipeline,
  type TransformGhidraOptions,
  type TransformResult,
  type AnalysisResult,
} from './ghidra.js';
