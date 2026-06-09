/**
 * Literal parsing utilities
 * Handles numeric, string, and character literals
 */

export interface IntegerLiteralValue {
  type: 'integer';
  value: bigint;
  suffix: string;    // '', 'u', 'l', 'ul', 'll', 'ull', etc.
  base: 2 | 8 | 10 | 16;
}

export interface FloatingLiteralValue {
  type: 'floating';
  value: number;
  suffix: string;    // '', 'f', 'l'
}

export interface CharLiteralValue {
  type: 'char';
  value: number;     // Character code
  prefix: string;    // '', 'u8', 'u', 'U', 'L'
}

export interface StringLiteralValue {
  type: 'string';
  value: string;     // Decoded string
  prefix: string;    // '', 'u8', 'u', 'U', 'L', 'R', etc.
  isRaw: boolean;
}

export interface UserDefinedLiteralValue {
  type: 'user_defined';
  base: IntegerLiteralValue | FloatingLiteralValue | CharLiteralValue | StringLiteralValue;
  udSuffix: string;  // User-defined suffix like _km, _s, etc.
}

export type LiteralValue =
  | IntegerLiteralValue
  | FloatingLiteralValue
  | CharLiteralValue
  | StringLiteralValue
  | UserDefinedLiteralValue;

/**
 * Parse an integer literal
 */
