/**
 * C++ AST Node Definitions
 * Complete AST representation for C++20/23
 */

import { NodeKind } from './kinds.js';
import type { SourceLocation, Token } from '../lexer/index.js';
import type { Trivia } from '../lexer/trivia.js';

// ============================================
// BASE INTERFACES
// ============================================

/**
 * Ghidra-specific metadata attached to AST nodes
 */
export interface GhidraMetadata {
  originalAddress?: string;        // e.g., "0x00401000"
  originalName?: string;           // Pre-transformation name
  decompilerWarnings?: string[];
  addressRanges?: AddressRange[];  // Which binary addresses this code covers
}

export interface AddressRange {
  start: string;                   // Hex address
  end: string;
  instruction?: string;            // Original assembly if available
}

/**
 * Base interface for all AST nodes
 */
export interface ASTNode {
  kind: NodeKind;
  location: SourceLocation;
  leadingTrivia: Trivia[];
  trailingTrivia: Trivia[];
  ghidraInfo?: GhidraMetadata;
}

// ============================================
// TRANSLATION UNIT
// ============================================

export interface TranslationUnit extends ASTNode {
  kind: NodeKind.TranslationUnit;
  declarations: Declaration[];
}

// ============================================
// TYPE NODES
// ============================================

export type TypeNode =
  | BuiltinType
  | PointerType
  | ReferenceType
  | RValueReferenceType
  | ArrayType
  | FunctionType
  | QualifiedType
  | ElaboratedType
  | TypedefType
  | TemplateType
  | AutoType
  | DecltypeType
  | TypeofType
  | MemberPointerType;

export interface BuiltinType extends ASTNode {
  kind: NodeKind.BuiltinType;
  name: string;  // 'int', 'char', 'void', 'bool', etc.
  modifiers: TypeModifier[];  // 'unsigned', 'long', 'short', etc.
}

export type TypeModifier = 'signed' | 'unsigned' | 'short' | 'long' | 'const' | 'volatile' | 'restrict';

export interface PointerType extends ASTNode {
  kind: NodeKind.PointerType;
  pointee: TypeNode;
  qualifiers: TypeQualifier[];
}

export type TypeQualifier = 'const' | 'volatile' | 'restrict';

export interface ReferenceType extends ASTNode {
  kind: NodeKind.ReferenceType;
  referenced: TypeNode;
}

export interface RValueReferenceType extends ASTNode {
  kind: NodeKind.RValueReferenceType;
  referenced: TypeNode;
}

export interface ArrayType extends ASTNode {
  kind: NodeKind.ArrayType;
  elementType: TypeNode;
  size: Expression | null;  // null for T[]
}

export interface FunctionType extends ASTNode {
  kind: NodeKind.FunctionType;
  returnType: TypeNode;
  parameters: TypeNode[];
  isVariadic: boolean;
  qualifiers: FunctionQualifier[];
}

export type FunctionQualifier = 'const' | 'volatile' | 'noexcept' | '&' | '&&';

export interface QualifiedType extends ASTNode {
  kind: NodeKind.QualifiedType;
  qualifiers: TypeQualifier[];
  type: TypeNode;
}

export interface ElaboratedType extends ASTNode {
  kind: NodeKind.ElaboratedType;
  keyword: 'class' | 'struct' | 'union' | 'enum';
  name: QualifiedId | Identifier;
}

export interface TypedefType extends ASTNode {
  kind: NodeKind.TypedefType;
  name: QualifiedId | Identifier;
}

export interface TemplateType extends ASTNode {
  kind: NodeKind.TemplateType;
  name: QualifiedId | Identifier;
  arguments: TemplateArgument[];
}

export interface AutoType extends ASTNode {
  kind: NodeKind.AutoType;
  isDecltypeAuto: boolean;  // decltype(auto)
}

export interface DecltypeType extends ASTNode {
  kind: NodeKind.DecltypeType;
  expression: Expression;
}

export interface TypeofType extends ASTNode {
  kind: NodeKind.TypeofType;
  expression: Expression;
}

export interface MemberPointerType extends ASTNode {
  kind: NodeKind.MemberPointerType;
  classType: TypeNode;
  memberType: TypeNode;
}

// ============================================
// TEMPLATE ARGUMENTS
// ============================================

