/**
 * AST Visitor Pattern
 * Provides traversal and transformation utilities for AST nodes
 */

import { NodeKind } from './kinds.js';
import type {
  ASTNode,
  AnyNode,
  TranslationUnit,
  Declaration,
  Statement,
  Expression,
  TypeNode,
  FunctionDecl,
  VariableDecl,
  ClassDecl,
  StructDecl,
  UnionDecl,
  EnumDecl,
  NamespaceDecl,
  TemplateDecl,
  CompoundStmt,
  IfStmt,
  ForStmt,
  WhileStmt,
  ReturnStmt,
  BinaryExpr,
  UnaryExpr,
  CallExpr,
  MemberExpr,
  Identifier,
  ParameterDecl,
  FieldDecl,
  MethodDecl,
  CaseStmt,
  DefaultStmt,
  LabelStmt,
  SwitchStmt,
  DoWhileStmt,
  ParenExpr,
} from './nodes.js';

/**
 * Visitor interface - implement methods for nodes you care about
 * Return undefined to keep the original node, or return a new node to replace it
 */
export interface ASTVisitor<T = void> {
  // Translation unit
  visitTranslationUnit?(node: TranslationUnit): T;

  // Declarations
  visitFunctionDecl?(node: FunctionDecl): T;
  visitVariableDecl?(node: VariableDecl): T;
  visitParameterDecl?(node: ParameterDecl): T;
  visitClassDecl?(node: ClassDecl): T;
  visitStructDecl?(node: StructDecl): T;
  visitUnionDecl?(node: UnionDecl): T;
  visitEnumDecl?(node: EnumDecl): T;
  visitNamespaceDecl?(node: NamespaceDecl): T;
  visitTemplateDecl?(node: TemplateDecl): T;
  visitFieldDecl?(node: FieldDecl): T;
  visitMethodDecl?(node: MethodDecl): T;

  // Statements
  visitCompoundStmt?(node: CompoundStmt): T;
  visitIfStmt?(node: IfStmt): T;
  visitForStmt?(node: ForStmt): T;
  visitWhileStmt?(node: WhileStmt): T;
  visitReturnStmt?(node: ReturnStmt): T;
  visitCaseStmt?(node: CaseStmt): T;
  visitDefaultStmt?(node: DefaultStmt): T;
  visitLabelStmt?(node: LabelStmt): T;
  visitSwitchStmt?(node: SwitchStmt): T;
  visitDoWhileStmt?(node: DoWhileStmt): T;

  // Expressions
  visitBinaryExpr?(node: BinaryExpr): T;
  visitParenExpr?(node: ParenExpr): T;
  visitUnaryExpr?(node: UnaryExpr): T;
  visitCallExpr?(node: CallExpr): T;
  visitMemberExpr?(node: MemberExpr): T;
  visitIdentifier?(node: Identifier): T;

  // Catch-all
  visitNode?(node: ASTNode): T;
}

/**
 * Walk the AST and call visitor methods
 */
export function walkAST<T>(node: ASTNode, visitor: ASTVisitor<T>): T | undefined {
  // Try specific visitor first
  const result = visitSpecific(node, visitor);
  if (result !== undefined) return result;

  // Fall back to generic visitor
  if (visitor.visitNode) {
    return visitor.visitNode(node);
  }

  return undefined;
}

