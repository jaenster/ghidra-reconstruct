/**
 * C++ Recursive Descent Parser
 * Parses C++ source into AST nodes
 */

import {
  Lexer,
  Token,
  TokenKind,
  TokenWithTrivia,
  reconstructSource,
} from '../lexer/index.js';
import type { Trivia } from '../lexer/trivia.js';
import type { SourceLocation } from '../lexer/token.js';
import {
  NodeKind,
  type TranslationUnit,
  type Declaration,
  type Statement,
  type Expression,
  type TypeNode,
  type FunctionDecl,
  type VariableDecl,
  type ParameterDecl,
  type ClassDecl,
  type StructDecl,
  type EnumDecl,
  type EnumeratorDecl,
  type NamespaceDecl,
  type TypedefDecl,
  type CompoundStmt,
  type ExprStmt,
  type IfStmt,
  type WhileStmt,
  type DoWhileStmt,
  type ForStmt,
  type ReturnStmt,
  type BreakStmt,
  type ContinueStmt,
  type NullStmt,
  type SwitchStmt,
  type CaseStmt,
  type DefaultStmt,
  type GotoStmt,
  type LabelStmt,
  type Identifier,
  type QualifiedId,
  type BinaryExpr,
  type UnaryExpr,
  type PostfixExpr,
  type CallExpr,
  type MemberExpr,
  type SubscriptExpr,
  type AssignExpr,
  type ConditionalExpr,
  type CStyleCastExpr,
  type ParenExpr,
  type InitListExpr,
  type IntegerLiteralExpr,
  type FloatingLiteralExpr,
  type StringLiteralExpr,
  type CharLiteralExpr,
  type BoolLiteralExpr,
  type NullptrLiteralExpr,
  type SizeofExpr,
  type BuiltinType,
  type PointerType,
  type ReferenceType,
  type ArrayType,
  type QualifiedType,
  type TemplateType,
  type TypeTemplateArg,
  type ExprTemplateArg,
  type BinaryOperator,
  type UnaryOperator,
  type AssignOperator,
  type FunctionSpecifier,
  type VariableSpecifier,
  type TypeQualifier,
  type CallingConvention,
  type Attribute,
} from '../ast/index.js';

export interface ParserOptions {
  filename?: string;
}

export class ParserError extends Error {
  constructor(
    message: string,
    public readonly location: SourceLocation
  ) {
    super(`${location.file}:${location.start.line}:${location.start.column}: ${message}`);
    this.name = 'ParserError';
  }
}

/**
 * Operator precedence for Pratt parsing
 */
const PRECEDENCE: Record<string, number> = {
  ',': 1,
  '=': 2, '+=': 2, '-=': 2, '*=': 2, '/=': 2, '%=': 2,
  '&=': 2, '|=': 2, '^=': 2, '<<=': 2, '>>=': 2,
  '?': 3,  // Ternary
  '||': 4,
  '&&': 5,
  '|': 6,
  '^': 7,
  '&': 8,
  '==': 9, '!=': 9,
  '<': 10, '>': 10, '<=': 10, '>=': 10, '<=>': 10,
  '<<': 11, '>>': 11,
  '+': 12, '-': 12,
  '*': 13, '/': 13, '%': 13,
  '.*': 14, '->*': 14,
};

const RIGHT_ASSOCIATIVE = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '?']);

export class Parser {
  private tokens: TokenWithTrivia[];
  private pos: number = 0;
  private filename: string;

  constructor(source: string, options: ParserOptions = {}) {
    const lexer = new Lexer(source, { filename: options.filename, preserveTrivia: true });
    this.tokens = lexer.tokenizeWithTrivia();
    this.filename = options.filename ?? '<input>';
  }

  /**
   * Parse the entire source as a translation unit
   */
  parse(): TranslationUnit {
    const declarations: Declaration[] = [];
    const startLoc = this.currentLocation();
    // Don't capture leading trivia for TranslationUnit - let the first declaration own it

    while (!this.isAtEnd()) {
      const decl = this.parseDeclaration();
      if (decl) {
        declarations.push(decl);
      }
    }

    return this.node(NodeKind.TranslationUnit, startLoc, { declarations }) as TranslationUnit;
  }

  /**
   * Parse a single declaration
   */
  parseDeclaration(): Declaration | null {
    // Capture leading trivia at the start of the declaration
    const leadingTrivia = this.captureLeadingTrivia();

    // Skip empty declarations
    if (this.check(TokenKind.Semicolon)) {
      const loc = this.currentLocation();
      this.advance();
      return this.node(NodeKind.EmptyDecl, loc, {}, leadingTrivia) as Declaration;
    }

    // Check for namespace
    if (this.check(TokenKind.Namespace)) {
      const decl = this.parseNamespaceDecl();
      // Attach the captured leading trivia to this declaration
      decl.leadingTrivia = leadingTrivia;
      return decl;
    }

    // Check for typedef
    if (this.check(TokenKind.Typedef)) {
      const decl = this.parseTypedefDecl();
      decl.leadingTrivia = leadingTrivia;
      return decl;
    }

    // Check for struct/class/union
    // Could be: struct definition, forward declaration, or variable with struct type
    if (this.check(TokenKind.Struct) || this.check(TokenKind.Class) || this.check(TokenKind.Union)) {
      // Look ahead to determine what this is:
      // - `struct { ... }` - anonymous definition
      // - `struct Name { ... }` - named definition
      // - `struct Name;` - forward declaration
      // - `struct Name varname` - variable declaration (handle via parseFunctionOrVariableDecl)
      const saved = this.pos;
      this.advance(); // skip struct/class/union
      if (this.check(TokenKind.LeftBrace)) {
        // Anonymous struct definition
        this.pos = saved;
        const decl = this.parseClassOrStructDecl();
        decl.leadingTrivia = leadingTrivia;
        return decl;
      }
      if (this.check(TokenKind.Identifier)) {
        this.advance(); // skip name
        if (this.check(TokenKind.LeftBrace) || this.check(TokenKind.Semicolon) || this.check(TokenKind.Colon)) {
          // Named definition, forward declaration, or has base classes
          this.pos = saved;
          const decl = this.parseClassOrStructDecl();
          decl.leadingTrivia = leadingTrivia;
          return decl;
        }
        // Otherwise it's a variable/function declaration with struct type
        this.pos = saved;
        const decl = this.parseFunctionOrVariableDecl();
        if (decl) {
          decl.leadingTrivia = leadingTrivia;
        }
        return decl;
      }
      // Something else - let the default parser handle it
      this.pos = saved;
      const decl = this.parseClassOrStructDecl();
      decl.leadingTrivia = leadingTrivia;
      return decl;
    }

    // Check for enum
    if (this.check(TokenKind.Enum)) {
      const decl = this.parseEnumDecl();
      decl.leadingTrivia = leadingTrivia;
      return decl;
    }

    // Try to parse as function or variable declaration
    const decl = this.parseFunctionOrVariableDecl();
    if (decl) {
      decl.leadingTrivia = leadingTrivia;
    }
    return decl;
  }

  /**
   * Parse namespace declaration
   */
  private parseNamespaceDecl(): NamespaceDecl {
    const startLoc = this.currentLocation();
    this.expect(TokenKind.Namespace);

    const isInline = this.match(TokenKind.Inline);
    const name = this.check(TokenKind.Identifier) ? this.parseIdentifier() : null;

    this.expect(TokenKind.LeftBrace);

    const declarations: Declaration[] = [];
    while (!this.check(TokenKind.RightBrace) && !this.isAtEnd()) {
      const decl = this.parseDeclaration();
      if (decl) declarations.push(decl);
    }

    this.expect(TokenKind.RightBrace);

    return this.node(NodeKind.NamespaceDecl, startLoc, {
      name,
      declarations,
      isInline,
      attributes: [],
    }) as NamespaceDecl;
  }

  /**
   * Parse typedef declaration
   */
  private parseTypedefDecl(): TypedefDecl {
    const startLoc = this.currentLocation();
    this.expect(TokenKind.Typedef);

    const type = this.parseType();
    const name = this.parseIdentifier();
    this.expect(TokenKind.Semicolon);

    return this.node(NodeKind.TypedefDecl, startLoc, { name, type }) as TypedefDecl;
  }

