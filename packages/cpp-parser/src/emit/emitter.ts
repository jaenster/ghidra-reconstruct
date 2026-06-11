/**
 * C++ Code Emitter
 * Pretty printer that emits valid C++ code from AST nodes
 */

import { NodeKind } from '../ast/kinds.js';
import { TriviaKind, type Trivia } from '../lexer/trivia.js';
import type {
  AnyNode,
  ASTNode,
  // Types
  TypeNode,
  BuiltinType,
  PointerType,
  ReferenceType,
  RValueReferenceType,
  ArrayType,
  FunctionType,
  QualifiedType,
  ElaboratedType,
  TypedefType,
  TemplateType,
  AutoType,
  DecltypeType,
  TypeofType,
  MemberPointerType,
  TemplateArgument,
  TypeTemplateArg,
  ExprTemplateArg,
  TemplateTemplateArg,

  // Declarations
  TranslationUnit,
  Declaration,
  FunctionDecl,
  VariableDecl,
  ParameterDecl,
  ClassDecl,
  StructDecl,
  UnionDecl,
  EnumDecl,
  EnumeratorDecl,
  NamespaceDecl,
  TypedefDecl,
  TypeAliasDecl,
  UsingDecl,
  UsingDirective,
  TemplateDecl,
  FieldDecl,
  MethodDecl,
  ConstructorDecl,
  DestructorDecl,
  FriendDecl,
  AccessSpecifierNode,
  StaticAssertDecl,
  LinkageSpec,
  NamespaceAlias,
  AsmDecl,
  EmptyDecl,
  BaseSpecifier,
  MemberInitializer,
  TemplateParameter,
  TemplateTypeParam,
  TemplateNonTypeParam,
  TemplateTemplateParam,

  // Statements
  Statement,
  CompoundStmt,
  ExprStmt,
  DeclStmt,
  IfStmt,
  SwitchStmt,
  CaseStmt,
  DefaultStmt,
  WhileStmt,
  DoWhileStmt,
  ForStmt,
  ForRangeStmt,
  BreakStmt,
  ContinueStmt,
  ReturnStmt,
  GotoStmt,
  LabelStmt,
  NullStmt,
  TryStmt,
  CatchClause,
  CoReturnStmt,

  // Expressions
  Expression,
  IntegerLiteralExpr,
  FloatingLiteralExpr,
  CharLiteralExpr,
  StringLiteralExpr,
  BoolLiteralExpr,
  NullptrLiteralExpr,
  UserDefinedLiteralExpr,
  Identifier,
  QualifiedId,
  ThisExpr,
  ParenExpr,
  BinaryExpr,
  UnaryExpr,
  PostfixExpr,
  ConditionalExpr,
  AssignExpr,
  CommaExpr,
  MemberExpr,
  SubscriptExpr,
  CallExpr,
  CStyleCastExpr,
  StaticCastExpr,
  DynamicCastExpr,
  ReinterpretCastExpr,
  ConstCastExpr,
  FunctionalCastExpr,
  SizeofExpr,
  AlignofExpr,
  TypeidExpr,
  NoexceptExpr,
  NewExpr,
  DeleteExpr,
  LambdaExpr,
  LambdaCapture,
  FoldExpr,
  InitListExpr,
  DesignatedInitExpr,
  PackExpansionExpr,
  SizeofPackExpr,
  RequiresExpr,
  ThrowExpr,
  CoYieldExpr,
  CoAwaitExpr,
  BinaryOperator,

  // Misc
  Attribute,
  RequiresClause,
} from '../ast/nodes.js';
import type { EmitStyle } from './style.js';
import { DEFAULT_STYLE } from './style.js';

/**
 * Operator precedence for parenthesization
 * Lower number = higher precedence
 */
const OPERATOR_PRECEDENCE: Record<string, number> = {
  // Scope resolution
  '::': 1,

  // Postfix
  '++_post': 2,
  '--_post': 2,
  '()': 2,
  '[]': 2,
  '.': 2,
  '->': 2,

  // Prefix/Unary
  '++_pre': 3,
  '--_pre': 3,
  '+_unary': 3,
  '-_unary': 3,
  '!': 3,
  '~': 3,
  '*_unary': 3, // dereference
  '&_unary': 3, // address-of
  'sizeof': 3,
  'alignof': 3,
  'new': 3,
  'delete': 3,

  // Pointer to member
  '.*': 4,
  '->*': 4,

  // Multiplicative
  '*': 5,
  '/': 5,
  '%': 5,

  // Additive
  '+': 6,
  '-': 6,

  // Shift
  '<<': 7,
  '>>': 7,

  // Three-way comparison
  '<=>': 8,

  // Relational
  '<': 9,
  '<=': 9,
  '>': 9,
  '>=': 9,

  // Equality
  '==': 10,
  '!=': 10,

  // Bitwise AND
  '&': 11,

  // Bitwise XOR
  '^': 12,

  // Bitwise OR
  '|': 13,

  // Logical AND
  '&&': 14,

  // Logical OR
  '||': 15,

  // Conditional
  '?:': 16,

  // Assignment (right-to-left associative)
  '=': 17,
  '+=': 17,
  '-=': 17,
  '*=': 17,
  '/=': 17,
  '%=': 17,
  '<<=': 17,
  '>>=': 17,
  '&=': 17,
  '^=': 17,
  '|=': 17,

  // Comma
  ',': 18,
};

/** Operators that are truly associative: a op (b op c) ≡ (a op b) op c */
const ASSOCIATIVE_OPS = new Set(['+', '*', '&&', '||', '&', '|', '^']);

/**
 * C++ Code Emitter
 */
export class CppEmitter {
  private style: EmitStyle;
  private indentLevel: number = 0;
  private output: string[] = [];

  constructor(style: Partial<EmitStyle> = {}) {
    this.style = { ...DEFAULT_STYLE, ...style };
  }

  /**
   * Emit code for any AST node
   */
  emit(node: AnyNode): string {
    this.output = [];
    this.indentLevel = 0;
    this.emitNode(node);
    return this.output.join('');
  }

  /**
   * Get the current indentation string
   */
  private indent(): string {
    if (this.style.useTabs) {
      return '\t'.repeat(this.indentLevel);
    }
    return ' '.repeat(this.indentLevel * this.style.indentWidth);
  }

  /**
   * Write text to output
   */
  private write(text: string): void {
    this.output.push(text);
  }

  /**
   * Write a newline
   */
  private newline(): void {
    this.write(this.style.lineEnding);
  }

  /**
   * Write text with current indentation
   */
  private writeLine(text: string = ''): void {
    this.write(this.indent() + text + this.style.lineEnding);
  }

  /**
   * Emit trivia (comments, whitespace preserved from source)
   */
  private emitTrivia(trivia: Trivia[] | undefined): void {
    if (!trivia || trivia.length === 0) return;

    for (const t of trivia) {
      switch (t.kind) {
        case TriviaKind.BlockComment:
          this.write(t.text);
          this.write(' ');
          break;
        case TriviaKind.LineComment:
          this.write(t.text);
          this.newline();
          this.write(this.indent());
          break;
        // Whitespace and newlines are typically reconstructed by the emitter
        // based on formatting rules, so we skip them
        default:
          break;
      }
    }
  }

