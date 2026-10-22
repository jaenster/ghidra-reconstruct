/**
 * Member Call Plugin
 *
 * A non-static member function of a class the tree defines for real is called
 * on its object. Ghidra spells every such call with the receiver as the first
 * argument; C++ calls the member on the object the receiver points at:
 *
 *   C::Fn(&obj, a)  →  obj.Fn(a)
 *   C::Fn(p, a)     →  p->Fn(a)
 *
 * The receiver is the same pointer either way, so the call keeps its value.
 *
 * Member name lookup starts in the class of the object's static type and stops
 * at the first class that declares the name: a name a class declares hides the
 * same name in every base. Where the receiver's class, or a class between it and
 * C, declares Fn, the call names the member in C (`obj.C::Fn(a)`); that is also
 * the spelling when the receiver's type is not known, as it calls C::Fn on any
 * receiver the original call accepted.
 *
 * Inside a non-static member the receiver parameter is `this`. A body that
 * assigns its receiver keeps it as a local initialized from `this`, since `this`
 * cannot be assigned.
 *
 * Which members are non-static, what each class declares and which class derives
 * from which is the generator's model (reconstruct `codegen/templates/members.ts`
 * and `bases.ts`), passed by spelling.
 *
 * Late (960): every pass before it reads the receiver as the typed parameter
 * and the call in Ghidra's form - the cast passes key on the parameter's type,
 * and `frame-group-locals` (950) reads `&local` as the local's address escaping.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CallExpr, CompoundStmt, Expression, FunctionDecl, Identifier, MemberExpr,
  ParameterDecl, PostfixExpr, QualifiedId, Statement, ThisExpr, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { Expr, Stmt, Decl } from '../../../ast/factory.js';
import { findNodesByKind, traverseAST } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createExprShape } from './expr-shape.js';
import { canonicalBase, shapeOfSpelling, typeNodeName, unwrapParens, type TypedefResolver } from './call-arg-cast.js';
import { isNullLike, unwrapAddressOf } from './method-call-rewrite.js';

export interface MemberCallModel {
  /** Class spelling → the names of its non-static member functions. */
  instanceMembers?: Record<string, readonly string[]>;
  /** Class spelling → every name the class declares itself: members, static data, nested types. */
  declaredNames?: Record<string, readonly string[]>;
  /** Each class with a base, and its direct base, as spellings. */
  bases?: ReadonlyArray<readonly [string, string]>;
  /** Typedef name → what it stands for. */
  typedefTargets?: Record<string, string>;
}

export interface MemberCallOptions extends PluginOptions, MemberCallModel {
  /** The receiver parameter of the body, when the body is a non-static member: it becomes `this`. */
  receiver?: string;
  /** Global name → declared spelling. */
  globalTypes?: Record<string, string>;
  /** A name declared by the enclosing class/namespace body. */
  enclosingVarTypes?: Record<string, string>;
  /** Aggregate name → member name → member spelling. */
  structFields?: Record<string, Record<string, string>>;
  /** Member name → spelling, for members whose name is unambiguous tree-wide. */
  fieldTypes?: Record<string, string>;
  /** Function name → return spelling. */
  functionReturnTypes?: Record<string, string>;
}

/** The model's questions, over class names as the type model spells them. */
export interface MemberCalls {
  /** Is `name` a non-static member function of `cls`? */
  isInstanceMember(cls: string, name: string): boolean;
  /**
   * Must a call of `cls::name` on a receiver of class `receiver` name the
   * member in `cls`? True where `receiver`, or a class between it and `cls`,
   * declares `name`, and where the receiver's class is unknown or not `cls` or
   * derived from it.
   */
  needsQualifier(receiver: string | undefined, cls: string, name: string): boolean;
  /** A spelling's class, as the type model names it. */
  classOf(spelling: string): string | undefined;
}

