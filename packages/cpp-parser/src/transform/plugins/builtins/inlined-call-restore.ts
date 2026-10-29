/**
 * Inlined Call Restore Plugin
 *
 * VC8 emits a static function's out-of-line copy, in a register convention of its
 * own, as soon as one call to it exists - even when every call was inlined. Game.exe
 * holds such functions with no call anywhere in the image: DRLGGRID_GetCellAddress
 * (0067c4d0, arguments in EAX, EDX and on the stack, RET 4) has no caller, while
 * AlterGridFlag (0067c4f0) computes exactly its body,
 *
 *     (*apFlagOperations[eOperation])((int*)(pDrlgGrid->pCellsFlags + pDrlgGrid->pCellsRowOffsets[nY] + nX), nFlag);
 *
 * The decompiler can only print the inlined copy, so the rebuild has no call, VC8
 * drops nothing and keeps the function extern, and its copy comes out RET 0xc. This
 * pass puts the call back where a site is a complete, exact instance of the body:
 *
 *     (*apFlagOperations[eOperation])((int*)DRLGGRID_GetCellAddress(pDrlgGrid, nY, nX), nFlag);
 *
 * and the emitter declares the callee `static inline`, so VC8 inlines the call to
 * the same code and gives the copy the original's convention.
 *
 * A callee's body takes one of two forms:
 *
 *  - `return E;` with no cast around E: a site is any rvalue expression that equals E
 *    with each parameter replaced by an argument, or `B[I]` when E is `B + I` (the
 *    decompiler's spelling of `*(B + I)`), which becomes `*F(args)`;
 *  - `if (C) return A; return B;` (or with an else): a site is
 *    `if (C) x = A; else x = B;` for one local `x`, which becomes `x = F(args)`.
 *    A return wrapped in a pointer cast to the return type matches an assignment of
 *    the uncast pointer, and the call is cast back to `x`'s declared pointer type.
 *
 * Value-preserving by construction, made only when:
 *  - every parameter appears in the body, and each argument is the same expression
 *    at every place its parameter appears;
 *  - an argument neither calls nor writes, and its type is the parameter's: a local
 *    or parameter (or a member, global or subscript whose type the declarations give)
 *    of the parameter's shape, or an integer literal for an integer parameter. The
 *    decompiler spells a cast wherever a value's type differs from the one the
 *    operation takes, so with the arguments typed as the parameters the uncast
 *    expression has the callee's return type;
 *  - the body names something besides its parameters and small constants - a
 *    member, a global, a call, a string - so `a * 16 + b` is never taken for a
 *    call to a helper that happens to compute it;
 *  - the body has no top-level lvalue (a bare member, subscript or dereference),
 *    which an assignment could write through.
 *
 * Callees arrive as options: the decompiled body as the pipeline would parse it,
 * plus the name a call to it is spelled with.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CallExpr, CharLiteralExpr, CompoundStmt, CStyleCastExpr, Expression,
  ExprStmt, FunctionDecl, Identifier, IfStmt, IntegerLiteralExpr, MemberExpr, ParameterDecl,
  ParenExpr, QualifiedId, ReturnStmt, Statement, StringLiteralExpr, SubscriptExpr, TypeNode, UnaryExpr,
  VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST, getChildren } from '../../../ast/visitor.js';
import { Expr, Stmt } from '../../../ast/factory.js';
import { parse } from '../../../parser/parser.js';
import { emit } from '../../../emit/emitter.js';
import { createTransformer, cloneNode, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { sameShape, shapeOfNode, unwrapParens, type TypeShape, type TypedefResolver } from './call-arg-cast.js';
import { createExprShape, type ExprShape } from './expr-shape.js';
import { effectsOf } from './access-order-evidence.js';

/** A function whose calls the original inlined, as the decompiler printed it. */
export interface InlinedCallee {
  /** The name a call to it is spelled with, `::`-separated. */
  callName: string;
  /** The return type its definition is emitted with. */
  returnType: string;
  /** Its parameter list as emitted: `int nY, int nX`. */
  params: string;
  /** Its decompiled body, between the braces, as the pipeline parses it. */
  body: string;
}

