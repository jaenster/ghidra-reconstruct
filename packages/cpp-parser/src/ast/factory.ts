/**
 * AST Factory Functions
 * Helpers for creating AST nodes programmatically
 */

import { NodeKind } from './kinds.js';
import type { SourceLocation, Position } from '../lexer/index.js';
import type { Trivia } from '../lexer/trivia.js';
import type {
  // Types
  TypeNode,
  BuiltinType,
  PointerType,
  ReferenceType,
  ArrayType,
  QualifiedType,
  TemplateType,
  AutoType,
  TypeModifier,
  TypeQualifier,

  // Declarations
  TranslationUnit,
  Declaration,
  FunctionDecl,
  VariableDecl,
  ParameterDecl,
  ClassDecl,
  StructDecl,
  EnumDecl,
  EnumeratorDecl,
  NamespaceDecl,
  TypedefDecl,
  TypeAliasDecl,
  FieldDecl,
  MethodDecl,
  FunctionSpecifier,
  VariableSpecifier,
  FieldSpecifier,

  // Statements
  Statement,
  CompoundStmt,
  ExprStmt,
  IfStmt,
  ForStmt,
  WhileStmt,
  DoWhileStmt,
  ReturnStmt,
  BreakStmt,
  ContinueStmt,
  NullStmt,
  LabelStmt,

  // Expressions
  Expression,
  Identifier,
  QualifiedId,
  IntegerLiteralExpr,
  FloatingLiteralExpr,
  StringLiteralExpr,
  CharLiteralExpr,
  BoolLiteralExpr,
  NullptrLiteralExpr,
  BinaryExpr,
  UnaryExpr,
  PostfixExpr,
  CallExpr,
  MemberExpr,
  SubscriptExpr,
  AssignExpr,
  ConditionalExpr,
  CStyleCastExpr,
  SizeofExpr,
  NewExpr,
  DeleteExpr,
  InitListExpr,
  ParenExpr,
  ThisExpr,
  BinaryOperator,
  UnaryOperator,
  AssignOperator,
  Attribute,
  GhidraMetadata,
} from './nodes.js';

// ============================================
// LOCATION HELPERS
// ============================================

const defaultPosition: Position = { line: 0, column: 0, offset: 0 };

const defaultLocation: SourceLocation = {
  file: '<generated>',
  start: defaultPosition,
  end: defaultPosition,
};

const emptyTrivia: Trivia[] = [];

/**
 * Helper to create AST nodes with default location and trivia.
 * Returns the node cast to the target type T.
 */
function withDefaults<T>(node: Omit<T, 'location' | 'leadingTrivia' | 'trailingTrivia'> & {
  location?: SourceLocation;
  leadingTrivia?: Trivia[];
  trailingTrivia?: Trivia[];
  ghidraInfo?: GhidraMetadata;
}): T {
  return {
    ...node,
    location: node.location ?? defaultLocation,
    leadingTrivia: node.leadingTrivia ?? emptyTrivia,
    trailingTrivia: node.trailingTrivia ?? emptyTrivia,
  } as T;
}

// ============================================
// TYPE FACTORY
// ============================================

export const Type = {
  builtin(name: string, modifiers: TypeModifier[] = []): BuiltinType {
    return withDefaults({
      kind: NodeKind.BuiltinType,
      name,
      modifiers,
    }) as BuiltinType;
  },

  int(modifiers: TypeModifier[] = []): BuiltinType {
    return Type.builtin('int', modifiers);
  },

  char(modifiers: TypeModifier[] = []): BuiltinType {
    return Type.builtin('char', modifiers);
  },

  void(): BuiltinType {
    return Type.builtin('void');
  },

  bool(): BuiltinType {
    return Type.builtin('bool');
  },

  float(): BuiltinType {
    return Type.builtin('float');
  },

  double(): BuiltinType {
    return Type.builtin('double');
  },

  pointer(pointee: TypeNode, qualifiers: TypeQualifier[] = []): PointerType {
    return withDefaults({
      kind: NodeKind.PointerType,
      pointee,
      qualifiers,
    }) as PointerType;
  },

  reference(referenced: TypeNode): ReferenceType {
    return withDefaults({
      kind: NodeKind.ReferenceType,
      referenced,
    }) as ReferenceType;
  },

  array(elementType: TypeNode, size: Expression | null = null): ArrayType {
    return withDefaults({
      kind: NodeKind.ArrayType,
      elementType,
      size,
    }) as ArrayType;
  },

  qualified(type: TypeNode, qualifiers: TypeQualifier[]): QualifiedType {
    return withDefaults({
      kind: NodeKind.QualifiedType,
      type,
      qualifiers,
    }) as QualifiedType;
  },

  const(type: TypeNode): QualifiedType {
    return Type.qualified(type, ['const']);
  },

  template(name: Identifier | QualifiedId, args: TypeNode[]): TemplateType {
    return withDefaults({
      kind: NodeKind.TemplateType,
      name,
      arguments: args.map(t => ({
        kind: NodeKind.TypeTemplateArg,
        type: t,
        location: defaultLocation,
        leadingTrivia: emptyTrivia,
        trailingTrivia: emptyTrivia,
      })),
    }) as TemplateType;
  },

  auto(isDecltypeAuto: boolean = false): AutoType {
    return withDefaults({
      kind: NodeKind.AutoType,
      isDecltypeAuto,
    }) as AutoType;
  },
};