export type TemplateArgument =
  | TypeTemplateArg
  | ExprTemplateArg
  | TemplateTemplateArg;

export interface TypeTemplateArg extends ASTNode {
  kind: NodeKind.TypeTemplateArg;
  type: TypeNode;
}

export interface ExprTemplateArg extends ASTNode {
  kind: NodeKind.ExprTemplateArg;
  expression: Expression;
}

export interface TemplateTemplateArg extends ASTNode {
  kind: NodeKind.TemplateTemplateArg;
  name: QualifiedId | Identifier;
}

// ============================================
// DECLARATIONS
// ============================================

export type Declaration =
  | FunctionDecl
  | VariableDecl
  | ClassDecl
  | StructDecl
  | UnionDecl
  | EnumDecl
  | NamespaceDecl
  | TypedefDecl
  | TypeAliasDecl
  | UsingDecl
  | UsingDirective
  | TemplateDecl
  | ConceptDecl
  | StaticAssertDecl
  | LinkageSpec
  | NamespaceAlias
  | AsmDecl
  | EmptyDecl;

export interface FunctionDecl extends ASTNode {
  kind: NodeKind.FunctionDecl;
  name: Identifier | QualifiedId | OperatorId;
  returnType: TypeNode;
  parameters: ParameterDecl[];
  body: CompoundStmt | null;  // null for declaration without definition
  specifiers: FunctionSpecifier[];
  callingConvention?: CallingConvention;  // __cdecl, __fastcall, etc.
  attributes: Attribute[];
  isVariadic: boolean;
  trailingReturnType?: TypeNode;  // auto f() -> int
  requiresClause?: RequiresClause;
}

export type FunctionSpecifier =
  | 'inline'
  | 'virtual'
  | 'explicit'
  | 'static'
  | 'extern'
  | 'constexpr'
  | 'consteval'
  | 'friend';

/**
 * Microsoft calling conventions (used by Ghidra decompiler)
 */
export type CallingConvention =
  | '__cdecl'
  | '__stdcall'
  | '__fastcall'
  | '__thiscall'
  | '__vectorcall'
  | '__clrcall';

export interface OperatorId extends ASTNode {
  kind: NodeKind.Identifier;  // Special case: operator overload name
  operator: string;  // '+', '[]', '()', 'new', 'delete', etc.
  isArray?: boolean;  // operator new[] vs operator new
}

export interface ParameterDecl extends ASTNode {
  kind: NodeKind.ParameterDecl;
  name: Identifier | null;  // null for unnamed parameters
  type: TypeNode;
  defaultValue: Expression | null;
  isVariadic: boolean;  // T... for parameter packs
}

export interface VariableDecl extends ASTNode {
  kind: NodeKind.VariableDecl;
  name: Identifier;
  type: TypeNode;
  initializer: Expression | InitListExpr | null;
  specifiers: VariableSpecifier[];
  attributes: Attribute[];
}

export type VariableSpecifier =
  | 'static'
  | 'extern'
  | 'thread_local'
  | 'mutable'
  | 'constexpr'
  | 'constinit'
  | 'inline';

export interface ClassDecl extends ASTNode {
  kind: NodeKind.ClassDecl;
  name: Identifier | null;  // null for anonymous classes
  bases: BaseSpecifier[];
  members: ClassMember[];
  isFinal: boolean;
  attributes: Attribute[];
}

export interface StructDecl extends ASTNode {
  kind: NodeKind.StructDecl;
  name: Identifier | null;
  bases: BaseSpecifier[];
  members: ClassMember[];
  isFinal: boolean;
  attributes: Attribute[];
}

export interface UnionDecl extends ASTNode {
  kind: NodeKind.UnionDecl;
  name: Identifier | null;
  members: ClassMember[];
  attributes: Attribute[];
}

export type ClassMember =
  | FieldDecl
  | MethodDecl
  | ConstructorDecl
  | DestructorDecl
  | FriendDecl
  | AccessSpecifierNode
  | TypedefDecl
  | TypeAliasDecl
  | UsingDecl
  | ClassDecl
  | StructDecl
  | UnionDecl
  | EnumDecl
  | TemplateDecl
  | StaticAssertDecl;