  /**
   * Parse struct, class, or union declaration
   */
  private parseClassOrStructDecl(): ClassDecl | StructDecl {
    const startLoc = this.currentLocation();
    const keyword = this.advance();
    const isClass = keyword.token.kind === TokenKind.Class;

    const name = this.check(TokenKind.Identifier) ? this.parseIdentifier() : null;

    // Check for forward declaration
    if (this.check(TokenKind.Semicolon)) {
      this.advance();
      const kind = isClass ? NodeKind.ClassDecl : NodeKind.StructDecl;
      return this.node(kind, startLoc, {
        name,
        bases: [],
        members: [],
        isFinal: false,
        attributes: [],
      }) as ClassDecl | StructDecl;
    }

    // Parse base classes if present
    const bases: any[] = [];
    if (this.check(TokenKind.Colon)) {
      this.advance();
      // TODO: Parse base specifiers
    }

    this.expect(TokenKind.LeftBrace);

    const members: any[] = [];
    while (!this.check(TokenKind.RightBrace) && !this.isAtEnd()) {
      // Parse member - simplified for now
      const member = this.parseDeclaration();
      if (member) members.push(member);
    }

    this.expect(TokenKind.RightBrace);
    this.match(TokenKind.Semicolon);

    const kind = isClass ? NodeKind.ClassDecl : NodeKind.StructDecl;
    return this.node(kind, startLoc, {
      name,
      bases,
      members,
      isFinal: false,
      attributes: [],
    }) as ClassDecl | StructDecl;
  }

  /**
   * Parse enum declaration
   */
  private parseEnumDecl(): EnumDecl {
    const startLoc = this.currentLocation();
    this.expect(TokenKind.Enum);

    const isScoped = this.match(TokenKind.Class) || this.match(TokenKind.Struct);
    const name = this.check(TokenKind.Identifier) ? this.parseIdentifier() : null;

    // Parse underlying type if present
    let underlyingType: TypeNode | null = null;
    if (this.check(TokenKind.Colon)) {
      this.advance();
      underlyingType = this.parseType();
    }

    // Check for forward declaration
    if (this.check(TokenKind.Semicolon)) {
      this.advance();
      return this.node(NodeKind.EnumDecl, startLoc, {
        name,
        isScoped,
        underlyingType,
        enumerators: [],
        attributes: [],
      }) as EnumDecl;
    }

    this.expect(TokenKind.LeftBrace);

    const enumerators: EnumeratorDecl[] = [];
    while (!this.check(TokenKind.RightBrace) && !this.isAtEnd()) {
      const enumStart = this.currentLocation();
      const enumName = this.parseIdentifier();

      let value: Expression | null = null;
      if (this.match(TokenKind.Equal)) {
        value = this.parseConditionalExpression();  // Don't consume commas
      }

      enumerators.push(this.node(NodeKind.EnumeratorDecl, enumStart, {
        name: enumName,
        value,
        attributes: [],
      }) as EnumeratorDecl);

      if (!this.match(TokenKind.Comma)) {
        break;
      }
    }

    this.expect(TokenKind.RightBrace);
    this.match(TokenKind.Semicolon);

    return this.node(NodeKind.EnumDecl, startLoc, {
      name,
      isScoped,
      underlyingType,
      enumerators,
      attributes: [],
    }) as EnumDecl;
  }

  /**
   * Parse function or variable declaration
   */
  private parseFunctionOrVariableDecl(): FunctionDecl | VariableDecl | null {
    const startLoc = this.currentLocation();

    // Parse specifiers
    const specifiers: FunctionSpecifier[] = [];
    while (this.checkSpecifier()) {
      specifiers.push(this.advance().token.text as FunctionSpecifier);
    }

    // Parse type
    const returnType = this.parseType();

    // Parse optional calling convention (Ghidra: void __fastcall FUN_...)
    let callingConvention: CallingConvention | undefined;
    if (this.checkCallingConvention()) {
      callingConvention = this.advance().token.text as CallingConvention;
    }

    // Check for pointer-to-array declaration: type (*name)[size]
    if (this.check(TokenKind.LeftParen) && this.looksLikePointerToArrayDecl()) {
      return this.parsePointerToArrayDecl(startLoc, specifiers as VariableSpecifier[], returnType);
    }

    // Parse name (could be qualified)
    const name = this.parseIdentifierOrQualified();

    // Check if this is a function (has parameters)
    if (this.check(TokenKind.LeftParen)) {
      return this.parseFunctionDeclRest(startLoc, specifiers, returnType, name, callingConvention);
    }

    // Otherwise it's a variable declaration
    return this.parseVariableDeclRest(startLoc, specifiers as VariableSpecifier[], returnType, name);
  }

  /**
   * Parse rest of function declaration
   */
  private parseFunctionDeclRest(
    startLoc: SourceLocation,
    specifiers: FunctionSpecifier[],
    returnType: TypeNode,
    name: Identifier | QualifiedId,
    callingConvention?: CallingConvention
  ): FunctionDecl {
    this.expect(TokenKind.LeftParen);

    const parameters: ParameterDecl[] = [];
    let isVariadic = false;

    if (!this.check(TokenKind.RightParen)) {
      do {
        if (this.check(TokenKind.Ellipsis)) {
          this.advance();
          isVariadic = true;
          break;
        }
        parameters.push(this.parseParameterDecl());
      } while (this.match(TokenKind.Comma));
    }

    this.expect(TokenKind.RightParen);

    // Parse optional qualifiers (const, noexcept, etc.)
    while (this.check(TokenKind.Const) || this.check(TokenKind.Noexcept)) {
      this.advance();
    }

    // Parse body or semicolon
    let body: CompoundStmt | null = null;
    if (this.check(TokenKind.LeftBrace)) {
      body = this.parseCompoundStatement();
    } else {
      this.expect(TokenKind.Semicolon);
    }

    return this.node(NodeKind.FunctionDecl, startLoc, {
      name,
      returnType,
      parameters,
      body,
      specifiers,
      callingConvention,
      attributes: [],
      isVariadic,
    }) as FunctionDecl;
  }

  /**
   * Parse parameter declaration
   */
  private parseParameterDecl(): ParameterDecl {
    const startLoc = this.currentLocation();

    let type = this.parseType();
    const name = this.check(TokenKind.Identifier) ? this.parseIdentifier() : null;

    // Handle array syntax in parameters: int arr[], int arr[10]
    // In C/C++, array parameters decay to pointers, but we parse them correctly
    while (this.check(TokenKind.LeftBracket)) {
      this.advance();
      const size = this.check(TokenKind.RightBracket) ? null : this.parseExpression();
      this.expect(TokenKind.RightBracket);
      type = this.node(NodeKind.ArrayType, startLoc, {
        elementType: type,
        size,
      }) as ArrayType;
    }

    let defaultValue: Expression | null = null;
    if (this.match(TokenKind.Equal)) {
      defaultValue = this.parseAssignmentExpression();
    }

    return this.node(NodeKind.ParameterDecl, startLoc, {
      name,
      type,
      defaultValue,
      isVariadic: false,
    }) as ParameterDecl;
  }

  /**
   * Parse rest of variable declaration
   */
  private parseVariableDeclRest(
    startLoc: SourceLocation,
    specifiers: VariableSpecifier[],
    type: TypeNode,
    name: Identifier | QualifiedId
  ): VariableDecl {
    // Handle array suffix
    while (this.check(TokenKind.LeftBracket)) {
      this.advance();
      const size = this.check(TokenKind.RightBracket) ? null : this.parseExpression();
      this.expect(TokenKind.RightBracket);
      type = this.node(NodeKind.ArrayType, startLoc, {
        elementType: type,
        size,
      }) as ArrayType;
    }

    let initializer: Expression | InitListExpr | null = null;
    if (this.match(TokenKind.Equal)) {
      if (this.check(TokenKind.LeftBrace)) {
        initializer = this.parseInitializerList();
      } else {
        initializer = this.parseAssignmentExpression();
      }
    }

    this.expect(TokenKind.Semicolon);

    return this.node(NodeKind.VariableDecl, startLoc, {
      name: name as Identifier,
      type,
      initializer,
      specifiers,
      attributes: [],
    }) as VariableDecl;
  }

  // ============================================
  // TYPE PARSING
  // ============================================

  /**
   * Parse a type
   */
  parseType(): TypeNode {
    const startLoc = this.currentLocation();

    // Parse qualifiers (const, volatile, restrict)
    const qualifiers: TypeQualifier[] = [];
    while (this.check(TokenKind.Const) || this.check(TokenKind.Volatile) || this.check(TokenKind.Restrict)) {
      qualifiers.push(this.advance().token.text as TypeQualifier);
    }

    // Parse base type
    let type = this.parseBaseType();

    // Apply leading qualifiers
    if (qualifiers.length > 0) {
      type = this.node(NodeKind.QualifiedType, startLoc, {
        qualifiers,
        type,
      }) as QualifiedType;
    }

    // Parse pointer/reference suffixes
    type = this.parseTypeSuffixes(type);

    return type;
  }