  /**
   * Emit any node (dispatcher)
   */
  private emitNode(node: ASTNode): void {
    // Emit leading trivia (comments before this node)
    this.emitTrivia(node.leadingTrivia);
    switch (node.kind) {
      // Translation Unit
      case NodeKind.TranslationUnit:
        this.emitTranslationUnit(node as TranslationUnit);
        break;

      // Types
      case NodeKind.BuiltinType:
        this.emitBuiltinType(node as BuiltinType);
        break;
      case NodeKind.PointerType:
        this.emitPointerType(node as PointerType);
        break;
      case NodeKind.ReferenceType:
        this.emitReferenceType(node as ReferenceType);
        break;
      case NodeKind.RValueReferenceType:
        this.emitRValueReferenceType(node as RValueReferenceType);
        break;
      case NodeKind.ArrayType:
        this.emitArrayType(node as ArrayType);
        break;
      case NodeKind.FunctionType:
        this.emitFunctionType(node as FunctionType);
        break;
      case NodeKind.QualifiedType:
        this.emitQualifiedType(node as QualifiedType);
        break;
      case NodeKind.ElaboratedType:
        this.emitElaboratedType(node as ElaboratedType);
        break;
      case NodeKind.TypedefType:
        this.emitTypedefType(node as TypedefType);
        break;
      case NodeKind.TemplateType:
        this.emitTemplateType(node as TemplateType);
        break;
      case NodeKind.AutoType:
        this.emitAutoType(node as AutoType);
        break;
      case NodeKind.DecltypeType:
        this.emitDecltypeType(node as DecltypeType);
        break;
      case NodeKind.TypeofType:
        this.emitTypeofType(node as TypeofType);
        break;
      case NodeKind.MemberPointerType:
        this.emitMemberPointerType(node as MemberPointerType);
        break;

      // Declarations
      case NodeKind.FunctionDecl:
        this.emitFunctionDecl(node as FunctionDecl);
        break;
      case NodeKind.VariableDecl:
        this.emitVariableDecl(node as VariableDecl);
        break;
      case NodeKind.ParameterDecl:
        this.emitParameterDecl(node as ParameterDecl);
        break;
      case NodeKind.ClassDecl:
        this.emitClassDecl(node as ClassDecl);
        break;
      case NodeKind.StructDecl:
        this.emitStructDecl(node as StructDecl);
        break;
      case NodeKind.UnionDecl:
        this.emitUnionDecl(node as UnionDecl);
        break;
      case NodeKind.EnumDecl:
        this.emitEnumDecl(node as EnumDecl);
        break;
      case NodeKind.EnumeratorDecl:
        this.emitEnumeratorDecl(node as EnumeratorDecl);
        break;
      case NodeKind.NamespaceDecl:
        this.emitNamespaceDecl(node as NamespaceDecl);
        break;
      case NodeKind.TypedefDecl:
        this.emitTypedefDecl(node as TypedefDecl);
        break;
      case NodeKind.TypeAliasDecl:
        this.emitTypeAliasDecl(node as TypeAliasDecl);
        break;
      case NodeKind.UsingDecl:
        this.emitUsingDecl(node as UsingDecl);
        break;
      case NodeKind.UsingDirective:
        this.emitUsingDirective(node as UsingDirective);
        break;
      case NodeKind.TemplateDecl:
        this.emitTemplateDecl(node as TemplateDecl);
        break;
      case NodeKind.FieldDecl:
        this.emitFieldDecl(node as FieldDecl);
        break;
      case NodeKind.MethodDecl:
        this.emitMethodDecl(node as MethodDecl);
        break;
      case NodeKind.ConstructorDecl:
        this.emitConstructorDecl(node as ConstructorDecl);
        break;
      case NodeKind.DestructorDecl:
        this.emitDestructorDecl(node as DestructorDecl);
        break;
      case NodeKind.FriendDecl:
        this.emitFriendDecl(node as FriendDecl);
        break;
      case NodeKind.AccessSpecifier:
        this.emitAccessSpecifier(node as AccessSpecifierNode);
        break;
      case NodeKind.StaticAssertDecl:
        this.emitStaticAssertDecl(node as StaticAssertDecl);
        break;
      case NodeKind.LinkageSpec:
        this.emitLinkageSpec(node as LinkageSpec);
        break;
      case NodeKind.NamespaceAlias:
        this.emitNamespaceAlias(node as NamespaceAlias);
        break;
      case NodeKind.AsmDecl:
        this.emitAsmDecl(node as AsmDecl);
        break;
      case NodeKind.EmptyDecl:
        this.write(';');
        break;

      // Statements
      case NodeKind.CompoundStmt:
        this.emitCompoundStmt(node as CompoundStmt);
        break;
      case NodeKind.ExprStmt:
        this.emitExprStmt(node as ExprStmt);
        break;
      case NodeKind.DeclStmt:
        this.emitDeclStmt(node as DeclStmt);
        break;
      case NodeKind.IfStmt:
        this.emitIfStmt(node as IfStmt);
        break;
      case NodeKind.SwitchStmt:
        this.emitSwitchStmt(node as SwitchStmt);
        break;
      case NodeKind.CaseStmt:
        this.emitCaseStmt(node as CaseStmt);
        break;
      case NodeKind.DefaultStmt:
        this.emitDefaultStmt(node as DefaultStmt);
        break;
      case NodeKind.WhileStmt:
        this.emitWhileStmt(node as WhileStmt);
        break;
      case NodeKind.DoWhileStmt:
        this.emitDoWhileStmt(node as DoWhileStmt);
        break;
      case NodeKind.ForStmt:
        this.emitForStmt(node as ForStmt);
        break;
      case NodeKind.ForRangeStmt:
        this.emitForRangeStmt(node as ForRangeStmt);
        break;
      case NodeKind.BreakStmt:
        this.write('break');
        break;
      case NodeKind.ContinueStmt:
        this.write('continue');
        break;
      case NodeKind.ReturnStmt:
        this.emitReturnStmt(node as ReturnStmt);
        break;
      case NodeKind.GotoStmt:
        this.emitGotoStmt(node as GotoStmt);
        break;
      case NodeKind.LabelStmt:
        this.emitLabelStmt(node as LabelStmt);
        break;
      case NodeKind.NullStmt:
        // Empty statement, nothing to emit
        break;
      case NodeKind.TryStmt:
        this.emitTryStmt(node as TryStmt);
        break;
      case NodeKind.CatchClause:
        this.emitCatchClause(node as CatchClause);
        break;
      case NodeKind.CoReturnStmt:
        this.emitCoReturnStmt(node as CoReturnStmt);
        break;

      // Expressions
      case NodeKind.IntegerLiteral:
        this.emitIntegerLiteral(node as IntegerLiteralExpr);
        break;
      case NodeKind.FloatingLiteral:
        this.emitFloatingLiteral(node as FloatingLiteralExpr);
        break;
      case NodeKind.CharLiteral:
        this.emitCharLiteral(node as CharLiteralExpr);
        break;
      case NodeKind.StringLiteral:
        this.emitStringLiteral(node as StringLiteralExpr);
        break;
      case NodeKind.BoolLiteral:
        this.emitBoolLiteral(node as BoolLiteralExpr);
        break;
      case NodeKind.NullptrLiteral:
        this.write('nullptr');
        break;
      case NodeKind.UserDefinedLiteral:
        this.emitUserDefinedLiteral(node as UserDefinedLiteralExpr);
        break;
      case NodeKind.Identifier:
        this.emitIdentifier(node as Identifier);
        break;
      case NodeKind.QualifiedId:
        this.emitQualifiedId(node as QualifiedId);
        break;
      case NodeKind.ThisExpr:
        this.write('this');
        break;
      case NodeKind.ParenExpr:
        this.emitParenExpr(node as ParenExpr);
        break;
      case NodeKind.BinaryExpr:
        this.emitBinaryExpr(node as BinaryExpr);
        break;
      case NodeKind.UnaryExpr:
        this.emitUnaryExpr(node as UnaryExpr);
        break;
      case NodeKind.PostfixExpr:
        this.emitPostfixExpr(node as PostfixExpr);
        break;
      case NodeKind.ConditionalExpr:
        this.emitConditionalExpr(node as ConditionalExpr);
        break;
      case NodeKind.AssignExpr:
        this.emitAssignExpr(node as AssignExpr);
        break;
      case NodeKind.CommaExpr:
        this.emitCommaExpr(node as CommaExpr);
        break;
      case NodeKind.MemberExpr:
        this.emitMemberExpr(node as MemberExpr);
        break;
      case NodeKind.SubscriptExpr:
        this.emitSubscriptExpr(node as SubscriptExpr);
        break;
      case NodeKind.CallExpr:
        this.emitCallExpr(node as CallExpr);
        break;
      case NodeKind.CStyleCastExpr:
        this.emitCStyleCastExpr(node as CStyleCastExpr);
        break;
      case NodeKind.StaticCastExpr:
        this.emitStaticCastExpr(node as StaticCastExpr);
        break;
      case NodeKind.DynamicCastExpr:
        this.emitDynamicCastExpr(node as DynamicCastExpr);
        break;
      case NodeKind.ReinterpretCastExpr:
        this.emitReinterpretCastExpr(node as ReinterpretCastExpr);
        break;
      case NodeKind.ConstCastExpr:
        this.emitConstCastExpr(node as ConstCastExpr);
        break;
      case NodeKind.FunctionalCastExpr:
        this.emitFunctionalCastExpr(node as FunctionalCastExpr);
        break;
      case NodeKind.SizeofExpr:
        this.emitSizeofExpr(node as SizeofExpr);
        break;
      case NodeKind.AlignofExpr:
        this.emitAlignofExpr(node as AlignofExpr);
        break;
      case NodeKind.TypeidExpr:
        this.emitTypeidExpr(node as TypeidExpr);
        break;
      case NodeKind.NoexceptExpr:
        this.emitNoexceptExpr(node as NoexceptExpr);
        break;
      case NodeKind.NewExpr:
        this.emitNewExpr(node as NewExpr);
        break;
      case NodeKind.DeleteExpr:
        this.emitDeleteExpr(node as DeleteExpr);
        break;
      case NodeKind.LambdaExpr:
        this.emitLambdaExpr(node as LambdaExpr);
        break;
      case NodeKind.FoldExpr:
        this.emitFoldExpr(node as FoldExpr);
        break;
      case NodeKind.InitListExpr:
        this.emitInitListExpr(node as InitListExpr);
        break;
      case NodeKind.DesignatedInitExpr:
        this.emitDesignatedInitExpr(node as DesignatedInitExpr);
        break;
      case NodeKind.PackExpansionExpr:
        this.emitPackExpansionExpr(node as PackExpansionExpr);
        break;
      case NodeKind.SizeofPackExpr:
        this.emitSizeofPackExpr(node as SizeofPackExpr);
        break;
      case NodeKind.RequiresExpr:
        this.emitRequiresExpr(node as RequiresExpr);
        break;
      case NodeKind.ThrowExpr:
        this.emitThrowExpr(node as ThrowExpr);
        break;
      case NodeKind.CoYieldExpr:
        this.emitCoYieldExpr(node as CoYieldExpr);
        break;
      case NodeKind.CoAwaitExpr:
        this.emitCoAwaitExpr(node as CoAwaitExpr);
        break;

      // Misc
      case NodeKind.Attribute:
        this.emitAttribute(node as Attribute);
        break;
      case NodeKind.RequiresClause:
        this.emitRequiresClause(node as RequiresClause);
        break;

      default:
        throw new Error(`Unsupported node kind: ${node.kind}`);
    }

    // Emit trailing trivia (comments after this node)
    this.emitTrivia(node.trailingTrivia);
  }