// ============================================
// EXPRESSION FACTORY
// ============================================

export const Expr = {
  identifier(name: string): Identifier {
    return withDefaults({
      kind: NodeKind.Identifier,
      name,
    }) as Identifier;
  },

  qualifiedId(parts: string[], isGlobal: boolean = false): QualifiedId {
    const qualifier = parts.slice(0, -1).map(p => Expr.identifier(p));
    const name = Expr.identifier(parts[parts.length - 1]);
    return withDefaults({
      kind: NodeKind.QualifiedId,
      qualifier,
      name,
      isGlobal,
    }) as QualifiedId;
  },

  intLiteral(value: bigint | number, base: 2 | 8 | 10 | 16 = 10): IntegerLiteralExpr {
    const bigValue = typeof value === 'number' ? BigInt(value) : value;
    const raw = base === 16 ? `0x${bigValue.toString(16)}` :
                base === 2 ? `0b${bigValue.toString(2)}` :
                base === 8 ? `0${bigValue.toString(8)}` :
                bigValue.toString();
    return withDefaults({
      kind: NodeKind.IntegerLiteral,
      value: bigValue,
      suffix: '',
      base,
      raw,
    }) as IntegerLiteralExpr;
  },

  floatLiteral(value: number): FloatingLiteralExpr {
    return withDefaults({
      kind: NodeKind.FloatingLiteral,
      value,
      suffix: '',
      raw: String(value),
    }) as FloatingLiteralExpr;
  },

  stringLiteral(value: string, prefix: string = ''): StringLiteralExpr {
    return withDefaults({
      kind: NodeKind.StringLiteral,
      value,
      prefix,
      isRaw: false,
      raw: `${prefix}"${value}"`,
    }) as StringLiteralExpr;
  },

  charLiteral(value: number | string): CharLiteralExpr {
    const charCode = typeof value === 'string' ? value.charCodeAt(0) : value;
    const char = String.fromCharCode(charCode);
    return withDefaults({
      kind: NodeKind.CharLiteral,
      value: charCode,
      prefix: '',
      raw: `'${char}'`,
    }) as CharLiteralExpr;
  },

  boolLiteral(value: boolean): BoolLiteralExpr {
    return withDefaults({
      kind: NodeKind.BoolLiteral,
      value,
    }) as BoolLiteralExpr;
  },

  nullptr(): NullptrLiteralExpr {
    return withDefaults({
      kind: NodeKind.NullptrLiteral,
    }) as NullptrLiteralExpr;
  },

  this(): ThisExpr {
    return withDefaults({
      kind: NodeKind.ThisExpr,
    }) as ThisExpr;
  },

  binary(left: Expression, operator: BinaryOperator, right: Expression): BinaryExpr {
    return withDefaults({
      kind: NodeKind.BinaryExpr,
      operator,
      left,
      right,
    }) as BinaryExpr;
  },

  unary(operator: UnaryOperator, operand: Expression): UnaryExpr {
    return withDefaults({
      kind: NodeKind.UnaryExpr,
      operator,
      operand,
    }) as UnaryExpr;
  },

  postfix(operand: Expression, operator: '++' | '--'): PostfixExpr {
    return withDefaults({
      kind: NodeKind.PostfixExpr,
      operator,
      operand,
    }) as PostfixExpr;
  },

  call(callee: Expression | string, args: Expression[]): CallExpr {
    const calleeExpr = typeof callee === 'string' ? Expr.identifier(callee) : callee;
    return withDefaults({
      kind: NodeKind.CallExpr,
      callee: calleeExpr,
      arguments: args,
    }) as CallExpr;
  },

  member(object: Expression, member: string | Identifier, isArrow: boolean = false): MemberExpr {
    const memberExpr = typeof member === 'string' ? Expr.identifier(member) : member;
    return withDefaults({
      kind: NodeKind.MemberExpr,
      object,
      member: memberExpr,
      isArrow,
    }) as MemberExpr;
  },

  subscript(array: Expression, index: Expression): SubscriptExpr {
    return withDefaults({
      kind: NodeKind.SubscriptExpr,
      array,
      index,
    }) as SubscriptExpr;
  },

  assign(left: Expression, right: Expression, operator: AssignOperator = '='): AssignExpr {
    return withDefaults({
      kind: NodeKind.AssignExpr,
      operator,
      left,
      right,
    }) as AssignExpr;
  },

  conditional(condition: Expression, thenExpr: Expression, elseExpr: Expression): ConditionalExpr {
    return withDefaults({
      kind: NodeKind.ConditionalExpr,
      condition,
      thenExpr,
      elseExpr,
    }) as ConditionalExpr;
  },

  cast(type: TypeNode, expression: Expression): CStyleCastExpr {
    return withDefaults({
      kind: NodeKind.CStyleCastExpr,
      type,
      expression,
    }) as CStyleCastExpr;
  },

  sizeof(operand: Expression | TypeNode, isType: boolean = false): SizeofExpr {
    return withDefaults({
      kind: NodeKind.SizeofExpr,
      operand,
      isType,
    }) as SizeofExpr;
  },

  new_(type: TypeNode, args: Expression[] = [], isArray: boolean = false): NewExpr {
    return withDefaults({
      kind: NodeKind.NewExpr,
      type,
      placement: [],
      initializer: args.length > 0 ? Expr.initList(args) : null,
      isArray,
    }) as NewExpr;
  },

  delete_(expression: Expression, isArray: boolean = false): DeleteExpr {
    return withDefaults({
      kind: NodeKind.DeleteExpr,
      expression,
      isArray,
    }) as DeleteExpr;
  },

  initList(elements: Expression[]): InitListExpr {
    return withDefaults({
      kind: NodeKind.InitListExpr,
      elements,
    }) as InitListExpr;
  },

  paren(expression: Expression): ParenExpr {
    return withDefaults({
      kind: NodeKind.ParenExpr,
      expression,
    }) as ParenExpr;
  },

  // Convenience: a + b
  add(left: Expression, right: Expression): BinaryExpr {
    return Expr.binary(left, '+', right);
  },

  // Convenience: a - b
  sub(left: Expression, right: Expression): BinaryExpr {
    return Expr.binary(left, '-', right);
  },

  // Convenience: a * b
  mul(left: Expression, right: Expression): BinaryExpr {
    return Expr.binary(left, '*', right);
  },

  // Convenience: a / b
  div(left: Expression, right: Expression): BinaryExpr {
    return Expr.binary(left, '/', right);
  },

  // Convenience: a == b
  eq(left: Expression, right: Expression): BinaryExpr {
    return Expr.binary(left, '==', right);
  },

  // Convenience: a != b
  ne(left: Expression, right: Expression): BinaryExpr {
    return Expr.binary(left, '!=', right);
  },

  // Convenience: a < b
  lt(left: Expression, right: Expression): BinaryExpr {
    return Expr.binary(left, '<', right);
  },

  // Convenience: a > b
  gt(left: Expression, right: Expression): BinaryExpr {
    return Expr.binary(left, '>', right);
  },

  // Convenience: a && b
  and(left: Expression, right: Expression): BinaryExpr {
    return Expr.binary(left, '&&', right);
  },

  // Convenience: a || b
  or(left: Expression, right: Expression): BinaryExpr {
    return Expr.binary(left, '||', right);
  },

  // Convenience: !a
  not(operand: Expression): UnaryExpr {
    return Expr.unary('!', operand);
  },

  // Convenience: -a
  neg(operand: Expression): UnaryExpr {
    return Expr.unary('-', operand);
  },

  // Convenience: *a (dereference)
  deref(operand: Expression): UnaryExpr {
    return Expr.unary('*', operand);
  },

  // Convenience: &a (address-of)
  addressOf(operand: Expression): UnaryExpr {
    return Expr.unary('&', operand);
  },
};