  /**
   * Parse base type (without pointers/references)
   */
  private parseBaseType(): TypeNode {
    const startLoc = this.currentLocation();

    // Check for builtin types
    if (this.checkBuiltinType()) {
      return this.parseBuiltinType();
    }

    // Check for struct/class/enum elaborated type
    if (this.check(TokenKind.Struct) || this.check(TokenKind.Class) || this.check(TokenKind.Enum)) {
      const keyword = this.advance().token.text as 'struct' | 'class' | 'enum';
      const name = this.parseIdentifierOrQualified();
      return this.node(NodeKind.ElaboratedType, startLoc, {
        keyword,
        name,
      }) as TypeNode;
    }

    // Otherwise, parse as named type (possibly templated)
    const name = this.parseIdentifierOrQualified();

    // Check for template arguments
    if (this.check(TokenKind.Less)) {
      return this.parseTemplateType(name);
    }

    return this.node(NodeKind.TypedefType, startLoc, { name }) as TypeNode;
  }

  /**
   * Parse builtin type (int, char, void, etc.)
   */
  private parseBuiltinType(): BuiltinType {
    const startLoc = this.currentLocation();
    const modifiers: string[] = [];
    let name = '';

    // Collect modifiers and base type
    while (this.checkBuiltinType()) {
      const token = this.advance().token;
      const text = token.text;

      if (text === 'signed' || text === 'unsigned' || text === 'short' || text === 'long') {
        modifiers.push(text);
      } else {
        name = text;
      }
    }

    // Default to int if only modifiers specified
    if (!name && modifiers.length > 0) {
      name = 'int';
    }

    return this.node(NodeKind.BuiltinType, startLoc, {
      name,
      modifiers,
    }) as BuiltinType;
  }

  /**
   * Parse template type arguments
   */
  private parseTemplateType(name: Identifier | QualifiedId): TemplateType {
    const startLoc = name.location;
    this.expect(TokenKind.Less);

    const args: (TypeTemplateArg | ExprTemplateArg)[] = [];
    if (!this.check(TokenKind.Greater) && !this.check(TokenKind.GreaterGreater)) {
      do {
        const argStart = this.currentLocation();
        // Non-type template parameter: integer literal or unary expression like -1
        if (this.check(TokenKind.IntegerLiteral) ||
            (this.check(TokenKind.Minus) && this.checkAhead(1, TokenKind.IntegerLiteral))) {
          const expression = this.parseUnaryExpression();
          args.push(this.node(NodeKind.ExprTemplateArg, argStart, { expression }) as ExprTemplateArg);
        } else {
          const type = this.parseType();
          args.push(this.node(NodeKind.TypeTemplateArg, argStart, { type }) as TypeTemplateArg);
        }
      } while (this.match(TokenKind.Comma));
    }

    // Handle >> as two >
    if (this.check(TokenKind.GreaterGreater)) {
      // Consume one > by creating a synthetic token
      const tok = this.current();
      tok.token = { ...tok.token, kind: TokenKind.Greater, text: '>' };
    } else {
      this.expect(TokenKind.Greater);
    }

    return this.node(NodeKind.TemplateType, startLoc, {
      name,
      arguments: args,
    }) as TemplateType;
  }

  /**
   * Parse type suffixes (pointers, references, arrays)
   */
  private parseTypeSuffixes(type: TypeNode): TypeNode {
    while (true) {
      if (this.check(TokenKind.Star)) {
        const startLoc = this.currentLocation();
        this.advance();

        const qualifiers: TypeQualifier[] = [];
        while (this.check(TokenKind.Const) || this.check(TokenKind.Volatile) || this.check(TokenKind.Restrict)) {
          qualifiers.push(this.advance().token.text as TypeQualifier);
        }

        type = this.node(NodeKind.PointerType, startLoc, {
          pointee: type,
          qualifiers,
        }) as PointerType;
      } else if (this.check(TokenKind.Ampersand)) {
        const startLoc = this.currentLocation();
        this.advance();
        type = this.node(NodeKind.ReferenceType, startLoc, {
          referenced: type,
        }) as ReferenceType;
      } else if (this.check(TokenKind.AmpAmp)) {
        const startLoc = this.currentLocation();
        this.advance();
        type = this.node(NodeKind.RValueReferenceType, startLoc, {
          referenced: type,
        }) as TypeNode;
      } else if (this.check(TokenKind.LeftBracket)) {
        // Ghidra array type syntax: type*[N] or type[N] in declarations
        const startLoc = this.currentLocation();
        this.advance();
        const size = this.check(TokenKind.RightBracket) ? null : this.parseExpression();
        this.expect(TokenKind.RightBracket);
        type = this.node(NodeKind.ArrayType, startLoc, {
          elementType: type,
          size,
        }) as ArrayType;
      } else if (this.check(TokenKind.LeftParen) && this.checkAhead(1, TokenKind.Star) &&
                 this.looksLikeAbstractPtrDeclarator()) {
        // Abstract pointer-to-array/function declarator in casts: (char (*) [4]) or (char (**) [32])
        const startLoc = this.currentLocation();
        this.advance(); // (
        // Count and consume pointer stars
        let ptrCount = 0;
        while (this.check(TokenKind.Star)) {
          this.advance();
          ptrCount++;
        }
        this.expect(TokenKind.RightParen); // )
        if (this.check(TokenKind.LeftBracket)) {
          // pointer-to-array: char(*)[4] = pointer to char[4], char(**)[4] = pointer to pointer to char[4]
          const bracketLoc = this.currentLocation();
          this.advance();
          const size = this.check(TokenKind.RightBracket) ? null : this.parseExpression();
          this.expect(TokenKind.RightBracket);
          const arrayType = this.node(NodeKind.ArrayType, bracketLoc, {
            elementType: type,
            size,
          }) as ArrayType;
          // Wrap in ptrCount layers of PointerType
          type = arrayType as TypeNode;
          for (let i = 0; i < ptrCount; i++) {
            type = this.node(NodeKind.PointerType, startLoc, {
              pointee: type,
              qualifiers: [],
            }) as PointerType;
          }
        } else {
          // Just pointer(s) in parens: char(*) or char(**)
          for (let i = 0; i < ptrCount; i++) {
            type = this.node(NodeKind.PointerType, startLoc, {
              pointee: type,
              qualifiers: [],
            }) as PointerType;
          }
        }
      } else {
        break;
      }
    }

    return type;
  }

  // ============================================
  // STATEMENT PARSING
  // ============================================

  /**
   * Parse a statement
   */
  parseStatement(): Statement {
    // Capture leading trivia at the start of the statement
    const leadingTrivia = this.captureLeadingTrivia();

    // Compound statement
    if (this.check(TokenKind.LeftBrace)) {
      const stmt = this.parseCompoundStatement();
      stmt.leadingTrivia = leadingTrivia;
      return stmt;
    }

    // Control flow - attach trivia to all these statements
    if (this.check(TokenKind.If)) {
      const stmt = this.parseIfStatement();
      stmt.leadingTrivia = leadingTrivia;
      return stmt;
    }
    if (this.check(TokenKind.While)) {
      const stmt = this.parseWhileStatement();
      stmt.leadingTrivia = leadingTrivia;
      return stmt;
    }
    if (this.check(TokenKind.Do)) {
      const stmt = this.parseDoWhileStatement();
      stmt.leadingTrivia = leadingTrivia;
      return stmt;
    }
    if (this.check(TokenKind.For)) {
      const stmt = this.parseForStatement();
      stmt.leadingTrivia = leadingTrivia;
      return stmt;
    }
    if (this.check(TokenKind.Switch)) {
      const stmt = this.parseSwitchStatement();
      stmt.leadingTrivia = leadingTrivia;
      return stmt;
    }
    if (this.check(TokenKind.Case)) {
      const stmt = this.parseCaseStatement();
      stmt.leadingTrivia = leadingTrivia;
      return stmt;
    }
    if (this.check(TokenKind.Default)) {
      const stmt = this.parseDefaultStatement();
      stmt.leadingTrivia = leadingTrivia;
      return stmt;
    }

    // Jump statements
    if (this.check(TokenKind.Return)) {
      const stmt = this.parseReturnStatement();
      stmt.leadingTrivia = leadingTrivia;
      return stmt;
    }
    if (this.check(TokenKind.Break)) {
      const stmt = this.parseBreakStatement();
      stmt.leadingTrivia = leadingTrivia;
      return stmt;
    }
    if (this.check(TokenKind.Continue)) {
      const stmt = this.parseContinueStatement();
      stmt.leadingTrivia = leadingTrivia;
      return stmt;
    }
    if (this.check(TokenKind.Goto)) {
      const stmt = this.parseGotoStatement();
      stmt.leadingTrivia = leadingTrivia;
      return stmt;
    }

    // Null statement
    if (this.check(TokenKind.Semicolon)) {
      const loc = this.currentLocation();
      this.advance();
      return this.node(NodeKind.NullStmt, loc, {}, leadingTrivia) as NullStmt;
    }

    // Label statement
    if (this.check(TokenKind.Identifier) && this.checkAhead(1, TokenKind.Colon)) {
      const stmt = this.parseLabelStatement();
      stmt.leadingTrivia = leadingTrivia;
      return stmt;
    }

    // Expression statement
    const stmt = this.parseExpressionStatement();
    stmt.leadingTrivia = leadingTrivia;
    return stmt;
  }