export function parseIntegerLiteral(text: string): IntegerLiteralValue {
  let remaining = text;
  let base: 2 | 8 | 10 | 16 = 10;

  // Determine base
  if (remaining.startsWith('0x') || remaining.startsWith('0X')) {
    base = 16;
    remaining = remaining.slice(2);
  } else if (remaining.startsWith('0b') || remaining.startsWith('0B')) {
    base = 2;
    remaining = remaining.slice(2);
  } else if (remaining.startsWith('0') && remaining.length > 1 && /[0-7]/.test(remaining[1])) {
    base = 8;
    remaining = remaining.slice(1);
  }

  // Remove digit separators
  remaining = remaining.replace(/'/g, '');

  // Find where digits end and suffix begins
  let digitEnd = 0;
  const digitRegex = base === 16 ? /[0-9a-fA-F]/ :
                     base === 2 ? /[01]/ :
                     base === 8 ? /[0-7]/ :
                     /[0-9]/;

  while (digitEnd < remaining.length && digitRegex.test(remaining[digitEnd])) {
    digitEnd++;
  }

  const digits = remaining.slice(0, digitEnd);
  const suffix = remaining.slice(digitEnd).toLowerCase();

  return {
    type: 'integer',
    value: BigInt(base === 10 ? digits : `0${base === 16 ? 'x' : base === 2 ? 'b' : 'o'}${digits}`),
    suffix,
    base,
  };
}

/**
 * Parse a floating-point literal
 */
export function parseFloatingLiteral(text: string): FloatingLiteralValue {
  let remaining = text.replace(/'/g, ''); // Remove digit separators

  // Find suffix
  let suffix = '';
  if (remaining.endsWith('f') || remaining.endsWith('F')) {
    suffix = 'f';
    remaining = remaining.slice(0, -1);
  } else if (remaining.endsWith('l') || remaining.endsWith('L')) {
    suffix = 'l';
    remaining = remaining.slice(0, -1);
  }

  return {
    type: 'floating',
    value: parseFloat(remaining),
    suffix,
  };
}

/**
 * Escape sequence map
 */
const ESCAPE_SEQUENCES: Record<string, number> = {
  'a': 0x07,   // Alert (bell)
  'b': 0x08,   // Backspace
  'f': 0x0C,   // Form feed
  'n': 0x0A,   // Newline
  'r': 0x0D,   // Carriage return
  't': 0x09,   // Horizontal tab
  'v': 0x0B,   // Vertical tab
  '\\': 0x5C,  // Backslash
  "'": 0x27,   // Single quote
  '"': 0x22,   // Double quote
  '?': 0x3F,   // Question mark
  '0': 0x00,   // Null
};

/**
 * Parse an escape sequence and return the character code
 */
export function parseEscapeSequence(text: string, index: number): { value: number; length: number } {
  if (text[index] !== '\\') {
    return { value: text.charCodeAt(index), length: 1 };
  }

  const next = text[index + 1];

  // Simple escape sequences
  if (next in ESCAPE_SEQUENCES) {
    return { value: ESCAPE_SEQUENCES[next], length: 2 };
  }

  // Octal escape: \nnn
  if (/[0-7]/.test(next)) {
    let octal = '';
    let i = index + 1;
    while (i < text.length && i < index + 4 && /[0-7]/.test(text[i])) {
      octal += text[i];
      i++;
    }
    return { value: parseInt(octal, 8), length: 1 + octal.length };
  }

  // Hex escape: \xnn
  if (next === 'x') {
    let hex = '';
    let i = index + 2;
    while (i < text.length && /[0-9a-fA-F]/.test(text[i])) {
      hex += text[i];
      i++;
    }
    return { value: parseInt(hex, 16), length: 2 + hex.length };
  }

  // Universal character names: \uXXXX or \UXXXXXXXX
  if (next === 'u') {
    const hex = text.slice(index + 2, index + 6);
    return { value: parseInt(hex, 16), length: 6 };
  }
  if (next === 'U') {
    const hex = text.slice(index + 2, index + 10);
    return { value: parseInt(hex, 16), length: 10 };
  }

  // Unknown escape - return as-is
  return { value: next.charCodeAt(0), length: 2 };
}

/**
 * Parse a character literal
 */
export function parseCharLiteral(text: string): CharLiteralValue {
  let prefix = '';
  let remaining = text;

  // Extract prefix
  if (remaining.startsWith('u8')) {
    prefix = 'u8';
    remaining = remaining.slice(2);
  } else if (remaining.startsWith('u') || remaining.startsWith('U') || remaining.startsWith('L')) {
    prefix = remaining[0];
    remaining = remaining.slice(1);
  }

  // Remove quotes
  remaining = remaining.slice(1, -1);

  // Parse escape sequence or character
  const { value } = parseEscapeSequence(remaining, 0);

  return {
    type: 'char',
    value,
    prefix,
  };
}

/**
 * Parse a string literal
 */
export function parseStringLiteral(text: string): StringLiteralValue {
  let prefix = '';
  let remaining = text;
  let isRaw = false;

  // Extract prefix (order matters - check longer prefixes first)
  const prefixes = ['u8R', 'uR', 'UR', 'LR', 'R', 'u8', 'u', 'U', 'L'];
  for (const p of prefixes) {
    if (remaining.startsWith(p)) {
      prefix = p;
      remaining = remaining.slice(p.length);
      isRaw = p.endsWith('R');
      break;
    }
  }

  if (isRaw) {
    // Raw string: R"delimiter(content)delimiter"
    const match = remaining.match(/^"([^(]*)\(([\s\S]*)\)\1"$/);
    if (match) {
      return {
        type: 'string',
        value: match[2],
        prefix,
        isRaw: true,
      };
    }
  }

  // Regular string - remove quotes and decode escapes
  remaining = remaining.slice(1, -1);

  let value = '';
  let i = 0;
  while (i < remaining.length) {
    const { value: charCode, length } = parseEscapeSequence(remaining, i);
    value += String.fromCodePoint(charCode);
    i += length;
  }

  return {
    type: 'string',
    value,
    prefix,
    isRaw: false,
  };
}

/**
 * Check if text looks like an integer literal
 */
export function isIntegerLiteral(text: string): boolean {
  return /^(?:0[xX][0-9a-fA-F']+|0[bB][01']+|0[0-7']*|[1-9][0-9']*)(?:[uUlL]{0,3})?$/.test(text);
}

/**
 * Check if text looks like a floating literal
 */
export function isFloatingLiteral(text: string): boolean {
  return /^(?:[0-9']*\.[0-9']+|[0-9']+\.?)[eE][+-]?[0-9']+[fFlL]?$/.test(text) ||
         /^[0-9']*\.[0-9']+[fFlL]?$/.test(text) ||
         /^[0-9']+\.[fFlL]?$/.test(text);
}

/**
 * Check if text looks like a character literal
 */
export function isCharLiteral(text: string): boolean {
  return /^(?:u8|[uUL])?'(?:[^'\\]|\\.)*'$/.test(text);
}

/**
 * Check if text looks like a string literal
 */
export function isStringLiteral(text: string): boolean {
  // Regular string
  if (/^(?:u8|[uUL])?"(?:[^"\\]|\\.)*"$/.test(text)) return true;
  // Raw string
  if (/^(?:u8|[uUL])?R"[^(]*\([\s\S]*\)[^"]*"$/.test(text)) return true;
  return false;
}