/** The declarations argument types are read from. */
export interface InlinedCallTables {
  globalTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  fieldTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
}

export interface InlinedCallRestoreOptions extends PluginOptions, InlinedCallTables {
  callees?: InlinedCallee[];
  onSite?: (e: { line: number; callee: string; form: InlinedCallForm }) => void;
}

export type InlinedCallForm = 'expression' | 'subscript' | 'select';

interface Pattern {
  callee: InlinedCallee;
  params: Array<{ name: string; type: TypeNode }>;
  /** `return E;` */
  expr?: Expression;
  /** `if (C) return A; return B;` - each arm without the pointer cast to the return type, if any. */
  select?: { cond: Expression; then: Expression; else: Expression; castArms: boolean };
}

const patternCache = new Map<string, Pattern | null>();

/** Wrap one decompiled body the way the pipeline does and parse it. */
function parseWrapped(returnType: string, params: string, body: string): FunctionDecl | undefined {
  try {
    const tu = parse(`${returnType} dummy(${params}) {${body}}`);
    const fn = tu.declarations.find(d => d.kind === NodeKind.FunctionDecl) as FunctionDecl | undefined;
    return fn?.body ? fn : undefined;
  } catch {
    return undefined;
  }
}

function paramName(p: ParameterDecl): string | undefined {
  const n = (p as unknown as { name?: Identifier | null }).name;
  return n && n.kind === NodeKind.Identifier ? n.name : undefined;
}

/** Statements that compile to something: comments and empty statements dropped. */
function realStatements(block: CompoundStmt): Statement[] {
  return block.statements.filter(s => s.kind !== NodeKind.NullStmt);
}

function onlyStatement(s: Statement): Statement {
  if (s.kind === NodeKind.CompoundStmt) {
    const inner = realStatements(s as CompoundStmt);
    if (inner.length === 1) return onlyStatement(inner[0]);
  }
  return s;
}

function returnValue(s: Statement): Expression | undefined {
  const r = onlyStatement(s);
  return r.kind === NodeKind.ReturnStmt ? (r as ReturnStmt).value ?? undefined : undefined;
}

const typeSpelling = (t: TypeNode): string => emit(t).replace(/\s+/g, ' ').trim();

/**
 * `(P *)E`: the cast and E, else undefined. A return is cast to the return type, which
 * the decompiler spells its own way (`undefined *` for an emitted `uint8_t *`), so
 * any pointer cast is taken; the two arms must agree on it.
 */
function pointerCast(e: Expression): { type: TypeNode; inner: Expression } | undefined {
  const u = unwrapParens(e);
  if (u.kind !== NodeKind.CStyleCastExpr) return undefined;
  const c = u as CStyleCastExpr;
  if ((shapeOfNode(c.type)?.stars ?? 0) === 0) return undefined;
  return { type: c.type, inner: c.expression };
}

function isLvalueRoot(e: Expression): boolean {
  const u = unwrapParens(e);
  return u.kind === NodeKind.Identifier || u.kind === NodeKind.QualifiedId || u.kind === NodeKind.MemberExpr
    || u.kind === NodeKind.SubscriptExpr || (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '*');
}

/** Whether the body names something besides its parameters and small constants. */
function hasAnchor(nodes: Expression[], params: ReadonlySet<string>): boolean {
  for (const root of nodes) {
    for (const n of traverseAST(root)) {
      switch (n.kind) {
        case NodeKind.MemberExpr:
        case NodeKind.CallExpr:
        case NodeKind.StringLiteral:
        case NodeKind.QualifiedId:
          return true;
        case NodeKind.Identifier:
          if (!params.has((n as Identifier).name)) return true;
          break;
        case NodeKind.IntegerLiteral:
          if ((n as IntegerLiteralExpr).value >= 0x100n) return true;
          break;
      }
    }
  }
  return false;
}

/** The pattern one callee's body gives, or null when it has no form this pass restores. */
export function compileInlinedCallee(callee: InlinedCallee): Pattern | null {
  const key = `${callee.callName}\u0000${callee.returnType}\u0000${callee.params}\u0000${callee.body}`;
  const cached = patternCache.get(key);
  if (cached !== undefined) return cached;
  const result = compileUncached(callee);
  patternCache.set(key, result);
  return result;
}