export function memberCalls(model: MemberCallModel): MemberCalls {
  const typedefTargets = model.typedefTargets;
  const resolve: TypedefResolver | undefined = typedefTargets ? (name: string) => typedefTargets[name] : undefined;
  const classOf = (spelling: string): string | undefined => {
    const s = shapeOfSpelling(spelling, resolve);
    return s && s.stars === 0 ? s.base : undefined;
  };
  const byClass = (table: Record<string, readonly string[]> | undefined): Map<string, Set<string>> => {
    const out = new Map<string, Set<string>>();
    for (const [spelling, names] of Object.entries(table ?? {})) {
      const cls = classOf(spelling);
      if (cls !== undefined) out.set(cls, new Set([...(out.get(cls) ?? []), ...names]));
    }
    return out;
  };
  const instance = byClass(model.instanceMembers);
  const declared = byClass(model.declaredNames);
  const baseOf = new Map<string, string>();
  for (const [derived, base] of model.bases ?? []) {
    const d = classOf(derived);
    const b = classOf(base);
    if (d !== undefined && b !== undefined) baseOf.set(d, b);
  }
  return {
    classOf,
    isInstanceMember: (cls, name) => instance.get(cls)?.has(name) ?? false,
    needsQualifier(receiver, cls, name) {
      if (receiver === undefined) return true;
      const seen = new Set<string>();
      for (let c: string | undefined = receiver; c !== undefined && !seen.has(c); c = baseOf.get(c)) {
        if (c === cls) return false;
        if (declared.get(c)?.has(name)) return true;
        seen.add(c);
      }
      return true;
    },
  };
}

/** The class a callee `C::name` names, as the type model spells it, or undefined. */
function calleeClass(q: QualifiedId): string | undefined {
  if (q.qualifier.length !== 1 || q.name.kind !== NodeKind.Identifier) return undefined;
  const name = typeNodeName(q.qualifier[0]);
  return name === undefined ? undefined : canonicalBase(name);
}

/** Does the body write `name`: assign it, step it, or take its address? */
function writes(body: ASTNode, name: string): boolean {
  const isName = (e: Expression) => {
    const u = unwrapParens(e);
    return u.kind === NodeKind.Identifier && (u as Identifier).name === name;
  };
  for (const n of traverseAST(body)) {
    if (n.kind === NodeKind.AssignExpr && isName((n as AssignExpr).left)) return true;
    if (n.kind === NodeKind.PostfixExpr && isName((n as PostfixExpr).operand)) return true;
    if (n.kind === NodeKind.UnaryExpr) {
      const u = n as UnaryExpr;
      if ((u.operator === '++' || u.operator === '--' || u.operator === '&') && isName(u.operand)) return true;
    }
  }
  return false;
}

/** Properties that hold a NAME (a declaration's, a member's, a qualifier's), never an expression. */
const NAME_SLOTS = ['name', 'member', 'label', 'namespace', 'pack'] as const;

/** Every reference to `name` as an expression, as `this`. */
function receiverToThis(body: ASTNode, name: string): ASTNode {
  const renamed = new WeakMap<ASTNode, Identifier>();
  return createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      if (n.kind === NodeKind.Identifier) {
        const id = n as Identifier;
        if (id.name !== name) return undefined;
        const self = { ...Expr.this(), location: id.location, leadingTrivia: id.leadingTrivia ?? [], trailingTrivia: id.trailingTrivia ?? [] } as ThisExpr;
        renamed.set(self, id);
        return self;
      }
      // An identifier in a name slot is not the variable: put it back.
      let restored: Record<string, unknown> | undefined;
      const rec = n as unknown as Record<string, unknown>;
      for (const key of NAME_SLOTS) {
        const child = rec[key] as ASTNode | undefined;
        const original = child && typeof child === 'object' ? renamed.get(child) : undefined;
        if (original) (restored ??= { ...rec })[key] = original;
      }
      if (n.kind === NodeKind.QualifiedId) {
        const q = n as QualifiedId;
        if (q.qualifier.some(p => renamed.has(p))) {
          (restored ??= { ...rec }).qualifier = q.qualifier.map(p => renamed.get(p) ?? p);
        }
      }
      return restored as unknown as ASTNode | undefined;
    },
  })(body);
}