  // ============================================
  // Translation Unit
  // ============================================

  private emitTranslationUnit(node: TranslationUnit): void {
    for (let i = 0; i < node.declarations.length; i++) {
      if (i > 0 && this.style.blankLineBetweenFunctions) {
        const prev = node.declarations[i - 1];
        const curr = node.declarations[i];
        if (prev.kind === NodeKind.FunctionDecl || curr.kind === NodeKind.FunctionDecl) {
          this.newline();
        }
      }
      this.emitNode(node.declarations[i]);
      this.newline();
    }
  }

  // ============================================
  // Types
  // ============================================

  private emitBuiltinType(node: BuiltinType): void {
    const parts: string[] = [];
    for (const mod of node.modifiers) {
      parts.push(mod);
    }
    parts.push(node.name);
    this.write(parts.join(' '));
  }

  private emitPointerType(node: PointerType): void {
    this.emitTypeNode(node.pointee);
    const qualStr = node.qualifiers.length > 0 ? ' ' + node.qualifiers.join(' ') : '';
    switch (this.style.pointerAlignment) {
      case 'left':
        this.write('*' + qualStr);
        break;
      case 'right':
        this.write(' *' + qualStr);
        break;
      case 'middle':
        this.write(' *' + qualStr);
        break;
    }
  }

  private emitReferenceType(node: ReferenceType): void {
    this.emitTypeNode(node.referenced);
    switch (this.style.pointerAlignment) {
      case 'left':
        this.write('&');
        break;
      case 'right':
        this.write(' &');
        break;
      case 'middle':
        this.write(' &');
        break;
    }
  }

  private emitRValueReferenceType(node: RValueReferenceType): void {
    this.emitTypeNode(node.referenced);
    switch (this.style.pointerAlignment) {
      case 'left':
        this.write('&&');
        break;
      case 'right':
        this.write(' &&');
        break;
      case 'middle':
        this.write(' &&');
        break;
    }
  }

  private emitArrayType(node: ArrayType): void {
    this.emitTypeNode(node.elementType);
    this.write('[');
    if (node.size) {
      this.emitNode(node.size);
    }
    this.write(']');
  }

  /**
   * Unwrap nested ArrayType nodes, returning the innermost element type
   * and the list of dimension sizes. Used for C/C++ declarator syntax where
   * array brackets go after the variable name, not in the type specifier.
   */
  private unwrapArrayType(type: TypeNode): { elementType: TypeNode; arraySizes: (Expression | null)[] } {
    let current = type;
    const arraySizes: (Expression | null)[] = [];
    while (current.kind === NodeKind.ArrayType) {
      const arr = current as ArrayType;
      arraySizes.push(arr.size);
      current = arr.elementType;
    }
    return { elementType: current, arraySizes };
  }

  /** Emit array dimension brackets: [40], [3][4], etc. */
  private emitArrayDimensions(sizes: (Expression | null)[]): void {
    for (const size of sizes) {
      this.write('[');
      if (size) this.emitNode(size);
      this.write(']');
    }
  }

  private emitFunctionType(node: FunctionType): void {
    this.emitTypeNode(node.returnType);
    this.write('(');
    if (this.style.spaceInsideParens) this.write(' ');
    for (let i = 0; i < node.parameters.length; i++) {
      if (i > 0) {
        this.write(',');
        if (this.style.spaceAfterComma) this.write(' ');
      }
      this.emitTypeNode(node.parameters[i]);
    }
    if (node.isVariadic) {
      if (node.parameters.length > 0) {
        this.write(',');
        if (this.style.spaceAfterComma) this.write(' ');
      }
      this.write('...');
    }
    if (this.style.spaceInsideParens) this.write(' ');
    this.write(')');
    if (node.qualifiers.length > 0) {
      this.write(' ' + node.qualifiers.join(' '));
    }
  }

  private emitQualifiedType(node: QualifiedType): void {
    this.write(node.qualifiers.join(' ') + ' ');
    this.emitTypeNode(node.type);
  }

  private emitElaboratedType(node: ElaboratedType): void {
    this.write(node.keyword + ' ');
    this.emitNode(node.name);
  }

  private emitTypedefType(node: TypedefType): void {
    this.emitNode(node.name);
  }

  private emitTemplateType(node: TemplateType): void {
    this.emitNode(node.name);
    this.write('<');
    for (let i = 0; i < node.arguments.length; i++) {
      if (i > 0) {
        this.write(',');
        if (this.style.spaceAfterComma) this.write(' ');
      }
      this.emitTemplateArgument(node.arguments[i]);
    }
    this.write('>');
  }

  private emitAutoType(node: AutoType): void {
    if (node.isDecltypeAuto) {
      this.write('decltype(auto)');
    } else {
      this.write('auto');
    }
  }

  private emitDecltypeType(node: DecltypeType): void {
    this.write('decltype(');
    this.emitNode(node.expression);
    this.write(')');
  }

  private emitTypeofType(node: TypeofType): void {
    this.write('typeof(');
    this.emitNode(node.expression);
    this.write(')');
  }

  private emitMemberPointerType(node: MemberPointerType): void {
    this.emitTypeNode(node.classType);
    this.write('::*');
    this.emitTypeNode(node.memberType);
  }

  private emitTypeNode(node: TypeNode): void {
    this.emitNode(node);
  }

  private emitTemplateArgument(arg: TemplateArgument): void {
    switch (arg.kind) {
      case NodeKind.TypeTemplateArg:
        this.emitTypeNode((arg as TypeTemplateArg).type);
        break;
      case NodeKind.ExprTemplateArg:
        this.emitNode((arg as ExprTemplateArg).expression);
        break;
      case NodeKind.TemplateTemplateArg:
        this.emitNode((arg as TemplateTemplateArg).name);
        break;
    }
  }

  // ============================================
  // Declarations
  // ============================================

  private emitAttributes(attrs: Attribute[]): void {
    if (attrs.length === 0) return;
    this.write('[[');
    for (let i = 0; i < attrs.length; i++) {
      if (i > 0) {
        this.write(',');
        if (this.style.spaceAfterComma) this.write(' ');
      }
      this.emitAttributeContent(attrs[i]);
    }
    this.write(']] ');
  }

  private emitAttributeContent(attr: Attribute): void {
    if (attr.namespace) {
      this.emitIdentifier(attr.namespace);
      this.write('::');
    }
    this.emitIdentifier(attr.name);
    if (attr.arguments.length > 0) {
      this.write('(');
      for (let i = 0; i < attr.arguments.length; i++) {
        if (i > 0) {
          this.write(',');
          if (this.style.spaceAfterComma) this.write(' ');
        }
        this.emitNode(attr.arguments[i] as ASTNode);
      }
      this.write(')');
    }
  }

  private emitFunctionDecl(node: FunctionDecl): void {
    this.write(this.indent());
    this.emitAttributes(node.attributes);

    // Specifiers
    if (node.specifiers.length > 0) {
      this.write(node.specifiers.join(' ') + ' ');
    }

    // Return type
    this.emitTypeNode(node.returnType);
    this.write(' ');

    // Calling convention (Ghidra: void __fastcall FUN_...)
    if (node.callingConvention) {
      this.write(node.callingConvention + ' ');
    }

    // Name
    this.emitNode(node.name);

    // Parameters
    if (this.style.spaceBeforeFunctionParen) this.write(' ');
    this.write('(');
    if (this.style.spaceInsideParens && node.parameters.length > 0) this.write(' ');
    for (let i = 0; i < node.parameters.length; i++) {
      if (i > 0) {
        this.write(',');
        if (this.style.spaceAfterComma) this.write(' ');
      }
      this.emitParameterDecl(node.parameters[i]);
    }
    if (node.isVariadic) {
      if (node.parameters.length > 0) {
        this.write(',');
        if (this.style.spaceAfterComma) this.write(' ');
      }
      this.write('...');
    }
    if (this.style.spaceInsideParens && node.parameters.length > 0) this.write(' ');
    this.write(')');

    // Requires clause
    if (node.requiresClause) {
      this.write(' ');
      this.emitRequiresClause(node.requiresClause);
    }

    // Body or semicolon
    if (node.body) {
      if (this.style.braceStyle !== 'allman') {
        this.write(' ');
      }
      this.emitCompoundStmt(node.body);
    } else {
      this.write(';');
    }
  }

  private emitParameterDecl(node: ParameterDecl): void {
    // Unwrap array type — C/C++ requires brackets after the declarator name
    const { elementType: paramElemType, arraySizes: paramArraySizes } = this.unwrapArrayType(node.type);
    this.emitTypeNode(paramElemType);
    if (node.name) {
      this.write(' ');
      this.emitIdentifier(node.name);
      this.emitArrayDimensions(paramArraySizes);
    }
    if (node.isVariadic) {
      this.write('...');
    }
    if (node.defaultValue) {
      if (this.style.spaceAroundOperators) {
        this.write(' = ');
      } else {
        this.write('=');
      }
      this.emitNode(node.defaultValue);
    }
  }