export interface FieldDecl extends ASTNode {
  kind: NodeKind.FieldDecl;
  name: Identifier;
  type: TypeNode;
  initializer: Expression | InitListExpr | null;
  bitWidth: Expression | null;  // int x : 5;
  specifiers: FieldSpecifier[];
  attributes: Attribute[];
}

export type FieldSpecifier = 'static' | 'mutable' | 'constexpr' | 'inline';

export interface MethodDecl extends ASTNode {
  kind: NodeKind.MethodDecl;
  name: Identifier | OperatorId;
  returnType: TypeNode;
  parameters: ParameterDecl[];
  body: CompoundStmt | null;
  specifiers: MethodSpecifier[];
  qualifiers: MethodQualifier[];
  attributes: Attribute[];
  isVariadic: boolean;
  trailingReturnType?: TypeNode;
  requiresClause?: RequiresClause;
}

export type MethodSpecifier =
  | 'static'
  | 'virtual'
  | 'explicit'
  | 'inline'
  | 'constexpr'
  | 'consteval'
  | 'friend';

export type MethodQualifier =
  | 'const'
  | 'volatile'
  | 'override'
  | 'final'
  | 'noexcept'
  | '&'
  | '&&'
  | '= 0'      // pure virtual
  | '= default'
  | '= delete';

export interface ConstructorDecl extends ASTNode {
  kind: NodeKind.ConstructorDecl;
  parameters: ParameterDecl[];
  body: CompoundStmt | null;
  initializers: MemberInitializer[];
  specifiers: ConstructorSpecifier[];
  attributes: Attribute[];
}

export type ConstructorSpecifier = 'explicit' | 'constexpr' | 'consteval' | 'inline';

export interface DestructorDecl extends ASTNode {
  kind: NodeKind.DestructorDecl;
  body: CompoundStmt | null;
  specifiers: DestructorSpecifier[];
  attributes: Attribute[];
  isVirtual: boolean;
}

export type DestructorSpecifier = 'virtual' | 'constexpr' | 'inline' | '= default' | '= delete';

export interface FriendDecl extends ASTNode {
  kind: NodeKind.FriendDecl;
  declaration: FunctionDecl | ClassDecl | TypeNode;
}

export interface AccessSpecifierNode extends ASTNode {
  kind: NodeKind.AccessSpecifier;
  access: 'public' | 'private' | 'protected';
}

export interface BaseSpecifier extends ASTNode {
  kind: NodeKind.BaseSpecifier;
  type: TypeNode;
  access: 'public' | 'private' | 'protected' | null;
  isVirtual: boolean;
  isPackExpansion: boolean;  // Base...
}

export interface MemberInitializer extends ASTNode {
  kind: NodeKind.MemberInitializer;
  member: Identifier | TypeNode;  // TypeNode for base class initializer
  arguments: Expression[] | InitListExpr;
  isPackExpansion: boolean;
}

export interface EnumDecl extends ASTNode {
  kind: NodeKind.EnumDecl;
  name: Identifier | null;
  isScoped: boolean;  // enum class vs enum
  underlyingType: TypeNode | null;
  enumerators: EnumeratorDecl[];
  attributes: Attribute[];
}

export interface EnumeratorDecl extends ASTNode {
  kind: NodeKind.EnumeratorDecl;
  name: Identifier;
  value: Expression | null;
  attributes: Attribute[];
}

export interface NamespaceDecl extends ASTNode {
  kind: NodeKind.NamespaceDecl;
  name: Identifier | null;  // null for anonymous namespace
  declarations: Declaration[];
  isInline: boolean;
  attributes: Attribute[];
}

export interface TypedefDecl extends ASTNode {
  kind: NodeKind.TypedefDecl;
  name: Identifier;
  type: TypeNode;
}

export interface TypeAliasDecl extends ASTNode {
  kind: NodeKind.TypeAliasDecl;
  name: Identifier;
  type: TypeNode;
  attributes: Attribute[];
}

export interface UsingDecl extends ASTNode {
  kind: NodeKind.UsingDecl;
  name: QualifiedId;
  isTypename: boolean;
}

export interface UsingDirective extends ASTNode {
  kind: NodeKind.UsingDirective;
  namespace: QualifiedId | Identifier;
  attributes: Attribute[];
}