  /**
   * Parse compound statement (block)
   */
  parseCompoundStatement(): CompoundStmt {
    const startLoc = this.currentLocation();
    this.expect(TokenKind.LeftBrace);

    const statements: Statement[] = [];
    while (!this.check(TokenKind.RightBrace) && !this.isAtEnd()) {
      // Check for declaration
      if (this.looksLikeDeclaration()) {
        const decl = this.parseDeclaration();
        if (decl) {
          statements.push(this.node(NodeKind.DeclStmt, decl.location, {
            declarations: [decl],
          }) as Statement);
        }
      } else {
        statements.push(this.parseStatement());
      }
    }

    this.expect(TokenKind.RightBrace);

    return this.node(NodeKind.CompoundStmt, startLoc, { statements }) as CompoundStmt;
  }

  /**
   * Parse if statement
   */
  private parseIfStatement(): IfStmt {
    const startLoc = this.currentLocation();
    this.expect(TokenKind.If);

    const isConstexpr = this.match(TokenKind.Constexpr);

    this.expect(TokenKind.LeftParen);
    const condition = this.parseExpression();
    this.expect(TokenKind.RightParen);

    const thenBranch = this.parseStatement();

    let elseBranch: Statement | null = null;
    if (this.match(TokenKind.Else)) {
      elseBranch = this.parseStatement();
    }

    return this.node(NodeKind.IfStmt, startLoc, {
      condition,
      thenBranch,
      elseBranch,
      isConstexpr,
    }) as IfStmt;
  }

  /**
   * Parse while statement
   */
  private parseWhileStatement(): WhileStmt {
    const startLoc = this.currentLocation();
    this.expect(TokenKind.While);
    this.expect(TokenKind.LeftParen);
    const condition = this.parseExpression();
    this.expect(TokenKind.RightParen);
    const body = this.parseStatement();

    return this.node(NodeKind.WhileStmt, startLoc, { condition, body }) as WhileStmt;
  }

  /**
   * Parse do-while statement
   */
  private parseDoWhileStatement(): DoWhileStmt {
    const startLoc = this.currentLocation();
    this.expect(TokenKind.Do);
    const body = this.parseStatement();
    this.expect(TokenKind.While);
    this.expect(TokenKind.LeftParen);
    const condition = this.parseExpression();
    this.expect(TokenKind.RightParen);
    this.expect(TokenKind.Semicolon);

    return this.node(NodeKind.DoWhileStmt, startLoc, { body, condition }) as DoWhileStmt;
  }

  /**
   * Parse for statement
   */
  private parseForStatement(): ForStmt {
    const startLoc = this.currentLocation();
    this.expect(TokenKind.For);
    this.expect(TokenKind.LeftParen);

    // Init
    let init: Statement | null = null;
    if (!this.check(TokenKind.Semicolon)) {
      if (this.looksLikeDeclaration()) {
        const decl = this.parseDeclaration();
        if (decl) {
          init = this.node(NodeKind.DeclStmt, decl.location, {
            declarations: [decl],
          }) as Statement;
        }
      } else {
        init = this.parseExpressionStatement();
      }
    } else {
      this.advance(); // consume ;
    }

    // Condition
    let condition: Expression | null = null;
    if (!this.check(TokenKind.Semicolon)) {
      condition = this.parseExpression();
    }
    this.expect(TokenKind.Semicolon);

    // Increment
    let increment: Expression | null = null;
    if (!this.check(TokenKind.RightParen)) {
      increment = this.parseExpression();
    }
    this.expect(TokenKind.RightParen);

    const body = this.parseStatement();

    return this.node(NodeKind.ForStmt, startLoc, {
      init,
      condition,
      increment,
      body,
    }) as ForStmt;
  }

  /**
   * Parse switch statement
   */
  private parseSwitchStatement(): SwitchStmt {
    const startLoc = this.currentLocation();
    this.expect(TokenKind.Switch);
    this.expect(TokenKind.LeftParen);
    const condition = this.parseExpression();
    this.expect(TokenKind.RightParen);
    const body = this.parseStatement();

    return this.node(NodeKind.SwitchStmt, startLoc, { condition, body }) as SwitchStmt;
  }

  /**
   * Parse case statement
   */
  private parseCaseStatement(): CaseStmt {
    const startLoc = this.currentLocation();
    this.expect(TokenKind.Case);
    const value = this.parseExpression();
    this.expect(TokenKind.Colon);
    // Allow empty case (fallthrough or end-of-switch): case N: } or case N: case M:
    const statement = (this.check(TokenKind.RightBrace) || this.check(TokenKind.Case) || this.check(TokenKind.Default))
      ? this.node(NodeKind.NullStmt, this.currentLocation(), {}) as NullStmt
      : this.parseStatement();

    return this.node(NodeKind.CaseStmt, startLoc, { value, statement }) as CaseStmt;
  }

  /**
   * Parse default statement
   */
  private parseDefaultStatement(): DefaultStmt {
    const startLoc = this.currentLocation();
    this.expect(TokenKind.Default);
    this.expect(TokenKind.Colon);
    // Allow empty default (fallthrough or end-of-switch)
    const statement = (this.check(TokenKind.RightBrace) || this.check(TokenKind.Case) || this.check(TokenKind.Default))
      ? this.node(NodeKind.NullStmt, this.currentLocation(), {}) as NullStmt
      : this.parseStatement();

    return this.node(NodeKind.DefaultStmt, startLoc, { statement }) as DefaultStmt;
  }

  /**
   * Parse return statement
   */
  private parseReturnStatement(): ReturnStmt {
    const startLoc = this.currentLocation();
    this.expect(TokenKind.Return);

    let value: Expression | null = null;
    if (!this.check(TokenKind.Semicolon)) {
      value = this.parseExpression();
    }
    this.expect(TokenKind.Semicolon);

    return this.node(NodeKind.ReturnStmt, startLoc, { value }) as ReturnStmt;
  }

  /**
   * Parse break statement
   */
  private parseBreakStatement(): BreakStmt {
    const startLoc = this.currentLocation();
    this.expect(TokenKind.Break);
    this.expect(TokenKind.Semicolon);
    return this.node(NodeKind.BreakStmt, startLoc, {}) as BreakStmt;
  }

  /**
   * Parse continue statement
   */
  private parseContinueStatement(): ContinueStmt {
    const startLoc = this.currentLocation();
    this.expect(TokenKind.Continue);
    this.expect(TokenKind.Semicolon);
    return this.node(NodeKind.ContinueStmt, startLoc, {}) as ContinueStmt;
  }

  /**
   * Parse goto statement
   */
  private parseGotoStatement(): GotoStmt {
    const startLoc = this.currentLocation();
    this.expect(TokenKind.Goto);
    const label = this.parseIdentifier();
    this.expect(TokenKind.Semicolon);
    return this.node(NodeKind.GotoStmt, startLoc, { label }) as GotoStmt;
  }

  /**
   * Parse label statement
   */
  private parseLabelStatement(): LabelStmt {
    const startLoc = this.currentLocation();
    const label = this.parseIdentifier();
    this.expect(TokenKind.Colon);
    // Allow label before closing brace: LAB_xxx: }
    const statement = this.check(TokenKind.RightBrace)
      ? this.node(NodeKind.NullStmt, this.currentLocation(), {}) as NullStmt
      : this.parseStatement();
    return this.node(NodeKind.LabelStmt, startLoc, { label, statement }) as LabelStmt;
  }