  private emitVariableDecl(node: VariableDecl): void {
    this.write(this.indent());
    this.emitAttributes(node.attributes);

    if (node.specifiers.length > 0) {
      this.write(node.specifiers.join(' ') + ' ');
    }

    // Unwrap array type — C/C++ requires brackets after the declarator name
    const { elementType, arraySizes } = this.unwrapArrayType(node.type);
    this.emitTypeNode(elementType);
    this.write(' ');
    this.emitIdentifier(node.name);
    this.emitArrayDimensions(arraySizes);

    if (node.initializer) {
      if (node.initializer.kind === NodeKind.InitListExpr) {
        this.emitInitListExpr(node.initializer as InitListExpr);
      } else {
        if (this.style.spaceAroundOperators) {
          this.write(' = ');
        } else {
          this.write('=');
        }
        this.emitNode(node.initializer);
      }
    }
    this.write(';');
  }

  private emitClassDecl(node: ClassDecl): void {
    this.emitClassOrStructDecl(node, 'class');
  }

  private emitStructDecl(node: StructDecl): void {
    this.emitClassOrStructDecl(node, 'struct');
  }

  private emitClassOrStructDecl(
    node: ClassDecl | StructDecl,
    keyword: 'class' | 'struct'
  ): void {
    this.write(this.indent());
    this.emitAttributes(node.attributes);
    this.write(keyword);

    if (node.name) {
      this.write(' ');
      this.emitIdentifier(node.name);
    }

    if (node.isFinal) {
      this.write(' final');
    }

    // Base specifiers
    if (node.bases.length > 0) {
      if (this.style.spaceBeforeColon) this.write(' ');
      this.write(':');
      if (this.style.spaceAfterColon) this.write(' ');
      for (let i = 0; i < node.bases.length; i++) {
        if (i > 0) {
          this.write(',');
          if (this.style.spaceAfterComma) this.write(' ');
        }
        this.emitBaseSpecifier(node.bases[i]);
      }
    }

    this.write(' ');
    this.emitOpenBrace();
    this.newline();
    this.indentLevel++;

    for (const member of node.members) {
      this.emitNode(member);
      this.newline();
    }

    this.indentLevel--;
    this.write(this.indent() + '};');
  }

  private emitBaseSpecifier(node: BaseSpecifier): void {
    if (node.isVirtual) {
      this.write('virtual ');
    }
    if (node.access) {
      this.write(node.access + ' ');
    }
    this.emitTypeNode(node.type);
    if (node.isPackExpansion) {
      this.write('...');
    }
  }

  private emitUnionDecl(node: UnionDecl): void {
    this.write(this.indent());
    this.emitAttributes(node.attributes);
    this.write('union');

    if (node.name) {
      this.write(' ');
      this.emitIdentifier(node.name);
    }

    this.write(' ');
    this.emitOpenBrace();
    this.newline();
    this.indentLevel++;

    for (const member of node.members) {
      this.emitNode(member);
      this.newline();
    }

    this.indentLevel--;
    this.write(this.indent() + '};');
  }

  private emitEnumDecl(node: EnumDecl): void {
    this.write(this.indent());
    this.emitAttributes(node.attributes);
    this.write('enum');

    if (node.isScoped) {
      this.write(' class');
    }

    if (node.name) {
      this.write(' ');
      this.emitIdentifier(node.name);
    }

    if (node.underlyingType) {
      if (this.style.spaceBeforeColon) this.write(' ');
      this.write(':');
      if (this.style.spaceAfterColon) this.write(' ');
      this.emitTypeNode(node.underlyingType);
    }

    this.write(' ');
    this.emitOpenBrace();
    this.newline();
    this.indentLevel++;

    for (let i = 0; i < node.enumerators.length; i++) {
      this.emitEnumeratorDecl(node.enumerators[i]);
      if (i < node.enumerators.length - 1) {
        this.write(',');
      }
      this.newline();
    }

    this.indentLevel--;
    this.write(this.indent() + '};');
  }

  private emitEnumeratorDecl(node: EnumeratorDecl): void {
    this.write(this.indent());
    this.emitAttributes(node.attributes);
    this.emitIdentifier(node.name);
    if (node.value) {
      if (this.style.spaceAroundOperators) {
        this.write(' = ');
      } else {
        this.write('=');
      }
      this.emitNode(node.value);
    }
  }

  private emitNamespaceDecl(node: NamespaceDecl): void {
    this.write(this.indent());
    this.emitAttributes(node.attributes);

    if (node.isInline) {
      this.write('inline ');
    }

    this.write('namespace');

    if (node.name) {
      this.write(' ');
      this.emitIdentifier(node.name);
    }

    this.write(' ');
    this.emitOpenBrace();
    this.newline();
    this.indentLevel++;

    for (const decl of node.declarations) {
      this.emitNode(decl);
      this.newline();
    }

    this.indentLevel--;
    this.write(this.indent() + '}');
  }

  private emitTypedefDecl(node: TypedefDecl): void {
    this.write(this.indent());
    this.write('typedef ');
    this.emitTypeNode(node.type);
    this.write(' ');
    this.emitIdentifier(node.name);
    this.write(';');
  }

  private emitTypeAliasDecl(node: TypeAliasDecl): void {
    this.write(this.indent());
    this.emitAttributes(node.attributes);
    this.write('using ');
    this.emitIdentifier(node.name);
    if (this.style.spaceAroundOperators) {
      this.write(' = ');
    } else {
      this.write('=');
    }
    this.emitTypeNode(node.type);
    this.write(';');
  }

  private emitUsingDecl(node: UsingDecl): void {
    this.write(this.indent());
    this.write('using ');
    if (node.isTypename) {
      this.write('typename ');
    }
    this.emitQualifiedId(node.name);
    this.write(';');
  }

  private emitUsingDirective(node: UsingDirective): void {
    this.write(this.indent());
    this.emitAttributes(node.attributes);
    this.write('using namespace ');
    this.emitNode(node.namespace);
    this.write(';');
  }

  private emitTemplateDecl(node: TemplateDecl): void {
    this.write(this.indent());
    this.write('template<');
    for (let i = 0; i < node.parameters.length; i++) {
      if (i > 0) {
        this.write(',');
        if (this.style.spaceAfterComma) this.write(' ');
      }
      this.emitTemplateParameter(node.parameters[i]);
    }
    this.write('>');
    this.newline();

    if (node.requiresClause) {
      this.emitRequiresClause(node.requiresClause);
      this.newline();
    }

    this.emitNode(node.declaration);
  }

  private emitTemplateParameter(param: TemplateParameter): void {
    switch (param.kind) {
      case NodeKind.TemplateTypeParam:
        this.emitTemplateTypeParam(param as TemplateTypeParam);
        break;
      case NodeKind.TemplateNonTypeParam:
        this.emitTemplateNonTypeParam(param as TemplateNonTypeParam);
        break;
      case NodeKind.TemplateTemplateParam:
        this.emitTemplateTemplateParam(param as TemplateTemplateParam);
        break;
    }
  }

  private emitTemplateTypeParam(param: TemplateTypeParam): void {
    if (param.constraint) {
      if ('kind' in param.constraint) {
        // TypeNode constraint
        this.emitTypeNode(param.constraint);
      } else {
        // ConceptConstraint
        this.emitNode(param.constraint.concept);
        if (param.constraint.arguments) {
          this.write('<');
          for (let i = 0; i < param.constraint.arguments.length; i++) {
            if (i > 0) {
              this.write(',');
              if (this.style.spaceAfterComma) this.write(' ');
            }
            this.emitTemplateArgument(param.constraint.arguments[i]);
          }
          this.write('>');
        }
      }
    } else {
      this.write('typename');
    }

    if (param.isVariadic) {
      this.write('...');
    }

    if (param.name) {
      this.write(' ');
      this.emitIdentifier(param.name);
    }

    if (param.defaultType) {
      if (this.style.spaceAroundOperators) {
        this.write(' = ');
      } else {
        this.write('=');
      }
      this.emitTypeNode(param.defaultType);
    }
  }

  private emitTemplateNonTypeParam(param: TemplateNonTypeParam): void {
    this.emitTypeNode(param.type);
    if (param.isVariadic) {
      this.write('...');
    }
    if (param.name) {
      this.write(' ');
      this.emitIdentifier(param.name);
    }
    if (param.defaultValue) {
      if (this.style.spaceAroundOperators) {
        this.write(' = ');
      } else {
        this.write('=');
      }
      this.emitNode(param.defaultValue);
    }
  }

  private emitTemplateTemplateParam(param: TemplateTemplateParam): void {
    this.write('template<');
    for (let i = 0; i < param.parameters.length; i++) {
      if (i > 0) {
        this.write(',');
        if (this.style.spaceAfterComma) this.write(' ');
      }
      this.emitTemplateParameter(param.parameters[i]);
    }
    this.write('> ');

    if (param.isVariadic) {
      this.write('typename...');
    } else {
      this.write('typename');
    }

    if (param.name) {
      this.write(' ');
      this.emitIdentifier(param.name);
    }

    if (param.defaultTemplate) {
      if (this.style.spaceAroundOperators) {
        this.write(' = ');
      } else {
        this.write('=');
      }
      this.emitNode(param.defaultTemplate);
    }
  }