function visitSpecific<T>(node: ASTNode, visitor: ASTVisitor<T>): T | undefined {
  switch (node.kind) {
    case NodeKind.TranslationUnit:
      return visitor.visitTranslationUnit?.(node as TranslationUnit);
    case NodeKind.FunctionDecl:
      return visitor.visitFunctionDecl?.(node as FunctionDecl);
    case NodeKind.VariableDecl:
      return visitor.visitVariableDecl?.(node as VariableDecl);
    case NodeKind.ParameterDecl:
      return visitor.visitParameterDecl?.(node as ParameterDecl);
    case NodeKind.ClassDecl:
      return visitor.visitClassDecl?.(node as ClassDecl);
    case NodeKind.StructDecl:
      return visitor.visitStructDecl?.(node as StructDecl);
    case NodeKind.UnionDecl:
      return visitor.visitUnionDecl?.(node as UnionDecl);
    case NodeKind.EnumDecl:
      return visitor.visitEnumDecl?.(node as EnumDecl);
    case NodeKind.NamespaceDecl:
      return visitor.visitNamespaceDecl?.(node as NamespaceDecl);
    case NodeKind.TemplateDecl:
      return visitor.visitTemplateDecl?.(node as TemplateDecl);
    case NodeKind.FieldDecl:
      return visitor.visitFieldDecl?.(node as FieldDecl);
    case NodeKind.MethodDecl:
      return visitor.visitMethodDecl?.(node as MethodDecl);
    case NodeKind.CompoundStmt:
      return visitor.visitCompoundStmt?.(node as CompoundStmt);
    case NodeKind.IfStmt:
      return visitor.visitIfStmt?.(node as IfStmt);
    case NodeKind.ForStmt:
      return visitor.visitForStmt?.(node as ForStmt);
    case NodeKind.WhileStmt:
      return visitor.visitWhileStmt?.(node as WhileStmt);
    case NodeKind.ReturnStmt:
      return visitor.visitReturnStmt?.(node as ReturnStmt);
    case NodeKind.CaseStmt:
      return visitor.visitCaseStmt?.(node as CaseStmt);
    case NodeKind.DefaultStmt:
      return visitor.visitDefaultStmt?.(node as DefaultStmt);
    case NodeKind.LabelStmt:
      return visitor.visitLabelStmt?.(node as LabelStmt);
    case NodeKind.SwitchStmt:
      return visitor.visitSwitchStmt?.(node as SwitchStmt);
    case NodeKind.DoWhileStmt:
      return visitor.visitDoWhileStmt?.(node as DoWhileStmt);
    case NodeKind.BinaryExpr:
      return visitor.visitBinaryExpr?.(node as BinaryExpr);
    case NodeKind.UnaryExpr:
      return visitor.visitUnaryExpr?.(node as UnaryExpr);
    case NodeKind.CallExpr:
      return visitor.visitCallExpr?.(node as CallExpr);
    case NodeKind.MemberExpr:
      return visitor.visitMemberExpr?.(node as MemberExpr);
    case NodeKind.Identifier:
      return visitor.visitIdentifier?.(node as Identifier);
    case NodeKind.ParenExpr:
      return visitor.visitParenExpr?.(node as ParenExpr);
    default:
      return undefined;
  }
}

/**
 * Recursively walk all nodes in the AST
 */
export function* traverseAST(node: ASTNode): Generator<ASTNode> {
  yield node;

  for (const child of getChildren(node)) {
    yield* traverseAST(child);
  }
}

/**
 * Get direct children of a node
 */
