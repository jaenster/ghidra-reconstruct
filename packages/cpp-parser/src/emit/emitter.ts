/**
 * C++ Code Emitter
 * Pretty printer that emits valid C++ code from AST nodes
 */

import { NodeKind, isExpression } from '../ast/kinds.js';
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
  MacroDecl,
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
  SehTryStmt,
  PpConditionalStmt,
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
 * The last statement of a switch body when it is a `case`/`default` label with
 * nothing after it. Returns null for every other shape, so an empty label that
 * is followed by more cases (a deliberate fallthrough) is never touched.
 */
function trailingEmptyLabel(body: ASTNode | null | undefined): ASTNode | null {
  if (!body || body.kind !== NodeKind.CompoundStmt) return null;
  const statements = (body as CompoundStmt).statements;
  const last = statements[statements.length - 1];
  if (!last) return null;
  if (last.kind !== NodeKind.CaseStmt && last.kind !== NodeKind.DefaultStmt) return null;
  const inner = (last as CaseStmt | DefaultStmt).statement;
  if (!inner) return last;
  if (inner.kind === NodeKind.NullStmt) return last;
  if (inner.kind === NodeKind.CompoundStmt && (inner as CompoundStmt).statements.length === 0) return last;
  return null;
}

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
      case NodeKind.MacroDecl:
        this.write(this.indent());
        this.emitNode((node as MacroDecl).call);
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
      case NodeKind.SehTryStmt:
        this.emitSehTryStmt(node as SehTryStmt);
        break;
      case NodeKind.PpConditionalStmt:
        this.emitPpConditionalStmt(node as PpConditionalStmt);
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
    // Pointer-to-array in a NON-declarator position (parameter / cast / abstract
    // type): Ghidra's `type[N]*` denotes a plain pointer, and `elem[N]*` is
    // ill-formed C++. Emit the flat `elem *` and drop the dimension. Named
    // declarators keep the faithful `T (*name)[N]` form via emitPointerToArrayDecl,
    // which bypasses this method — so 2D-array locals are untouched.
    // (This replaces a fragile text regex that also clobbered subscript-multiplies.)
    let ptrLevels = 0;
    let cur: TypeNode = node;
    while (cur.kind === NodeKind.PointerType) { ptrLevels++; cur = (cur as PointerType).pointee; }
    if (cur.kind === NodeKind.ArrayType) {
      const { elementType } = this.unwrapArrayType(cur);
      this.emitTypeNode(elementType);
      this.write(' ' + '*'.repeat(ptrLevels));
      return;
    }
    // Pointer-to-function: the star binds inside the parentheses, so the flat
    // `ret(args) *` this method would otherwise write is a different type
    // (a function returning a pointer). `ret (*)(args)`.
    if (cur.kind === NodeKind.FunctionType) {
      const fn = cur as FunctionType;
      this.emitTypeNode(fn.returnType);
      const convention = fn.callingConvention ? fn.callingConvention + ' ' : '';
      this.write(' (' + convention + '*'.repeat(ptrLevels) + ')(');
      for (let i = 0; i < fn.parameters.length; i++) {
        if (i > 0) this.write(this.style.spaceAfterComma ? ', ' : ',');
        this.emitTypeNode(fn.parameters[i]);
      }
      if (fn.isVariadic) {
        if (fn.parameters.length > 0) this.write(this.style.spaceAfterComma ? ', ' : ',');
        this.write('...');
      }
      this.write(')');
      return;
    }
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
      this.emitAssignmentExpression(node.size);
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

  /** Keep the shared base type separate from each name's pointer/array declarator. */
  private localDeclarator(type: TypeNode, name: string): { base: TypeNode; name: string } {
    switch (type.kind) {
      case NodeKind.PointerType: {
        const pointer = type as PointerType;
        const qualifiers = pointer.qualifiers.length ? pointer.qualifiers.join(' ') + ' ' : '';
        let decorated = '*' + qualifiers + name;
        if (pointer.pointee.kind === NodeKind.ArrayType || pointer.pointee.kind === NodeKind.FunctionType) {
          const convention = pointer.pointee.kind === NodeKind.FunctionType
            ? (pointer.pointee as FunctionType).callingConvention
            : undefined;
          decorated = '(' + (convention ? convention + ' ' : '') + decorated + ')';
        }
        return this.localDeclarator(pointer.pointee, decorated);
      }
      case NodeKind.ReferenceType: {
        const ref = type as ReferenceType;
        const wrapped = ref.referenced.kind === NodeKind.ArrayType || ref.referenced.kind === NodeKind.FunctionType;
        const convention = ref.referenced.kind === NodeKind.FunctionType
          ? (ref.referenced as FunctionType).callingConvention : undefined;
        const decorated = wrapped ? '(' + (convention ? convention + ' ' : '') + '&' + name + ')' : '&' + name;
        return this.localDeclarator(ref.referenced, decorated);
      }
      case NodeKind.RValueReferenceType: {
        const ref = type as RValueReferenceType;
        const wrapped = ref.referenced.kind === NodeKind.ArrayType || ref.referenced.kind === NodeKind.FunctionType;
        const convention = ref.referenced.kind === NodeKind.FunctionType
          ? (ref.referenced as FunctionType).callingConvention : undefined;
        const decorated = wrapped ? '(' + (convention ? convention + ' ' : '') + '&&' + name + ')' : '&&' + name;
        return this.localDeclarator(ref.referenced, decorated);
      }
      case NodeKind.QualifiedType: {
        const qualified = type as QualifiedType;
        if (qualified.type.kind === NodeKind.PointerType) {
          const pointer = qualified.type as PointerType;
          return this.localDeclarator({
            ...pointer,
            qualifiers: [...pointer.qualifiers, ...qualified.qualifiers],
          }, name);
        }
        if (qualified.type.kind === NodeKind.ArrayType) {
          const array = qualified.type as ArrayType;
          return this.localDeclarator({
            ...array,
            elementType: { ...qualified, type: array.elementType },
          }, name);
        }
        return { base: type, name };
      }
      case NodeKind.ArrayType: {
        const arr = type as ArrayType;
        const size = arr.size ? new CppEmitter(this.style).emit(arr.size as AnyNode) : '';
        return this.localDeclarator(arr.elementType, name + '[' + size + ']');
      }
      case NodeKind.FunctionType: {
        const fn = type as FunctionType;
        const separator = this.style.spaceAfterComma ? ', ' : ',';
        const parameters = fn.parameters.map(p => new CppEmitter(this.style).emit(p as AnyNode));
        if (fn.isVariadic) parameters.push('...');
        const qualifiers = fn.qualifiers.length ? ' ' + fn.qualifiers.join(' ') : '';
        return this.localDeclarator(fn.returnType, name + '(' + parameters.join(separator) + ')' + qualifiers);
      }
      default:
        return { base: type, name };
    }
  }

  /**
   * Emit a pointer-to-array declarator `T (*name)[N]…` when the type is a pointer
   * (possibly multi-level) whose pointee is an array. Returns false (emit nothing)
   * for any other type, so the caller falls back to the normal declarator path.
   */
  /** True when a type is a (multi-level) pointer whose pointee is an array. */
  private isPointerToArray(type: TypeNode): boolean {
    let cur: TypeNode = type;
    let levels = 0;
    while (cur.kind === NodeKind.PointerType) { levels++; cur = (cur as PointerType).pointee; }
    return levels > 0 && cur.kind === NodeKind.ArrayType;
  }

  private emitPointerToArrayDecl(type: TypeNode, name: import('../ast/nodes.js').Identifier): boolean {
    let levels = 0;
    let cur: TypeNode = type;
    while (cur.kind === NodeKind.PointerType) {
      levels++;
      cur = (cur as PointerType).pointee;
    }
    if (levels === 0 || cur.kind !== NodeKind.ArrayType) return false;
    const { elementType, arraySizes } = this.unwrapArrayType(cur);
    this.emitTypeNode(elementType);
    this.write(' (');
    this.write('*'.repeat(levels));
    this.emitIdentifier(name);
    this.write(')');
    this.emitArrayDimensions(arraySizes);
    return true;
  }

  /** Build a named function declarator through pointer, reference, array and cv wrappers. */
  private namedFunctionDeclarator(type: TypeNode, name: string): { fn: FunctionType; name: string } | null {
    if (type.kind === NodeKind.QualifiedType) {
      const qualified = type as QualifiedType;
      if (qualified.type.kind === NodeKind.PointerType) {
        const pointer = qualified.type as PointerType;
        return this.namedFunctionDeclarator({
          ...pointer, qualifiers: [...pointer.qualifiers, ...qualified.qualifiers],
        }, name);
      }
      if (qualified.type.kind === NodeKind.ArrayType) {
        const array = qualified.type as ArrayType;
        return this.namedFunctionDeclarator({
          ...array, elementType: { ...qualified, type: array.elementType },
        }, name);
      }
      return null;
    }
    if (type.kind === NodeKind.ArrayType) {
      const array = type as ArrayType;
      const size = array.size ? new CppEmitter(this.style).emit(array.size as AnyNode) : '';
      return this.namedFunctionDeclarator(array.elementType, name + '[' + size + ']');
    }
    if (type.kind === NodeKind.PointerType || type.kind === NodeKind.ReferenceType ||
        type.kind === NodeKind.RValueReferenceType) {
      const next = type.kind === NodeKind.PointerType ? (type as PointerType).pointee
        : type.kind === NodeKind.ReferenceType ? (type as ReferenceType).referenced
        : (type as RValueReferenceType).referenced;
      const marker = type.kind === NodeKind.PointerType
        ? '*' + ((type as PointerType).qualifiers.length ? ' ' + (type as PointerType).qualifiers.join(' ') + ' ' : '')
        : type.kind === NodeKind.ReferenceType ? '&' : '&&';
      let decorated = marker + name;
      const wrapped = next.kind === NodeKind.ArrayType || next.kind === NodeKind.FunctionType ||
        (next.kind === NodeKind.QualifiedType &&
          ((next as QualifiedType).type.kind === NodeKind.ArrayType ||
           (next as QualifiedType).type.kind === NodeKind.FunctionType));
      if (wrapped) {
        const fn = next.kind === NodeKind.FunctionType ? next as FunctionType : null;
        decorated = '(' + (fn?.callingConvention ? fn.callingConvention + ' ' : '') + decorated + ')';
      }
      return this.namedFunctionDeclarator(next, decorated);
    }
    return type.kind === NodeKind.FunctionType ? { fn: type as FunctionType, name } : null;
  }

  /** A named function pointer keeps its name inside the pointer declarator. */
  private emitNamedFunctionPointerDecl(type: TypeNode, name: Identifier, specifiers: readonly string[] = []): boolean {
    const declarator = this.namedFunctionDeclarator(type, name.name);
    if (!declarator) return false;
    const { fn } = declarator;
    if (specifiers.length > 0) this.write(specifiers.join(' ') + ' ');
    this.emitTypeNode(fn.returnType);
    this.write(' ' + declarator.name);
    this.write('(');
    for (let i = 0; i < fn.parameters.length; i++) {
      if (i > 0) this.write(this.style.spaceAfterComma ? ', ' : ',');
      this.emitTypeNode(fn.parameters[i]);
    }
    if (fn.isVariadic) {
      if (fn.parameters.length > 0) this.write(this.style.spaceAfterComma ? ', ' : ',');
      this.write('...');
    }
    this.write(')');
    if (fn.qualifiers.length > 0) this.write(' ' + fn.qualifiers.join(' '));
    return true;
  }

  /**
   * Emit an ABSTRACT pointer-to-array declarator `T (*)[N]` — the nameless twin of
   * `emitPointerToArrayDecl`. Legal wherever a type-id is, which is where a cast
   * lives, so `(char (*)[60])p` keeps the extent the declarator `char (*p)[60]`
   * already carries. Without it the cast flattened to `char *` and disagreed with
   * the very variable it was assigned to.
   *
   * Returns false — emitting nothing — when the type is not a pointer to a sized
   * array, so the caller falls back to `emitTypeNode`. An array with no extent
   * (`T (*)[]`) is not a complete type in a cast, so it takes the fallback too.
   */
  private emitAbstractPointerToArray(type: TypeNode): boolean {
    let levels = 0;
    let cur: TypeNode = type;
    while (cur.kind === NodeKind.PointerType) { levels++; cur = (cur as PointerType).pointee; }
    if (levels === 0 || cur.kind !== NodeKind.ArrayType) return false;
    const { elementType, arraySizes } = this.unwrapArrayType(cur);
    if (arraySizes.length === 0 || arraySizes.some(s => !s)) return false;
    this.emitTypeNode(elementType);
    this.write(' (');
    this.write('*'.repeat(levels));
    this.write(')');
    this.emitArrayDimensions(arraySizes);
    return true;
  }

  /** Emit array dimension brackets: [40], [3][4], etc. */
  private emitArrayDimensions(sizes: (Expression | null)[]): void {
    for (const size of sizes) {
      this.write('[');
      if (size) this.emitAssignmentExpression(size);
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
        this.emitTemplateValue((arg as ExprTemplateArg).expression);
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
    // GCC's own attributes are read from `__attribute__((...))` and printed back that way.
    if (attrs.every(a => a.namespace?.name === 'gnu' && a.arguments.length === 0)) {
      this.write(`__attribute__((${attrs.map(a => a.name.name).join(', ')})) `);
      return;
    }
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
        const arg = attr.arguments[i];
        if (isExpression(arg.kind)) this.emitAssignmentExpression(arg as Expression);
        else this.emitNode(arg as ASTNode);
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
    if (node.name && this.emitNamedFunctionPointerDecl(node.type, node.name)) {
      if (node.defaultValue) {
        this.write(this.style.spaceAroundOperators ? ' = ' : '=');
        this.emitExprWithPrecedence(node.defaultValue, 17);
      }
      return;
    }
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
      this.emitAssignmentExpression(node.defaultValue);
    }
  }

  private emitVariableDecl(node: VariableDecl): void {
    this.write(this.indent());
    this.emitAttributes(node.attributes);

    if (node.specifiers.length > 0) {
      this.write(node.specifiers.join(' ') + ' ');
    }

    // Pointer-to-array (`T (*name)[N]`): a pointer whose pointee is an array needs
    // the C declarator syntax, NOT `T[N]* name` (invalid C++). Without this,
    // Ghidra's `D2UnitStrc*(*)[5]` locals emit as `D2UnitStrc*[5]* name` and the
    // declaration — plus every use of the name — fails to compile.
    const namedFunctionPointer = this.emitNamedFunctionPointerDecl(node.type, node.name);
    if (!namedFunctionPointer &&
        !this.emitPointerToArrayDecl(node.type, node.name)) {
      // Unwrap array type — C/C++ requires brackets after the declarator name
      const { elementType, arraySizes } = this.unwrapArrayType(node.type);
      this.emitTypeNode(elementType);
      this.write(' ');
      this.emitIdentifier(node.name);
      this.emitArrayDimensions(arraySizes);
    }

    if (node.initializer) {
      if (node.initializer.kind === NodeKind.InitListExpr) {
        if (node.copyListInit) this.write(this.style.spaceAroundOperators ? ' = ' : '=');
        this.emitInitListExpr(node.initializer as InitListExpr);
      } else {
        if (this.style.spaceAroundOperators) {
          this.write(' = ');
        } else {
          this.write('=');
        }
        this.emitAssignmentExpression(node.initializer);
      }
    }
    this.write(';');
  }

  private emitClassDecl(node: ClassDecl): void {
    this.emitClassOrStructDecl(node, 'class');
  }

  private emitStructDecl(node: StructDecl, noIndent = false): void {
    this.emitClassOrStructDecl(node, 'struct', noIndent);
  }

  private emitClassOrStructDecl(
    node: ClassDecl | StructDecl,
    keyword: 'class' | 'struct',
    noIndent = false
  ): void {
    if (!noIndent) this.write(this.indent());
    this.emitAttributes(node.attributes);
    this.write(keyword);

    if (node.name) {
      this.write(' ');
      if (node.name.kind === NodeKind.TemplateType) this.emitTemplateType(node.name);
      else this.emitIdentifier(node.name);
    }

    if (node.isForwardDeclaration) {
      this.write(';');
      return;
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

  private emitUnionDecl(node: UnionDecl, noIndent = false): void {
    if (!noIndent) this.write(this.indent());
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
      this.emitAssignmentExpression(node.value);
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
    if (!this.emitNamedFunctionPointerDecl(node.type, node.name)) {
      this.emitTypeNode(node.type);
      this.write(' ');
      this.emitIdentifier(node.name);
    }
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
      this.write(param.keyword ?? 'typename');
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
      this.emitTemplateValue(param.defaultValue);
    }
  }

  /**
   * A value inside `<...>`. The first unbracketed `>` there closes the list, so an
   * expression that would print one is parenthesised: `L<(sizeof(T) > 4)>`.
   */
  private emitTemplateValue(expr: Expression): void {
    const bare = (e: any): boolean => {
      switch (e?.kind) {
        case NodeKind.ParenExpr: return bare(e.expression);
        case NodeKind.BinaryExpr: return e.operator === '>' || e.operator === '>>' || bare(e.left) || bare(e.right);
        case NodeKind.UnaryExpr: return bare(e.operand);
        case NodeKind.CStyleCastExpr: return bare(e.expression);
        case NodeKind.ConditionalExpr: return bare(e.condition) || bare(e.thenExpr) || bare(e.elseExpr);
        default: return false;
      }
    };
    if (!bare(expr) && !this.isCommaOperatorExpr(expr)) {
      this.emitNode(expr);
      return;
    }
    this.write('(');
    this.emitNode(expr);
    this.write(')');
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

    this.write(param.keyword ?? 'typename');
    if (param.isVariadic) {
      this.write('...');
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
    if (!this.emitNamedFunctionPointerDecl(node.type, node.name)) {
      const { elementType: fieldElemType, arraySizes: fieldArraySizes } = this.unwrapArrayType(node.type);
      this.emitTypeNode(fieldElemType);
      this.write(' ');
      this.emitIdentifier(node.name);
      this.emitArrayDimensions(fieldArraySizes);
    }

    if (node.bitWidth) {
      if (this.style.spaceBeforeColon) this.write(' ');
      this.write(':');
      if (this.style.spaceAfterColon) this.write(' ');
      this.emitAssignmentExpression(node.bitWidth);
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
        this.emitAssignmentExpression(node.initializer);
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
        this.emitAssignmentExpression(node.arguments[i]);
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

  private emitStaticAssertDecl(node: StaticAssertDecl, noIndent = false): void {
    if (!noIndent) this.write(this.indent());
    this.write('static_assert(');
    this.emitAssignmentExpression(node.condition);
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
      case NodeKind.SehTryStmt:
        return true;
      default:
        return false;
    }
  }

  /**
   * Whether to insert a blank line between two consecutive statements. A blank
   * line is emitted only AFTER a control-flow block, never before one: a
   * statement that sets up a condition (e.g. `int x = f();`) stays tight to the
   * `if` that consumes it. Adjacent `if`s stay tight too, so guard-clause
   * ladders don't get blown apart — the blank lands after the last guard,
   * before the main body.
   */
  private blankLineBetween(a: Statement, b: Statement): boolean {
    if (!this.style.blankLineAroundControlFlow) return false;
    if (!this.isControlFlowBlock(a)) return false;
    if (a.kind === NodeKind.IfStmt && b.kind === NodeKind.IfStmt) return false;
    return true;
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
      case NodeKind.SehTryStmt:
      case NodeKind.PpConditionalStmt:
      case NodeKind.LabelStmt:
      case NodeKind.NullStmt:
      case NodeKind.CaseStmt:
      case NodeKind.DefaultStmt:
        return false;
      // A record definition or a static_assert inside a block writes its own
      // `};` / `);`. Emitting a statement terminator after it leaves a stray
      // empty declaration.
      case NodeKind.DeclStmt:
        return !this.isSelfTerminatingDecl(stmt as DeclStmt);
      default:
        return true;
    }
  }

  /** A `DeclStmt` whose one declaration emits its own indent and terminator. */
  private isSelfTerminatingDecl(stmt: DeclStmt): boolean {
    if (stmt.declarations.length !== 1) return false;
    switch (stmt.declarations[0].kind) {
      case NodeKind.StructDecl:
      case NodeKind.UnionDecl:
      case NodeKind.StaticAssertDecl:
        return true;
      default:
        return false;
    }
  }

  private emitExprStmt(node: ExprStmt): void {
    this.emitNode(node.expression);
  }

  private emitDeclStmt(node: DeclStmt): void {
    // The enclosing block already wrote the indent and, per `needsSemicolon`,
    // adds no terminator: these declarations supply their own.
    if (this.isSelfTerminatingDecl(node)) {
      const decl = node.declarations[0];
      this.emitTrivia(decl.leadingTrivia);
      if (decl.kind === NodeKind.StructDecl) this.emitStructDecl(decl as StructDecl, true);
      else if (decl.kind === NodeKind.UnionDecl) this.emitUnionDecl(decl as UnionDecl, true);
      else this.emitStaticAssertDecl(decl as StaticAssertDecl, true);
      return;
    }
    const variableDecls = node.declarations.every(d => d.kind === NodeKind.VariableDecl)
      ? node.declarations as VariableDecl[] : [];
    const variableDeclarators = variableDecls.length > 1
      ? variableDecls.map(v => this.localDeclarator(v.type, v.name.name)) : null;
    if (variableDeclarators) {
      const bases = variableDeclarators.map(d => new CppEmitter(this.style).emit(d.base as AnyNode));
      if (bases.some(base => base !== bases[0])) {
        throw new Error('Cannot emit a declaration list with different base types');
      }
    }
    for (let i = 0; i < node.declarations.length; i++) {
      if (i > 0) {
        this.write(',');
        if (this.style.spaceAfterComma) this.write(' ');
      }
      const decl = node.declarations[i];
      if (decl.kind === NodeKind.VariableDecl) {
        // For DeclStmt, emit inline (without indent and trailing semicolon)
        const v = decl as VariableDecl;
        if (variableDeclarators) {
          if (i === 0) {
            if (v.specifiers.length > 0) this.write(v.specifiers.join(' ') + ' ');
            this.emitTypeNode(variableDeclarators[0].base);
            this.write(' ');
          }
          this.write(variableDeclarators[i].name);
          if (v.initializer) {
            if (v.initializer.kind === NodeKind.InitListExpr) {
              if (v.copyListInit) this.write(this.style.spaceAroundOperators ? ' = ' : '=');
              this.emitInitListExpr(v.initializer as InitListExpr);
            } else {
              this.write(this.style.spaceAroundOperators ? ' = ' : '=');
              this.emitExprWithPrecedence(v.initializer, 17);
            }
          }
          continue;
        }
        // Pointer-to-array (`T (*name)[N]`) needs the C declarator syntax. Handle
        // the (common) single-declarator case here so body locals like
        // `D2UnitStrc*(*)[5] ppUnitTable` don't emit as invalid `T[N]* name`.
        if (i === 0 && node.declarations.length === 1 && this.emitNamedFunctionPointerDecl(v.type, v.name, v.specifiers)) {
          if (v.initializer) {
            if ((v.initializer as ASTNode).kind === NodeKind.InitListExpr) {
              if (v.copyListInit) this.write(this.style.spaceAroundOperators ? ' = ' : '=');
              this.emitInitListExpr(v.initializer as InitListExpr);
            } else {
              this.write(this.style.spaceAroundOperators ? ' = ' : '=');
              this.emitExprWithPrecedence(v.initializer, 17);
            }
          }
          continue;
        }
        if (i === 0 && node.declarations.length === 1 && this.isPointerToArray(v.type)) {
          if (v.specifiers.length > 0) this.write(v.specifiers.join(' ') + ' ');
          this.emitPointerToArrayDecl(v.type, v.name);
          if (v.initializer) {
            if ((v.initializer as ASTNode).kind === NodeKind.InitListExpr) {
              if (v.copyListInit) this.write(this.style.spaceAroundOperators ? ' = ' : '=');
              this.emitInitListExpr(v.initializer as InitListExpr);
            } else {
              this.write(this.style.spaceAroundOperators ? ' = ' : '=');
              this.emitAssignmentExpression(v.initializer);
            }
          }
          continue;
        }
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
            if (v.copyListInit) this.write(this.style.spaceAroundOperators ? ' = ' : '=');
            this.emitInitListExpr(v.initializer as InitListExpr);
          } else {
            if (this.style.spaceAroundOperators) {
              this.write(' = ');
            } else {
              this.write('=');
            }
            this.emitAssignmentExpression(v.initializer);
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

    // A following `else` binds to the nearest unmatched `if`, including one
    // at the end of an unbraced loop or label body. Keep the AST's owner by
    // bracing the then branch only when that branch could absorb this else.
    this.emitControlFlowBody(node.thenBranch, !!node.elseBranch && this.canAbsorbElse(node.thenBranch));

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

  private canAbsorbElse(stmt: Statement): boolean {
    switch (stmt.kind) {
      case NodeKind.IfStmt:
        return !(stmt as IfStmt).elseBranch || this.canAbsorbElse((stmt as IfStmt).elseBranch!);
      case NodeKind.WhileStmt:
        return this.canAbsorbElse((stmt as WhileStmt).body);
      case NodeKind.ForStmt:
        return this.canAbsorbElse((stmt as ForStmt).body);
      case NodeKind.ForRangeStmt:
        return this.canAbsorbElse((stmt as ForRangeStmt).body);
      case NodeKind.SwitchStmt:
        return this.canAbsorbElse((stmt as SwitchStmt).body);
      case NodeKind.CaseStmt:
        return this.canAbsorbElse((stmt as CaseStmt).statement);
      case NodeKind.DefaultStmt:
        return this.canAbsorbElse((stmt as DefaultStmt).statement);
      case NodeKind.LabelStmt:
        return this.canAbsorbElse((stmt as LabelStmt).statement);
      case NodeKind.PpConditionalStmt:
        // Preprocessing can expose an unmatched if (or several statements)
        // from either branch, so the emitted if body needs its own braces.
        return true;
      default:
        // A compound statement and a do-while's closing `while` both stop a
        // later `else` from reaching an if nested inside them.
        return false;
    }
  }

  private emitControlFlowBody(stmt: Statement, forceBraces = false): void {
    if (stmt.kind === NodeKind.CompoundStmt || this.style.alwaysUseBraces || forceBraces) {
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
      // An empty body is `;`: printed as nothing, `if (a) ;` took the next statement as its body.
      else if (stmt.kind === NodeKind.NullStmt) this.write(';');
      this.indentLevel--;
    }
  }

  /**
   * The trailing `case`/`default` of a switch whose statement is empty. C++
   * (before C++23) needs a statement after a label, so `case X:` as the last
   * thing before the closing brace is a hard error. Falling off the end of a
   * switch and breaking out of it are the same thing, so `break;` is faithful —
   * but ONLY for the last label. An empty label anywhere else is a deliberate
   * fallthrough and must stay empty.
   */
  private emptyTrailingLabel: ASTNode | null = null;

  private emitSwitchStmt(node: SwitchStmt): void {
    const previousTrailingLabel = this.emptyTrailingLabel;
    this.emptyTrailingLabel = trailingEmptyLabel(node.body);
    try {
      this.emitSwitchStmtInner(node);
    } finally {
      this.emptyTrailingLabel = previousTrailingLabel;
    }
  }

  private emitSwitchStmtInner(node: SwitchStmt): void {
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
    this.emitAssignmentExpression(node.value);
    this.write(':');
    this.newline();
    this.indentLevel++;
    this.write(this.indent());
    if (node === this.emptyTrailingLabel) {
      this.write('break;');
    } else {
      this.emitNode(node.statement);
      if (this.needsSemicolon(node.statement)) this.write(';');
    }
    this.indentLevel--;
  }

  private emitDefaultStmt(node: DefaultStmt): void {
    this.write('default:');
    this.newline();
    this.indentLevel++;
    this.write(this.indent());
    if (node === this.emptyTrailingLabel) {
      this.write('break;');
    } else {
      this.emitNode(node.statement);
      if (this.needsSemicolon(node.statement)) this.write(';');
    }
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
    // A label needs its statement: printed as nothing, `L: ;` would label whatever
    // follows (or end a block, which C++17 rejects).
    else if (node.statement.kind === NodeKind.NullStmt) this.write(';');
  }

  private emitSehTryStmt(node: SehTryStmt): void {
    this.write('__try ');
    this.emitCompoundStmt(node.body);
    if (this.style.braceStyle === 'stroustrup' || this.style.braceStyle === 'k&r') {
      this.write(' ');
    } else {
      this.newline();
      this.write(this.indent());
    }
    if (node.handlerKind === 'finally') {
      this.write('__finally ');
    } else {
      this.write('__except');
      if (this.style.spaceAfterKeyword) this.write(' ');
      this.write('(');
      if (node.filter) this.emitNode(node.filter);
      this.write(') ');
    }
    this.emitCompoundStmt(node.handler);
  }

  /** `#if` / `#else` / `#endif` around statements, at the statements' own indent. */
  private emitPpConditionalStmt(node: PpConditionalStmt): void {
    const branch = (stmts: Statement[]) => {
      for (const stmt of stmts) {
        this.newline();
        this.write(this.indent());
        this.emitNode(stmt);
        if (this.needsSemicolon(stmt)) this.write(';');
      }
    };
    this.write(`#if ${node.condition}`);
    branch(node.thenStatements);
    if (node.elseStatements) {
      this.newline();
      this.write(this.indent());
      this.write('#else');
      branch(node.elseStatements);
    }
    this.newline();
    this.write(this.indent());
    this.write('#endif');
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
    if (node.isRaw) {
      this.write(node.raw);
      return;
    }
    // Parsed literals retain their source spelling. Escape only question marks
    // not already escaped in that spelling, so C++03 phase-one trigraph
    // substitution cannot change their contents. Keep prefix and suffix intact.
    const firstQuote = node.raw.indexOf('"');
    const lastQuote = node.raw.lastIndexOf('"');
    if (firstQuote < 0 || lastQuote <= firstQuote) {
      this.write(node.raw);
      return;
    }
    let out = node.raw.slice(0, firstQuote + 1);
    let backslashes = 0;
    for (let i = firstQuote + 1; i < lastQuote; i++) {
      const ch = node.raw[i];
      if (ch === '?' && backslashes % 2 === 0) out += '\\';
      out += ch;
      backslashes = ch === '\\' ? backslashes + 1 : 0;
    }
    this.write(out + node.raw.slice(lastQuote));
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
    // The parser represents the comma operator as BinaryExpr(',', ...), while
    // transforms may construct CommaExpr. In either form, foo((a, b)) must stay
    // a one-argument call rather than becoming foo(a, b).
    if (this.isCommaOperatorExpr(inner)) {
      this.write('(');
      this.emitNode(inner);
      this.write(')');
      return;
    }
    this.emitNode(inner);
  }

  private isCommaOperatorExpr(expr: Expression): boolean {
    return expr.kind === NodeKind.CommaExpr
      || (expr.kind === NodeKind.BinaryExpr && ((expr as BinaryExpr).operator as string) === ',');
  }

  private getExprPrecedence(expr: Expression): number {
    // Look through transparent ParenExpr to get the inner expression's precedence
    if (expr.kind === NodeKind.ParenExpr) {
      const inner = (expr as ParenExpr).expression;
      // Comma-operator parens are kept explicitly, so treat them as an atom.
      if (this.isCommaOperatorExpr(inner)) return 0;
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

  /** One expression in a comma-delimited grammar position. */
  private emitAssignmentExpression(expr: Expression): void {
    this.emitExprWithPrecedence(expr, OPERATOR_PRECEDENCE['=']);
  }

  private emitBinaryExpr(node: BinaryExpr): void {
    const precedence = OPERATOR_PRECEDENCE[node.operator] ?? 20;
    // `(a < b) > c` printed as `a < b > c` is the same comparison only while `a`
    // names no template; where it does, the `>` closes a template argument list.
    // A `<` comparison on the left of an operator that starts with `>` keeps its
    // parentheses.
    if (node.operator.startsWith('>') && this.isLessThanComparison(node.left)) {
      this.write('(');
      this.emitNode(node.left);
      this.write(')');
    } else {
      this.emitExprWithPrecedence(node.left, precedence);
    }
    // Right child grouping also determines whether the first right token is visible.
    const rightPrec = this.rightChildSameAssociativeOp(node) ? precedence : precedence - 1;
    if (this.style.spaceAroundOperators) {
      this.write(' ' + node.operator + ' ');
    } else {
      this.write(node.operator);
      if (this.binaryRightNeedsTokenSeparator(node, rightPrec)) this.write(' ');
    }
    // Right child: use precedence - 1 to force parens for same-precedence ops
    // (e.g. a - (b - c) ≠ a - b - c). But if the right child is the same
    // associative operator, parens are unnecessary (e.g. a && b && c).
    this.emitExprWithPrecedence(node.right, rightPrec);
  }

  /** Prevent compact binary/unary tokens from merging or starting a comment. */
  private binaryRightNeedsTokenSeparator(node: BinaryExpr, rightPrecedence: number): boolean {
    const op = node.operator;
    if (op !== '+' && op !== '-' && op !== '&' && op !== '/') return false;
    const first = this.firstEmittedExprToken(node.right, rightPrecedence);
    return first?.startsWith(op === '/' ? '*' : op) ?? false;
  }

  /** Trace only the expression's emitted left edge, including inserted parentheses. */
  private firstEmittedExprToken(expr: Expression, parentPrecedence: number): string | null {
    while (true) {
      if (this.getExprPrecedence(expr) > parentPrecedence) return '(';
      switch (expr.kind) {
        case NodeKind.ParenExpr: {
          const inner = (expr as ParenExpr).expression;
          if (inner.kind === NodeKind.CommaExpr) return '(';
          expr = inner;
          break;
        }
        case NodeKind.BinaryExpr: {
          const binary = expr as BinaryExpr;
          if (binary.operator.startsWith('>') && this.isLessThanComparison(binary.left)) return '(';
          parentPrecedence = OPERATOR_PRECEDENCE[binary.operator] ?? 20;
          expr = binary.left;
          break;
        }
        case NodeKind.UnaryExpr:
          return (expr as UnaryExpr).operator;
        case NodeKind.IntegerLiteral:
        case NodeKind.FloatingLiteral:
        case NodeKind.UserDefinedLiteral:
          return expr.raw;
        case NodeKind.PostfixExpr: {
          const postfix = expr as PostfixExpr;
          parentPrecedence = OPERATOR_PRECEDENCE[postfix.operator + '_post'] ?? 2;
          expr = postfix.operand;
          break;
        }
        case NodeKind.MemberExpr:
          expr = (expr as MemberExpr).object;
          parentPrecedence = 2;
          break;
        case NodeKind.SubscriptExpr:
          expr = (expr as SubscriptExpr).array;
          parentPrecedence = 2;
          break;
        case NodeKind.CallExpr:
          expr = (expr as CallExpr).callee;
          parentPrecedence = 2;
          break;
        case NodeKind.PackExpansionExpr:
          expr = (expr as PackExpansionExpr).pattern;
          parentPrecedence = Infinity;
          break;
        default:
          return null;
      }
    }
  }

  /** A `<` comparison, looking through ParenExpr. */
  private isLessThanComparison(expr: Expression): boolean {
    while (expr.kind === NodeKind.ParenExpr) expr = (expr as ParenExpr).expression;
    return expr.kind === NodeKind.BinaryExpr && (expr as BinaryExpr).operator === '<';
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

  /** Keep adjacent prefix operators and signed literal text from lexing as ++, --, or &&. */
  private unaryOperandNeedsTokenSeparator(node: UnaryExpr): boolean {
    const op = node.operator;
    if (op !== '+' && op !== '-' && op !== '&') return false;
    let operand = node.operand;
    while (operand.kind === NodeKind.ParenExpr) operand = (operand as ParenExpr).expression;
    if (operand.kind === NodeKind.UnaryExpr) return (operand as UnaryExpr).operator.startsWith(op);
    if (operand.kind === NodeKind.IntegerLiteral || operand.kind === NodeKind.FloatingLiteral) {
      return (operand as IntegerLiteralExpr | FloatingLiteralExpr).raw.startsWith(op);
    }
    return false;
  }

  private emitUnaryExpr(node: UnaryExpr): void {
    this.write(node.operator);
    if (this.unaryOperandNeedsTokenSeparator(node)) this.write(' ');
    this.emitExprWithPrecedence(node.operand, 3);
  }

  private emitPostfixExpr(node: PostfixExpr): void {
    // Parenthesize a lower-precedence operand so `++`/`--` binds to it, not to a
    // sub-expression: a deref operand `*(short *)(p)` (prec 3) must emit
    // `(*(short *)(p))++`, else `*(short *)(p)++` increments the cast (an rvalue)
    // → "lvalue required as increment operand".
    const precedence = OPERATOR_PRECEDENCE[node.operator + '_post'] ?? 2;
    this.emitExprWithPrecedence(node.operand, precedence);
    this.write(node.operator);
  }

  private emitConditionalExpr(node: ConditionalExpr): void {
    const precedence = OPERATOR_PRECEDENCE['?:'];
    // C++ parses the condition as a logical-or expression. A conditional,
    // assignment, or comma expression here needs its own parentheses.
    this.emitExprWithPrecedence(node.condition, OPERATOR_PRECEDENCE['||']);
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
    const precedence = OPERATOR_PRECEDENCE[node.operator] ?? 17;
    // An assignment's left grammar is a logical-or-expression. A conditional
    // or another assignment on the left needs parentheses even though `?:`
    // has nominally higher precedence: `(c ? a : b) = v` and `c ? a : b = v`
    // select different assignment targets.
    this.emitExprWithPrecedence(node.left, OPERATOR_PRECEDENCE['||']);
    if (this.style.spaceAroundOperators) {
      this.write(' ' + node.operator + ' ');
    } else {
      this.write(node.operator);
    }
    // Assignment associates right-to-left; a comma expression on the right
    // still needs grouping or it escapes this assignment.
    this.emitExprWithPrecedence(node.right, precedence);
  }

  private emitCommaExpr(node: CommaExpr): void {
    for (let i = 0; i < node.expressions.length; i++) {
      if (i > 0) {
        this.write(',');
        if (this.style.spaceAfterComma) this.write(' ');
      }
      const expression = node.expressions[i];
      let inner = expression;
      while (inner.kind === NodeKind.ParenExpr) inner = (inner as ParenExpr).expression;
      // The comma operator associates left-to-right. A comma expression in a
      // later slot is the right operand and needs grouping, especially when
      // operator comma is overloaded. ParenExpr already preserves a CommaExpr
      // wrapper, while a BinaryExpr comma wrapper can be transparent.
      const commaOperator = inner.kind === NodeKind.CommaExpr ||
        (inner.kind === NodeKind.BinaryExpr && ((inner as BinaryExpr).operator as string) === ',');
      const preservedParen = expression.kind === NodeKind.ParenExpr && inner.kind === NodeKind.CommaExpr;
      const groupRightComma = i > 0 && commaOperator && !preservedParen;
      if (groupRightComma) this.write('(');
      this.emitNode(expression);
      if (groupRightComma) this.write(')');
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
    this.emitAssignmentExpression(node.index);
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
      // A call argument is an assignment-expression; a top-level comma is
      // the argument separator, so a comma-operator AST needs parentheses.
      this.emitAssignmentExpression(node.arguments[i]);
    }
    if (this.style.spaceInsideParens && node.arguments.length > 0) this.write(' ');
    this.write(')');
  }

  private emitCStyleCastExpr(node: CStyleCastExpr): void {
    this.write('(');
    if (!this.emitAbstractPointerToArray(node.type)) this.emitTypeNode(node.type);
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
      this.emitAssignmentExpression(node.arguments[i]);
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
        this.emitAssignmentExpression(node.placement[i]);
      }
      this.write(')');
    }
    this.write(' ');
    if (node.isArray) {
      this.emitTypeNode(node.type);
      this.write('[');
      if (node.arraySize) {
        this.emitAssignmentExpression(node.arraySize);
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
        this.emitAssignmentExpression(node.initializer);
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
        this.emitAssignmentExpression(node.initializer);
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
    if (node.multiline && node.elements.length > 0) {
      this.write('{');
      this.newline();
      this.indentLevel++;
      node.elements.forEach((e, i) => {
        this.write(this.indent());
        this.emitAssignmentExpression(e);
        if (i < node.elements.length - 1) this.write(',');
        this.newline();
      });
      this.indentLevel--;
      this.write(this.indent() + '}');
      return;
    }
    this.write('{');
    for (let i = 0; i < node.elements.length; i++) {
      if (i > 0) {
        this.write(',');
        if (this.style.spaceAfterComma) this.write(' ');
      }
      this.emitAssignmentExpression(node.elements[i]);
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
        this.emitAssignmentExpression(designator.index);
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
      this.emitAssignmentExpression(node.initializer as Expression);
    }
  }

  private emitPackExpansionExpr(node: PackExpansionExpr): void {
    this.emitAssignmentExpression(node.pattern);
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
      this.emitAssignmentExpression(node.expression);
    }
  }

  private emitCoYieldExpr(node: CoYieldExpr): void {
    this.write('co_yield ');
    this.emitAssignmentExpression(node.expression);
  }

  private emitCoAwaitExpr(node: CoAwaitExpr): void {
    this.write('co_await ');
    this.emitAssignmentExpression(node.expression);
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