  private emitFieldDecl(node: FieldDecl): void {
    this.write(this.indent());
    this.emitAttributes(node.attributes);

    if (node.specifiers.length > 0) {
      this.write(node.specifiers.join(' ') + ' ');
    }

    // Unwrap array type — C/C++ requires brackets after the declarator name
    const { elementType: fieldElemType, arraySizes: fieldArraySizes } = this.unwrapArrayType(node.type);
    this.emitTypeNode(fieldElemType);
    this.write(' ');
    this.emitIdentifier(node.name);
    this.emitArrayDimensions(fieldArraySizes);

    if (node.bitWidth) {
      if (this.style.spaceBeforeColon) this.write(' ');
      this.write(':');
      if (this.style.spaceAfterColon) this.write(' ');
      this.emitNode(node.bitWidth);
    }

    if (node.initializer) {
      if ((node.initializer as ASTNode).kind === NodeKind.InitListExpr) {
        this.emitInitListExpr(node.initializer as InitListExpr);
      } else {
        if (this.style.spaceAroundOperators) {
          this.write(' = ');
        } else {
          this.write('=');
        }
        this.emitNode(node.initializer);
      }
    }
    this.write(';');
  }

  private emitMethodDecl(node: MethodDecl): void {
    this.write(this.indent());
    this.emitAttributes(node.attributes);

    if (node.specifiers.length > 0) {
      this.write(node.specifiers.join(' ') + ' ');
    }

    this.emitTypeNode(node.returnType);
    this.write(' ');
    this.emitNode(node.name);

    if (this.style.spaceBeforeFunctionParen) this.write(' ');
    this.write('(');
    if (this.style.spaceInsideParens && node.parameters.length > 0) this.write(' ');
    for (let i = 0; i < node.parameters.length; i++) {
      if (i > 0) {
        this.write(',');
        if (this.style.spaceAfterComma) this.write(' ');
      }
      this.emitParameterDecl(node.parameters[i]);
    }
    if (node.isVariadic) {
      if (node.parameters.length > 0) {
        this.write(',');
        if (this.style.spaceAfterComma) this.write(' ');
      }
      this.write('...');
    }
    if (this.style.spaceInsideParens && node.parameters.length > 0) this.write(' ');
    this.write(')');

    // Method qualifiers
    if (node.qualifiers.length > 0) {
      this.write(' ' + node.qualifiers.join(' '));
    }

    if (node.requiresClause) {
      this.write(' ');
      this.emitRequiresClause(node.requiresClause);
    }

    if (node.body) {
      this.write(' ');
      this.emitCompoundStmt(node.body);
    } else {
      this.write(';');
    }
  }

  private emitConstructorDecl(node: ConstructorDecl): void {
    this.write(this.indent());
    this.emitAttributes(node.attributes);

    if (node.specifiers.length > 0) {
      this.write(node.specifiers.join(' ') + ' ');
    }

    // Constructor name should match class name - omitted here, caller should provide context
    if (this.style.spaceBeforeFunctionParen) this.write(' ');
    this.write('(');
    if (this.style.spaceInsideParens && node.parameters.length > 0) this.write(' ');
    for (let i = 0; i < node.parameters.length; i++) {
      if (i > 0) {
        this.write(',');
        if (this.style.spaceAfterComma) this.write(' ');
      }
      this.emitParameterDecl(node.parameters[i]);
    }
    if (this.style.spaceInsideParens && node.parameters.length > 0) this.write(' ');
    this.write(')');

    // Member initializers
    if (node.initializers.length > 0) {
      if (this.style.spaceBeforeColon) this.write(' ');
      this.write(':');
      if (this.style.spaceAfterColon) this.write(' ');
      for (let i = 0; i < node.initializers.length; i++) {
        if (i > 0) {
          this.write(',');
          if (this.style.spaceAfterComma) this.write(' ');
        }
        this.emitMemberInitializer(node.initializers[i]);
      }
    }

    if (node.body) {
      this.write(' ');
      this.emitCompoundStmt(node.body);
    } else {
      this.write(';');
    }
  }

  private emitMemberInitializer(node: MemberInitializer): void {
    if (node.member.kind === NodeKind.Identifier) {
      this.emitIdentifier(node.member as Identifier);
    } else {
      this.emitTypeNode(node.member as TypeNode);
    }

    if (Array.isArray(node.arguments)) {
      this.write('(');
      for (let i = 0; i < node.arguments.length; i++) {
        if (i > 0) {
          this.write(',');
          if (this.style.spaceAfterComma) this.write(' ');
        }
        this.emitNode(node.arguments[i]);
      }
      this.write(')');
    } else {
      this.emitInitListExpr(node.arguments);
    }

    if (node.isPackExpansion) {
      this.write('...');
    }
  }

  private emitDestructorDecl(node: DestructorDecl): void {
    this.write(this.indent());
    this.emitAttributes(node.attributes);

    if (node.isVirtual) {
      this.write('virtual ');
    }

    if (node.specifiers.length > 0) {
      for (const spec of node.specifiers) {
        if (spec !== 'virtual') {
          this.write(spec + ' ');
        }
      }
    }

    // Destructor name should be ~ClassName - omitted here
    this.write('~');
    if (this.style.spaceBeforeFunctionParen) this.write(' ');
    this.write('()');

    // Special destructor specifiers
    for (const spec of node.specifiers) {
      if (spec === '= default' || spec === '= delete') {
        this.write(' ' + spec);
      }
    }

    if (node.body) {
      this.write(' ');
      this.emitCompoundStmt(node.body);
    } else {
      this.write(';');
    }
  }

  private emitFriendDecl(node: FriendDecl): void {
    this.write(this.indent());
    this.write('friend ');
    this.emitNode(node.declaration as ASTNode);
  }

  private emitAccessSpecifier(node: AccessSpecifierNode): void {
    // Reduce indent for access specifiers
    const savedIndent = this.indentLevel;
    this.indentLevel = Math.max(0, this.indentLevel - 1);
    this.write(this.indent());
    this.indentLevel = savedIndent;
    this.write(node.access + ':');
  }

  private emitStaticAssertDecl(node: StaticAssertDecl): void {
    this.write(this.indent());
    this.write('static_assert(');
    this.emitNode(node.condition);
    if (node.message) {
      this.write(',');
      if (this.style.spaceAfterComma) this.write(' ');
      this.emitStringLiteral(node.message);
    }
    this.write(');');
  }

  private emitLinkageSpec(node: LinkageSpec): void {
    this.write(this.indent());
    this.write('extern "' + node.language + '"');

    if (node.declarations.length === 1) {
      this.write(' ');
      this.emitNode(node.declarations[0]);
    } else {
      this.write(' ');
      this.emitOpenBrace();
      this.newline();
      this.indentLevel++;
      for (const decl of node.declarations) {
        this.emitNode(decl);
        this.newline();
      }
      this.indentLevel--;
      this.write(this.indent() + '}');
    }
  }

  private emitNamespaceAlias(node: NamespaceAlias): void {
    this.write(this.indent());
    this.write('namespace ');
    this.emitIdentifier(node.name);
    if (this.style.spaceAroundOperators) {
      this.write(' = ');
    } else {
      this.write('=');
    }
    this.emitNode(node.target);
    this.write(';');
  }

  private emitAsmDecl(node: AsmDecl): void {
    this.write(this.indent());
    this.write('asm(');
    this.emitStringLiteral(node.code);
    this.write(');');
  }

  // ============================================
  // Statements
  // ============================================

  private emitOpenBrace(): void {
    if (this.style.braceStyle === 'allman') {
      this.newline();
      this.write(this.indent() + '{');
    } else {
      this.write('{');
    }
  }

  private emitCompoundStmt(node: CompoundStmt): void {
    this.emitOpenBrace();
    if (node.statements.length > 0) {
      this.newline();
      this.indentLevel++;
      let prev: Statement | null = null;
      for (const stmt of node.statements) {
        if (prev && this.blankLineBetween(prev, stmt)) {
          this.newline();
        }
        this.write(this.indent());
        this.emitNode(stmt);
        if (this.needsSemicolon(stmt)) {
          this.write(';');
        }
        this.newline();
        prev = stmt;
      }
      this.indentLevel--;
      this.write(this.indent());
    }
    this.write('}');
  }

  /** A statement that emits a braced control-flow block. */
  private isControlFlowBlock(stmt: Statement): boolean {
    switch (stmt.kind) {
      case NodeKind.IfStmt:
      case NodeKind.ForStmt:
      case NodeKind.ForRangeStmt:
      case NodeKind.WhileStmt:
      case NodeKind.DoWhileStmt:
      case NodeKind.SwitchStmt:
      case NodeKind.TryStmt:
        return true;
      default:
        return false;
    }
  }

  /**
   * Whether to insert a blank line between two consecutive statements. Spaces
   * control-flow blocks apart from surrounding code, but keeps adjacent `if`
   * statements tight so guard-clause ladders don't get blown apart.
   */
  private blankLineBetween(a: Statement, b: Statement): boolean {
    if (!this.style.blankLineAroundControlFlow) return false;
    if (a.kind === NodeKind.IfStmt && b.kind === NodeKind.IfStmt) return false;
    return this.isControlFlowBlock(a) || this.isControlFlowBlock(b);
  }