export function getChildren(node: ASTNode): ASTNode[] {
  const children: ASTNode[] = [];

  switch (node.kind) {
    case NodeKind.TranslationUnit:
      children.push(...(node as TranslationUnit).declarations);
      break;

    case NodeKind.FunctionDecl: {
      const fn = node as FunctionDecl;
      children.push(fn.returnType);
      children.push(...fn.parameters);
      if (fn.body) children.push(fn.body);
      if (fn.name) children.push(fn.name as ASTNode);
      break;
    }

    case NodeKind.VariableDecl: {
      const v = node as VariableDecl;
      children.push(v.type);
      children.push(v.name);
      if (v.initializer) children.push(v.initializer);
      break;
    }

    case NodeKind.CompoundStmt:
      children.push(...(node as CompoundStmt).statements);
      break;

    case NodeKind.IfStmt: {
      const ifStmt = node as IfStmt;
      children.push(ifStmt.condition);
      children.push(ifStmt.thenBranch);
      if (ifStmt.elseBranch) children.push(ifStmt.elseBranch);
      break;
    }

    case NodeKind.ForStmt: {
      const forStmt = node as ForStmt;
      if (forStmt.init) children.push(forStmt.init);
      if (forStmt.condition) children.push(forStmt.condition);
      if (forStmt.increment) children.push(forStmt.increment);
      children.push(forStmt.body);
      break;
    }

    case NodeKind.WhileStmt: {
      const whileStmt = node as WhileStmt;
      children.push(whileStmt.condition);
      children.push(whileStmt.body);
      break;
    }

    case NodeKind.DoWhileStmt: {
      const doWhile = node as import('./nodes.js').DoWhileStmt;
      children.push(doWhile.body);
      children.push(doWhile.condition);
      break;
    }

    case NodeKind.LabelStmt: {
      const labelStmt = node as import('./nodes.js').LabelStmt;
      children.push(labelStmt.label);
      children.push(labelStmt.statement);
      break;
    }

    case NodeKind.GotoStmt: {
      const gotoStmt = node as import('./nodes.js').GotoStmt;
      children.push(gotoStmt.label);
      break;
    }

    case NodeKind.ReturnStmt: {
      const ret = node as ReturnStmt;
      if (ret.value) children.push(ret.value);
      break;
    }

    case NodeKind.BinaryExpr: {
      const bin = node as BinaryExpr;
      children.push(bin.left);
      children.push(bin.right);
      break;
    }

    case NodeKind.UnaryExpr: {
      const un = node as UnaryExpr;
      children.push(un.operand);
      break;
    }

    case NodeKind.CallExpr: {
      const call = node as CallExpr;
      children.push(call.callee);
      children.push(...call.arguments);
      break;
    }

    case NodeKind.MemberExpr: {
      const mem = node as MemberExpr;
      children.push(mem.object);
      children.push(mem.member as ASTNode);
      break;
    }

    case NodeKind.SwitchStmt: {
      const sw = node as any;
      children.push(sw.condition);
      children.push(sw.body);
      break;
    }

    case NodeKind.CaseStmt: {
      const cs = node as any;
      children.push(cs.value);
      children.push(cs.statement);
      break;
    }

    case NodeKind.DefaultStmt: {
      const ds = node as any;
      children.push(ds.statement);
      break;
    }

    case NodeKind.TryStmt: {
      const ts = node as any;
      children.push(ts.body);
      children.push(...ts.handlers);
      break;
    }

    case NodeKind.CatchClause: {
      const cc = node as any;
      if (cc.parameter) children.push(cc.parameter);
      children.push(cc.body);
      break;
    }

    case NodeKind.ForRangeStmt: {
      const fr = node as any;
      children.push(fr.declaration);
      children.push(fr.range);
      children.push(fr.body);
      break;
    }

    case NodeKind.ExprStmt: {
      const es = node as any;
      children.push(es.expression);
      break;
    }

    case NodeKind.DeclStmt: {
      const ds = node as any;
      children.push(...ds.declarations);
      break;
    }

    case NodeKind.ParameterDecl: {
      const pd = node as ParameterDecl;
      if (pd.name) children.push(pd.name);
      pd.type && children.push(pd.type as ASTNode);
      if (pd.defaultValue) children.push(pd.defaultValue);
      break;
    }

    case NodeKind.AssignExpr: {
      const ae = node as any;
      children.push(ae.left);
      children.push(ae.right);
      break;
    }

    case NodeKind.ParenExpr: {
      const pe = node as any;
      children.push(pe.expression);
      break;
    }

    case NodeKind.CStyleCastExpr: {
      const cast = node as any;
      children.push(cast.type);
      children.push(cast.expression);
      break;
    }

    case NodeKind.ConditionalExpr: {
      const ce = node as any;
      children.push(ce.condition);
      children.push(ce.thenExpr);
      children.push(ce.elseExpr);
      break;
    }

    case NodeKind.PostfixExpr: {
      const pf = node as any;
      children.push(pf.operand);
      break;
    }

    case NodeKind.CommaExpr: {
      const comma = node as any;
      children.push(...comma.expressions);
      break;
    }

    case NodeKind.SubscriptExpr: {
      const sub = node as any;
      children.push(sub.array);
      children.push(sub.index);
      break;
    }

    case NodeKind.StaticCastExpr:
    case NodeKind.DynamicCastExpr:
    case NodeKind.ReinterpretCastExpr:
    case NodeKind.ConstCastExpr: {
      const cast = node as any;
      children.push(cast.type);
      children.push(cast.expression);
      break;
    }

    case NodeKind.FunctionalCastExpr: {
      const fc = node as any;
      children.push(fc.type);
      children.push(...fc.arguments);
      break;
    }

    case NodeKind.SizeofExpr: {
      const se = node as any;
      children.push(se.operand);
      break;
    }

    case NodeKind.AlignofExpr: {
      const ae = node as any;
      children.push(ae.type);
      break;
    }

    case NodeKind.NewExpr: {
      const ne = node as any;
      children.push(ne.type);
      children.push(...ne.placement);
      if (ne.initializer) children.push(ne.initializer);
      break;
    }

    case NodeKind.DeleteExpr: {
      const de = node as any;
      children.push(de.expression);
      break;
    }

    case NodeKind.ThrowExpr: {
      const te = node as any;
      if (te.expression) children.push(te.expression);
      break;
    }

    case NodeKind.InitListExpr: {
      const il = node as any;
      children.push(...il.elements);
      break;
    }

    case NodeKind.DesignatedInitExpr: {
      const di = node as any;
      children.push(di.initializer);
      break;
    }

    case NodeKind.LambdaExpr: {
      const lam = node as any;
      children.push(...lam.captures);
      children.push(...lam.parameters);
      if (lam.body) children.push(lam.body);
      break;
    }

    case NodeKind.FoldExpr: {
      const fe = node as any;
      children.push(fe.pattern);
      if (fe.init) children.push(fe.init);
      break;
    }

    case NodeKind.UnionDecl: {
      const ud = node as any;
      if (ud.name) children.push(ud.name);
      children.push(...ud.members);
      break;
    }

    case NodeKind.EnumDecl: {
      const ed = node as EnumDecl;
      if (ed.name) children.push(ed.name);
      children.push(...ed.enumerators as ASTNode[]);
      break;
    }

    case NodeKind.FieldDecl: {
      const fd = node as FieldDecl;
      children.push(fd.name);
      children.push(fd.type as ASTNode);
      if (fd.initializer) children.push(fd.initializer);
      break;
    }

    case NodeKind.MethodDecl: {
      const md = node as MethodDecl;
      children.push(md.name as ASTNode);
      children.push(md.returnType as ASTNode);
      children.push(...md.parameters);
      if (md.body) children.push(md.body);
      break;
    }

    case NodeKind.ConstructorDecl:
    case NodeKind.DestructorDecl: {
      const cd = node as any;
      if (cd.parameters) children.push(...cd.parameters);
      if (cd.body) children.push(cd.body);
      if (cd.initializers) children.push(...cd.initializers);
      break;
    }

    case NodeKind.TemplateDecl: {
      const td = node as TemplateDecl;
      children.push(...td.parameters as ASTNode[]);
      children.push(td.declaration as ASTNode);
      break;
    }

    case NodeKind.TypedefDecl:
    case NodeKind.TypeAliasDecl: {
      const tad = node as any;
      children.push(tad.name);
      children.push(tad.type);
      break;
    }

    case NodeKind.LinkageSpec: {
      const ls = node as any;
      children.push(...ls.declarations);
      break;
    }

    case NodeKind.StaticAssertDecl: {
      const sa = node as any;
      children.push(sa.condition);
      if (sa.message) children.push(sa.message);
      break;
    }

    case NodeKind.PointerType: {
      const pt = node as any;
      children.push(pt.pointee);
      break;
    }

    case NodeKind.ReferenceType:
    case NodeKind.RValueReferenceType: {
      const rt = node as any;
      children.push(rt.referenced);
      break;
    }

    case NodeKind.ArrayType: {
      const at = node as any;
      children.push(at.elementType);
      if (at.size) children.push(at.size);
      break;
    }

    case NodeKind.FunctionType: {
      const ft = node as any;
      children.push(ft.returnType);
      children.push(...ft.parameters);
      break;
    }

    case NodeKind.QualifiedType: {
      const qt = node as any;
      children.push(qt.type);
      break;
    }

    case NodeKind.ElaboratedType: {
      const et = node as any;
      children.push(et.name);
      break;
    }

    case NodeKind.TemplateType: {
      const tt = node as any;
      children.push(tt.name);
      children.push(...tt.arguments);
      break;
    }

    case NodeKind.DecltypeType:
    case NodeKind.TypeofType: {
      const dt = node as any;
      children.push(dt.expression);
      break;
    }

    case NodeKind.MemberPointerType: {
      const mpt = node as any;
      children.push(mpt.classType);
      children.push(mpt.memberType);
      break;
    }

    case NodeKind.QualifiedId: {
      const qi = node as any;
      children.push(...qi.qualifier);
      children.push(qi.name);
      break;
    }

    case NodeKind.CoReturnStmt: {
      const cr = node as any;
      if (cr.value) children.push(cr.value);
      break;
    }

    // Leaf nodes: Identifier, IntegerLiteral, FloatingLiteral, CharLiteral,
    // StringLiteral, BoolLiteral, NullptrLiteral, ThisExpr, BreakStmt,
    // ContinueStmt, NullStmt, BuiltinType, AutoType, Error, TypedefType
    default:
      break;
  }

  return children;
}