export interface TemplateDecl extends ASTNode {
  kind: NodeKind.TemplateDecl;
  parameters: TemplateParameter[];
  declaration: Declaration;
  requiresClause?: RequiresClause;
}

export type TemplateParameter =
  | TemplateTypeParam
  | TemplateNonTypeParam
  | TemplateTemplateParam;

export interface TemplateTypeParam extends ASTNode {
  kind: NodeKind.TemplateTypeParam;
  name: Identifier | null;
  constraint?: TypeNode | ConceptConstraint;
  defaultType?: TypeNode;
  isVariadic: boolean;  // typename... T
}

export interface ConceptConstraint {
  concept: QualifiedId | Identifier;
  arguments?: TemplateArgument[];
}

export interface TemplateNonTypeParam extends ASTNode {
  kind: NodeKind.TemplateNonTypeParam;
  name: Identifier | null;
  type: TypeNode;
  defaultValue?: Expression;
  isVariadic: boolean;
}

export interface TemplateTemplateParam extends ASTNode {
  kind: NodeKind.TemplateTemplateParam;
  name: Identifier | null;
  parameters: TemplateParameter[];
  defaultTemplate?: QualifiedId | Identifier;
  isVariadic: boolean;
}

export interface ConceptDecl extends ASTNode {
  kind: NodeKind.ConceptDecl;
  name: Identifier;
  parameters: TemplateParameter[];
  constraint: Expression;
}

export interface StaticAssertDecl extends ASTNode {
  kind: NodeKind.StaticAssertDecl;
  condition: Expression;
  message: StringLiteralExpr | null;
}

export interface LinkageSpec extends ASTNode {
  kind: NodeKind.LinkageSpec;
  language: string;  // "C", "C++"
  declarations: Declaration[];
}

export interface NamespaceAlias extends ASTNode {
  kind: NodeKind.NamespaceAlias;
  name: Identifier;
  target: QualifiedId | Identifier;
}

export interface AsmDecl extends ASTNode {
  kind: NodeKind.AsmDecl;
  code: StringLiteralExpr;
}

export interface EmptyDecl extends ASTNode {
  kind: NodeKind.EmptyDecl;
}

// ============================================
// STATEMENTS
// ============================================

export type Statement =
  | CompoundStmt
  | ExprStmt
  | DeclStmt
  | IfStmt
  | SwitchStmt
  | CaseStmt
  | DefaultStmt
  | WhileStmt
  | DoWhileStmt
  | ForStmt
  | ForRangeStmt
  | BreakStmt
  | ContinueStmt
  | ReturnStmt
  | GotoStmt
  | LabelStmt
  | NullStmt
  | TryStmt
  | CoReturnStmt;

export interface CompoundStmt extends ASTNode {
  kind: NodeKind.CompoundStmt;
  statements: Statement[];
}

export interface ExprStmt extends ASTNode {
  kind: NodeKind.ExprStmt;
  expression: Expression;
}

export interface DeclStmt extends ASTNode {
  kind: NodeKind.DeclStmt;
  declarations: Declaration[];
}

export interface IfStmt extends ASTNode {
  kind: NodeKind.IfStmt;
  init?: Statement;  // C++17 if (init; condition)
  condition: Expression;
  thenBranch: Statement;
  elseBranch: Statement | null;
  isConstexpr: boolean;  // if constexpr
}

export interface SwitchStmt extends ASTNode {
  kind: NodeKind.SwitchStmt;
  init?: Statement;
  condition: Expression;
  body: Statement;
}

export interface CaseStmt extends ASTNode {
  kind: NodeKind.CaseStmt;
  value: Expression;
  statement: Statement;
}

export interface DefaultStmt extends ASTNode {
  kind: NodeKind.DefaultStmt;
  statement: Statement;
}

export interface WhileStmt extends ASTNode {
  kind: NodeKind.WhileStmt;
  condition: Expression;
  body: Statement;
}

export interface DoWhileStmt extends ASTNode {
  kind: NodeKind.DoWhileStmt;
  body: Statement;
  condition: Expression;
}

export interface ForStmt extends ASTNode {
  kind: NodeKind.ForStmt;
  init: Statement | null;
  condition: Expression | null;
  increment: Expression | null;
  body: Statement;
}