  private needsSemicolon(stmt: Statement): boolean {
    switch (stmt.kind) {
      case NodeKind.CompoundStmt:
      case NodeKind.IfStmt:
      case NodeKind.SwitchStmt:
      case NodeKind.WhileStmt:
      case NodeKind.DoWhileStmt:
      case NodeKind.ForStmt:
      case NodeKind.ForRangeStmt:
      case NodeKind.TryStmt:
      case NodeKind.LabelStmt:
      case NodeKind.NullStmt:
      case NodeKind.CaseStmt:
      case NodeKind.DefaultStmt:
        return false;
      default:
        return true;
    }
  }

  private emitExprStmt(node: ExprStmt): void {
    this.emitNode(node.expression);
  }

  private emitDeclStmt(node: DeclStmt): void {
    for (let i = 0; i < node.declarations.length; i++) {
      if (i > 0) {
        this.write(',');
        if (this.style.spaceAfterComma) this.write(' ');
      }
      const decl = node.declarations[i];
      if (decl.kind === NodeKind.VariableDecl) {
        // For DeclStmt, emit inline (without indent and trailing semicolon)
        const v = decl as VariableDecl;
        // Unwrap array type — C/C++ requires brackets after the declarator name
        const { elementType, arraySizes } = this.unwrapArrayType(v.type);
        if (i === 0) {
          if (v.specifiers.length > 0) {
            this.write(v.specifiers.join(' ') + ' ');
          }
          this.emitTypeNode(elementType);
          this.write(' ');
        }
        this.emitIdentifier(v.name);
        this.emitArrayDimensions(arraySizes);
        if (v.initializer) {
          if ((v.initializer as ASTNode).kind === NodeKind.InitListExpr) {
            this.emitInitListExpr(v.initializer as InitListExpr);
          } else {
            if (this.style.spaceAroundOperators) {
              this.write(' = ');
            } else {
              this.write('=');
            }
            this.emitNode(v.initializer);
          }
        }
      } else {
        this.emitNode(decl);
      }
    }
  }

  private emitIfStmt(node: IfStmt): void {
    if (node.isConstexpr) {
      this.write('if constexpr');
    } else {
      this.write('if');
    }

    if (this.style.spaceAfterKeyword) this.write(' ');
    this.write('(');
    if (this.style.spaceInsideParens) this.write(' ');

    if (node.init) {
      this.emitNode(node.init);
      if (this.needsSemicolon(node.init)) this.write(';');
      this.write(' ');
    }

    this.emitNode(node.condition);
    if (this.style.spaceInsideParens) this.write(' ');
    this.write(')');

    this.emitControlFlowBody(node.thenBranch);

    if (node.elseBranch) {
      if (this.style.braceStyle === 'stroustrup' || this.style.braceStyle === 'k&r') {
        this.write(' else');
      } else {
        this.newline();
        this.write(this.indent() + 'else');
      }

      if (node.elseBranch.kind === NodeKind.IfStmt) {
        // else if
        this.write(' ');
        this.emitIfStmt(node.elseBranch as IfStmt);
      } else {
        this.emitControlFlowBody(node.elseBranch);
      }
    }
  }

  private emitControlFlowBody(stmt: Statement): void {
    if (stmt.kind === NodeKind.CompoundStmt || this.style.alwaysUseBraces) {
      this.write(' ');
      if (stmt.kind === NodeKind.CompoundStmt) {
        this.emitCompoundStmt(stmt as CompoundStmt);
      } else {
        // Wrap single statement in braces
        this.emitOpenBrace();
        this.newline();
        this.indentLevel++;
        this.write(this.indent());
        this.emitNode(stmt);
        if (this.needsSemicolon(stmt)) this.write(';');
        this.newline();
        this.indentLevel--;
        this.write(this.indent() + '}');
      }
    } else {
      this.newline();
      this.indentLevel++;
      this.write(this.indent());
      this.emitNode(stmt);
      if (this.needsSemicolon(stmt)) this.write(';');
      this.indentLevel--;
    }
  }

  private emitSwitchStmt(node: SwitchStmt): void {
    this.write('switch');
    if (this.style.spaceAfterKeyword) this.write(' ');
    this.write('(');
    if (this.style.spaceInsideParens) this.write(' ');

    if (node.init) {
      this.emitNode(node.init);
      if (this.needsSemicolon(node.init)) this.write(';');
      this.write(' ');
    }

    this.emitNode(node.condition);
    if (this.style.spaceInsideParens) this.write(' ');
    this.write(') ');
    this.emitNode(node.body);
  }

  private emitCaseStmt(node: CaseStmt): void {
    this.write('case ');
    this.emitNode(node.value);
    this.write(':');
    this.newline();
    this.indentLevel++;
    this.write(this.indent());
    this.emitNode(node.statement);
    if (this.needsSemicolon(node.statement)) this.write(';');
    this.indentLevel--;
  }

  private emitDefaultStmt(node: DefaultStmt): void {
    this.write('default:');
    this.newline();
    this.indentLevel++;
    this.write(this.indent());
    this.emitNode(node.statement);
    if (this.needsSemicolon(node.statement)) this.write(';');
    this.indentLevel--;
  }

  private emitWhileStmt(node: WhileStmt): void {
    this.write('while');
    if (this.style.spaceAfterKeyword) this.write(' ');
    this.write('(');
    if (this.style.spaceInsideParens) this.write(' ');
    this.emitNode(node.condition);
    if (this.style.spaceInsideParens) this.write(' ');
    this.write(')');
    this.emitControlFlowBody(node.body);
  }

  private emitDoWhileStmt(node: DoWhileStmt): void {
    this.write('do');
    this.emitControlFlowBody(node.body);
    this.write(' while');
    if (this.style.spaceAfterKeyword) this.write(' ');
    this.write('(');
    if (this.style.spaceInsideParens) this.write(' ');
    this.emitNode(node.condition);
    if (this.style.spaceInsideParens) this.write(' ');
    this.write(');');
  }

  private emitForStmt(node: ForStmt): void {
    this.write('for');
    if (this.style.spaceAfterKeyword) this.write(' ');
    this.write('(');
    if (this.style.spaceInsideParens) this.write(' ');

    if (node.init) {
      this.emitNode(node.init);
      if (this.needsSemicolon(node.init)) this.write(';');
    } else {
      this.write(';');
    }
    this.write(' ');

    if (node.condition) {
      this.emitNode(node.condition);
    }
    this.write(';');

    if (node.increment) {
      this.write(' ');
      this.emitNode(node.increment);
    }

    if (this.style.spaceInsideParens) this.write(' ');
    this.write(')');
    this.emitControlFlowBody(node.body);
  }

  private emitForRangeStmt(node: ForRangeStmt): void {
    this.write('for');
    if (this.style.spaceAfterKeyword) this.write(' ');
    this.write('(');
    if (this.style.spaceInsideParens) this.write(' ');

    if (node.init) {
      this.emitNode(node.init);
      if (this.needsSemicolon(node.init)) this.write(';');
      this.write(' ');
    }

    // Emit declaration inline
    const v = node.declaration;
    if (v.specifiers.length > 0) {
      this.write(v.specifiers.join(' ') + ' ');
    }
    // Unwrap array type — C/C++ requires brackets after the declarator name
    const { elementType: forElemType, arraySizes: forArraySizes } = this.unwrapArrayType(v.type);
    this.emitTypeNode(forElemType);
    this.write(' ');
    this.emitIdentifier(v.name);
    this.emitArrayDimensions(forArraySizes);

    if (this.style.spaceBeforeColon) this.write(' ');
    this.write(':');
    if (this.style.spaceAfterColon) this.write(' ');
    this.emitNode(node.range);

    if (this.style.spaceInsideParens) this.write(' ');
    this.write(')');
    this.emitControlFlowBody(node.body);
  }

  private emitReturnStmt(node: ReturnStmt): void {
    this.write('return');
    if (node.value) {
      this.write(' ');
      this.emitNode(node.value);
    }
  }

  private emitGotoStmt(node: GotoStmt): void {
    this.write('goto ');
    this.emitIdentifier(node.label);
  }

  private emitLabelStmt(node: LabelStmt): void {
    this.emitIdentifier(node.label);
    this.write(':');
    this.newline();
    this.write(this.indent());
    this.emitNode(node.statement);
    if (this.needsSemicolon(node.statement)) this.write(';');
  }

  private emitTryStmt(node: TryStmt): void {
    this.write('try ');
    this.emitCompoundStmt(node.body);
    for (const handler of node.handlers) {
      if (this.style.braceStyle === 'stroustrup' || this.style.braceStyle === 'k&r') {
        this.write(' ');
      } else {
        this.newline();
        this.write(this.indent());
      }
      this.emitCatchClause(handler);
    }
  }

  private emitCatchClause(node: CatchClause): void {
    this.write('catch');
    if (this.style.spaceAfterKeyword) this.write(' ');
    this.write('(');
    if (this.style.spaceInsideParens) this.write(' ');
    if (node.parameter) {
      this.emitParameterDecl(node.parameter);
    } else {
      this.write('...');
    }
    if (this.style.spaceInsideParens) this.write(' ');
    this.write(') ');
    this.emitCompoundStmt(node.body);
  }

  private emitCoReturnStmt(node: CoReturnStmt): void {
    this.write('co_return');
    if (node.value) {
      this.write(' ');
      this.emitNode(node.value);
    }
  }

  // ============================================
  // Expressions
  // ============================================

