/**
 * Code Emitter Style Configuration
 * Configurable formatting options for C++ code emission
 */

/**
 * Brace style for compound statements
 */
export type BraceStyle =
  | 'allman'      // Braces on new line
  | 'k&r'         // Opening brace on same line, closing on new line
  | 'stroustrup'; // K&R with cuddled else

/**
 * Formatting options for the emitter
 */
export interface EmitStyle {
  /** Use tabs for indentation instead of spaces */
  useTabs: boolean;

  /** Number of spaces per indent level (ignored if useTabs is true) */
  indentWidth: number;

  /** Brace placement style */
  braceStyle: BraceStyle;

  /** Add space after keywords (if, for, while, etc.) */
  spaceAfterKeyword: boolean;

  /** Add space before opening parenthesis in function calls */
  spaceBeforeFunctionParen: boolean;

  /** Add space inside parentheses */
  spaceInsideParens: boolean;

  /** Add space around binary operators */
  spaceAroundOperators: boolean;

  /** Add space after commas */
  spaceAfterComma: boolean;

  /** Add space before colons in inheritance lists */
  spaceBeforeColon: boolean;

  /** Add space after colons in inheritance lists */
  spaceAfterColon: boolean;

  /** Maximum line width (0 = no limit) */
  maxLineWidth: number;

  /** Add blank line between function definitions */
  blankLineBetweenFunctions: boolean;

  /** Add blank line between class members of different access levels */
  blankLineAfterAccessSpecifier: boolean;

  /** Pointer/reference alignment: 'left' (int* x), 'right' (int *x), or 'middle' (int * x) */
  pointerAlignment: 'left' | 'right' | 'middle';

  /** Always use braces for single-statement if/for/while bodies */
  alwaysUseBraces: boolean;

  /** Line ending style */
  lineEnding: '\n' | '\r\n';
}

/**
 * Default style - similar to LLVM/Clang format
 */
export const DEFAULT_STYLE: EmitStyle = {
  useTabs: false,
  indentWidth: 2,
  braceStyle: 'k&r',
  spaceAfterKeyword: true,
  spaceBeforeFunctionParen: false,
  spaceInsideParens: false,
  spaceAroundOperators: true,
  spaceAfterComma: true,
  spaceBeforeColon: true,
  spaceAfterColon: true,
  maxLineWidth: 0,
  blankLineBetweenFunctions: true,
  blankLineAfterAccessSpecifier: false,
  pointerAlignment: 'left',
  alwaysUseBraces: false,
  lineEnding: '\n',
};

/**
 * Google C++ Style Guide format
 */
export const GOOGLE_STYLE: EmitStyle = {
  useTabs: false,
  indentWidth: 2,
  braceStyle: 'k&r',
  spaceAfterKeyword: true,
  spaceBeforeFunctionParen: false,
  spaceInsideParens: false,
  spaceAroundOperators: true,
  spaceAfterComma: true,
  spaceBeforeColon: true,
  spaceAfterColon: true,
  maxLineWidth: 80,
  blankLineBetweenFunctions: true,
  blankLineAfterAccessSpecifier: false,
  pointerAlignment: 'left',
  alwaysUseBraces: false,
  lineEnding: '\n',
};

/**
 * LLVM/Clang format style
 */
export const LLVM_STYLE: EmitStyle = {
  useTabs: false,
  indentWidth: 2,
  braceStyle: 'k&r',
  spaceAfterKeyword: true,
  spaceBeforeFunctionParen: false,
  spaceInsideParens: false,
  spaceAroundOperators: true,
  spaceAfterComma: true,
  spaceBeforeColon: true,
  spaceAfterColon: true,
  maxLineWidth: 80,
  blankLineBetweenFunctions: true,
  blankLineAfterAccessSpecifier: false,
  pointerAlignment: 'right',
  alwaysUseBraces: false,
  lineEnding: '\n',
};

/**
 * GNU style format
 */
export const GNU_STYLE: EmitStyle = {
  useTabs: false,
  indentWidth: 2,
  braceStyle: 'allman',
  spaceAfterKeyword: true,
  spaceBeforeFunctionParen: true,
  spaceInsideParens: false,
  spaceAroundOperators: true,
  spaceAfterComma: true,
  spaceBeforeColon: true,
  spaceAfterColon: true,
  maxLineWidth: 79,
  blankLineBetweenFunctions: true,
  blankLineAfterAccessSpecifier: false,
  pointerAlignment: 'middle',
  alwaysUseBraces: false,
  lineEnding: '\n',
};

/**
 * Microsoft style format
 */
export const MICROSOFT_STYLE: EmitStyle = {
  useTabs: false,
  indentWidth: 4,
  braceStyle: 'allman',
  spaceAfterKeyword: true,
  spaceBeforeFunctionParen: false,
  spaceInsideParens: false,
  spaceAroundOperators: true,
  spaceAfterComma: true,
  spaceBeforeColon: true,
  spaceAfterColon: true,
  maxLineWidth: 0,
  blankLineBetweenFunctions: true,
  blankLineAfterAccessSpecifier: true,
  pointerAlignment: 'left',
  alwaysUseBraces: true,
  lineEnding: '\r\n',
};

/**
 * Create a custom style by merging with defaults
 */
export function createStyle(overrides: Partial<EmitStyle>): EmitStyle {
  return { ...DEFAULT_STYLE, ...overrides };
}