export interface ForRangeStmt extends ASTNode {
  kind: NodeKind.ForRangeStmt;
  init?: Statement;  // C++20 for (init; decl : range)
  declaration: VariableDecl;
  range: Expression;
  body: Statement;
}

export interface BreakStmt extends ASTNode {
  kind: NodeKind.BreakStmt;
}

export interface ContinueStmt extends ASTNode {
  kind: NodeKind.ContinueStmt;
}

export interface ReturnStmt extends ASTNode {
  kind: NodeKind.ReturnStmt;
  value: Expression | null;
}

export interface GotoStmt extends ASTNode {
  kind: NodeKind.GotoStmt;
  label: Identifier;
}

export interface LabelStmt extends ASTNode {
  kind: NodeKind.LabelStmt;
  label: Identifier;
  statement: Statement;
}

export interface NullStmt extends ASTNode {
  kind: NodeKind.NullStmt;
}

export interface TryStmt extends ASTNode {
  kind: NodeKind.TryStmt;
  body: CompoundStmt;
  handlers: CatchClause[];
}

export interface CatchClause extends ASTNode {
  kind: NodeKind.CatchClause;
  parameter: ParameterDecl | null;  // null for catch(...)
  body: CompoundStmt;
}

export interface CoReturnStmt extends ASTNode {
  kind: NodeKind.CoReturnStmt;
  value: Expression | null;
}

// ============================================
// EXPRESSIONS
// ============================================

export type Expression =
  | IntegerLiteralExpr
  | FloatingLiteralExpr
  | CharLiteralExpr
  | StringLiteralExpr
  | BoolLiteralExpr
  | NullptrLiteralExpr
  | UserDefinedLiteralExpr
  | Identifier
  | QualifiedId
  | ThisExpr
  | ParenExpr
  | BinaryExpr
  | UnaryExpr
  | PostfixExpr
  | ConditionalExpr
  | AssignExpr
  | CommaExpr
  | MemberExpr
  | SubscriptExpr
  | CallExpr
  | CStyleCastExpr
  | StaticCastExpr
  | DynamicCastExpr
  | ReinterpretCastExpr
  | ConstCastExpr
  | FunctionalCastExpr
  | SizeofExpr
  | AlignofExpr
  | TypeidExpr
  | NoexceptExpr
  | NewExpr
  | DeleteExpr
  | LambdaExpr
  | FoldExpr
  | InitListExpr
  | DesignatedInitExpr
  | PackExpansionExpr
  | SizeofPackExpr
  | RequiresExpr
  | ThrowExpr
  | CoYieldExpr
  | CoAwaitExpr;

// Literals
export interface IntegerLiteralExpr extends ASTNode {
  kind: NodeKind.IntegerLiteral;
  value: bigint;
  suffix: string;
  base: 2 | 8 | 10 | 16;
  raw: string;  // Original text
}

export interface FloatingLiteralExpr extends ASTNode {
  kind: NodeKind.FloatingLiteral;
  value: number;
  suffix: string;
  raw: string;
}

export interface CharLiteralExpr extends ASTNode {
  kind: NodeKind.CharLiteral;
  value: number;
  prefix: string;
  raw: string;
}

export interface StringLiteralExpr extends ASTNode {
  kind: NodeKind.StringLiteral;
  value: string;
  prefix: string;
  isRaw: boolean;
  raw: string;
}

export interface BoolLiteralExpr extends ASTNode {
  kind: NodeKind.BoolLiteral;
  value: boolean;
}

export interface NullptrLiteralExpr extends ASTNode {
  kind: NodeKind.NullptrLiteral;
}

export interface UserDefinedLiteralExpr extends ASTNode {
  kind: NodeKind.UserDefinedLiteral;
  literal: IntegerLiteralExpr | FloatingLiteralExpr | CharLiteralExpr | StringLiteralExpr;
  suffix: string;
  raw: string;
}

// Primary expressions
export interface Identifier extends ASTNode {
  kind: NodeKind.Identifier;
  name: string;
}

export interface QualifiedId extends ASTNode {
  kind: NodeKind.QualifiedId;
  qualifier: (Identifier | TemplateType)[];  // ns::nested::
  name: Identifier | TemplateType | OperatorId;
  isGlobal: boolean;  // ::name
}