  private emitIntegerLiteral(node: IntegerLiteralExpr): void {
    this.write(node.raw);
  }

  private emitFloatingLiteral(node: FloatingLiteralExpr): void {
    this.write(node.raw);
  }

  private emitCharLiteral(node: CharLiteralExpr): void {
    this.write(node.raw);
  }

  private emitStringLiteral(node: StringLiteralExpr): void {
    this.write(node.raw);
  }

  private emitBoolLiteral(node: BoolLiteralExpr): void {
    this.write(node.value ? 'true' : 'false');
  }

  private emitUserDefinedLiteral(node: UserDefinedLiteralExpr): void {
    this.write(node.raw);
  }

  private emitIdentifier(node: Identifier): void {
    // Handle operator overload names
    if ('operator' in node && (node as any).operator) {
      const op = node as any;
      this.write('operator' + op.operator);
      if (op.isArray) {
        this.write('[]');
      }
    } else {
      this.write(node.name);
    }
  }

  private emitQualifiedId(node: QualifiedId): void {
    if (node.isGlobal) {
      this.write('::');
    }
    for (const qual of node.qualifier) {
      this.emitNode(qual);
      this.write('::');
    }
    this.emitNode(node.name);
  }

  private emitParenExpr(node: ParenExpr): void {
    const inner = node.expression;
    // CommaExpr needs explicit parens — without them, foo((a, b)) becomes foo(a, b)
    if (inner.kind === NodeKind.CommaExpr) {
      this.write('(');
      this.emitNode(inner);
      this.write(')');
      return;
    }
    this.emitNode(inner);
  }

  private getExprPrecedence(expr: Expression): number {
    // Look through transparent ParenExpr to get the inner expression's precedence
    if (expr.kind === NodeKind.ParenExpr) {
      const inner = (expr as ParenExpr).expression;
      // CommaExpr parens are kept explicitly, so treat as atom
      if (inner.kind === NodeKind.CommaExpr) return 0;
      return this.getExprPrecedence(inner);
    }
    switch (expr.kind) {
      case NodeKind.BinaryExpr:
        return OPERATOR_PRECEDENCE[(expr as BinaryExpr).operator] ?? 20;
      case NodeKind.UnaryExpr:
        return OPERATOR_PRECEDENCE[(expr as UnaryExpr).operator + '_unary'] ??
          OPERATOR_PRECEDENCE[(expr as UnaryExpr).operator] ?? 3;
      case NodeKind.PostfixExpr:
        return OPERATOR_PRECEDENCE[(expr as PostfixExpr).operator + '_post'] ?? 2;
      case NodeKind.AssignExpr:
        return OPERATOR_PRECEDENCE[(expr as AssignExpr).operator] ?? 17;
      case NodeKind.ConditionalExpr:
        return OPERATOR_PRECEDENCE['?:'];
      case NodeKind.CommaExpr:
        return OPERATOR_PRECEDENCE[','];
      case NodeKind.MemberExpr:
        return OPERATOR_PRECEDENCE[(expr as MemberExpr).isArrow ? '->' : '.'];
      case NodeKind.SubscriptExpr:
        return OPERATOR_PRECEDENCE['[]'];
      case NodeKind.CallExpr:
        return OPERATOR_PRECEDENCE['()'];
      case NodeKind.CStyleCastExpr:
      case NodeKind.StaticCastExpr:
      case NodeKind.DynamicCastExpr:
      case NodeKind.ReinterpretCastExpr:
      case NodeKind.ConstCastExpr:
      case NodeKind.FunctionalCastExpr:
        return 3; // Unary precedence — ensures ((Type*)expr)->Method() gets parens
      default:
        return 0; // Highest precedence (atoms)
    }
  }

  private emitExprWithPrecedence(expr: Expression, parentPrecedence: number): void {
    const exprPrecedence = this.getExprPrecedence(expr);
    const needsParens = exprPrecedence > parentPrecedence;
    if (needsParens) {
      this.write('(');
    }
    this.emitNode(expr);
    if (needsParens) {
      this.write(')');
    }
  }

  private emitBinaryExpr(node: BinaryExpr): void {
    const precedence = OPERATOR_PRECEDENCE[node.operator] ?? 20;
    this.emitExprWithPrecedence(node.left, precedence);
    if (this.style.spaceAroundOperators) {
      this.write(' ' + node.operator + ' ');
    } else {
      this.write(node.operator);
    }
    // Right child: use precedence - 1 to force parens for same-precedence ops
    // (e.g. a - (b - c) ≠ a - b - c). But if the right child is the same
    // associative operator, parens are unnecessary (e.g. a && b && c).
    const rightPrec = this.rightChildSameAssociativeOp(node) ? precedence : precedence - 1;
    this.emitExprWithPrecedence(node.right, rightPrec);
  }

  /** Check if right child (looking through ParenExpr) is the same associative operator */
  private rightChildSameAssociativeOp(node: BinaryExpr): boolean {
    let right: Expression = node.right;
    while (right.kind === NodeKind.ParenExpr) {
      right = (right as ParenExpr).expression;
    }
    if (right.kind !== NodeKind.BinaryExpr) return false;
    const rightOp = (right as BinaryExpr).operator;
    if (rightOp !== node.operator) return false;
    // Only truly associative operators: &&, ||, &, |, ^, +, *
    return ASSOCIATIVE_OPS.has(node.operator);
  }

  private emitUnaryExpr(node: UnaryExpr): void {
    const op = node.operator;
    // Prefix increment/decrement and other prefix operators
    if (op === '++' || op === '--') {
      this.write(op);
      this.emitNode(node.operand);
    } else {
      this.write(op);
      this.emitExprWithPrecedence(node.operand, 3);
    }
  }

  private emitPostfixExpr(node: PostfixExpr): void {
    this.emitNode(node.operand);
    this.write(node.operator);
  }

  private emitConditionalExpr(node: ConditionalExpr): void {
    const precedence = OPERATOR_PRECEDENCE['?:'];
    this.emitExprWithPrecedence(node.condition, precedence);
    if (this.style.spaceAroundOperators) {
      this.write(' ? ');
    } else {
      this.write('?');
    }
    this.emitExprWithPrecedence(node.thenExpr, precedence);
    if (this.style.spaceAroundOperators) {
      this.write(' : ');
    } else {
      this.write(':');
    }
    this.emitExprWithPrecedence(node.elseExpr, precedence);
  }

  private emitAssignExpr(node: AssignExpr): void {
    this.emitNode(node.left);
    if (this.style.spaceAroundOperators) {
      this.write(' ' + node.operator + ' ');
    } else {
      this.write(node.operator);
    }
    this.emitNode(node.right);
  }

  private emitCommaExpr(node: CommaExpr): void {
    for (let i = 0; i < node.expressions.length; i++) {
      if (i > 0) {
        this.write(',');
        if (this.style.spaceAfterComma) this.write(' ');
      }
      this.emitNode(node.expressions[i]);
    }
  }

  private emitMemberExpr(node: MemberExpr): void {
    this.emitExprWithPrecedence(node.object, 2);
    this.write(node.isArrow ? '->' : '.');
    this.emitNode(node.member);
  }

  private emitSubscriptExpr(node: SubscriptExpr): void {
    this.emitExprWithPrecedence(node.array, 2);
    this.write('[');
    this.emitNode(node.index);
    this.write(']');
  }

  private emitCallExpr(node: CallExpr): void {
    this.emitExprWithPrecedence(node.callee, 2);
    if (this.style.spaceBeforeFunctionParen) this.write(' ');
    this.write('(');
    if (this.style.spaceInsideParens && node.arguments.length > 0) this.write(' ');
    for (let i = 0; i < node.arguments.length; i++) {
      if (i > 0) {
        this.write(',');
        if (this.style.spaceAfterComma) this.write(' ');
      }
      this.emitNode(node.arguments[i]);
    }
    if (this.style.spaceInsideParens && node.arguments.length > 0) this.write(' ');
    this.write(')');
  }

  private emitCStyleCastExpr(node: CStyleCastExpr): void {
    this.write('(');
    this.emitTypeNode(node.type);
    this.write(')');
    this.emitExprWithPrecedence(node.expression, 3);
  }

  private emitStaticCastExpr(node: StaticCastExpr): void {
    this.write('static_cast<');
    this.emitTypeNode(node.type);
    this.write('>(');
    this.emitNode(node.expression);
    this.write(')');
  }

  private emitDynamicCastExpr(node: DynamicCastExpr): void {
    this.write('dynamic_cast<');
    this.emitTypeNode(node.type);
    this.write('>(');
    this.emitNode(node.expression);
    this.write(')');
  }

  private emitReinterpretCastExpr(node: ReinterpretCastExpr): void {
    this.write('reinterpret_cast<');
    this.emitTypeNode(node.type);
    this.write('>(');
    this.emitNode(node.expression);
    this.write(')');
  }

  private emitConstCastExpr(node: ConstCastExpr): void {
    this.write('const_cast<');
    this.emitTypeNode(node.type);
    this.write('>(');
    this.emitNode(node.expression);
    this.write(')');
  }

  private emitFunctionalCastExpr(node: FunctionalCastExpr): void {
    this.emitTypeNode(node.type);
    this.write('(');
    for (let i = 0; i < node.arguments.length; i++) {
      if (i > 0) {
        this.write(',');
        if (this.style.spaceAfterComma) this.write(' ');
      }
      this.emitNode(node.arguments[i]);
    }
    this.write(')');
  }