function compileUncached(callee: InlinedCallee): Pattern | null {
  const fn = parseWrapped(callee.returnType, callee.params, callee.body);
  if (!fn?.body) return null;
  const params: Pattern['params'] = [];
  for (const p of fn.parameters) {
    const name = paramName(p);
    if (!name) return null;
    params.push({ name, type: (p as unknown as VariableDecl).type });
  }
  if (params.length === 0) return null;
  const names = new Set(params.map(p => p.name));
  // Locals in the body would be names a site cannot bind.
  for (const n of traverseAST(fn.body)) if (n.kind === NodeKind.VariableDecl || n.kind === NodeKind.LabelStmt) return null;

  const stmts = realStatements(fn.body);
  const pattern: Pattern = { callee, params };
  if (stmts.length === 1 && stmts[0].kind === NodeKind.ReturnStmt) {
    const e = (stmts[0] as ReturnStmt).value;
    if (!e || isLvalueRoot(e) || unwrapParens(e).kind === NodeKind.CStyleCastExpr) return null;
    pattern.expr = e;
  } else if ((stmts.length === 2 || stmts.length === 1) && stmts[0].kind === NodeKind.IfStmt) {
    const ifs = stmts[0] as IfStmt;
    if (ifs.init) return null;
    const a = returnValue(ifs.thenBranch);
    const b = stmts.length === 2
      ? (stmts[1].kind === NodeKind.ReturnStmt ? (stmts[1] as ReturnStmt).value ?? undefined : undefined)
      : (ifs.elseBranch ? returnValue(ifs.elseBranch) : undefined);
    if (!a || !b || (stmts.length === 2 && ifs.elseBranch)) return null;
    const ua = pointerCast(a);
    const ub = pointerCast(b);
    if ((ua === undefined) !== (ub === undefined)) return null;
    if (ua && ub && typeSpelling(ua.type) !== typeSpelling(ub.type)) return null;
    if (ua && (shapeOfNode(fn.returnType)?.stars ?? 0) === 0) return null;
    const castArms = ua !== undefined;
    pattern.select = { cond: ifs.condition, then: ua ? ua.inner : a, else: ub ? ub.inner : b, castArms };
  } else {
    return null;
  }

  const roots = pattern.expr ? [pattern.expr] : [pattern.select!.cond, pattern.select!.then, pattern.select!.else];
  const used = new Set<string>();
  for (const r of roots) for (const n of traverseAST(r)) if (n.kind === NodeKind.Identifier) used.add((n as Identifier).name);
  if (params.some(p => !used.has(p.name))) return null;
  // A parameter written in the body is not an expression the site can pass.
  for (const r of roots) {
    for (const n of traverseAST(r)) {
      if ((n.kind === NodeKind.AssignExpr && unwrapParens((n as AssignExpr).left).kind === NodeKind.Identifier
        && names.has(((unwrapParens((n as AssignExpr).left)) as Identifier).name))) return null;
    }
  }
  if (!hasAnchor(roots, names)) return null;
  return pattern;
}

type Bindings = Map<string, Expression>;

/** Exact structural equality of two subtrees, parentheses aside. */
function same(a: ASTNode, b: ASTNode): boolean {
  return unify(a, b, undefined, new Map());
}

/**
 * Whether `site` is `pat` with each parameter in `params` replaced by one expression
 * (recorded in `bound`). Node kinds this does not know never match.
 */
