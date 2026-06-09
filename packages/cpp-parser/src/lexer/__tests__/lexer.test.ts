import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Lexer, reconstructSource, TokenKind, TriviaKind } from '../index.js';

describe('Lexer', () => {
  describe('basic tokens', () => {
    it('tokenizes empty input', () => {
      const lexer = new Lexer('');
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens.length, 1);
      assert.strictEqual(tokens[0].kind, TokenKind.EOF);
    });

    it('tokenizes single identifier', () => {
      const lexer = new Lexer('foo');
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens.length, 2);
      assert.strictEqual(tokens[0].kind, TokenKind.Identifier);
      assert.strictEqual(tokens[0].text, 'foo');
    });

    it('tokenizes multiple identifiers', () => {
      const lexer = new Lexer('foo bar baz');
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens.length, 4); // 3 identifiers + EOF
      assert.strictEqual(tokens[0].text, 'foo');
      assert.strictEqual(tokens[1].text, 'bar');
      assert.strictEqual(tokens[2].text, 'baz');
    });
  });

  describe('keywords', () => {
    it('recognizes C++ keywords', () => {
      const lexer = new Lexer('int void return if else while for class struct');
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[0].kind, TokenKind.Int);
      assert.strictEqual(tokens[1].kind, TokenKind.Void);
      assert.strictEqual(tokens[2].kind, TokenKind.Return);
      assert.strictEqual(tokens[3].kind, TokenKind.If);
      assert.strictEqual(tokens[4].kind, TokenKind.Else);
      assert.strictEqual(tokens[5].kind, TokenKind.While);
      assert.strictEqual(tokens[6].kind, TokenKind.For);
      assert.strictEqual(tokens[7].kind, TokenKind.Class);
      assert.strictEqual(tokens[8].kind, TokenKind.Struct);
    });

    it('recognizes modern C++ keywords', () => {
      const lexer = new Lexer('constexpr nullptr auto decltype noexcept override final');
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[0].kind, TokenKind.Constexpr);
      assert.strictEqual(tokens[1].kind, TokenKind.Nullptr);
      assert.strictEqual(tokens[2].kind, TokenKind.Auto);
      assert.strictEqual(tokens[3].kind, TokenKind.Decltype);
      assert.strictEqual(tokens[4].kind, TokenKind.Noexcept);
      assert.strictEqual(tokens[5].kind, TokenKind.Override);
      assert.strictEqual(tokens[6].kind, TokenKind.Final);
    });
  });

  describe('operators', () => {
    it('tokenizes single-char operators', () => {
      const lexer = new Lexer('+ - * / % & | ^ ~ !');
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[0].kind, TokenKind.Plus);
      assert.strictEqual(tokens[1].kind, TokenKind.Minus);
      assert.strictEqual(tokens[2].kind, TokenKind.Star);
      assert.strictEqual(tokens[3].kind, TokenKind.Slash);
      assert.strictEqual(tokens[4].kind, TokenKind.Percent);
      assert.strictEqual(tokens[5].kind, TokenKind.Ampersand);
      assert.strictEqual(tokens[6].kind, TokenKind.Pipe);
      assert.strictEqual(tokens[7].kind, TokenKind.Caret);
      assert.strictEqual(tokens[8].kind, TokenKind.Tilde);
      assert.strictEqual(tokens[9].kind, TokenKind.Exclaim);
    });

    it('tokenizes multi-char operators', () => {
      const lexer = new Lexer('++ -- && || == != <= >= << >> -> :: ...');
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[0].kind, TokenKind.PlusPlus);
      assert.strictEqual(tokens[1].kind, TokenKind.MinusMinus);
      assert.strictEqual(tokens[2].kind, TokenKind.AmpAmp);
      assert.strictEqual(tokens[3].kind, TokenKind.PipePipe);
      assert.strictEqual(tokens[4].kind, TokenKind.EqualEqual);
      assert.strictEqual(tokens[5].kind, TokenKind.NotEqual);
      assert.strictEqual(tokens[6].kind, TokenKind.LessEqual);
      assert.strictEqual(tokens[7].kind, TokenKind.GreaterEqual);
      assert.strictEqual(tokens[8].kind, TokenKind.LessLess);
      assert.strictEqual(tokens[9].kind, TokenKind.GreaterGreater);
      assert.strictEqual(tokens[10].kind, TokenKind.Arrow);
      assert.strictEqual(tokens[11].kind, TokenKind.ColonColon);
      assert.strictEqual(tokens[12].kind, TokenKind.Ellipsis);
    });

    it('tokenizes assignment operators', () => {
      const lexer = new Lexer('= += -= *= /= %= &= |= ^= <<= >>=');
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[0].kind, TokenKind.Equal);
      assert.strictEqual(tokens[1].kind, TokenKind.PlusEqual);
      assert.strictEqual(tokens[2].kind, TokenKind.MinusEqual);
      assert.strictEqual(tokens[3].kind, TokenKind.StarEqual);
      assert.strictEqual(tokens[4].kind, TokenKind.SlashEqual);
      assert.strictEqual(tokens[5].kind, TokenKind.PercentEqual);
      assert.strictEqual(tokens[6].kind, TokenKind.AmpEqual);
      assert.strictEqual(tokens[7].kind, TokenKind.PipeEqual);
      assert.strictEqual(tokens[8].kind, TokenKind.CaretEqual);
      assert.strictEqual(tokens[9].kind, TokenKind.LessLessEqual);
      assert.strictEqual(tokens[10].kind, TokenKind.GreaterGreaterEqual);
    });

    it('tokenizes spaceship operator', () => {
      const lexer = new Lexer('a <=> b');
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[1].kind, TokenKind.Spaceship);
      assert.strictEqual(tokens[1].text, '<=>');
    });

    it('tokenizes member access operators', () => {
      const lexer = new Lexer('. -> .* ->*');
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[0].kind, TokenKind.Dot);
      assert.strictEqual(tokens[1].kind, TokenKind.Arrow);
      assert.strictEqual(tokens[2].kind, TokenKind.DotStar);
      assert.strictEqual(tokens[3].kind, TokenKind.ArrowStar);
    });
  });

  describe('brackets and punctuation', () => {
    it('tokenizes brackets', () => {
      const lexer = new Lexer('(){}[]');
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[0].kind, TokenKind.LeftParen);
      assert.strictEqual(tokens[1].kind, TokenKind.RightParen);
      assert.strictEqual(tokens[2].kind, TokenKind.LeftBrace);
      assert.strictEqual(tokens[3].kind, TokenKind.RightBrace);
      assert.strictEqual(tokens[4].kind, TokenKind.LeftBracket);
      assert.strictEqual(tokens[5].kind, TokenKind.RightBracket);
    });

    it('tokenizes attribute brackets', () => {
      const lexer = new Lexer('[[nodiscard]]');
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[0].kind, TokenKind.LeftAttrBracket);
      assert.strictEqual(tokens[1].kind, TokenKind.Identifier);
      assert.strictEqual(tokens[2].kind, TokenKind.RightAttrBracket);
    });

    it('tokenizes punctuation', () => {
      const lexer = new Lexer('; , : ?');
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[0].kind, TokenKind.Semicolon);
      assert.strictEqual(tokens[1].kind, TokenKind.Comma);
      assert.strictEqual(tokens[2].kind, TokenKind.Colon);
      assert.strictEqual(tokens[3].kind, TokenKind.Question);
    });
  });

  describe('integer literals', () => {
    it('tokenizes decimal integers', () => {
      const lexer = new Lexer('0 42 123456');
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[0].kind, TokenKind.IntegerLiteral);
      assert.strictEqual(tokens[0].text, '0');
      assert.strictEqual(tokens[1].text, '42');
      assert.strictEqual(tokens[2].text, '123456');
    });

    it('tokenizes hex integers', () => {
      const lexer = new Lexer('0x1 0xFF 0xDEADBEEF');
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[0].kind, TokenKind.IntegerLiteral);
      assert.strictEqual(tokens[0].text, '0x1');
      assert.strictEqual(tokens[1].text, '0xFF');
      assert.strictEqual(tokens[2].text, '0xDEADBEEF');
    });

    it('tokenizes binary integers', () => {
      const lexer = new Lexer('0b0 0b1 0b1010');
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[0].kind, TokenKind.IntegerLiteral);
      assert.strictEqual(tokens[0].text, '0b0');
      assert.strictEqual(tokens[1].text, '0b1');
      assert.strictEqual(tokens[2].text, '0b1010');
    });

    it('tokenizes integers with digit separators', () => {
      const lexer = new Lexer("1'000'000 0xFF'FF'FF'FF");
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[0].kind, TokenKind.IntegerLiteral);
      assert.strictEqual(tokens[0].text, "1'000'000");
      assert.strictEqual(tokens[1].text, "0xFF'FF'FF'FF");
    });

    it('tokenizes integers with suffixes', () => {
      const lexer = new Lexer('42u 42l 42ul 42ull 42ULL');
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[0].text, '42u');
      assert.strictEqual(tokens[1].text, '42l');
      assert.strictEqual(tokens[2].text, '42ul');
      assert.strictEqual(tokens[3].text, '42ull');
      assert.strictEqual(tokens[4].text, '42ULL');
    });
  });

  describe('floating literals', () => {
    it('tokenizes floating point numbers', () => {
      const lexer = new Lexer('0.0 3.14 .5 1.');
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[0].kind, TokenKind.FloatingLiteral);
      assert.strictEqual(tokens[0].text, '0.0');
      assert.strictEqual(tokens[1].text, '3.14');
      assert.strictEqual(tokens[2].text, '.5');
      assert.strictEqual(tokens[3].text, '1.');
    });

    it('tokenizes scientific notation', () => {
      const lexer = new Lexer('1e10 1E10 1e+10 1e-10 3.14e2');
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[0].kind, TokenKind.FloatingLiteral);
      assert.strictEqual(tokens[0].text, '1e10');
      assert.strictEqual(tokens[2].text, '1e+10');
      assert.strictEqual(tokens[3].text, '1e-10');
    });

    it('tokenizes floats with suffixes', () => {
      const lexer = new Lexer('1.0f 1.0F 1.0l 1.0L');
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[0].text, '1.0f');
      assert.strictEqual(tokens[1].text, '1.0F');
      assert.strictEqual(tokens[2].text, '1.0l');
      assert.strictEqual(tokens[3].text, '1.0L');
    });
  });

  describe('string literals', () => {
    it('tokenizes simple strings', () => {
      const lexer = new Lexer('"hello" "world"');
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[0].kind, TokenKind.StringLiteral);
      assert.strictEqual(tokens[0].text, '"hello"');
      assert.strictEqual(tokens[1].text, '"world"');
    });

    it('tokenizes strings with escape sequences', () => {
      const lexer = new Lexer('"hello\\nworld" "tab\\there"');
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[0].kind, TokenKind.StringLiteral);
      assert.strictEqual(tokens[0].text, '"hello\\nworld"');
    });

    it('tokenizes prefixed strings', () => {
      const lexer = new Lexer('L"wide" u"utf16" U"utf32" u8"utf8"');
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[0].text, 'L"wide"');
      assert.strictEqual(tokens[1].text, 'u"utf16"');
      assert.strictEqual(tokens[2].text, 'U"utf32"');
      assert.strictEqual(tokens[3].text, 'u8"utf8"');
    });

    it('tokenizes raw strings', () => {
      const lexer = new Lexer('R"(hello\\nworld)"');
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[0].kind, TokenKind.StringLiteral);
      assert.strictEqual(tokens[0].text, 'R"(hello\\nworld)"');
    });

    it('tokenizes raw strings with delimiter', () => {
      const lexer = new Lexer('R"delim(has ) in it)delim"');
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[0].kind, TokenKind.StringLiteral);
      assert.strictEqual(tokens[0].text, 'R"delim(has ) in it)delim"');
    });
  });

  describe('character literals', () => {
    it('tokenizes simple chars', () => {
      const lexer = new Lexer("'a' 'b' 'c'");
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[0].kind, TokenKind.CharLiteral);
      assert.strictEqual(tokens[0].text, "'a'");
      assert.strictEqual(tokens[1].text, "'b'");
    });

    it('tokenizes escape sequences in chars', () => {
      const lexer = new Lexer("'\\n' '\\t' '\\0' '\\''");
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[0].text, "'\\n'");
      assert.strictEqual(tokens[1].text, "'\\t'");
      assert.strictEqual(tokens[2].text, "'\\0'");
      assert.strictEqual(tokens[3].text, "'\\''");
    });

    it('tokenizes prefixed chars', () => {
      const lexer = new Lexer("L'w' u'u' U'U' u8'8'");
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[0].text, "L'w'");
      assert.strictEqual(tokens[1].text, "u'u'");
      assert.strictEqual(tokens[2].text, "U'U'");
      assert.strictEqual(tokens[3].text, "u8'8'");
    });
  });

  describe('user-defined literals', () => {
    it('tokenizes user-defined numeric literals', () => {
      const lexer = new Lexer('123_km 45.6_ms');
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[0].kind, TokenKind.UserDefinedLiteral);
      assert.strictEqual(tokens[0].text, '123_km');
      assert.strictEqual(tokens[1].kind, TokenKind.UserDefinedLiteral);
      assert.strictEqual(tokens[1].text, '45.6_ms');
    });

    it('tokenizes user-defined string literals', () => {
      const lexer = new Lexer('"hello"_s');
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[0].kind, TokenKind.UserDefinedLiteral);
      assert.strictEqual(tokens[0].text, '"hello"_s');
    });
  });

  describe('trivia preservation', () => {
    it('preserves whitespace', () => {
      const lexer = new Lexer('  foo  bar  ');
      const tokens = lexer.tokenizeWithTrivia();
      // Leading spaces before foo
      assert.strictEqual(tokens[0].leadingTrivia.length, 1);
      assert.strictEqual(tokens[0].leadingTrivia[0].kind, TriviaKind.Whitespace);
      assert.strictEqual(tokens[0].leadingTrivia[0].text, '  ');
    });

    it('preserves line comments', () => {
      const lexer = new Lexer('foo // comment\nbar');
      const tokens = lexer.tokenizeWithTrivia();
      // foo has trailing comment
      assert.strictEqual(tokens[0].trailingTrivia.length, 2); // space + comment
      assert.strictEqual(tokens[0].trailingTrivia[1].kind, TriviaKind.LineComment);
      assert.strictEqual(tokens[0].trailingTrivia[1].text, '// comment');
    });

    it('preserves block comments', () => {
      const lexer = new Lexer('foo /* comment */ bar');
      const tokens = lexer.tokenizeWithTrivia();
      // Block comment is trailing trivia for foo or leading for bar
      const hasBlockComment = tokens.some(t =>
        t.leadingTrivia.some(tr => tr.kind === TriviaKind.BlockComment) ||
        t.trailingTrivia.some(tr => tr.kind === TriviaKind.BlockComment)
      );
      assert.ok(hasBlockComment);
    });

    it('preserves newlines', () => {
      const lexer = new Lexer('foo\nbar');
      const tokens = lexer.tokenizeWithTrivia();
      // bar should have newline in leading trivia
      assert.strictEqual(tokens[1].leadingTrivia[0].kind, TriviaKind.Newline);
    });
  });

  describe('source reconstruction', () => {
    it('reconstructs simple source', () => {
      const source = 'int main() {}';
      const lexer = new Lexer(source);
      const tokens = lexer.tokenizeWithTrivia();
      const reconstructed = reconstructSource(tokens);
      assert.strictEqual(reconstructed, source);
    });

    it('reconstructs source with whitespace', () => {
      const source = '  int   main (  )  {  }  ';
      const lexer = new Lexer(source);
      const tokens = lexer.tokenizeWithTrivia();
      const reconstructed = reconstructSource(tokens);
      assert.strictEqual(reconstructed, source);
    });

    it('reconstructs source with comments', () => {
      const source = 'int /* comment */ main() // end\n{}';
      const lexer = new Lexer(source);
      const tokens = lexer.tokenizeWithTrivia();
      const reconstructed = reconstructSource(tokens);
      assert.strictEqual(reconstructed, source);
    });

    it('reconstructs complex source', () => {
      const source = `// Header comment
int foo(int x) {
    // Body comment
    return x + 1; /* inline */
}
`;
      const lexer = new Lexer(source);
      const tokens = lexer.tokenizeWithTrivia();
      const reconstructed = reconstructSource(tokens);
      assert.strictEqual(reconstructed, source);
    });
  });

  describe('digraphs', () => {
    it('tokenizes digraphs', () => {
      const lexer = new Lexer('<: :> <% %>');
      const tokens = lexer.tokenize();
      assert.strictEqual(tokens[0].kind, TokenKind.DiLeftBracket);
      assert.strictEqual(tokens[1].kind, TokenKind.DiRightBracket);
      assert.strictEqual(tokens[2].kind, TokenKind.DiLeftBrace);
      assert.strictEqual(tokens[3].kind, TokenKind.DiRightBrace);
    });
  });

  describe('error handling', () => {
    it('throws on unterminated string', () => {
      const lexer = new Lexer('"unterminated');
      assert.throws(() => lexer.tokenize(), /Unterminated string literal/);
    });

    it('throws on unterminated char', () => {
      const lexer = new Lexer("'x");
      assert.throws(() => lexer.tokenize(), /Unterminated character literal/);
    });

    it('throws on unexpected character', () => {
      const lexer = new Lexer('foo @ bar');
      assert.throws(() => lexer.tokenize(), /Unexpected character/);
    });
  });

  describe('position tracking', () => {
    it('tracks line and column numbers', () => {
      const lexer = new Lexer('foo\nbar\nbaz');
      const tokens = lexer.tokenize();

      assert.strictEqual(tokens[0].location.start.line, 1);
      assert.strictEqual(tokens[0].location.start.column, 1);

      assert.strictEqual(tokens[1].location.start.line, 2);
      assert.strictEqual(tokens[1].location.start.column, 1);

      assert.strictEqual(tokens[2].location.start.line, 3);
      assert.strictEqual(tokens[2].location.start.column, 1);
    });

    it('tracks offsets', () => {
      const lexer = new Lexer('ab cd');
      const tokens = lexer.tokenize();

      assert.strictEqual(tokens[0].location.start.offset, 0);
      assert.strictEqual(tokens[0].location.end.offset, 2);

      assert.strictEqual(tokens[1].location.start.offset, 3);
      assert.strictEqual(tokens[1].location.end.offset, 5);
    });
  });

  describe('real C++ code', () => {
    it('tokenizes a simple function', () => {
      const source = `int add(int a, int b) {
    return a + b;
}`;
      const lexer = new Lexer(source);
      const tokens = lexer.tokenize();

      // int add ( int a , int b ) { return a + b ; }
      const kinds = tokens.slice(0, -1).map(t => t.kind);
      assert.deepStrictEqual(kinds, [
        TokenKind.Int,        // int
        TokenKind.Identifier, // add
        TokenKind.LeftParen,  // (
        TokenKind.Int,        // int
        TokenKind.Identifier, // a
        TokenKind.Comma,      // ,
        TokenKind.Int,        // int
        TokenKind.Identifier, // b
        TokenKind.RightParen, // )
        TokenKind.LeftBrace,  // {
        TokenKind.Return,     // return
        TokenKind.Identifier, // a
        TokenKind.Plus,       // +
        TokenKind.Identifier, // b
        TokenKind.Semicolon,  // ;
        TokenKind.RightBrace, // }
      ]);
    });

    it('tokenizes template syntax', () => {
      const source = 'std::vector<int> v;';
      const lexer = new Lexer(source);
      const tokens = lexer.tokenize();

      const kinds = tokens.slice(0, -1).map(t => t.kind);
      assert.deepStrictEqual(kinds, [
        TokenKind.Identifier,  // std
        TokenKind.ColonColon,  // ::
        TokenKind.Identifier,  // vector
        TokenKind.Less,        // <
        TokenKind.Int,         // int
        TokenKind.Greater,     // >
        TokenKind.Identifier,  // v
        TokenKind.Semicolon,   // ;
      ]);
    });

    it('tokenizes Ghidra-style code', () => {
      const source = `/* 0x00401000 */
void FUN_00401000(int *param_1) {
    *(int *)0x402000 = *param_1;
}`;
      const lexer = new Lexer(source);
      const tokens = lexer.tokenizeWithTrivia();
      const reconstructed = reconstructSource(tokens);
      assert.strictEqual(reconstructed, source);
    });
  });
});
