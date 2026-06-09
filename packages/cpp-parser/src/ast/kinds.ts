/**
 * AST Node Kinds
 * Complete enumeration of all C++ AST node types
 */

export enum NodeKind {
  // ============================================
  // SOURCE FILE
  // ============================================
  TranslationUnit = 'TranslationUnit',

  // ============================================
  // DECLARATIONS
  // ============================================
  FunctionDecl = 'FunctionDecl',
  VariableDecl = 'VariableDecl',
  ParameterDecl = 'ParameterDecl',
  ClassDecl = 'ClassDecl',
  StructDecl = 'StructDecl',
  UnionDecl = 'UnionDecl',
  EnumDecl = 'EnumDecl',
  EnumeratorDecl = 'EnumeratorDecl',
  NamespaceDecl = 'NamespaceDecl',
  TypedefDecl = 'TypedefDecl',
  TypeAliasDecl = 'TypeAliasDecl',       // using X = Y
  UsingDecl = 'UsingDecl',               // using ns::name
  UsingDirective = 'UsingDirective',     // using namespace ns
  TemplateDecl = 'TemplateDecl',
  TemplateTypeParam = 'TemplateTypeParam',
  TemplateNonTypeParam = 'TemplateNonTypeParam',
  TemplateTemplateParam = 'TemplateTemplateParam',
  ConceptDecl = 'ConceptDecl',
  FieldDecl = 'FieldDecl',               // Class/struct member variable
  MethodDecl = 'MethodDecl',             // Class/struct member function
  ConstructorDecl = 'ConstructorDecl',
  DestructorDecl = 'DestructorDecl',
  FriendDecl = 'FriendDecl',
  AccessSpecifier = 'AccessSpecifier',   // public:, private:, protected:
  StaticAssertDecl = 'StaticAssertDecl',
  LinkageSpec = 'LinkageSpec',           // extern "C" { }
  NamespaceAlias = 'NamespaceAlias',     // namespace foo = bar::baz
  AsmDecl = 'AsmDecl',                   // asm("...")
  EmptyDecl = 'EmptyDecl',               // ;

  // ============================================
  // STATEMENTS
  // ============================================
  CompoundStmt = 'CompoundStmt',         // { ... }
  ExprStmt = 'ExprStmt',                 // expr;
  DeclStmt = 'DeclStmt',                 // declaration statement
  IfStmt = 'IfStmt',
  SwitchStmt = 'SwitchStmt',
  CaseStmt = 'CaseStmt',
  DefaultStmt = 'DefaultStmt',
  WhileStmt = 'WhileStmt',
  DoWhileStmt = 'DoWhileStmt',
  ForStmt = 'ForStmt',
  ForRangeStmt = 'ForRangeStmt',         // for (auto x : container)
  BreakStmt = 'BreakStmt',
  ContinueStmt = 'ContinueStmt',
  ReturnStmt = 'ReturnStmt',
  GotoStmt = 'GotoStmt',
  LabelStmt = 'LabelStmt',
  NullStmt = 'NullStmt',                 // ;
  TryStmt = 'TryStmt',
  CatchClause = 'CatchClause',
  ThrowExpr = 'ThrowExpr',

  // C++20 Coroutines
  CoReturnStmt = 'CoReturnStmt',
  CoYieldExpr = 'CoYieldExpr',
  CoAwaitExpr = 'CoAwaitExpr',

  // ============================================
  // EXPRESSIONS
  // ============================================
  // Literals
  IntegerLiteral = 'IntegerLiteral',
  FloatingLiteral = 'FloatingLiteral',
  CharLiteral = 'CharLiteral',
  StringLiteral = 'StringLiteral',
  BoolLiteral = 'BoolLiteral',
  NullptrLiteral = 'NullptrLiteral',
  UserDefinedLiteral = 'UserDefinedLiteral',

  // Primary expressions
  Identifier = 'Identifier',
  QualifiedId = 'QualifiedId',           // ns::name
  ThisExpr = 'ThisExpr',
  ParenExpr = 'ParenExpr',               // (expr)

  // Operators
  BinaryExpr = 'BinaryExpr',
  UnaryExpr = 'UnaryExpr',
  PostfixExpr = 'PostfixExpr',           // x++, x--
  ConditionalExpr = 'ConditionalExpr',   // a ? b : c
  AssignExpr = 'AssignExpr',
  CommaExpr = 'CommaExpr',