  /**
   * Parse expression statement
   */
  private parseExpressionStatement(): ExprStmt {
    const startLoc = this.currentLocation();
    const expression = this.parseExpression();
    this.expect(TokenKind.Semicolon);
    return this.node(NodeKind.ExprStmt, startLoc, { expression }) as ExprStmt;
  }

  // ============================================
  // EXPRESSION PARSING (Pratt Parser)
  // ============================================

  /**
   * Parse an expression (includes comma operator)
   */
  parseExpression(): Expression {
    return this.parseBinaryExpression(0);
  }

  /**
   * Parse assignment expression (excludes comma operator)
   */
  private parseAssignmentExpression(): Expression {
    return this.parseBinaryExpression(2);  // Start above comma precedence
  }

  /**
   * Parse conditional expression (excludes comma and assignment)
   */
  private parseConditionalExpression(): Expression {
    return this.parseBinaryExpression(3);  // Start at ternary precedence
  }

  /**
   * Parse binary expression with precedence climbing
   */
  private parseBinaryExpression(minPrecedence: number): Expression {
    let left = this.parseUnaryExpression();

    while (true) {
      const operator = this.currentOperator();
      if (!operator) break;

      const precedence = PRECEDENCE[operator];
      if (precedence === undefined || precedence < minPrecedence) break;

      // Handle ternary operator
      if (operator === '?') {
        this.advance();
        const thenExpr = this.parseExpression();
        this.expect(TokenKind.Colon);
        const elseExpr = this.parseBinaryExpression(precedence);
        left = this.node(NodeKind.ConditionalExpr, left.location, {
          condition: left,
          thenExpr,
          elseExpr,
        }) as ConditionalExpr;
        continue;
      }

      this.advance();

      const nextMinPrecedence = RIGHT_ASSOCIATIVE.has(operator) ? precedence : precedence + 1;
      const right = this.parseBinaryExpression(nextMinPrecedence);

      // Check if it's an assignment operator
      if (this.isAssignmentOperator(operator)) {
        left = this.node(NodeKind.AssignExpr, left.location, {
          operator: operator as AssignOperator,
          left,
          right,
        }) as AssignExpr;
      } else {
        left = this.node(NodeKind.BinaryExpr, left.location, {
          operator: operator as BinaryOperator,
          left,
          right,
        }) as BinaryExpr;
      }
    }

    return left;
  }

  /**
   * Parse unary expression
   */
  private parseUnaryExpression(): Expression {
    const startLoc = this.currentLocation();

    // Prefix operators
    if (this.checkUnaryOperator()) {
      const operator = this.advance().token.text as UnaryOperator;
      const operand = this.parseUnaryExpression();
      return this.node(NodeKind.UnaryExpr, startLoc, { operator, operand }) as UnaryExpr;
    }

    // sizeof
    if (this.check(TokenKind.Sizeof)) {
      return this.parseSizeofExpression();
    }

    // Cast expression: (type)expr
    if (this.check(TokenKind.LeftParen) && this.looksLikeCast()) {
      return this.parseCastExpression();
    }

    return this.parsePostfixExpression();
  }

  /**
   * Parse sizeof expression
   */
  private parseSizeofExpression(): SizeofExpr {
    const startLoc = this.currentLocation();
    this.expect(TokenKind.Sizeof);

    if (this.check(TokenKind.LeftParen)) {
      this.advance();
      if (this.looksLikeType()) {
        const type = this.parseType();
        this.expect(TokenKind.RightParen);
        return this.node(NodeKind.SizeofExpr, startLoc, {
          operand: type,
          isType: true,
        }) as SizeofExpr;
      }
      const expr = this.parseExpression();
      this.expect(TokenKind.RightParen);
      return this.node(NodeKind.SizeofExpr, startLoc, {
        operand: expr,
        isType: false,
      }) as SizeofExpr;
    }

    const operand = this.parseUnaryExpression();
    return this.node(NodeKind.SizeofExpr, startLoc, {
      operand,
      isType: false,
    }) as SizeofExpr;
  }

  /**
   * Parse cast expression
   */
  private parseCastExpression(): CStyleCastExpr {
    const startLoc = this.currentLocation();
    this.expect(TokenKind.LeftParen);
    const type = this.parseType();
    this.expect(TokenKind.RightParen);
    const expression = this.parseUnaryExpression();

    return this.node(NodeKind.CStyleCastExpr, startLoc, {
      type,
      expression,
    }) as CStyleCastExpr;
  }

  /**
   * Parse postfix expression
   */
  private parsePostfixExpression(): Expression {
    let expr = this.parsePrimaryExpression();

    while (true) {
      if (this.check(TokenKind.LeftParen)) {
        // Function call
        expr = this.parseCallExpression(expr);
      } else if (this.check(TokenKind.LeftBracket)) {
        // Subscript
        expr = this.parseSubscriptExpression(expr);
      } else if (this.check(TokenKind.Dot) || this.check(TokenKind.Arrow)) {
        // Member access
        expr = this.parseMemberExpression(expr);
      } else if (this.check(TokenKind.PlusPlus) || this.check(TokenKind.MinusMinus)) {
        // Postfix increment/decrement
        const operator = this.advance().token.text as '++' | '--';
        expr = this.node(NodeKind.PostfixExpr, expr.location, {
          operator,
          operand: expr,
        }) as PostfixExpr;
      } else {
        break;
      }
    }

    return expr;
  }

  /**
   * Parse call expression
   */
  private parseCallExpression(callee: Expression): CallExpr {
    this.expect(TokenKind.LeftParen);

    const args: Expression[] = [];
    if (!this.check(TokenKind.RightParen)) {
      do {
        args.push(this.parseAssignmentExpression());
      } while (this.match(TokenKind.Comma));
    }

    this.expect(TokenKind.RightParen);

    return this.node(NodeKind.CallExpr, callee.location, {
      callee,
      arguments: args,
    }) as CallExpr;
  }

  /**
   * Parse subscript expression
   */
  private parseSubscriptExpression(array: Expression): SubscriptExpr {
    this.expect(TokenKind.LeftBracket);
    const index = this.parseExpression();

    // Handle ]] (RightAttrBracket) by splitting into ] + ] like >> for templates
    if (this.check(TokenKind.RightAttrBracket)) {
      // Rewrite the ]] token to ] in place (don't advance — the caller will see
      // a ] at this same position next time, exactly like the >> template fix)
      const tok = this.current();
      tok.token = { ...tok.token, kind: TokenKind.RightBracket, text: ']' };
      // Now advance past this rewritten ] — but we need to leave a ] behind
      // for the outer subscript. Insert a synthetic ] token after current position.
      const syntheticToken: TokenWithTrivia = {
        leadingTrivia: [],
        token: { ...tok.token, kind: TokenKind.RightBracket, text: ']' },
        trailingTrivia: [],
      };
      this.tokens.splice(this.pos + 1, 0, syntheticToken);
    }
    this.expect(TokenKind.RightBracket);

    return this.node(NodeKind.SubscriptExpr, array.location, {
      array,
      index,
    }) as SubscriptExpr;
  }

  /**
   * Parse member expression
   */
  private parseMemberExpression(object: Expression): MemberExpr {
    const isArrow = this.check(TokenKind.Arrow);
    this.advance(); // . or ->

    let member: Identifier | TemplateType;
    if (this.check(TokenKind.Tilde)) {
      // Destructor call: obj->~ClassName() or obj.~ClassName()
      member = this.parseDestructorName();
    } else if (this.check(TokenKind.Operator)) {
      // Operator member: obj.operator=() etc.
      member = this.parseOperatorName();
    } else if (this.check(TokenKind.Class) || this.check(TokenKind.Struct) ||
               this.check(TokenKind.Enum) || this.check(TokenKind.Int) ||
               this.check(TokenKind.Char) || this.check(TokenKind.Short) ||
               this.check(TokenKind.Long) || this.check(TokenKind.Float) ||
               this.check(TokenKind.Double)) {
      // Keyword used as member name (Ghidra decompiler quirk, e.g. obj.class)
      const kwLoc = this.currentLocation();
      const tok = this.advance();
      member = this.node(NodeKind.Identifier, kwLoc, {
        name: tok.token.text,
      }) as Identifier;
    } else {
      const id = this.parseIdentifier();
      // Check for template arguments on member name (Ghidra emits e.g. obj.super_TSHashTable<T,U>)
      if (this.check(TokenKind.Less) && this.looksLikeTemplateArgs()) {
        member = this.parseTemplateType(id);
      } else {
        member = id;
      }
    }

    return this.node(NodeKind.MemberExpr, object.location, {
      object,
      member: member as Identifier,
      isArrow,
    }) as MemberExpr;
  }