export interface ThisExpr extends ASTNode {
  kind: NodeKind.ThisExpr;
}

export interface ParenExpr extends ASTNode {
  kind: NodeKind.ParenExpr;
  expression: Expression;
}

// Operators
export interface BinaryExpr extends ASTNode {
  kind: NodeKind.BinaryExpr;
  operator: BinaryOperator;
  left: Expression;
  right: Expression;
}

export type BinaryOperator =
  | '+' | '-' | '*' | '/' | '%'
  | '&' | '|' | '^' | '<<' | '>>'
  | '&&' | '||'
  | '==' | '!=' | '<' | '>' | '<=' | '>=' | '<=>'
  | '.*' | '->*';

export interface UnaryExpr extends ASTNode {
  kind: NodeKind.UnaryExpr;
  operator: UnaryOperator;
  operand: Expression;
}

export type UnaryOperator = '+' | '-' | '!' | '~' | '*' | '&' | '++' | '--';

export interface PostfixExpr extends ASTNode {
  kind: NodeKind.PostfixExpr;
  operator: '++' | '--';
  operand: Expression;
}

export interface ConditionalExpr extends ASTNode {
  kind: NodeKind.ConditionalExpr;
  condition: Expression;
  thenExpr: Expression;
  elseExpr: Expression;
}

export interface AssignExpr extends ASTNode {
  kind: NodeKind.AssignExpr;
  operator: AssignOperator;
  left: Expression;
  right: Expression;
}

export type AssignOperator =
  | '=' | '+=' | '-=' | '*=' | '/=' | '%='
  | '&=' | '|=' | '^=' | '<<=' | '>>=';

export interface CommaExpr extends ASTNode {
  kind: NodeKind.CommaExpr;
  expressions: Expression[];
}

// Member access
export interface MemberExpr extends ASTNode {
  kind: NodeKind.MemberExpr;
  object: Expression;
  member: Identifier | TemplateType;
  isArrow: boolean;  // -> vs .
}

export interface SubscriptExpr extends ASTNode {
  kind: NodeKind.SubscriptExpr;
  array: Expression;
  index: Expression;
}

export interface CallExpr extends ASTNode {
  kind: NodeKind.CallExpr;
  callee: Expression;
  arguments: Expression[];
}

// Casts
export interface CStyleCastExpr extends ASTNode {
  kind: NodeKind.CStyleCastExpr;
  type: TypeNode;
  expression: Expression;
}

export interface StaticCastExpr extends ASTNode {
  kind: NodeKind.StaticCastExpr;
  type: TypeNode;
  expression: Expression;
}

export interface DynamicCastExpr extends ASTNode {
  kind: NodeKind.DynamicCastExpr;
  type: TypeNode;
  expression: Expression;
}

export interface ReinterpretCastExpr extends ASTNode {
  kind: NodeKind.ReinterpretCastExpr;
  type: TypeNode;
  expression: Expression;
}

export interface ConstCastExpr extends ASTNode {
  kind: NodeKind.ConstCastExpr;
  type: TypeNode;
  expression: Expression;
}

export interface FunctionalCastExpr extends ASTNode {
  kind: NodeKind.FunctionalCastExpr;
  type: TypeNode;
  arguments: Expression[];
}

// Type expressions
export interface SizeofExpr extends ASTNode {
  kind: NodeKind.SizeofExpr;
  operand: Expression | TypeNode;
  isType: boolean;
}

export interface AlignofExpr extends ASTNode {
  kind: NodeKind.AlignofExpr;
  type: TypeNode;
}

export interface TypeidExpr extends ASTNode {
  kind: NodeKind.TypeidExpr;
  operand: Expression | TypeNode;
  isType: boolean;
}

export interface NoexceptExpr extends ASTNode {
  kind: NodeKind.NoexceptExpr;
  expression: Expression;
}

// Memory
export interface NewExpr extends ASTNode {
  kind: NodeKind.NewExpr;
  type: TypeNode;
  placement: Expression[];  // new (args) Type
  initializer: Expression | InitListExpr | null;
  isArray: boolean;
  arraySize?: Expression;
}

export interface DeleteExpr extends ASTNode {
  kind: NodeKind.DeleteExpr;
  expression: Expression;
  isArray: boolean;
}