// ============================================
// STATEMENT FACTORY
// ============================================

export const Stmt = {
  compound(statements: Statement[]): CompoundStmt {
    return withDefaults({
      kind: NodeKind.CompoundStmt,
      statements,
    }) as CompoundStmt;
  },

  expr(expression: Expression): ExprStmt {
    return withDefaults({
      kind: NodeKind.ExprStmt,
      expression,
    }) as ExprStmt;
  },

  if_(condition: Expression, thenBranch: Statement, elseBranch: Statement | null = null): IfStmt {
    return withDefaults({
      kind: NodeKind.IfStmt,
      condition,
      thenBranch,
      elseBranch,
      isConstexpr: false,
    }) as IfStmt;
  },

  for_(
    init: Statement | null,
    condition: Expression | null,
    increment: Expression | null,
    body: Statement
  ): ForStmt {
    return withDefaults({
      kind: NodeKind.ForStmt,
      init,
      condition,
      increment,
      body,
    }) as ForStmt;
  },

  while_(condition: Expression, body: Statement): WhileStmt {
    return withDefaults({
      kind: NodeKind.WhileStmt,
      condition,
      body,
    }) as WhileStmt;
  },

  doWhile(body: Statement, condition: Expression): DoWhileStmt {
    return withDefaults({
      kind: NodeKind.DoWhileStmt,
      body,
      condition,
    }) as DoWhileStmt;
  },

  return_(value: Expression | null = null): ReturnStmt {
    return withDefaults({
      kind: NodeKind.ReturnStmt,
      value,
    }) as ReturnStmt;
  },

  break_(): BreakStmt {
    return withDefaults({
      kind: NodeKind.BreakStmt,
    }) as BreakStmt;
  },

  continue_(): ContinueStmt {
    return withDefaults({
      kind: NodeKind.ContinueStmt,
    }) as ContinueStmt;
  },

  null_(): NullStmt {
    return withDefaults({
      kind: NodeKind.NullStmt,
    }) as NullStmt;
  },

  label(name: string | Identifier, statement: Statement = Stmt.null_()): LabelStmt {
    return withDefaults({
      kind: NodeKind.LabelStmt,
      label: typeof name === 'string' ? Expr.identifier(name) : name,
      statement,
    }) as LabelStmt;
  },

  block(statements: Statement[]): CompoundStmt {
    return Stmt.compound(statements);
  },
};

