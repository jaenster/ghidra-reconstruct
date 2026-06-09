/**
 * C++ Lexer with trivia preservation
 * Tokenizes C++ source while preserving all whitespace and comments
 */

import { Token, TokenKind, Position, SourceLocation } from './token.js';
import { Trivia, TriviaKind, TokenWithTrivia } from './trivia.js';
import { KEYWORDS, DIGRAPHS } from './keywords.js';
import {
  parseIntegerLiteral,
  parseFloatingLiteral,
  parseCharLiteral,
  parseStringLiteral,
} from './literals.js';

export interface LexerOptions {
  filename?: string;
  /** If true, attach trivia to tokens */
  preserveTrivia?: boolean;
}

export class LexerError extends Error {
  constructor(
    message: string,
    public readonly location: SourceLocation
  ) {
    super(`${location.file}:${location.start.line}:${location.start.column}: ${message}`);
    this.name = 'LexerError';
  }
}

export class Lexer {
  private source: string;
  private filename: string;
  private pos: number = 0;
  private line: number = 1;
  private column: number = 1;
  private preserveTrivia: boolean;

  constructor(source: string, options: LexerOptions = {}) {
    this.source = source;
    this.filename = options.filename ?? '<input>';
    this.preserveTrivia = options.preserveTrivia ?? true;
  }

  /**
   * Tokenize the entire source, returning tokens with trivia
   */
  tokenizeWithTrivia(): TokenWithTrivia[] {
    const result: TokenWithTrivia[] = [];
    let leadingTrivia: Trivia[] = [];

    while (!this.isAtEnd()) {
      // Collect leading trivia
      leadingTrivia = this.scanTrivia();

      if (this.isAtEnd()) {
        // EOF token with leading trivia
        result.push({
          leadingTrivia,
          token: this.makeToken(TokenKind.EOF, ''),
          trailingTrivia: [],
        });
        break;
      }

      // Scan token
      const token = this.scanToken();

      // Collect trailing trivia (whitespace on same line, until newline)
      const trailingTrivia = this.scanTrailingTrivia();

      result.push({
        leadingTrivia,
        token,
        trailingTrivia,
      });

      leadingTrivia = [];
    }

    if (result.length === 0 || result[result.length - 1].token.kind !== TokenKind.EOF) {
      result.push({
        leadingTrivia,
        token: this.makeToken(TokenKind.EOF, ''),
        trailingTrivia: [],
      });
    }

    return result;
  }

  /**
   * Tokenize without trivia (simpler interface)
   */
  tokenize(): Token[] {
    return this.tokenizeWithTrivia().map(t => t.token);
  }

  /**
   * Get current position
   */
  private getPosition(): Position {
    return {
      line: this.line,
      column: this.column,
      offset: this.pos,
    };
  }

  /**
   * Make a token at current position
   */
  private makeToken(kind: TokenKind, text: string, value?: unknown): Token {
    const start = {
      line: this.line,
      column: this.column - text.length,
      offset: this.pos - text.length,
    };
    const end = this.getPosition();

    return {
      kind,
      text,
      location: { file: this.filename, start, end },
      value,
    };
  }

  /**
   * Check if at end of input
   */
  private isAtEnd(): boolean {
    return this.pos >= this.source.length;
  }

  /**
   * Peek at current character
   */
  private peek(offset: number = 0): string {
    return this.source[this.pos + offset] ?? '\0';
  }