// Lambda
export interface LambdaExpr extends ASTNode {
  kind: NodeKind.LambdaExpr;
  captures: LambdaCapture[];
  captureDefault: '=' | '&' | null;
  parameters: ParameterDecl[];
  returnType: TypeNode | null;  // null for deduced
  body: CompoundStmt | Expression;  // Expression for implicit return
  specifiers: LambdaSpecifier[];
  templateParams?: TemplateParameter[];  // C++20 generic lambdas
  requiresClause?: RequiresClause;
}

export type LambdaSpecifier = 'mutable' | 'constexpr' | 'consteval' | 'static';

export interface LambdaCapture extends ASTNode {
  kind: NodeKind.LambdaCapture;
  name: Identifier | null;  // null for this or *this
  isThis: boolean;
  isDeref: boolean;  // *this
  isRef: boolean;  // &x
  initializer?: Expression;  // x = expr (init capture)
  isPackExpansion: boolean;
}

// Fold expressions
export interface FoldExpr extends ASTNode {
  kind: NodeKind.FoldExpr;
  operator: BinaryOperator;
  pattern: Expression;
  init?: Expression;
  isLeftFold: boolean;  // (... op pack) vs (pack op ...)
}

// Initializers
export interface InitListExpr extends ASTNode {
  kind: NodeKind.InitListExpr;
  elements: (Expression | DesignatedInitExpr)[];
}

export interface DesignatedInitExpr extends ASTNode {
  kind: NodeKind.DesignatedInitExpr;
  designators: Designator[];
  initializer: Expression | InitListExpr;
}

export type Designator =
  | { kind: 'field'; name: Identifier }
  | { kind: 'index'; index: Expression };

// Pack expansion
export interface PackExpansionExpr extends ASTNode {
  kind: NodeKind.PackExpansionExpr;
  pattern: Expression;
}

export interface SizeofPackExpr extends ASTNode {
  kind: NodeKind.SizeofPackExpr;
  pack: Identifier;
}

// Requires expression (C++20)
export interface RequiresExpr extends ASTNode {
  kind: NodeKind.RequiresExpr;
  parameters: ParameterDecl[];
  requirements: Requirement[];
}

export type Requirement =
  | SimpleRequirement
  | TypeRequirement
  | CompoundRequirement
  | NestedRequirement;

export interface SimpleRequirement {
  kind: 'simple';
  expression: Expression;
}

export interface TypeRequirement {
  kind: 'type';
  type: TypeNode;
}

export interface CompoundRequirement {
  kind: 'compound';
  expression: Expression;
  noexcept: boolean;
  returnType?: TypeNode;
}

export interface NestedRequirement {
  kind: 'nested';
  constraint: Expression;
}

// Throw
export interface ThrowExpr extends ASTNode {
  kind: NodeKind.ThrowExpr;
  expression: Expression | null;  // null for re-throw
}

// Coroutines
export interface CoYieldExpr extends ASTNode {
  kind: NodeKind.CoYieldExpr;
  expression: Expression;
}

export interface CoAwaitExpr extends ASTNode {
  kind: NodeKind.CoAwaitExpr;
  expression: Expression;
}

// ============================================
// CLAUSES & MISC
// ============================================

export interface Attribute extends ASTNode {
  kind: NodeKind.Attribute;
  namespace: Identifier | null;  // [[ns::attr]]
  name: Identifier;
  arguments: (Expression | TypeNode)[];
}

export interface AttributeList extends ASTNode {
  kind: NodeKind.AttributeList;
  attributes: Attribute[];
}

export interface RequiresClause extends ASTNode {
  kind: NodeKind.RequiresClause;
  constraint: Expression;
}

// ============================================
// ERROR NODE
// ============================================

export interface ErrorNode extends ASTNode {
  kind: NodeKind.Error;
  message: string;
  tokens: Token[];
}

// ============================================
// UNION TYPE FOR ALL NODES
// ============================================

export type AnyNode =
  | TranslationUnit
  | TypeNode
  | Declaration
  | Statement
  | Expression
  | TemplateArgument
  | TemplateParameter
  | ClassMember
  | Attribute
  | AttributeList
  | RequiresClause
  | BaseSpecifier
  | MemberInitializer
  | CatchClause
  | LambdaCapture
  | ErrorNode;