/**
 * Find all nodes matching a predicate
 */
export function findNodes(node: ASTNode, predicate: (n: ASTNode) => boolean): ASTNode[] {
  const results: ASTNode[] = [];
  for (const n of traverseAST(node)) {
    if (predicate(n)) {
      results.push(n);
    }
  }
  return results;
}

/**
 * Find all nodes of a specific kind
 */
export function findNodesByKind<K extends NodeKind>(node: ASTNode, kind: K): ASTNode[] {
  return findNodes(node, n => n.kind === kind);
}

/**
 * Find all identifiers with a specific name
 */
export function findIdentifiers(node: ASTNode, name: string): Identifier[] {
  return findNodes(node, n =>
    n.kind === NodeKind.Identifier && (n as Identifier).name === name
  ) as Identifier[];
}

/**
 * Transform AST nodes using a visitor
 * Returns a new AST with transformed nodes (immutable)
 */
export function transformAST<N extends ASTNode>(
  node: N,
  visitor: ASTVisitor<ASTNode | undefined>
): N {
  // First, transform children
  const transformedChildren = transformChildren(node, visitor);

  // Then, apply visitor to this node
  const result = walkAST(transformedChildren, visitor);

  return (result ?? transformedChildren) as N;
}

function transformChildren<N extends ASTNode>(
  node: N,
  visitor: ASTVisitor<ASTNode | undefined>
): N {
  // Create a shallow copy with transformed children
  const copy = { ...node };

  switch (node.kind) {
    case NodeKind.TranslationUnit: {
      const tu = copy as unknown as TranslationUnit;
      tu.declarations = tu.declarations.map(d => transformAST(d, visitor));
      break;
    }

    case NodeKind.FunctionDecl: {
      const fn = copy as unknown as FunctionDecl;
      if (fn.name) fn.name = transformAST(fn.name as any, visitor) as any;
      fn.returnType = transformAST(fn.returnType, visitor);
      fn.parameters = fn.parameters.map(p => transformAST(p, visitor));
      if (fn.body) fn.body = transformAST(fn.body, visitor);
      break;
    }

    case NodeKind.ParameterDecl: {
      const param = copy as unknown as ParameterDecl;
      if (param.name) param.name = transformAST(param.name, visitor);
      param.type = transformAST(param.type, visitor);
      if (param.defaultValue) param.defaultValue = transformAST(param.defaultValue, visitor);
      break;
    }

    case NodeKind.VariableDecl: {
      const varDecl = copy as unknown as VariableDecl;
      varDecl.name = transformAST(varDecl.name, visitor);
      varDecl.type = transformAST(varDecl.type, visitor);
      if (varDecl.initializer) varDecl.initializer = transformAST(varDecl.initializer, visitor);
      break;
    }

    case NodeKind.DeclStmt: {
      const declStmt = copy as any;
      declStmt.declarations = declStmt.declarations.map((d: any) => transformAST(d, visitor));
      break;
    }

    case NodeKind.ExprStmt: {
      const exprStmt = copy as any;
      exprStmt.expression = transformAST(exprStmt.expression, visitor);
      break;
    }

    case NodeKind.ReturnStmt: {
      const retStmt = copy as any;
      if (retStmt.value) retStmt.value = transformAST(retStmt.value, visitor);
      break;
    }

    case NodeKind.AssignExpr: {
      const assign = copy as any;
      assign.left = transformAST(assign.left, visitor);
      assign.right = transformAST(assign.right, visitor);
      break;
    }

    case NodeKind.CompoundStmt: {
      const compound = copy as unknown as CompoundStmt;
      compound.statements = compound.statements.map(s => transformAST(s, visitor));
      break;
    }

    case NodeKind.IfStmt: {
      const ifStmt = copy as unknown as IfStmt;
      ifStmt.condition = transformAST(ifStmt.condition, visitor);
      ifStmt.thenBranch = transformAST(ifStmt.thenBranch, visitor);
      if (ifStmt.elseBranch) {
        ifStmt.elseBranch = transformAST(ifStmt.elseBranch, visitor);
      }
      break;
    }

    case NodeKind.ForStmt: {
      const forStmt = copy as any;
      if (forStmt.init) forStmt.init = transformAST(forStmt.init, visitor);
      if (forStmt.condition) forStmt.condition = transformAST(forStmt.condition, visitor);
      if (forStmt.increment) forStmt.increment = transformAST(forStmt.increment, visitor);
      forStmt.body = transformAST(forStmt.body, visitor);
      break;
    }

    case NodeKind.WhileStmt: {
      const whileStmt = copy as any;
      whileStmt.condition = transformAST(whileStmt.condition, visitor);
      whileStmt.body = transformAST(whileStmt.body, visitor);
      break;
    }

    case NodeKind.DoWhileStmt: {
      const doWhile = copy as any;
      doWhile.body = transformAST(doWhile.body, visitor);
      doWhile.condition = transformAST(doWhile.condition, visitor);
      break;
    }

    case NodeKind.LabelStmt: {
      const labelStmt = copy as any;
      labelStmt.label = transformAST(labelStmt.label, visitor);
      labelStmt.statement = transformAST(labelStmt.statement, visitor);
      break;
    }

    case NodeKind.BinaryExpr: {
      const bin = copy as unknown as BinaryExpr;
      bin.left = transformAST(bin.left, visitor);
      bin.right = transformAST(bin.right, visitor);
      break;
    }

    case NodeKind.UnaryExpr: {
      const un = copy as unknown as UnaryExpr;
      un.operand = transformAST(un.operand, visitor);
      break;
    }

    case NodeKind.CallExpr: {
      const call = copy as unknown as CallExpr;
      call.callee = transformAST(call.callee, visitor);
      call.arguments = call.arguments.map(a => transformAST(a, visitor));
      break;
    }

    case NodeKind.SubscriptExpr: {
      const sub = copy as any;
      sub.array = transformAST(sub.array, visitor);
      sub.index = transformAST(sub.index, visitor);
      break;
    }

    case NodeKind.MemberExpr: {
      const mem = copy as any;
      mem.object = transformAST(mem.object, visitor);
      if (mem.member) mem.member = transformAST(mem.member, visitor);
      break;
    }

    case NodeKind.ParenExpr: {
      const paren = copy as any;
      paren.expression = transformAST(paren.expression, visitor);
      break;
    }

    case NodeKind.CStyleCastExpr: {
      const cast = copy as any;
      cast.type = transformAST(cast.type, visitor);
      cast.expression = transformAST(cast.expression, visitor);
      break;
    }

    case NodeKind.ConditionalExpr: {
      const cond = copy as any;
      cond.condition = transformAST(cond.condition, visitor);
      cond.thenExpr = transformAST(cond.thenExpr, visitor);
      cond.elseExpr = transformAST(cond.elseExpr, visitor);
      break;
    }

    case NodeKind.PostfixExpr: {
      const post = copy as any;
      post.operand = transformAST(post.operand, visitor);
      break;
    }

    case NodeKind.CommaExpr: {
      const comma = copy as any;
      comma.expressions = comma.expressions.map((e: any) => transformAST(e, visitor));
      break;
    }

    case NodeKind.SwitchStmt: {
      const sw = copy as any;
      sw.condition = transformAST(sw.condition, visitor);
      sw.body = transformAST(sw.body, visitor);
      break;
    }

    case NodeKind.CaseStmt: {
      const cs = copy as any;
      cs.value = transformAST(cs.value, visitor);
      cs.statement = transformAST(cs.statement, visitor);
      break;
    }

    case NodeKind.DefaultStmt: {
      const ds = copy as any;
      ds.statement = transformAST(ds.statement, visitor);
      break;
    }

    case NodeKind.TryStmt: {
      const ts = copy as any;
      ts.body = transformAST(ts.body, visitor);
      ts.handlers = ts.handlers.map((h: any) => transformAST(h, visitor));
      break;
    }

    case NodeKind.CatchClause: {
      const cc = copy as any;
      if (cc.parameter) cc.parameter = transformAST(cc.parameter, visitor);
      cc.body = transformAST(cc.body, visitor);
      break;
    }

    case NodeKind.ForRangeStmt: {
      const fr = copy as any;
      fr.declaration = transformAST(fr.declaration, visitor);
      fr.range = transformAST(fr.range, visitor);
      fr.body = transformAST(fr.body, visitor);
      break;
    }

    case NodeKind.GotoStmt: {
      const gs = copy as any;
      gs.label = transformAST(gs.label, visitor);
      break;
    }

    case NodeKind.ClassDecl:
    case NodeKind.StructDecl: {
      const cls = copy as any;
      if (cls.name) cls.name = transformAST(cls.name, visitor);
      cls.members = cls.members.map((m: any) => transformAST(m, visitor));
      break;
    }

    case NodeKind.NamespaceDecl: {
      const ns = copy as any;
      if (ns.name) ns.name = transformAST(ns.name, visitor);
      ns.declarations = ns.declarations.map((d: any) => transformAST(d, visitor));
      break;
    }

    case NodeKind.StaticCastExpr:
    case NodeKind.DynamicCastExpr:
    case NodeKind.ReinterpretCastExpr:
    case NodeKind.ConstCastExpr: {
      const cast = copy as any;
      cast.type = transformAST(cast.type, visitor);
      cast.expression = transformAST(cast.expression, visitor);
      break;
    }

    case NodeKind.FunctionalCastExpr: {
      const fc = copy as any;
      fc.type = transformAST(fc.type, visitor);
      fc.arguments = fc.arguments.map((a: any) => transformAST(a, visitor));
      break;
    }

    case NodeKind.SizeofExpr: {
      const se = copy as any;
      se.operand = transformAST(se.operand, visitor);
      break;
    }

    case NodeKind.AlignofExpr: {
      const ae = copy as any;
      ae.type = transformAST(ae.type, visitor);
      break;
    }

    case NodeKind.NewExpr: {
      const ne = copy as any;
      ne.type = transformAST(ne.type, visitor);
      ne.placement = ne.placement.map((p: any) => transformAST(p, visitor));
      if (ne.initializer) ne.initializer = transformAST(ne.initializer, visitor);
      break;
    }

    case NodeKind.DeleteExpr: {
      const de = copy as any;
      de.expression = transformAST(de.expression, visitor);
      break;
    }

    case NodeKind.ThrowExpr: {
      const te = copy as any;
      if (te.expression) te.expression = transformAST(te.expression, visitor);
      break;
    }

    case NodeKind.InitListExpr: {
      const il = copy as any;
      il.elements = il.elements.map((e: any) => transformAST(e, visitor));
      break;
    }

    case NodeKind.DesignatedInitExpr: {
      const di = copy as any;
      di.initializer = transformAST(di.initializer, visitor);
      break;
    }

    case NodeKind.LambdaExpr: {
      const lam = copy as any;
      lam.captures = lam.captures.map((c: any) => transformAST(c, visitor));
      lam.parameters = lam.parameters.map((p: any) => transformAST(p, visitor));
      lam.body = transformAST(lam.body, visitor);
      break;
    }

    case NodeKind.FoldExpr: {
      const fe = copy as any;
      fe.pattern = transformAST(fe.pattern, visitor);
      if (fe.init) fe.init = transformAST(fe.init, visitor);
      break;
    }

    case NodeKind.UnionDecl: {
      const ud = copy as any;
      if (ud.name) ud.name = transformAST(ud.name, visitor);
      ud.members = ud.members.map((m: any) => transformAST(m, visitor));
      break;
    }

    case NodeKind.EnumDecl: {
      const ed = copy as any;
      if (ed.name) ed.name = transformAST(ed.name, visitor);
      ed.enumerators = ed.enumerators.map((e: any) => transformAST(e, visitor));
      break;
    }

    case NodeKind.FieldDecl: {
      const fd = copy as any;
      fd.name = transformAST(fd.name, visitor);
      fd.type = transformAST(fd.type, visitor);
      if (fd.initializer) fd.initializer = transformAST(fd.initializer, visitor);
      break;
    }

    case NodeKind.MethodDecl: {
      const md = copy as any;
      md.name = transformAST(md.name, visitor);
      md.returnType = transformAST(md.returnType, visitor);
      md.parameters = md.parameters.map((p: any) => transformAST(p, visitor));
      if (md.body) md.body = transformAST(md.body, visitor);
      break;
    }

    case NodeKind.ConstructorDecl:
    case NodeKind.DestructorDecl: {
      const cd = copy as any;
      if (cd.parameters) cd.parameters = cd.parameters.map((p: any) => transformAST(p, visitor));
      if (cd.body) cd.body = transformAST(cd.body, visitor);
      break;
    }

    case NodeKind.TemplateDecl: {
      const td = copy as any;
      td.parameters = td.parameters.map((p: any) => transformAST(p, visitor));
      td.declaration = transformAST(td.declaration, visitor);
      break;
    }

    case NodeKind.TypedefDecl:
    case NodeKind.TypeAliasDecl: {
      const tad = copy as any;
      tad.name = transformAST(tad.name, visitor);
      tad.type = transformAST(tad.type, visitor);
      break;
    }

    case NodeKind.LinkageSpec: {
      const ls = copy as any;
      ls.declarations = ls.declarations.map((d: any) => transformAST(d, visitor));
      break;
    }

    case NodeKind.StaticAssertDecl: {
      const sa = copy as any;
      sa.condition = transformAST(sa.condition, visitor);
      if (sa.message) sa.message = transformAST(sa.message, visitor);
      break;
    }

    case NodeKind.PointerType: {
      const pt = copy as any;
      pt.pointee = transformAST(pt.pointee, visitor);
      break;
    }

    case NodeKind.ReferenceType:
    case NodeKind.RValueReferenceType: {
      const rt = copy as any;
      rt.referenced = transformAST(rt.referenced, visitor);
      break;
    }

    case NodeKind.ArrayType: {
      const at = copy as any;
      at.elementType = transformAST(at.elementType, visitor);
      if (at.size) at.size = transformAST(at.size, visitor);
      break;
    }

    case NodeKind.FunctionType: {
      const ft = copy as any;
      ft.returnType = transformAST(ft.returnType, visitor);
      ft.parameters = ft.parameters.map((p: any) => transformAST(p, visitor));
      break;
    }

    case NodeKind.QualifiedType: {
      const qt = copy as any;
      qt.type = transformAST(qt.type, visitor);
      break;
    }

    case NodeKind.ElaboratedType: {
      const et = copy as any;
      et.name = transformAST(et.name, visitor);
      break;
    }

    case NodeKind.TemplateType: {
      const tt = copy as any;
      tt.name = transformAST(tt.name, visitor);
      tt.arguments = tt.arguments.map((a: any) => transformAST(a, visitor));
      break;
    }

    case NodeKind.DecltypeType:
    case NodeKind.TypeofType: {
      const dt = copy as any;
      dt.expression = transformAST(dt.expression, visitor);
      break;
    }

    case NodeKind.MemberPointerType: {
      const mpt = copy as any;
      mpt.classType = transformAST(mpt.classType, visitor);
      mpt.memberType = transformAST(mpt.memberType, visitor);
      break;
    }

    case NodeKind.QualifiedId: {
      const qi = copy as any;
      qi.qualifier = qi.qualifier.map((q: any) => transformAST(q, visitor));
      qi.name = transformAST(qi.name, visitor);
      break;
    }

    case NodeKind.CoReturnStmt: {
      const cr = copy as any;
      if (cr.value) cr.value = transformAST(cr.value, visitor);
      break;
    }
  }

  return copy;
}

/**
 * Count nodes in an AST
 */
export function countNodes(node: ASTNode): number {
  let count = 0;
  for (const _ of traverseAST(node)) {
    count++;
  }
  return count;
}

/**
 * Get the depth of the AST
 */
export function getASTDepth(node: ASTNode): number {
  const children = getChildren(node);
  if (children.length === 0) return 1;
  return 1 + Math.max(...children.map(getASTDepth));
}
