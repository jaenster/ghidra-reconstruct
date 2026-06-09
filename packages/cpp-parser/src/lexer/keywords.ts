/**
 * C++ Keywords Map
 * Maps keyword strings to their token kinds
 */

import { TokenKind } from './token.js';

/**
 * Map of all C++ keywords to their TokenKind
 */
export const KEYWORDS: ReadonlyMap<string, TokenKind> = new Map([
  // Storage class specifiers
  ['auto', TokenKind.Auto],
  ['register', TokenKind.Register],
  ['static', TokenKind.Static],
  ['extern', TokenKind.Extern],
  ['mutable', TokenKind.Mutable],
  ['thread_local', TokenKind.ThreadLocal],

  // Type specifiers
  ['void', TokenKind.Void],
  ['bool', TokenKind.Bool],
  ['char', TokenKind.Char],
  ['char8_t', TokenKind.Char8_t],
  ['char16_t', TokenKind.Char16_t],
  ['char32_t', TokenKind.Char32_t],
  ['wchar_t', TokenKind.Wchar_t],
  ['short', TokenKind.Short],
  ['int', TokenKind.Int],
  ['long', TokenKind.Long],
  ['signed', TokenKind.Signed],
  ['unsigned', TokenKind.Unsigned],
  ['float', TokenKind.Float],
  ['double', TokenKind.Double],

  // Type qualifiers
  ['const', TokenKind.Const],
  ['volatile', TokenKind.Volatile],
  ['restrict', TokenKind.Restrict],

  // Class/struct/union/enum
  ['class', TokenKind.Class],
  ['struct', TokenKind.Struct],
  ['union', TokenKind.Union],
  ['enum', TokenKind.Enum],

  // Access specifiers
  ['public', TokenKind.Public],
  ['private', TokenKind.Private],
  ['protected', TokenKind.Protected],

  // Control flow
  ['if', TokenKind.If],
  ['else', TokenKind.Else],
  ['switch', TokenKind.Switch],
  ['case', TokenKind.Case],
  ['default', TokenKind.Default],
  ['while', TokenKind.While],
  ['do', TokenKind.Do],
  ['for', TokenKind.For],
  ['break', TokenKind.Break],
  ['continue', TokenKind.Continue],
  ['return', TokenKind.Return],
  ['goto', TokenKind.Goto],

  // Exception handling
  ['try', TokenKind.Try],
  ['catch', TokenKind.Catch],
  ['throw', TokenKind.Throw],
  ['noexcept', TokenKind.Noexcept],

  // Operators and expressions
  ['sizeof', TokenKind.Sizeof],
  ['alignof', TokenKind.Alignof],
  ['alignas', TokenKind.Alignas],
  ['decltype', TokenKind.Decltype],
  ['typeid', TokenKind.Typeid],
  ['new', TokenKind.New],
  ['delete', TokenKind.Delete],
  ['this', TokenKind.This],
  ['nullptr', TokenKind.Nullptr],
  ['true', TokenKind.True],
  ['false', TokenKind.False],

  // Templates
  ['template', TokenKind.Template],
  ['typename', TokenKind.Typename],
  ['concept', TokenKind.Concept],
  ['requires', TokenKind.Requires],

  // Namespaces
  ['namespace', TokenKind.Namespace],
  ['using', TokenKind.Using],

  // Type casting
  ['const_cast', TokenKind.Const_cast],
  ['dynamic_cast', TokenKind.Dynamic_cast],
  ['reinterpret_cast', TokenKind.Reinterpret_cast],
  ['static_cast', TokenKind.Static_cast],

  // Other
  ['asm', TokenKind.Asm],
  ['explicit', TokenKind.Explicit],
  ['export', TokenKind.Export],
  ['friend', TokenKind.Friend],
  ['inline', TokenKind.Inline],
  ['operator', TokenKind.Operator],
  ['typedef', TokenKind.Typedef],
  ['virtual', TokenKind.Virtual],
  ['override', TokenKind.Override],
  ['final', TokenKind.Final],

  // C++11+
  ['constexpr', TokenKind.Constexpr],
  ['consteval', TokenKind.Consteval],
  ['constinit', TokenKind.Constinit],
  ['static_assert', TokenKind.Static_assert],

  // C++20 modules
  ['import', TokenKind.Import],
  ['module', TokenKind.Module],

  // C++20 coroutines
  ['co_await', TokenKind.Co_await],
  ['co_return', TokenKind.Co_return],
  ['co_yield', TokenKind.Co_yield],

  // Microsoft calling conventions (used by Ghidra)
  ['__cdecl', TokenKind.CallingConvCdecl],
  ['__stdcall', TokenKind.CallingConvStdcall],
  ['__fastcall', TokenKind.CallingConvFastcall],
  ['__thiscall', TokenKind.CallingConvThiscall],
  ['__vectorcall', TokenKind.CallingConvVectorcall],
  ['__clrcall', TokenKind.CallingConvClrcall],
]);

/**
 * Check if a string is a C++ keyword
 */
export function isKeywordString(text: string): boolean {
  return KEYWORDS.has(text);
}

/**
 * Get the TokenKind for a keyword string, or undefined if not a keyword
 */
export function getKeywordKind(text: string): TokenKind | undefined {
  return KEYWORDS.get(text);
}

/**
 * Alternative tokens (digraphs) - maps digraph to equivalent token
 */
export const DIGRAPHS: ReadonlyMap<string, TokenKind> = new Map([
  ['<:', TokenKind.DiLeftBracket],   // [
  [':>', TokenKind.DiRightBracket],  // ]
  ['<%', TokenKind.DiLeftBrace],     // {
  ['%>', TokenKind.DiRightBrace],    // }
  ['%:', TokenKind.DiHash],          // #
  ['%:%:', TokenKind.DiHashHash],    // ##
]);

/**
 * Get the canonical token kind for a digraph
 */
export function getDigraphCanonical(kind: TokenKind): TokenKind {
  switch (kind) {
    case TokenKind.DiLeftBracket:
      return TokenKind.LeftBracket;
    case TokenKind.DiRightBracket:
      return TokenKind.RightBracket;
    case TokenKind.DiLeftBrace:
      return TokenKind.LeftBrace;
    case TokenKind.DiRightBrace:
      return TokenKind.RightBrace;
    case TokenKind.DiHash:
      return TokenKind.Hash;
    case TokenKind.DiHashHash:
      return TokenKind.HashHash;
    default:
      return kind;
  }
}