function createMemberCallTransformer(options: MemberCallOptions = {}): Transformer {
  const instanceTable = options.instanceMembers ?? {};
  const receiver = options.receiver;
  if (Object.keys(instanceTable).length === 0 && !receiver) return createTransformer({});
  const calls = memberCalls(options);
  const tables = {
    globalTypes: options.globalTypes,
    enclosingVarTypes: options.enclosingVarTypes,
    structFields: options.structFields,
    fieldTypes: options.fieldTypes,
    returnTypes: options.functionReturnTypes,
    resolve: options.typedefTargets ? (name: string) => options.typedefTargets![name] : undefined,
  };

  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;
      const localTypes = new Map<string, TypeNode>();
      for (const p of node.parameters) {
        const pd = p as ParameterDecl;
        if (pd.name) localTypes.set(pd.name.name, pd.type);
      }
      for (const d of findNodesByKind(node.body, NodeKind.VariableDecl)) {
        const v = d as VariableDecl;
        if (!localTypes.has(v.name.name)) localTypes.set(v.name.name, v.type);
      }
      const shape = createExprShape(localTypes, tables);

      let body: ASTNode = createTransformer({
        visitCallExpr(call: CallExpr): ASTNode | undefined {
          if (call.callee.kind !== NodeKind.QualifiedId || call.arguments.length === 0) return undefined;
          const callee = call.callee as QualifiedId;
          const cls = calleeClass(callee);
          const name = (callee.name as Identifier).name;
          if (cls === undefined || !calls.isInstanceMember(cls, name)) return undefined;
          const [recv, ...rest] = call.arguments;
          if (isNullLike(recv)) return undefined;
          const recvShape = shape(recv);
          const recvClass = recvShape && recvShape.stars === 1 ? recvShape.base : undefined;
          const member: Identifier | QualifiedId = calls.needsQualifier(recvClass, cls, name)
            ? { ...callee, isGlobal: false }
            : (callee.name as Identifier);
          const { object, useArrow } = unwrapAddressOf(recv);
          const callee2: MemberExpr = {
            kind: NodeKind.MemberExpr,
            object,
            member,
            isArrow: useArrow,
            location: callee.location,
            leadingTrivia: callee.leadingTrivia ?? [],
            trailingTrivia: [],
          };
          return updateNode(call, { callee: callee2, arguments: rest } as Partial<CallExpr>);
        },
      })(node.body);

      if (receiver && localTypes.has(receiver)) {
        if (!writes(body, receiver)) {
          body = receiverToThis(body, receiver);
        } else {
          // The body steps or reseats its receiver: it keeps a local copy of `this`.
          const type = localTypes.get(receiver)!;
          const copy = Stmt.declStmt([Decl.variable(receiver, type, Expr.this())]);
          const block = body as CompoundStmt;
          body = { ...block, statements: [copy as Statement, ...block.statements] } as CompoundStmt;
        }
      }
      return updateNode(node, { body } as Partial<FunctionDecl>);
    },
  });
}

export const memberCallPlugin: TransformPlugin = {
  id: 'member-call',
  name: 'Member Call',
  description:
    'Call a non-static member on its object (C::Fn(&obj, a) -> obj.Fn(a), naming C where a class between hides Fn) and spell the receiver `this` inside one',
  version: '1.0.0',
  defaultEnabled: true,
  // After frame-group-locals (950), which reads `&local` as an escaping address;
  // before the label passes (985+), which only touch labels.
  priority: 960,
  tags: ['cpp', 'cleanup'],
  createTransformer: createMemberCallTransformer,
};