  // Member access
  MemberExpr = 'MemberExpr',             // a.b or a->b
  SubscriptExpr = 'SubscriptExpr',       // a[b]
  CallExpr = 'CallExpr',                 // f(args)

  // Casts
  CStyleCastExpr = 'CStyleCastExpr',     // (Type)expr
  StaticCastExpr = 'StaticCastExpr',
  DynamicCastExpr = 'DynamicCastExpr',
  ReinterpretCastExpr = 'ReinterpretCastExpr',
  ConstCastExpr = 'ConstCastExpr',
  FunctionalCastExpr = 'FunctionalCastExpr', // Type(expr)

  // Type expressions
  SizeofExpr = 'SizeofExpr',
  AlignofExpr = 'AlignofExpr',
  TypeidExpr = 'TypeidExpr',
  NoexceptExpr = 'NoexceptExpr',

  // Memory
  NewExpr = 'NewExpr',
  DeleteExpr = 'DeleteExpr',

  // Lambda
  LambdaExpr = 'LambdaExpr',
  LambdaCapture = 'LambdaCapture',

  // C++17 Fold expressions
  FoldExpr = 'FoldExpr',

  // Initializers
  InitListExpr = 'InitListExpr',         // { a, b, c }
  DesignatedInitExpr = 'DesignatedInitExpr', // .field = value

  // Pack expansion
  PackExpansionExpr = 'PackExpansionExpr', // expr...
  SizeofPackExpr = 'SizeofPackExpr',     // sizeof...(pack)

  // C++20 Requires
  RequiresExpr = 'RequiresExpr',

  // ============================================
  // TYPES
  // ============================================
  BuiltinType = 'BuiltinType',           // int, char, void, etc.
  PointerType = 'PointerType',           // T*
  ReferenceType = 'ReferenceType',       // T&
  RValueReferenceType = 'RValueReferenceType', // T&&
  ArrayType = 'ArrayType',               // T[N]
  FunctionType = 'FunctionType',         // T(Args...)
  QualifiedType = 'QualifiedType',       // const T, volatile T
  ElaboratedType = 'ElaboratedType',     // class T, struct T, enum T
  TypedefType = 'TypedefType',           // Named type alias
  TemplateType = 'TemplateType',         // Template<Args>
  AutoType = 'AutoType',                 // auto, decltype(auto)
  DecltypeType = 'DecltypeType',         // decltype(expr)
  TypeofType = 'TypeofType',             // typeof(expr) - GCC extension
  MemberPointerType = 'MemberPointerType', // T Class::*

  // ============================================
  // TEMPLATE ARGUMENTS
  // ============================================
  TypeTemplateArg = 'TypeTemplateArg',
  ExprTemplateArg = 'ExprTemplateArg',
  TemplateTemplateArg = 'TemplateTemplateArg',

  // ============================================
  // CLAUSES & MISC
  // ============================================
  Attribute = 'Attribute',               // [[attr]]
  AttributeList = 'AttributeList',       // [[attr1, attr2]]
  RequiresClause = 'RequiresClause',     // requires (...)
  BaseSpecifier = 'BaseSpecifier',       // : public Base
  MemberInitializer = 'MemberInitializer', // member(value)

  // ============================================
  // SPECIAL
  // ============================================
  Error = 'Error',                       // Parse error placeholder
}

const DECLARATION_KINDS = new Set([
  NodeKind.FunctionDecl,
  NodeKind.VariableDecl,
  NodeKind.ParameterDecl,
  NodeKind.ClassDecl,
  NodeKind.StructDecl,
  NodeKind.UnionDecl,
  NodeKind.EnumDecl,
  NodeKind.EnumeratorDecl,
  NodeKind.NamespaceDecl,
  NodeKind.TypedefDecl,
  NodeKind.TypeAliasDecl,
  NodeKind.UsingDecl,
  NodeKind.UsingDirective,
  NodeKind.TemplateDecl,
  NodeKind.TemplateTypeParam,
  NodeKind.TemplateNonTypeParam,
  NodeKind.TemplateTemplateParam,
  NodeKind.ConceptDecl,
  NodeKind.FieldDecl,
  NodeKind.MethodDecl,
  NodeKind.ConstructorDecl,
  NodeKind.DestructorDecl,
  NodeKind.FriendDecl,
  NodeKind.AccessSpecifier,
  NodeKind.StaticAssertDecl,
  NodeKind.LinkageSpec,
  NodeKind.NamespaceAlias,
  NodeKind.AsmDecl,
  NodeKind.EmptyDecl,
]);