function unify(pat: ASTNode, site: ASTNode, params: ReadonlySet<string> | undefined, bound: Bindings): boolean {
  const p = isExpressionKind(pat) ? unwrapParens(pat as Expression) : pat;
  const s = isExpressionKind(site) ? unwrapParens(site as Expression) : site;
  if (p.kind === NodeKind.Identifier && params?.has((p as Identifier).name)) {
    const name = (p as Identifier).name;
    const prev = bound.get(name);
    if (prev) return same(prev, s);
    bound.set(name, s as Expression);
    return true;
  }
  if (p.kind !== s.kind) return false;
  switch (p.kind) {
    case NodeKind.Identifier:
      return (p as Identifier).name === (s as Identifier).name;
    case NodeKind.QualifiedId:
      return emit(p as QualifiedId) === emit(s as QualifiedId);
    case NodeKind.IntegerLiteral:
      return (p as IntegerLiteralExpr).value === (s as IntegerLiteralExpr).value
        && (p as IntegerLiteralExpr).suffix.toLowerCase() === (s as IntegerLiteralExpr).suffix.toLowerCase();
    case NodeKind.CharLiteral:
      return (p as CharLiteralExpr).value === (s as CharLiteralExpr).value;
    case NodeKind.StringLiteral:
      return (p as StringLiteralExpr).value === (s as StringLiteralExpr).value;
    case NodeKind.BinaryExpr: {
      const a = p as BinaryExpr, b = s as BinaryExpr;
      return a.operator === b.operator && unify(a.left, b.left, params, bound) && unify(a.right, b.right, params, bound);
    }
    case NodeKind.UnaryExpr: {
      const a = p as UnaryExpr, b = s as UnaryExpr;
      return a.operator === b.operator && unify(a.operand, b.operand, params, bound);
    }
    case NodeKind.MemberExpr: {
      const a = p as MemberExpr, b = s as MemberExpr;
      return a.isArrow === b.isArrow && emit(a.member) === emit(b.member) && unify(a.object, b.object, params, bound);
    }
    case NodeKind.SubscriptExpr: {
      const a = p as SubscriptExpr, b = s as SubscriptExpr;
      return unify(a.array, b.array, params, bound) && unify(a.index, b.index, params, bound);
    }
    case NodeKind.CStyleCastExpr: {
      const a = p as CStyleCastExpr, b = s as CStyleCastExpr;
      return typeSpelling(a.type) === typeSpelling(b.type) && unify(a.expression, b.expression, params, bound);
    }
    case NodeKind.CallExpr: {
      const a = p as CallExpr, b = s as CallExpr;
      if (a.arguments.length !== b.arguments.length || !unify(a.callee, b.callee, params, bound)) return false;
      return a.arguments.every((x, i) => unify(x, b.arguments[i], params, bound));
    }
    case NodeKind.ConditionalExpr: {
      const ca = getChildren(p), cb = getChildren(s);
      return ca.length === cb.length && ca.every((x, i) => unify(x, cb[i], params, bound));
    }
    default:
      return false;
  }
}

const EXPRESSION_KINDS = new Set<NodeKind>([
  NodeKind.Identifier, NodeKind.QualifiedId, NodeKind.IntegerLiteral, NodeKind.CharLiteral,
  NodeKind.StringLiteral, NodeKind.BinaryExpr, NodeKind.UnaryExpr, NodeKind.MemberExpr,
  NodeKind.SubscriptExpr, NodeKind.CStyleCastExpr, NodeKind.CallExpr, NodeKind.ConditionalExpr,
  NodeKind.ParenExpr, NodeKind.AssignExpr, NodeKind.PostfixExpr,
]);
const isExpressionKind = (n: ASTNode): boolean => EXPRESSION_KINDS.has(n.kind);

const isIntegral = (s: TypeShape | null): boolean => !!s && s.stars === 0
  && /^(?:(?:unsigned |signed )?(?:char|short|int|long|long long)|bool|u?int(?:8|16|32|64)_t|uint|ushort|uchar|byte|word|dword|undefined[124]?|BYTE|WORD|DWORD|BOOL|UINT|INT|LONG|ULONG)$/.test(s.base);

/** The call arguments the bindings give, or undefined when one is not provably the parameter's type. */
function argumentsFor(pattern: Pattern, bound: Bindings, shapeOf: ExprShape, resolve: TypedefResolver): Expression[] | undefined {
  const args: Expression[] = [];
  for (const p of pattern.params) {
    const arg = bound.get(p.name);
    if (!arg) return undefined;
    const fx = effectsOf(arg);
    if (fx.calls > 0 || fx.writes > 0) return undefined;
    const want = shapeOfNode(p.type, 0, resolve);
    if (!want) return undefined;
    const lit = arg.kind === NodeKind.UnaryExpr && (arg as UnaryExpr).operator === '-' ? unwrapParens((arg as UnaryExpr).operand) : arg;
    if (lit.kind === NodeKind.IntegerLiteral) {
      if (!isIntegral(want)) return undefined;
    } else {
      const have = shapeOf(arg);
      if (!have || !sameShape(have, want)) return undefined;
    }
    args.push(cloneNode(arg));
  }
  return args;
}

