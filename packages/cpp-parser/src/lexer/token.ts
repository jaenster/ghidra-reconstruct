/**
 * C++ Token Types
 * Complete set of tokens for C++20/23
 */

export enum TokenKind {
  // End of file
  EOF = 'EOF',

  // Identifiers and literals
  Identifier = 'Identifier',
  IntegerLiteral = 'IntegerLiteral',
  FloatingLiteral = 'FloatingLiteral',
  CharLiteral = 'CharLiteral',
  StringLiteral = 'StringLiteral',
  UserDefinedLiteral = 'UserDefinedLiteral',

  // Keywords - Storage class specifiers
  Auto = 'auto',
  Register = 'register',
  Static = 'static',
  Extern = 'extern',
  Mutable = 'mutable',
  ThreadLocal = 'thread_local',

  // Keywords - Type specifiers
  Void = 'void',
  Bool = 'bool',
  Char = 'char',
  Char8_t = 'char8_t',
  Char16_t = 'char16_t',
  Char32_t = 'char32_t',
  Wchar_t = 'wchar_t',
  Short = 'short',
  Int = 'int',
  Long = 'long',
  Signed = 'signed',
  Unsigned = 'unsigned',
  Float = 'float',
  Double = 'double',

  // Keywords - Type qualifiers
  Const = 'const',
  Volatile = 'volatile',
  Restrict = 'restrict',

  // Keywords - Class/struct/union/enum
  Class = 'class',
  Struct = 'struct',
  Union = 'union',
  Enum = 'enum',

  // Keywords - Access specifiers
  Public = 'public',
  Private = 'private',
  Protected = 'protected',

  // Keywords - Control flow
  If = 'if',
  Else = 'else',
  Switch = 'switch',
  Case = 'case',
  Default = 'default',
  While = 'while',
  Do = 'do',
  For = 'for',
  Break = 'break',
  Continue = 'continue',
  Return = 'return',
  Goto = 'goto',

  // Keywords - Exception handling
  Try = 'try',
  Catch = 'catch',
  Throw = 'throw',
  Noexcept = 'noexcept',

  // Keywords - Operators and expressions
  Sizeof = 'sizeof',
  Alignof = 'alignof',
  Alignas = 'alignas',
  Decltype = 'decltype',
  Typeid = 'typeid',
  New = 'new',
  Delete = 'delete',
  This = 'this',
  Nullptr = 'nullptr',
  True = 'true',
  False = 'false',

  // Keywords - Templates
  Template = 'template',
  Typename = 'typename',
  Concept = 'concept',
  Requires = 'requires',

  // Keywords - Namespaces
  Namespace = 'namespace',
  Using = 'using',

  // Keywords - Type traits and casting
  Const_cast = 'const_cast',
  Dynamic_cast = 'dynamic_cast',
  Reinterpret_cast = 'reinterpret_cast',
  Static_cast = 'static_cast',

  // Keywords - Other
  Asm = 'asm',
  Explicit = 'explicit',
  Export = 'export',
  Friend = 'friend',
  Inline = 'inline',
  Operator = 'operator',
  Typedef = 'typedef',
  Virtual = 'virtual',
  Override = 'override',
  Final = 'final',

  // Keywords - C++11+
  Constexpr = 'constexpr',
  Consteval = 'consteval',
  Constinit = 'constinit',
  Static_assert = 'static_assert',

  // Keywords - C++20 modules
  Import = 'import',
  Module = 'module',

  // Keywords - C++20 coroutines
  Co_await = 'co_await',
  Co_return = 'co_return',
  Co_yield = 'co_yield',

  // Operators - Arithmetic
  Plus = '+',
  Minus = '-',
  Star = '*',
  Slash = '/',
  Percent = '%',

  // Operators - Comparison
  EqualEqual = '==',
  NotEqual = '!=',
  Less = '<',
  Greater = '>',
  LessEqual = '<=',
  GreaterEqual = '>=',
  Spaceship = '<=>',

  // Operators - Logical
  Ampersand = '&',
  Pipe = '|',
  Caret = '^',
  Tilde = '~',
  AmpAmp = '&&',
  PipePipe = '||',
  Exclaim = '!',

  // Operators - Shift
  LessLess = '<<',
  GreaterGreater = '>>',

  // Operators - Assignment
  Equal = '=',
  PlusEqual = '+=',
  MinusEqual = '-=',
  StarEqual = '*=',
  SlashEqual = '/=',
  PercentEqual = '%=',
  AmpEqual = '&=',
  PipeEqual = '|=',
  CaretEqual = '^=',
  LessLessEqual = '<<=',
  GreaterGreaterEqual = '>>=',

  // Operators - Increment/Decrement
  PlusPlus = '++',
  MinusMinus = '--',

  // Operators - Member access
  Dot = '.',
  Arrow = '->',
  DotStar = '.*',
  ArrowStar = '->*',

  // Operators - Other
  Question = '?',
  Colon = ':',
  ColonColon = '::',
  Comma = ',',
  Semicolon = ';',
  Ellipsis = '...',

  // Brackets
  LeftParen = '(',
  RightParen = ')',
  LeftBracket = '[',
  RightBracket = ']',
  LeftBrace = '{',
  RightBrace = '}',

  // Preprocessor
  Hash = '#',
  HashHash = '##',

  // Attributes
  LeftAttrBracket = '[[',
  RightAttrBracket = ']]',

  // Digraphs (alternative tokens)
  DiLeftBracket = '<:',    // [
  DiRightBracket = ':>',   // ]
  DiLeftBrace = '<%',      // {
  DiRightBrace = '%>',     // }
  DiHash = '%:',           // #
  DiHashHash = '%:%:',     // ##

  // Microsoft calling conventions (used by Ghidra decompiler)
  CallingConvCdecl = '__cdecl',
  CallingConvStdcall = '__stdcall',
  CallingConvFastcall = '__fastcall',
  CallingConvThiscall = '__thiscall',
  CallingConvVectorcall = '__vectorcall',
  CallingConvClrcall = '__clrcall',
}

export interface Position {
  line: number;    // 1-indexed
  column: number;  // 1-indexed
  offset: number;  // 0-indexed byte offset
}

export interface SourceLocation {
  file: string;
  start: Position;
  end: Position;
}

export interface Token {
  kind: TokenKind;
  text: string;           // Exact text as it appears in source
  location: SourceLocation;
  value?: unknown;        // Parsed value for literals
}

/**
 * Check if a token kind is a keyword
 */
export function isKeyword(kind: TokenKind): boolean {
  return kind >= TokenKind.Auto && kind <= TokenKind.Co_yield;
}

/**
 * Check if a token kind is a literal
 */
export function isLiteral(kind: TokenKind): boolean {
  return (
    kind === TokenKind.IntegerLiteral ||
    kind === TokenKind.FloatingLiteral ||
    kind === TokenKind.CharLiteral ||
    kind === TokenKind.StringLiteral ||
    kind === TokenKind.UserDefinedLiteral
  );
}

/**
 * Check if a token kind is an assignment operator
 */
export function isAssignmentOperator(kind: TokenKind): boolean {
  return (
    kind === TokenKind.Equal ||
    kind === TokenKind.PlusEqual ||
    kind === TokenKind.MinusEqual ||
    kind === TokenKind.StarEqual ||
    kind === TokenKind.SlashEqual ||
    kind === TokenKind.PercentEqual ||
    kind === TokenKind.AmpEqual ||
    kind === TokenKind.PipeEqual ||
    kind === TokenKind.CaretEqual ||
    kind === TokenKind.LessLessEqual ||
    kind === TokenKind.GreaterGreaterEqual
  );
}