  /**
   * Parse primary expression
   */
  private parsePrimaryExpression(): Expression {
    const startLoc = this.currentLocation();

    // Literals
    if (this.check(TokenKind.IntegerLiteral)) {
      return this.parseIntegerLiteral();
    }
    if (this.check(TokenKind.FloatingLiteral)) {
      return this.parseFloatingLiteral();
    }
    if (this.check(TokenKind.StringLiteral)) {
      return this.parseStringLiteral();
    }
    if (this.check(TokenKind.CharLiteral)) {
      return this.parseCharLiteral();
    }
    if (this.check(TokenKind.True) || this.check(TokenKind.False)) {
      const value = this.advance().token.kind === TokenKind.True;
      return this.node(NodeKind.BoolLiteral, startLoc, { value }) as BoolLiteralExpr;
    }
    if (this.check(TokenKind.Nullptr)) {
      this.advance();
      return this.node(NodeKind.NullptrLiteral, startLoc, {}) as NullptrLiteralExpr;
    }

    // Parenthesized expression
    if (this.check(TokenKind.LeftParen)) {
      this.advance();
      const expression = this.parseExpression();
      this.expect(TokenKind.RightParen);
      return this.node(NodeKind.ParenExpr, startLoc, { expression }) as ParenExpr;
    }

    // Initializer list
    if (this.check(TokenKind.LeftBrace)) {
      return this.parseInitializerList();
    }

    // This
    if (this.check(TokenKind.This)) {
      this.advance();
      return this.node(NodeKind.ThisExpr, startLoc, {}) as Expression;
    }

    // Operator name as expression (e.g., operator+(a, b) as free function call)
    if (this.check(TokenKind.Operator)) {
      return this.parseOperatorName();
    }

    // Identifier (possibly qualified)
    if (this.check(TokenKind.Identifier) || this.check(TokenKind.ColonColon)) {
      return this.parseIdentifierOrQualified();
    }

    throw new ParserError(`Unexpected token: ${this.current().token.text}`, startLoc);
  }

  /**
   * Parse integer literal
   */
  private parseIntegerLiteral(): IntegerLiteralExpr {
    const startLoc = this.currentLocation();
    const token = this.expect(TokenKind.IntegerLiteral);
    const value = token.value as { value: bigint; suffix: string; base: number };

    return this.node(NodeKind.IntegerLiteral, startLoc, {
      value: value.value,
      suffix: value.suffix,
      base: value.base as 2 | 8 | 10 | 16,
      raw: token.text,
    }) as IntegerLiteralExpr;
  }

  /**
   * Parse floating literal
   */
  private parseFloatingLiteral(): FloatingLiteralExpr {
    const startLoc = this.currentLocation();
    const token = this.expect(TokenKind.FloatingLiteral);
    const value = token.value as { value: number; suffix: string };

    return this.node(NodeKind.FloatingLiteral, startLoc, {
      value: value.value,
      suffix: value.suffix,
      raw: token.text,
    }) as FloatingLiteralExpr;
  }

  /**
   * Parse string literal
   */
  private parseStringLiteral(): StringLiteralExpr {
    const startLoc = this.currentLocation();
    const token = this.expect(TokenKind.StringLiteral);
    const value = token.value as { value: string; prefix: string; isRaw: boolean };

    return this.node(NodeKind.StringLiteral, startLoc, {
      value: value.value,
      prefix: value.prefix,
      isRaw: value.isRaw,
      raw: token.text,
    }) as StringLiteralExpr;
  }

  /**
   * Parse character literal
   */
  private parseCharLiteral(): CharLiteralExpr {
    const startLoc = this.currentLocation();
    const token = this.expect(TokenKind.CharLiteral);
    const value = token.value as { value: number; prefix: string };

    return this.node(NodeKind.CharLiteral, startLoc, {
      value: value.value,
      prefix: value.prefix,
      raw: token.text,
    }) as CharLiteralExpr;
  }

  /**
   * Parse initializer list
   */
  private parseInitializerList(): InitListExpr {
    const startLoc = this.currentLocation();
    this.expect(TokenKind.LeftBrace);

    const elements: Expression[] = [];
    if (!this.check(TokenKind.RightBrace)) {
      do {
        if (this.check(TokenKind.LeftBrace)) {
          elements.push(this.parseInitializerList());
        } else {
          elements.push(this.parseAssignmentExpression());
        }
      } while (this.match(TokenKind.Comma) && !this.check(TokenKind.RightBrace));
    }

    this.expect(TokenKind.RightBrace);

    return this.node(NodeKind.InitListExpr, startLoc, { elements }) as InitListExpr;
  }

  /**
   * Parse identifier
   */
  private parseIdentifier(): Identifier {
    const startLoc = this.currentLocation();
    const token = this.expect(TokenKind.Identifier);
    return this.node(NodeKind.Identifier, startLoc, { name: token.text }) as Identifier;
  }

  /**
   * Parse identifier or qualified identifier
   */
  private parseIdentifierOrQualified(): Identifier | QualifiedId {
    const startLoc = this.currentLocation();
    const isGlobal = this.match(TokenKind.ColonColon);

    const parts: (Identifier | TemplateType)[] = [];

    do {
      // Check for operator name: operator=, operator+, operator[], etc.
      if (this.check(TokenKind.Operator)) {
        parts.push(this.parseOperatorName());
      } else if (this.check(TokenKind.Tilde)) {
        // Destructor: ~ClassName
        parts.push(this.parseDestructorName());
      } else {
        const id = this.parseIdentifier();

        // Check for template arguments
        if (this.check(TokenKind.Less) && this.looksLikeTemplateArgs()) {
          parts.push(this.parseTemplateType(id));
        } else {
          parts.push(id);
        }
      }
    } while (this.match(TokenKind.ColonColon));

    if (parts.length === 1 && !isGlobal) {
      return parts[0] as Identifier;
    }

    const name = parts.pop()!;
    return this.node(NodeKind.QualifiedId, startLoc, {
      qualifier: parts,
      name,
      isGlobal,
    }) as QualifiedId;
  }

  /**
   * Parse an operator name: operator+, operator==, operator[], operator(), operator new, etc.
   */
  private parseOperatorName(): Identifier {
    const startLoc = this.currentLocation();
    this.expect(TokenKind.Operator);

    let opName = 'operator';
    const kind = this.current().token.kind;

    // Special multi-token operators
    if (kind === TokenKind.LeftParen) {
      // operator()
      this.advance();
      this.expect(TokenKind.RightParen);
      opName += '()';
    } else if (kind === TokenKind.LeftBracket) {
      // operator[]
      this.advance();
      this.expect(TokenKind.RightBracket);
      opName += '[]';
    } else if (kind === TokenKind.New) {
      this.advance();
      if (this.check(TokenKind.LeftBracket)) {
        // operator new[]
        this.advance();
        this.expect(TokenKind.RightBracket);
        opName += ' new[]';
      } else {
        opName += ' new';
      }
    } else if (kind === TokenKind.Delete) {
      this.advance();
      if (this.check(TokenKind.LeftBracket)) {
        // operator delete[]
        this.advance();
        this.expect(TokenKind.RightBracket);
        opName += ' delete[]';
      } else {
        opName += ' delete';
      }
    } else {
      // Single or double operator token: +, -, *, /, ==, !=, <<, >>, +=, etc.
      opName += this.advance().token.text;
    }

    return this.node(NodeKind.Identifier, startLoc, { name: opName }) as Identifier;
  }

  /**
   * Parse a destructor name: ~ClassName
   */
  private parseDestructorName(): Identifier {
    const startLoc = this.currentLocation();
    this.expect(TokenKind.Tilde);
    const name = this.expect(TokenKind.Identifier);
    return this.node(NodeKind.Identifier, startLoc, { name: '~' + name.text }) as Identifier;
  }

  // ============================================
  // HELPER METHODS
  // ============================================

  private current(): TokenWithTrivia {
    return this.tokens[this.pos] ?? this.tokens[this.tokens.length - 1];
  }

  private currentLocation(): SourceLocation {
    return this.current().token.location;
  }