  /**
   * Advance and return current character
   */
  private advance(): string {
    const char = this.source[this.pos++];
    if (char === '\n') {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    return char;
  }

  /**
   * Check if next char matches and advance if so
   */
  private match(expected: string): boolean {
    if (this.isAtEnd() || this.source[this.pos] !== expected) {
      return false;
    }
    this.advance();
    return true;
  }

  /**
   * Scan trivia (whitespace, comments, directives)
   */
  private scanTrivia(): Trivia[] {
    const trivia: Trivia[] = [];

    while (!this.isAtEnd()) {
      const start = this.getPosition();
      const char = this.peek();

      if (char === ' ' || char === '\t') {
        // Whitespace
        let text = '';
        while (!this.isAtEnd() && (this.peek() === ' ' || this.peek() === '\t')) {
          text += this.advance();
        }
        trivia.push({
          kind: TriviaKind.Whitespace,
          text,
          location: { file: this.filename, start, end: this.getPosition() },
        });
      } else if (char === '\n') {
        // Newline
        this.advance();
        trivia.push({
          kind: TriviaKind.Newline,
          text: '\n',
          location: { file: this.filename, start, end: this.getPosition() },
        });
      } else if (char === '\r') {
        // Handle \r\n and \r
        this.advance();
        const text = this.match('\n') ? '\r\n' : '\r';
        trivia.push({
          kind: TriviaKind.Newline,
          text,
          location: { file: this.filename, start, end: this.getPosition() },
        });
      } else if (char === '/' && this.peek(1) === '/') {
        // Line comment
        let text = '';
        while (!this.isAtEnd() && this.peek() !== '\n') {
          text += this.advance();
        }
        trivia.push({
          kind: TriviaKind.LineComment,
          text,
          location: { file: this.filename, start, end: this.getPosition() },
        });
      } else if (char === '/' && this.peek(1) === '*') {
        // Block comment
        let text = this.advance() + this.advance(); // /*
        while (!this.isAtEnd() && !(this.peek() === '*' && this.peek(1) === '/')) {
          text += this.advance();
        }
        if (!this.isAtEnd()) {
          text += this.advance() + this.advance(); // */
        }
        trivia.push({
          kind: TriviaKind.BlockComment,
          text,
          location: { file: this.filename, start, end: this.getPosition() },
        });
      } else if (char === '#' && this.column === 1) {
        // Preprocessor directive (must be at start of line, but we already consumed leading whitespace)
        // Actually, let's handle # at any point for safety
        let text = '';
        while (!this.isAtEnd() && this.peek() !== '\n') {
          // Handle line continuation
          if (this.peek() === '\\' && this.peek(1) === '\n') {
            text += this.advance() + this.advance();
          } else {
            text += this.advance();
          }
        }
        trivia.push({
          kind: TriviaKind.Directive,
          text,
          location: { file: this.filename, start, end: this.getPosition() },
        });
      } else {
        break;
      }
    }

    return trivia;
  }

  /**
   * Scan trailing trivia (same line only, until newline)
   */
  private scanTrailingTrivia(): Trivia[] {
    const trivia: Trivia[] = [];

    while (!this.isAtEnd()) {
      const start = this.getPosition();
      const char = this.peek();

      if (char === ' ' || char === '\t') {
        let text = '';
        while (!this.isAtEnd() && (this.peek() === ' ' || this.peek() === '\t')) {
          text += this.advance();
        }
        trivia.push({
          kind: TriviaKind.Whitespace,
          text,
          location: { file: this.filename, start, end: this.getPosition() },
        });
      } else if (char === '/' && this.peek(1) === '/') {
        // Line comment is trailing trivia
        let text = '';
        while (!this.isAtEnd() && this.peek() !== '\n') {
          text += this.advance();
        }
        trivia.push({
          kind: TriviaKind.LineComment,
          text,
          location: { file: this.filename, start, end: this.getPosition() },
        });
        break; // Newline is leading trivia for next token
      } else if (char === '/' && this.peek(1) === '*') {
        // Block comment on same line
        let text = this.advance() + this.advance();
        while (!this.isAtEnd() && !(this.peek() === '*' && this.peek(1) === '/')) {
          if (this.peek() === '\n') {
            // Block comment crosses lines - stop here
            break;
          }
          text += this.advance();
        }
        if (this.peek() === '*' && this.peek(1) === '/') {
          text += this.advance() + this.advance();
        }
        trivia.push({
          kind: TriviaKind.BlockComment,
          text,
          location: { file: this.filename, start, end: this.getPosition() },
        });
      } else {
        break;
      }
    }

    return trivia;
  }

  /**
   * Scan a single token
   */
  private scanToken(): Token {
    const start = this.getPosition();
    const char = this.advance();

    // Single character tokens
    switch (char) {
      case '(':
        return this.makeToken(TokenKind.LeftParen, char);
      case ')':
        return this.makeToken(TokenKind.RightParen, char);
      case '{':
        return this.makeToken(TokenKind.LeftBrace, char);
      case '}':
        return this.makeToken(TokenKind.RightBrace, char);
      case '[':
        if (this.match('[')) {
          return this.makeToken(TokenKind.LeftAttrBracket, '[[');
        }
        return this.makeToken(TokenKind.LeftBracket, char);
      case ']':
        if (this.match(']')) {
          return this.makeToken(TokenKind.RightAttrBracket, ']]');
        }
        return this.makeToken(TokenKind.RightBracket, char);
      case ';':
        return this.makeToken(TokenKind.Semicolon, char);
      case ',':
        return this.makeToken(TokenKind.Comma, char);
      case '~':
        return this.makeToken(TokenKind.Tilde, char);
      case '?':
        return this.makeToken(TokenKind.Question, char);

      case '+':
        if (this.match('+')) return this.makeToken(TokenKind.PlusPlus, '++');
        if (this.match('=')) return this.makeToken(TokenKind.PlusEqual, '+=');
        return this.makeToken(TokenKind.Plus, char);

      case '-':
        if (this.match('-')) return this.makeToken(TokenKind.MinusMinus, '--');
        if (this.match('=')) return this.makeToken(TokenKind.MinusEqual, '-=');
        if (this.match('>')) {
          if (this.match('*')) return this.makeToken(TokenKind.ArrowStar, '->*');
          return this.makeToken(TokenKind.Arrow, '->');
        }
        return this.makeToken(TokenKind.Minus, char);

      case '*':
        if (this.match('=')) return this.makeToken(TokenKind.StarEqual, '*=');
        return this.makeToken(TokenKind.Star, char);

      case '/':
        if (this.match('=')) return this.makeToken(TokenKind.SlashEqual, '/=');
        return this.makeToken(TokenKind.Slash, char);

      case '%':
        if (this.match('=')) return this.makeToken(TokenKind.PercentEqual, '%=');
        if (this.match('>')) return this.makeToken(TokenKind.DiRightBrace, '%>');
        if (this.match(':')) {
          if (this.match('%') && this.match(':')) {
            return this.makeToken(TokenKind.DiHashHash, '%:%:');
          }
          return this.makeToken(TokenKind.DiHash, '%:');
        }
        return this.makeToken(TokenKind.Percent, char);

      case '&':
        if (this.match('&')) return this.makeToken(TokenKind.AmpAmp, '&&');
        if (this.match('=')) return this.makeToken(TokenKind.AmpEqual, '&=');
        return this.makeToken(TokenKind.Ampersand, char);

      case '|':
        if (this.match('|')) return this.makeToken(TokenKind.PipePipe, '||');
        if (this.match('=')) return this.makeToken(TokenKind.PipeEqual, '|=');
        return this.makeToken(TokenKind.Pipe, char);

      case '^':
        if (this.match('=')) return this.makeToken(TokenKind.CaretEqual, '^=');
        return this.makeToken(TokenKind.Caret, char);

      case '!':
        if (this.match('=')) return this.makeToken(TokenKind.NotEqual, '!=');
        return this.makeToken(TokenKind.Exclaim, char);

      case '=':
        if (this.match('=')) return this.makeToken(TokenKind.EqualEqual, '==');
        return this.makeToken(TokenKind.Equal, char);

      case '<':
        if (this.match('<')) {
          if (this.match('=')) return this.makeToken(TokenKind.LessLessEqual, '<<=');
          return this.makeToken(TokenKind.LessLess, '<<');
        }
        if (this.match('=')) {
          if (this.match('>')) return this.makeToken(TokenKind.Spaceship, '<=>');
          return this.makeToken(TokenKind.LessEqual, '<=');
        }
        if (this.match(':')) return this.makeToken(TokenKind.DiLeftBracket, '<:');
        if (this.match('%')) return this.makeToken(TokenKind.DiLeftBrace, '<%');
        return this.makeToken(TokenKind.Less, char);

      case '>':
        if (this.match('>')) {
          if (this.match('=')) return this.makeToken(TokenKind.GreaterGreaterEqual, '>>=');
          return this.makeToken(TokenKind.GreaterGreater, '>>');
        }
        if (this.match('=')) return this.makeToken(TokenKind.GreaterEqual, '>=');
        return this.makeToken(TokenKind.Greater, char);

      case ':':
        if (this.match(':')) return this.makeToken(TokenKind.ColonColon, '::');
        if (this.match('>')) return this.makeToken(TokenKind.DiRightBracket, ':>');
        return this.makeToken(TokenKind.Colon, char);

      case '.':
        if (this.match('.')) {
          if (this.match('.')) return this.makeToken(TokenKind.Ellipsis, '...');
          // Back up - this is an error or two dots
          this.pos--;
          this.column--;
        }
        if (this.match('*')) return this.makeToken(TokenKind.DotStar, '.*');
        // Check for floating literal starting with .
        if (this.isDigit(this.peek())) {
          return this.scanNumericLiteral(char);
        }
        return this.makeToken(TokenKind.Dot, char);

      case '#':
        if (this.match('#')) return this.makeToken(TokenKind.HashHash, '##');
        return this.makeToken(TokenKind.Hash, char);

      case '"':
        return this.scanStringLiteral('', true);

      case "'":
        return this.scanCharLiteral('', true);

      default:
        // Numbers
        if (this.isDigit(char)) {
          return this.scanNumericLiteral(char);
        }

        // Identifiers and keywords
        if (this.isIdentifierStart(char)) {
          return this.scanIdentifier(char);
        }

        throw new LexerError(`Unexpected character: '${char}'`, {
          file: this.filename,
          start,
          end: this.getPosition(),
        });
    }
  }

  /**
   * Scan a numeric literal (integer or floating)
   */
  private scanNumericLiteral(first: string): Token {
    let text = first;
    let isFloat = first === '.';
    let hasExponent = false;

    // Check for hex, binary, or octal prefix
    if (first === '0' && (this.peek() === 'x' || this.peek() === 'X')) {
      text += this.advance(); // x
      while (this.isHexDigit(this.peek()) || this.peek() === "'") {
        text += this.advance();
      }
      // Check for hex float
      if (this.peek() === '.') {
        isFloat = true;
        text += this.advance();
        while (this.isHexDigit(this.peek()) || this.peek() === "'") {
          text += this.advance();
        }
      }
      if (this.peek() === 'p' || this.peek() === 'P') {
        isFloat = true;
        hasExponent = true;
        text += this.advance();
        if (this.peek() === '+' || this.peek() === '-') {
          text += this.advance();
        }
        while (this.isDigit(this.peek()) || this.peek() === "'") {
          text += this.advance();
        }
      }
    } else if (first === '0' && (this.peek() === 'b' || this.peek() === 'B')) {
      text += this.advance(); // b
      while (this.peek() === '0' || this.peek() === '1' || this.peek() === "'") {
        text += this.advance();
      }
    } else {
      // Decimal or octal
      while (this.isDigit(this.peek()) || this.peek() === "'") {
        text += this.advance();
      }

      // Decimal point
      if (this.peek() === '.' && this.peek(1) !== '.') {
        isFloat = true;
        text += this.advance();
        while (this.isDigit(this.peek()) || this.peek() === "'") {
          text += this.advance();
        }
      }

      // Exponent
      if (this.peek() === 'e' || this.peek() === 'E') {
        isFloat = true;
        hasExponent = true;
        text += this.advance();
        if (this.peek() === '+' || this.peek() === '-') {
          text += this.advance();
        }
        while (this.isDigit(this.peek()) || this.peek() === "'") {
          text += this.advance();
        }
      }
    }

    // Suffix (u, l, ul, ull, f, etc.)
    while (this.isIdentifierChar(this.peek())) {
      const suffix = this.peek().toLowerCase();
      if ('ulULfF'.includes(this.peek())) {
        text += this.advance();
      } else if (this.isIdentifierStart(this.peek())) {
        // User-defined literal suffix
        while (this.isIdentifierChar(this.peek())) {
          text += this.advance();
        }
        // This is a user-defined literal
        return this.makeToken(TokenKind.UserDefinedLiteral, text);
      } else {
        break;
      }
    }

    if (isFloat) {
      const value = parseFloatingLiteral(text);
      return this.makeToken(TokenKind.FloatingLiteral, text, value);
    } else {
      const value = parseIntegerLiteral(text);
      return this.makeToken(TokenKind.IntegerLiteral, text, value);
    }
  }

  /**
   * Scan an identifier or keyword
   */
  private scanIdentifier(first: string): Token {
    let text = first;

    while (this.isIdentifierChar(this.peek())) {
      text += this.advance();
    }

    // Check for string/char literal prefixes
    if ((text === 'u8' || text === 'u' || text === 'U' || text === 'L' || text === 'R') && this.peek() === '"') {
      return this.scanStringLiteral(text);
    }
    if ((text === 'u8' || text === 'u' || text === 'U' || text === 'L') && this.peek() === "'") {
      return this.scanCharLiteral(text);
    }
    // Raw string with prefix
    if ((text === 'u8R' || text === 'uR' || text === 'UR' || text === 'LR') && this.peek() === '"') {
      return this.scanStringLiteral(text);
    }

    // Check if it's a keyword
    const keyword = KEYWORDS.get(text);
    if (keyword !== undefined) {
      return this.makeToken(keyword, text);
    }

    return this.makeToken(TokenKind.Identifier, text);
  }

  /**
   * Scan a string literal
   * @param prefix - The prefix (like u8, L, R) before the opening quote
   * @param quoteConsumed - If true, the opening " was already consumed
   */
  private scanStringLiteral(prefix: string, quoteConsumed: boolean = false): Token {
    let text = prefix;
    const isRaw = prefix.endsWith('R');

    if (quoteConsumed) {
      text += '"';
    } else {
      text += this.advance(); // Opening "
    }

    if (isRaw) {
      // Raw string R"delimiter(content)delimiter"
      let delimiter = '';
      while (this.peek() !== '(' && !this.isAtEnd()) {
        delimiter += this.advance();
        text = prefix + '"' + delimiter;
      }
      if (this.isAtEnd()) {
        throw new LexerError('Unterminated raw string literal', {
          file: this.filename,
          start: { line: this.line, column: this.column - text.length, offset: this.pos - text.length },
          end: this.getPosition(),
        });
      }
      text += this.advance(); // (

      const endMarker = ')' + delimiter + '"';
      while (!this.isAtEnd()) {
        if (this.source.substring(this.pos, this.pos + endMarker.length) === endMarker) {
          for (let i = 0; i < endMarker.length; i++) {
            text += this.advance();
          }
          break;
        }
        text += this.advance();
      }
    } else {
      // Regular string
      while (!this.isAtEnd() && this.peek() !== '"') {
        if (this.peek() === '\\') {
          text += this.advance(); // Backslash
          if (!this.isAtEnd()) {
            text += this.advance(); // Escaped char
          }
        } else if (this.peek() === '\n') {
          throw new LexerError('Unterminated string literal', {
            file: this.filename,
            start: { line: this.line, column: this.column - text.length, offset: this.pos - text.length },
            end: this.getPosition(),
          });
        } else {
          text += this.advance();
        }
      }

      if (this.isAtEnd()) {
        throw new LexerError('Unterminated string literal', {
          file: this.filename,
          start: { line: this.line, column: this.column - text.length, offset: this.pos - text.length },
          end: this.getPosition(),
        });
      }

      text += this.advance(); // Closing "
    }

    // Check for user-defined literal suffix
    if (this.peek() === '_' || this.isIdentifierStart(this.peek())) {
      while (this.isIdentifierChar(this.peek())) {
        text += this.advance();
      }
      return this.makeToken(TokenKind.UserDefinedLiteral, text);
    }

    const value = parseStringLiteral(text);
    return this.makeToken(TokenKind.StringLiteral, text, value);
  }

  /**
   * Scan a character literal
   * @param prefix - The prefix (like u8, L) before the opening quote
   * @param quoteConsumed - If true, the opening ' was already consumed
   */
  private scanCharLiteral(prefix: string, quoteConsumed: boolean = false): Token {
    let text = prefix;
    if (quoteConsumed) {
      text += "'";
    } else {
      text += this.advance(); // Opening '
    }

    while (!this.isAtEnd() && this.peek() !== "'") {
      if (this.peek() === '\\') {
        text += this.advance();
        if (!this.isAtEnd()) {
          text += this.advance();
        }
      } else if (this.peek() === '\n') {
        throw new LexerError('Unterminated character literal', {
          file: this.filename,
          start: { line: this.line, column: this.column - text.length, offset: this.pos - text.length },
          end: this.getPosition(),
        });
      } else {
        text += this.advance();
      }
    }

    if (this.isAtEnd()) {
      throw new LexerError('Unterminated character literal', {
        file: this.filename,
        start: { line: this.line, column: this.column - text.length, offset: this.pos - text.length },
        end: this.getPosition(),
      });
    }

    text += this.advance(); // Closing '

    // Check for user-defined literal suffix
    if (this.peek() === '_' || this.isIdentifierStart(this.peek())) {
      while (this.isIdentifierChar(this.peek())) {
        text += this.advance();
      }
      return this.makeToken(TokenKind.UserDefinedLiteral, text);
    }

    const value = parseCharLiteral(text);
    return this.makeToken(TokenKind.CharLiteral, text, value);
  }

  /**
   * Character classification helpers
   */
  private isDigit(char: string): boolean {
    return char >= '0' && char <= '9';
  }

  private isHexDigit(char: string): boolean {
    return this.isDigit(char) || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F');
  }

  private isIdentifierStart(char: string): boolean {
    return (char >= 'a' && char <= 'z') ||
           (char >= 'A' && char <= 'Z') ||
           char === '_';
  }

  private isIdentifierChar(char: string): boolean {
    return this.isIdentifierStart(char) || this.isDigit(char);
  }
}

/**
 * Reconstruct source from tokens with trivia
 */
export function reconstructSource(tokens: TokenWithTrivia[]): string {
  let result = '';
  for (const { leadingTrivia, token, trailingTrivia } of tokens) {
    for (const trivia of leadingTrivia) {
      result += trivia.text;
    }
    result += token.text;
    for (const trivia of trailingTrivia) {
      result += trivia.text;
    }
  }
  return result;
}