const STATEMENT_KINDS = new Set([
  NodeKind.CompoundStmt,
  NodeKind.ExprStmt,
  NodeKind.DeclStmt,
  NodeKind.IfStmt,
  NodeKind.SwitchStmt,
  NodeKind.CaseStmt,
  NodeKind.DefaultStmt,
  NodeKind.WhileStmt,
  NodeKind.DoWhileStmt,
  NodeKind.ForStmt,
  NodeKind.ForRangeStmt,
  NodeKind.BreakStmt,
  NodeKind.ContinueStmt,
  NodeKind.ReturnStmt,
  NodeKind.GotoStmt,
  NodeKind.LabelStmt,
  NodeKind.NullStmt,
  NodeKind.TryStmt,
  NodeKind.CatchClause,
  NodeKind.ThrowExpr,
  NodeKind.CoReturnStmt,
  NodeKind.CoYieldExpr,
  NodeKind.CoAwaitExpr,
]);

const EXPRESSION_KINDS = new Set([
  NodeKind.IntegerLiteral,
  NodeKind.FloatingLiteral,
  NodeKind.CharLiteral,
  NodeKind.StringLiteral,
  NodeKind.BoolLiteral,
  NodeKind.NullptrLiteral,
  NodeKind.UserDefinedLiteral,
  NodeKind.Identifier,
  NodeKind.QualifiedId,
  NodeKind.ThisExpr,
  NodeKind.ParenExpr,
  NodeKind.BinaryExpr,
  NodeKind.UnaryExpr,
  NodeKind.PostfixExpr,
  NodeKind.ConditionalExpr,
  NodeKind.AssignExpr,
  NodeKind.CommaExpr,
  NodeKind.MemberExpr,
  NodeKind.SubscriptExpr,
  NodeKind.CallExpr,
  NodeKind.CStyleCastExpr,
  NodeKind.StaticCastExpr,
  NodeKind.DynamicCastExpr,
  NodeKind.ReinterpretCastExpr,
  NodeKind.ConstCastExpr,
  NodeKind.FunctionalCastExpr,
  NodeKind.SizeofExpr,
  NodeKind.AlignofExpr,
  NodeKind.TypeidExpr,
  NodeKind.NoexceptExpr,
  NodeKind.NewExpr,
  NodeKind.DeleteExpr,
  NodeKind.LambdaExpr,
  NodeKind.LambdaCapture,
  NodeKind.FoldExpr,
  NodeKind.InitListExpr,
  NodeKind.DesignatedInitExpr,
  NodeKind.PackExpansionExpr,
  NodeKind.SizeofPackExpr,
  NodeKind.RequiresExpr,
  NodeKind.ThrowExpr,
  NodeKind.CoYieldExpr,
  NodeKind.CoAwaitExpr,
]);

const TYPE_KINDS = new Set([
  NodeKind.BuiltinType,
  NodeKind.PointerType,
  NodeKind.ReferenceType,
  NodeKind.RValueReferenceType,
  NodeKind.ArrayType,
  NodeKind.FunctionType,
  NodeKind.QualifiedType,
  NodeKind.ElaboratedType,
  NodeKind.TypedefType,
  NodeKind.TemplateType,
  NodeKind.AutoType,
  NodeKind.DecltypeType,
  NodeKind.TypeofType,
  NodeKind.MemberPointerType,
]);

const LITERAL_KINDS = new Set([
  NodeKind.IntegerLiteral,
  NodeKind.FloatingLiteral,
  NodeKind.CharLiteral,
  NodeKind.StringLiteral,
  NodeKind.BoolLiteral,
  NodeKind.NullptrLiteral,
  NodeKind.UserDefinedLiteral,
]);

/**
 * Check if a node kind is a declaration
 */
export function isDeclaration(kind: NodeKind): boolean {
  return DECLARATION_KINDS.has(kind);
}

/**
 * Check if a node kind is a statement
 */
export function isStatement(kind: NodeKind): boolean {
  return STATEMENT_KINDS.has(kind);
}

/**
 * Check if a node kind is an expression
 */
export function isExpression(kind: NodeKind): boolean {
  return EXPRESSION_KINDS.has(kind);
}

/**
 * Check if a node kind is a type
 */
export function isType(kind: NodeKind): boolean {
  return TYPE_KINDS.has(kind);
}

/**
 * Check if a node kind is a literal
 */
export function isLiteral(kind: NodeKind): boolean {
  return LITERAL_KINDS.has(kind);
}