  private emitSizeofExpr(node: SizeofExpr): void {
    this.write('sizeof');
    if (node.isType) {
      this.write('(');
      this.emitTypeNode(node.operand as TypeNode);
      this.write(')');
    } else {
      this.write('(');
      this.emitNode(node.operand as Expression);
      this.write(')');
    }
  }

  private emitAlignofExpr(node: AlignofExpr): void {
    this.write('alignof(');
    this.emitTypeNode(node.type);
    this.write(')');
  }

  private emitTypeidExpr(node: TypeidExpr): void {
    this.write('typeid(');
    if (node.isType) {
      this.emitTypeNode(node.operand as TypeNode);
    } else {
      this.emitNode(node.operand as Expression);
    }
    this.write(')');
  }

  private emitNoexceptExpr(node: NoexceptExpr): void {
    this.write('noexcept(');
    this.emitNode(node.expression);
    this.write(')');
  }

  private emitNewExpr(node: NewExpr): void {
    this.write('new');
    if (node.placement.length > 0) {
      this.write('(');
      for (let i = 0; i < node.placement.length; i++) {
        if (i > 0) {
          this.write(',');
          if (this.style.spaceAfterComma) this.write(' ');
        }
        this.emitNode(node.placement[i]);
      }
      this.write(')');
    }
    this.write(' ');
    if (node.isArray) {
      this.emitTypeNode(node.type);
      this.write('[');
      if (node.arraySize) {
        this.emitNode(node.arraySize);
      }
      this.write(']');
    } else {
      this.emitTypeNode(node.type);
    }
    if (node.initializer) {
      if ((node.initializer as ASTNode).kind === NodeKind.InitListExpr) {
        this.emitInitListExpr(node.initializer as InitListExpr);
      } else {
        this.write('(');
        this.emitNode(node.initializer);
        this.write(')');
      }
    }
  }

  private emitDeleteExpr(node: DeleteExpr): void {
    this.write('delete');
    if (node.isArray) {
      this.write('[]');
    }
    this.write(' ');
    this.emitNode(node.expression);
  }

  private emitLambdaExpr(node: LambdaExpr): void {
    // Template parameters (C++20)
    if (node.templateParams && node.templateParams.length > 0) {
      this.write('<');
      for (let i = 0; i < node.templateParams.length; i++) {
        if (i > 0) {
          this.write(',');
          if (this.style.spaceAfterComma) this.write(' ');
        }
        this.emitTemplateParameter(node.templateParams[i]);
      }
      this.write('>');
    }

    // Capture clause
    this.write('[');
    if (node.captureDefault) {
      this.write(node.captureDefault);
      if (node.captures.length > 0) {
        this.write(',');
        if (this.style.spaceAfterComma) this.write(' ');
      }
    }
    for (let i = 0; i < node.captures.length; i++) {
      if (i > 0) {
        this.write(',');
        if (this.style.spaceAfterComma) this.write(' ');
      }
      this.emitLambdaCapture(node.captures[i]);
    }
    this.write(']');

    // Parameters
    if (node.parameters.length > 0 || node.specifiers.length > 0 || node.returnType) {
      this.write('(');
      for (let i = 0; i < node.parameters.length; i++) {
        if (i > 0) {
          this.write(',');
          if (this.style.spaceAfterComma) this.write(' ');
        }
        this.emitParameterDecl(node.parameters[i]);
      }
      this.write(')');

      // Specifiers
      if (node.specifiers.length > 0) {
        this.write(' ' + node.specifiers.join(' '));
      }

      // Return type
      if (node.returnType) {
        this.write(' -> ');
        this.emitTypeNode(node.returnType);
      }
    }

    // Requires clause
    if (node.requiresClause) {
      this.write(' ');
      this.emitRequiresClause(node.requiresClause);
    }

    // Body
    this.write(' ');
    if ((node.body as ASTNode).kind === NodeKind.CompoundStmt) {
      this.emitCompoundStmt(node.body as CompoundStmt);
    } else {
      this.write('{ return ');
      this.emitNode(node.body as Expression);
      this.write('; }');
    }
  }

  private emitLambdaCapture(node: LambdaCapture): void {
    if (node.isThis) {
      if (node.isDeref) {
        this.write('*this');
      } else {
        this.write('this');
      }
    } else if (node.name) {
      if (node.isRef) {
        this.write('&');
      }
      this.emitIdentifier(node.name);
      if (node.initializer) {
        if (this.style.spaceAroundOperators) {
          this.write(' = ');
        } else {
          this.write('=');
        }
        this.emitNode(node.initializer);
      }
    }
    if (node.isPackExpansion) {
      this.write('...');
    }
  }

  private emitFoldExpr(node: FoldExpr): void {
    this.write('(');
    if (node.isLeftFold) {
      if (node.init) {
        this.emitNode(node.init);
        if (this.style.spaceAroundOperators) {
          this.write(' ' + node.operator + ' ');
        } else {
          this.write(node.operator);
        }
      }
      this.write('...');
      if (this.style.spaceAroundOperators) {
        this.write(' ' + node.operator + ' ');
      } else {
        this.write(node.operator);
      }
      this.emitNode(node.pattern);
    } else {
      this.emitNode(node.pattern);
      if (this.style.spaceAroundOperators) {
        this.write(' ' + node.operator + ' ');
      } else {
        this.write(node.operator);
      }
      this.write('...');
      if (node.init) {
        if (this.style.spaceAroundOperators) {
          this.write(' ' + node.operator + ' ');
        } else {
          this.write(node.operator);
        }
        this.emitNode(node.init);
      }
    }
    this.write(')');
  }

  private emitInitListExpr(node: InitListExpr): void {
    this.write('{');
    for (let i = 0; i < node.elements.length; i++) {
      if (i > 0) {
        this.write(',');
        if (this.style.spaceAfterComma) this.write(' ');
      }
      this.emitNode(node.elements[i]);
    }
    this.write('}');
  }

  private emitDesignatedInitExpr(node: DesignatedInitExpr): void {
    for (const designator of node.designators) {
      if (designator.kind === 'field') {
        this.write('.');
        this.emitIdentifier(designator.name);
      } else {
        this.write('[');
        this.emitNode(designator.index);
        this.write(']');
      }
    }
    if (this.style.spaceAroundOperators) {
      this.write(' = ');
    } else {
      this.write('=');
    }
    if ((node.initializer as ASTNode).kind === NodeKind.InitListExpr) {
      this.emitInitListExpr(node.initializer as InitListExpr);
    } else {
      this.emitNode(node.initializer as Expression);
    }
  }

  private emitPackExpansionExpr(node: PackExpansionExpr): void {
    this.emitNode(node.pattern);
    this.write('...');
  }

  private emitSizeofPackExpr(node: SizeofPackExpr): void {
    this.write('sizeof...(');
    this.emitIdentifier(node.pack);
    this.write(')');
  }

  private emitRequiresExpr(node: RequiresExpr): void {
    this.write('requires');
    if (node.parameters.length > 0) {
      this.write('(');
      for (let i = 0; i < node.parameters.length; i++) {
        if (i > 0) {
          this.write(',');
          if (this.style.spaceAfterComma) this.write(' ');
        }
        this.emitParameterDecl(node.parameters[i]);
      }
      this.write(')');
    }
    this.write(' ');
    this.emitOpenBrace();
    this.newline();
    this.indentLevel++;
    for (const req of node.requirements) {
      this.write(this.indent());
      this.emitRequirement(req);
      this.write(';');
      this.newline();
    }
    this.indentLevel--;
    this.write(this.indent() + '}');
  }

  private emitRequirement(req: RequiresExpr['requirements'][0]): void {
    switch (req.kind) {
      case 'simple':
        this.emitNode(req.expression);
        break;
      case 'type':
        this.write('typename ');
        this.emitTypeNode(req.type);
        break;
      case 'compound':
        this.write('{ ');
        this.emitNode(req.expression);
        this.write(' }');
        if (req.noexcept) {
          this.write(' noexcept');
        }
        if (req.returnType) {
          this.write(' -> ');
          this.emitTypeNode(req.returnType);
        }
        break;
      case 'nested':
        this.write('requires ');
        this.emitNode(req.constraint);
        break;
    }
  }

  private emitThrowExpr(node: ThrowExpr): void {
    this.write('throw');
    if (node.expression) {
      this.write(' ');
      this.emitNode(node.expression);
    }
  }

  private emitCoYieldExpr(node: CoYieldExpr): void {
    this.write('co_yield ');
    this.emitNode(node.expression);
  }

  private emitCoAwaitExpr(node: CoAwaitExpr): void {
    this.write('co_await ');
    this.emitNode(node.expression);
  }

  // ============================================
  // Misc
  // ============================================

  private emitAttribute(node: Attribute): void {
    this.write('[[');
    this.emitAttributeContent(node);
    this.write(']]');
  }

  private emitRequiresClause(node: RequiresClause): void {
    this.write('requires ');
    this.emitNode(node.constraint);
  }
}

/**
 * Emit C++ code from an AST node with default style
 */
export function emit(node: AnyNode, style?: Partial<EmitStyle>): string {
  const emitter = new CppEmitter(style);
  return emitter.emit(node);
}