// ============================================
// DECLARATION FACTORY
// ============================================

export const Decl = {
  translationUnit(declarations: Declaration[]): TranslationUnit {
    return withDefaults({
      kind: NodeKind.TranslationUnit,
      declarations,
    }) as TranslationUnit;
  },

  function_(
    name: string | Identifier,
    returnType: TypeNode,
    parameters: ParameterDecl[],
    body: CompoundStmt | null = null,
    specifiers: FunctionSpecifier[] = []
  ): FunctionDecl {
    const nameId = typeof name === 'string' ? Expr.identifier(name) : name;
    return withDefaults({
      kind: NodeKind.FunctionDecl,
      name: nameId,
      returnType,
      parameters,
      body,
      specifiers,
      attributes: [],
      isVariadic: false,
    }) as FunctionDecl;
  },

  parameter(
    name: string | Identifier | null,
    type: TypeNode,
    defaultValue: Expression | null = null
  ): ParameterDecl {
    const nameId = name === null ? null :
      typeof name === 'string' ? Expr.identifier(name) : name;
    return withDefaults({
      kind: NodeKind.ParameterDecl,
      name: nameId,
      type,
      defaultValue,
      isVariadic: false,
    }) as ParameterDecl;
  },

  variable(
    name: string | Identifier,
    type: TypeNode,
    initializer: Expression | InitListExpr | null = null,
    specifiers: VariableSpecifier[] = []
  ): VariableDecl {
    const nameId = typeof name === 'string' ? Expr.identifier(name) : name;
    return withDefaults({
      kind: NodeKind.VariableDecl,
      name: nameId,
      type,
      initializer,
      specifiers,
      attributes: [],
    }) as VariableDecl;
  },

  class_(
    name: string | Identifier | null,
    members: ClassDecl['members'] = [],
    bases: ClassDecl['bases'] = []
  ): ClassDecl {
    const nameId = name === null ? null :
      typeof name === 'string' ? Expr.identifier(name) : name;
    return withDefaults({
      kind: NodeKind.ClassDecl,
      name: nameId,
      bases,
      members,
      isFinal: false,
      attributes: [],
    }) as ClassDecl;
  },

  struct_(
    name: string | Identifier | null,
    members: StructDecl['members'] = [],
    bases: StructDecl['bases'] = []
  ): StructDecl {
    const nameId = name === null ? null :
      typeof name === 'string' ? Expr.identifier(name) : name;
    return withDefaults({
      kind: NodeKind.StructDecl,
      name: nameId,
      bases,
      members,
      isFinal: false,
      attributes: [],
    }) as StructDecl;
  },

  field(
    name: string | Identifier,
    type: TypeNode,
    initializer: Expression | null = null,
    specifiers: FieldSpecifier[] = []
  ): FieldDecl {
    const nameId = typeof name === 'string' ? Expr.identifier(name) : name;
    return withDefaults({
      kind: NodeKind.FieldDecl,
      name: nameId,
      type,
      initializer,
      bitWidth: null,
      specifiers,
      attributes: [],
    }) as FieldDecl;
  },

  enum_(
    name: string | Identifier | null,
    enumerators: EnumeratorDecl[],
    isScoped: boolean = false,
    underlyingType: TypeNode | null = null
  ): EnumDecl {
    const nameId = name === null ? null :
      typeof name === 'string' ? Expr.identifier(name) : name;
    return withDefaults({
      kind: NodeKind.EnumDecl,
      name: nameId,
      isScoped,
      underlyingType,
      enumerators,
      attributes: [],
    }) as EnumDecl;
  },

  enumerator(
    name: string | Identifier,
    value: Expression | null = null
  ): EnumeratorDecl {
    const nameId = typeof name === 'string' ? Expr.identifier(name) : name;
    return withDefaults({
      kind: NodeKind.EnumeratorDecl,
      name: nameId,
      value,
      attributes: [],
    }) as EnumeratorDecl;
  },

  namespace_(
    name: string | Identifier | null,
    declarations: Declaration[],
    isInline: boolean = false
  ): NamespaceDecl {
    const nameId = name === null ? null :
      typeof name === 'string' ? Expr.identifier(name) : name;
    return withDefaults({
      kind: NodeKind.NamespaceDecl,
      name: nameId,
      declarations,
      isInline,
      attributes: [],
    }) as NamespaceDecl;
  },

  typedef_(name: string | Identifier, type: TypeNode): TypedefDecl {
    const nameId = typeof name === 'string' ? Expr.identifier(name) : name;
    return withDefaults({
      kind: NodeKind.TypedefDecl,
      name: nameId,
      type,
    }) as TypedefDecl;
  },

  typeAlias(name: string | Identifier, type: TypeNode): TypeAliasDecl {
    const nameId = typeof name === 'string' ? Expr.identifier(name) : name;
    return withDefaults({
      kind: NodeKind.TypeAliasDecl,
      name: nameId,
      type,
      attributes: [],
    }) as TypeAliasDecl;
  },
};

// ============================================
// ATTRIBUTE FACTORY
// ============================================

export const Attr = {
  create(name: string, args: Expression[] = [], namespace: string | null = null): Attribute {
    return withDefaults({
      kind: NodeKind.Attribute,
      namespace: namespace ? Expr.identifier(namespace) : null,
      name: Expr.identifier(name),
      arguments: args,
    }) as Attribute;
  },

  nodiscard(reason?: string): Attribute {
    const args = reason ? [Expr.stringLiteral(reason)] : [];
    return Attr.create('nodiscard', args);
  },

  deprecated(reason?: string): Attribute {
    const args = reason ? [Expr.stringLiteral(reason)] : [];
    return Attr.create('deprecated', args);
  },

  maybe_unused(): Attribute {
    return Attr.create('maybe_unused');
  },

  noreturn(): Attribute {
    return Attr.create('noreturn');
  },

  likely(): Attribute {
    return Attr.create('likely');
  },

  unlikely(): Attribute {
    return Attr.create('unlikely');
  },
};

// ============================================
// COMBINED FACTORY
// ============================================

export const AST = {
  Type,
  Expr,
  Stmt,
  Decl,
  Attr,
};

export default AST;