  private isAtEnd(): boolean {
    return this.current().token.kind === TokenKind.EOF;
  }

  private check(kind: TokenKind): boolean {
    return this.current().token.kind === kind;
  }

  private checkAhead(offset: number, kind: TokenKind): boolean {
    const index = this.pos + offset;
    if (index >= this.tokens.length) return false;
    return this.tokens[index].token.kind === kind;
  }

  private match(kind: TokenKind): boolean {
    if (this.check(kind)) {
      this.advance();
      return true;
    }
    return false;
  }

  private advance(): TokenWithTrivia {
    const token = this.current();
    if (!this.isAtEnd()) this.pos++;
    return token;
  }

  private expect(kind: TokenKind): Token {
    if (!this.check(kind)) {
      throw new ParserError(
        `Expected ${kind}, got ${this.current().token.kind}`,
        this.currentLocation()
      );
    }
    return this.advance().token;
  }

  /**
   * Capture leading trivia from the current token (before consuming it)
   */
  private captureLeadingTrivia(): Trivia[] {
    if (this.pos < this.tokens.length) {
      return this.tokens[this.pos].leadingTrivia;
    }
    return [];
  }

  /**
   * Capture trailing trivia from the last consumed token
   */
  private captureTrailingTrivia(): Trivia[] {
    if (this.pos > 0 && this.pos <= this.tokens.length) {
      return this.tokens[this.pos - 1].trailingTrivia;
    }
    return [];
  }

  private node<K extends NodeKind>(
    kind: K,
    location: SourceLocation,
    props: Record<string, any>,
    leadingTrivia?: Trivia[],
    trailingTrivia?: Trivia[]
  ): { kind: K; location: SourceLocation; leadingTrivia: Trivia[]; trailingTrivia: Trivia[] } {
    return {
      kind,
      location,
      leadingTrivia: leadingTrivia ?? [],
      trailingTrivia: trailingTrivia ?? [],
      ...props,
    };
  }

  private checkSpecifier(): boolean {
    const kind = this.current().token.kind;
    return (
      kind === TokenKind.Static ||
      kind === TokenKind.Extern ||
      kind === TokenKind.Inline ||
      kind === TokenKind.Virtual ||
      kind === TokenKind.Explicit ||
      kind === TokenKind.Constexpr ||
      kind === TokenKind.Consteval
    );
  }

  private checkCallingConvention(): boolean {
    const kind = this.current().token.kind;
    return (
      kind === TokenKind.CallingConvCdecl ||
      kind === TokenKind.CallingConvStdcall ||
      kind === TokenKind.CallingConvFastcall ||
      kind === TokenKind.CallingConvThiscall ||
      kind === TokenKind.CallingConvVectorcall ||
      kind === TokenKind.CallingConvClrcall
    );
  }

  private checkBuiltinType(): boolean {
    const kind = this.current().token.kind;
    return (
      kind === TokenKind.Void ||
      kind === TokenKind.Bool ||
      kind === TokenKind.Char ||
      kind === TokenKind.Short ||
      kind === TokenKind.Int ||
      kind === TokenKind.Long ||
      kind === TokenKind.Float ||
      kind === TokenKind.Double ||
      kind === TokenKind.Signed ||
      kind === TokenKind.Unsigned ||
      kind === TokenKind.Wchar_t ||
      kind === TokenKind.Char8_t ||
      kind === TokenKind.Char16_t ||
      kind === TokenKind.Char32_t
    );
  }

  private checkUnaryOperator(): boolean {
    const kind = this.current().token.kind;
    return (
      kind === TokenKind.Plus ||
      kind === TokenKind.Minus ||
      kind === TokenKind.Exclaim ||
      kind === TokenKind.Tilde ||
      kind === TokenKind.Star ||
      kind === TokenKind.Ampersand ||
      kind === TokenKind.PlusPlus ||
      kind === TokenKind.MinusMinus
    );
  }

  private currentOperator(): string | null {
    const token = this.current().token;
    const text = token.text;
    if (PRECEDENCE[text] !== undefined) {
      return text;
    }
    return null;
  }

  private isAssignmentOperator(op: string): boolean {
    return op === '=' || op.endsWith('=') && op !== '==' && op !== '!=' && op !== '<=' && op !== '>=' && op !== '<=>';
  }

  private looksLikeDeclaration(): boolean {
    // Simplified heuristic
    const saved = this.pos;
    try {
      // Check for type specifiers
      if (this.checkSpecifier()) return true;
      if (this.checkBuiltinType()) return true;
      if (this.check(TokenKind.Struct) || this.check(TokenKind.Class) ||
          this.check(TokenKind.Enum) || this.check(TokenKind.Typedef)) return true;

      // Check for type name followed by identifier/star
      if (this.check(TokenKind.Identifier)) {
        this.advance();
        while (this.check(TokenKind.ColonColon)) {
          this.advance();
          if (this.check(TokenKind.Identifier)) this.advance();
        }
        // Skip template args (bail on expression-only operators)
        if (this.check(TokenKind.Less)) {
          let depth = 1;
          this.advance();
          let isTemplate = true;
          while (depth > 0 && !this.isAtEnd()) {
            if (this.check(TokenKind.Less)) depth++;
            else if (this.check(TokenKind.Greater)) depth--;
            else if (this.check(TokenKind.GreaterGreater)) depth -= 2;
            else if (this.check(TokenKind.Semicolon) || this.check(TokenKind.LeftBrace) ||
                     this.check(TokenKind.AmpAmp) || this.check(TokenKind.PipePipe) ||
                     this.check(TokenKind.EqualEqual) || this.check(TokenKind.NotEqual) ||
                     this.check(TokenKind.LessEqual) || this.check(TokenKind.GreaterEqual) ||
                     this.check(TokenKind.Arrow)) {
              isTemplate = false;
              break;
            }
            this.advance();
          }
          if (!isTemplate || depth < 0) return false;
        }
        // Check for pointer/ref/qualifiers and array suffixes (interleaved, e.g. Type*[5]*)
        let madeProgress = true;
        while (madeProgress) {
          madeProgress = false;
          while (this.check(TokenKind.Star) || this.check(TokenKind.Ampersand) ||
                 this.check(TokenKind.Const) || this.check(TokenKind.Volatile) ||
                 this.check(TokenKind.Restrict)) {
            this.advance();
            madeProgress = true;
          }
          // Skip array suffixes on type: type*[N] or type[N] or type[N][M]
          while (this.check(TokenKind.LeftBracket)) {
            let depth = 1;
            this.advance();
            while (depth > 0 && !this.isAtEnd()) {
              if (this.check(TokenKind.LeftBracket)) depth++;
              else if (this.check(TokenKind.RightBracket)) depth--;
              this.advance();
            }
            madeProgress = true;
          }
        }
        if (this.check(TokenKind.Identifier)) return true;
        // Check for pointer-to-array: type (*name)[size]
        // Full pattern check to avoid false positive on expressions like g(*x)
        if (this.check(TokenKind.LeftParen) && this.checkAhead(1, TokenKind.Star) &&
            this.checkAhead(2, TokenKind.Identifier) && this.checkAhead(3, TokenKind.RightParen) &&
            this.checkAhead(4, TokenKind.LeftBracket)) return true;
      }

      return false;
    } finally {
      this.pos = saved;
    }
  }