function callOf(pattern: Pattern, args: Expression[]): CallExpr {
  const parts = pattern.callee.callName.split('::').filter(Boolean);
  const callee = parts.length > 1 ? Expr.qualifiedId(parts) : Expr.identifier(parts[0]);
  return Expr.call(callee, args);
}

export interface InlinedCallSite { callee: string; line: number; form: InlinedCallForm }

/**
 * Restore the calls in one function. Returns the rewritten function, or undefined
 * when nothing matched, and the sites it rewrote.
 */
export function restoreInlinedCalls(
  fn: FunctionDecl,
  callees: ReadonlyArray<InlinedCallee>,
  tables: InlinedCallTables = {},
): { fn: FunctionDecl | undefined; sites: InlinedCallSite[] } {
  const sites: InlinedCallSite[] = [];
  if (!fn.body) return { fn: undefined, sites };
  const patterns = callees.map(compileInlinedCallee).filter((p): p is Pattern => p !== null);
  if (patterns.length === 0) return { fn: undefined, sites };

  const body = cloneNode(fn.body);
  const typedefTargets = tables.typedefTargets ?? {};
  const resolve: TypedefResolver = name => typedefTargets[name];
  const localTypes = new Map<string, TypeNode>();
  for (const p of fn.parameters) {
    const n = paramName(p);
    if (n) localTypes.set(n, (p as unknown as VariableDecl).type);
  }
  for (const n of traverseAST(body)) {
    if (n.kind === NodeKind.VariableDecl) localTypes.set((n as VariableDecl).name.name, (n as VariableDecl).type);
  }
  const shapeOf = createExprShape(localTypes, {
    globalTypes: tables.globalTypes, structFields: tables.structFields, fieldTypes: tables.fieldTypes, resolve,
  });
  const line = (n: ASTNode): number => n.location?.start.line ?? 0;

  const tryExpression = (e: Expression): Expression | undefined => {
    for (const pat of patterns) {
      if (!pat.expr) continue;
      const names = new Set(pat.params.map(p => p.name));
      let bound: Bindings = new Map();
      if (unify(pat.expr, e, names, bound)) {
        const args = argumentsFor(pat, bound, shapeOf, resolve);
        if (args) {
          sites.push({ callee: pat.callee.callName, line: line(e), form: 'expression' });
          return callOf(pat, args);
        }
      }
      // `B[I]` is the decompiler's `*(B + I)`.
      const ue = unwrapParens(pat.expr);
      const se = unwrapParens(e);
      if (se.kind === NodeKind.SubscriptExpr && ue.kind === NodeKind.BinaryExpr && (ue as BinaryExpr).operator === '+') {
        bound = new Map();
        const b = ue as BinaryExpr, s = se as SubscriptExpr;
        if (unify(b.left, s.array, names, bound) && unify(b.right, s.index, names, bound)) {
          const args = argumentsFor(pat, bound, shapeOf, resolve);
          if (args) {
            sites.push({ callee: pat.callee.callName, line: line(e), form: 'subscript' });
            return Expr.deref(callOf(pat, args));
          }
        }
      }
    }
    return undefined;
  };

  /** `if (C) x = A; else x = B;` */
  const trySelect = (s: IfStmt): Statement | undefined => {
    if (s.init || !s.elseBranch) return undefined;
    const arm = (b: Statement): AssignExpr | undefined => {
      const one = onlyStatement(b);
      if (one.kind !== NodeKind.ExprStmt) return undefined;
      const e = unwrapParens((one as ExprStmt).expression);
      return e.kind === NodeKind.AssignExpr && (e as AssignExpr).operator === '=' ? e as AssignExpr : undefined;
    };
    const ta = arm(s.thenBranch), ea = arm(s.elseBranch);
    if (!ta || !ea) return undefined;
    const target = unwrapParens(ta.left);
    if (target.kind !== NodeKind.Identifier || !same(target, ea.left)) return undefined;
    const targetType = localTypes.get((target as Identifier).name);
    if (!targetType) return undefined;
    for (const pat of patterns) {
      if (!pat.select) continue;
      const names = new Set(pat.params.map(p => p.name));
      const bound: Bindings = new Map();
      if (!unify(pat.select.cond, s.condition, names, bound)) continue;
      if (!unify(pat.select.then, ta.right, names, bound) || !unify(pat.select.else, ea.right, names, bound)) continue;
      const args = argumentsFor(pat, bound, shapeOf, resolve);
      if (!args) continue;
      let value: Expression = callOf(pat, args);
      if (pat.select.castArms) {
        // The arms are the uncast pointers; the call returns them cast to its pointer
        // return type, and a pointer target takes that back unchanged.
        const want = shapeOfNode(targetType, 0, resolve);
        if (!want || want.stars === 0) continue;
        const armShapes = [shapeOf(ta.right), shapeOf(ea.right)];
        if (armShapes.some(a => !a || a.stars === 0)) continue;
        value = Expr.cast(cloneNode(targetType), value);
      }
      sites.push({ callee: pat.callee.callName, line: line(s), form: 'select' });
      const stmt = Stmt.expr(Expr.assign(cloneNode(target as Expression), value));
      (stmt as { leadingTrivia: unknown }).leadingTrivia = s.leadingTrivia;
      return stmt;
    }
    return undefined;
  };

  // Rewrite in place on the clone, outermost match first; a rewritten subtree is not
  // searched again. Positions an assignment writes, an address is taken of, or an
  // increment changes are not values and are skipped.
  const walk = (node: ASTNode, lvalue: boolean): ASTNode => {
    if (node.kind === NodeKind.IfStmt) {
      const r = trySelect(node as IfStmt);
      if (r) return r;
    }
    if (!lvalue && isExpressionKind(node) && node.kind !== NodeKind.ParenExpr) {
      const r = tryExpression(node as Expression);
      if (r) return r;
    }
    const n = node as unknown as Record<string, unknown>;
    const children = new Set(getChildren(node));
    for (const key of Object.keys(n)) {
      const v = n[key];
      const childLvalue = (key === 'left' && node.kind === NodeKind.AssignExpr)
        || ((key === 'operand') && ((node.kind === NodeKind.UnaryExpr && ['&', '++', '--'].includes((node as UnaryExpr).operator))
          || node.kind === NodeKind.PostfixExpr || node.kind === NodeKind.SizeofExpr))
        || (key === 'expression' && node.kind === NodeKind.ParenExpr && lvalue);
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          if (v[i] && typeof v[i] === 'object' && children.has(v[i] as ASTNode)) v[i] = walk(v[i] as ASTNode, false);
        }
      } else if (v && typeof v === 'object' && children.has(v as ASTNode)) {
        n[key] = walk(v as ASTNode, childLvalue);
      }
    }
    return node;
  };
  walk(body, false);
  if (sites.length === 0) return { fn: undefined, sites };
  return { fn: updateNode(fn, { body } as Partial<FunctionDecl>), sites };
}

function createInlinedCallRestoreTransformer(options: InlinedCallRestoreOptions = {}): Transformer {
  const callees = options.callees ?? [];
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (callees.length === 0) return undefined;
      const { fn, sites } = restoreInlinedCalls(node, callees, options);
      for (const s of sites) options.onSite?.(s);
      return fn;
    },
  });
}

export const inlinedCallRestorePlugin: TransformPlugin = {
  id: 'inlined-call-restore',
  name: 'Inlined Call Restore',
  description:
    'Writes a call where the decompiler printed the body of a helper the original called and VC8 inlined',
  version: '1.0.0',
  defaultEnabled: true,
  // First of all: the sites are matched against the callee's body as the decompiler
  // printed it, before any pass reshapes either.
  priority: 0.5,
  // Core: which callees are defined `static inline` is decided before any preset is
  // chosen, and a callee nothing calls would be dropped.
  tags: ['core', 'matching'],
  createTransformer: createInlinedCallRestoreTransformer,
};