  private looksLikeCast(): boolean {
    const saved = this.pos;
    try {
      this.advance(); // (

      if (!this.looksLikeType()) {
        return false;
      }

      // Try to consume what looks like a type declaration
      // Types can contain: identifiers, *, &, const, volatile, ::, <>, []
      // Types CANNOT contain: +, -, /, %, binary operators, numbers after identifier
      // Key heuristic: a type has at most one user-defined identifier (the type name).
      // If we see "ident * ident", it's multiplication, not a pointer type.
      let identifierCount = 0;
      let lastWasColonColon = false;
      let lastWasStar = false;
      let lastWasAmpersand = false;
      while (!this.check(TokenKind.RightParen) && !this.isAtEnd()) {
        const kind = this.current().token.kind;

        // Valid type tokens
        if (kind === TokenKind.Identifier) {
          if (!lastWasColonColon) {
            identifierCount++;
          }
          // Two non-qualified identifiers = expression like (a * b) or (a & b), not a cast
          if (identifierCount > 1 && (lastWasStar || lastWasAmpersand)) {
            return false;
          }
          lastWasColonColon = false;
          lastWasStar = false;
          lastWasAmpersand = false;
          this.advance();
          continue;
        }
        if (kind === TokenKind.Star) {
          // &* is invalid in C++ types (pointer to reference) — this is expr & *deref
          if (lastWasAmpersand) {
            return false;
          }
          lastWasStar = true;
          lastWasColonColon = false;
          lastWasAmpersand = false;
          this.advance();
          continue;
        }
        if (kind === TokenKind.ColonColon) {
          lastWasColonColon = true;
          lastWasStar = false;
          lastWasAmpersand = false;
          this.advance();
          continue;
        }
        if (kind === TokenKind.Ampersand) {
          lastWasAmpersand = true;
          lastWasColonColon = false;
          lastWasStar = false;
          this.advance();
          continue;
        }
        if (kind === TokenKind.Const ||
            kind === TokenKind.Volatile ||
            kind === TokenKind.Unsigned ||
            kind === TokenKind.Signed ||
            kind === TokenKind.Long ||
            kind === TokenKind.Short ||
            kind === TokenKind.Int ||
            kind === TokenKind.Char ||
            kind === TokenKind.Void ||
            kind === TokenKind.Float ||
            kind === TokenKind.Double ||
            kind === TokenKind.Bool ||
            kind === TokenKind.Wchar_t ||
            kind === TokenKind.Char8_t ||
            kind === TokenKind.Char16_t ||
            kind === TokenKind.Char32_t ||
            kind === TokenKind.Restrict ||
            kind === TokenKind.Struct ||
            kind === TokenKind.Class ||
            kind === TokenKind.Enum) {
          lastWasColonColon = false;
          lastWasStar = false;
          lastWasAmpersand = false;
          this.advance();
          continue;
        }

        // Template arguments - skip balanced <>
        if (kind === TokenKind.Less) {
          let depth = 1;
          this.advance();
          while (depth > 0 && !this.isAtEnd()) {
            if (this.check(TokenKind.Less)) depth++;
            else if (this.check(TokenKind.Greater)) depth--;
            else if (this.check(TokenKind.GreaterGreater)) depth -= 2;
            this.advance();
          }
          continue;
        }

        // Array declarator - skip balanced []
        if (kind === TokenKind.LeftBracket) {
          let depth = 1;
          this.advance();
          while (depth > 0 && !this.isAtEnd()) {
            if (this.check(TokenKind.LeftBracket)) depth++;
            else if (this.check(TokenKind.RightBracket)) depth--;
            this.advance();
          }
          continue;
        }

        // Pointer-to-array cast: (char (*) [4]) or (int (*) [12])
        // Skip balanced () inside type
        if (kind === TokenKind.LeftParen) {
          let depth = 1;
          this.advance();
          while (depth > 0 && !this.isAtEnd()) {
            if (this.check(TokenKind.LeftParen)) depth++;
            else if (this.check(TokenKind.RightParen)) depth--;
            this.advance();
          }
          continue;
        }

        // Any other token means this is NOT a type - it's an expression
        // This catches: +, -, /, %, numbers, etc.
        return false;
      }

      if (this.check(TokenKind.RightParen)) {
        this.advance();
        // After ) a cast MUST be followed by a valid expression start.
        // If followed by ; ) , ] } it's a parenthesized expression, not a cast.
        if (this.check(TokenKind.Semicolon) || this.check(TokenKind.RightParen) ||
            this.check(TokenKind.Comma) || this.check(TokenKind.RightBracket) ||
            this.check(TokenKind.RightBrace) || this.check(TokenKind.Colon) ||
            this.check(TokenKind.EOF)) {
          return false;
        }
        // Cast is followed by: identifier, literal, (, unary op, sizeof, or another cast
        // Binary-only operators like + - * can also appear (as unary)
        return !this.currentOperator() || this.checkUnaryOperator() ||
               this.check(TokenKind.LeftParen) || this.check(TokenKind.Identifier) ||
               this.check(TokenKind.IntegerLiteral) || this.check(TokenKind.StringLiteral) ||
               this.check(TokenKind.CharLiteral) || this.check(TokenKind.FloatingLiteral) ||
               this.check(TokenKind.Sizeof) || this.check(TokenKind.True) ||
               this.check(TokenKind.False) || this.check(TokenKind.Nullptr) ||
               this.check(TokenKind.This);
      }
      return false;
    } finally {
      this.pos = saved;
    }
  }

  private looksLikeType(): boolean {
    return this.checkBuiltinType() ||
           this.check(TokenKind.Struct) ||
           this.check(TokenKind.Class) ||
           this.check(TokenKind.Enum) ||
           this.check(TokenKind.Const) ||
           this.check(TokenKind.Volatile) ||
           this.check(TokenKind.Restrict) ||
           this.check(TokenKind.Identifier);
  }

  /**
   * Check if current position looks like an abstract pointer declarator: (*) or (**)
   * Used in cast types like (char (*) [32]) or (char (**) [32])
   */
  private looksLikeAbstractPtrDeclarator(): boolean {
    const saved = this.pos;
    try {
      if (!this.check(TokenKind.LeftParen)) return false;
      this.advance(); // (
      if (!this.check(TokenKind.Star)) return false;
      while (this.check(TokenKind.Star)) this.advance(); // *, **, etc.
      return this.check(TokenKind.RightParen);
    } finally {
      this.pos = saved;
    }
  }

  /**
   * Check if current position looks like a pointer-to-array declaration: (*name)[size]
   */
  private looksLikePointerToArrayDecl(): boolean {
    const saved = this.pos;
    try {
      if (!this.check(TokenKind.LeftParen)) return false;
      this.advance(); // (
      if (!this.check(TokenKind.Star)) return false;
      this.advance(); // *
      if (!this.check(TokenKind.Identifier)) return false;
      this.advance(); // name
      if (!this.check(TokenKind.RightParen)) return false;
      this.advance(); // )
      return this.check(TokenKind.LeftBracket);
    } finally {
      this.pos = saved;
    }
  }

  /**
   * Parse pointer-to-array declaration: type (*name)[size]
   */
  private parsePointerToArrayDecl(
    startLoc: SourceLocation,
    specifiers: VariableSpecifier[],
    baseType: TypeNode
  ): VariableDecl {
    this.expect(TokenKind.LeftParen);
    this.expect(TokenKind.Star);
    const name = this.parseIdentifier();
    this.expect(TokenKind.RightParen);
    this.expect(TokenKind.LeftBracket);
    const size = this.check(TokenKind.RightBracket) ? null : this.parseExpression();
    this.expect(TokenKind.RightBracket);

    // Build the type: pointer to array of baseType
    const arrayType = this.node(NodeKind.ArrayType, startLoc, {
      elementType: baseType,
      size,
    }) as ArrayType;
    const ptrType = this.node(NodeKind.PointerType, startLoc, {
      pointee: arrayType,
      qualifiers: [],
    }) as PointerType;

    let initializer: Expression | null = null;
    if (this.match(TokenKind.Equal)) {
      if (this.check(TokenKind.LeftBrace)) {
        initializer = this.parseInitializerList();
      } else {
        initializer = this.parseAssignmentExpression();
      }
    }

    this.expect(TokenKind.Semicolon);

    return this.node(NodeKind.VariableDecl, startLoc, {
      name,
      type: ptrType,
      initializer,
      specifiers,
      attributes: [],
    }) as VariableDecl;
  }

  private looksLikeTemplateArgs(): boolean {
    // Heuristic: < followed by type-like tokens and eventually >
    // Bail on tokens that can't appear in template arguments
    const saved = this.pos;
    try {
      this.advance(); // <
      let depth = 1;
      while (depth > 0 && !this.isAtEnd()) {
        if (this.check(TokenKind.Less)) depth++;
        else if (this.check(TokenKind.Greater)) depth--;
        else if (this.check(TokenKind.GreaterGreater)) depth -= 2;
        else if (this.check(TokenKind.Semicolon) || this.check(TokenKind.LeftBrace) ||
                 this.check(TokenKind.AmpAmp) || this.check(TokenKind.PipePipe) ||
                 this.check(TokenKind.EqualEqual) || this.check(TokenKind.NotEqual) ||
                 this.check(TokenKind.LessEqual) || this.check(TokenKind.GreaterEqual) ||
                 this.check(TokenKind.Arrow)) {
          return false; // Definitely not template args
        }
        this.advance();
      }
      return depth === 0;
    } finally {
      this.pos = saved;
    }
  }
}

/**
 * Parse C++ source code
 */
export function parse(source: string, options?: ParserOptions): TranslationUnit {
  const parser = new Parser(source, options);
  return parser.parse();
}
