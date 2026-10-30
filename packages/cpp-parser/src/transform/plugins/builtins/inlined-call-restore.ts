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
 *    call to a helper that happens to compute it. A `return E;` body of at least two
 *    operators on nothing else is taken only where the caller vouches for the site
 *    (`unanchored`): the codegen does where it is the one copy in the callee's unit;
 *  - the body has no top-level lvalue (a bare member, subscript or dereference),
 *    which an assignment could write through.
 *
 * A body of several statements, its locals declared first, is matched as a run of
 * consecutive statements in one block (`run`):
 *
 *  - `S1; ...; Sn; return L;` with L a local: the run `S1'; ...; Sn';` that assigns a
 *    site local x where the body assigns L becomes `x = F(args);`
 *    (DRLGROOMTILE_AllocTileLink, 0066e5e0, in DRLGROOMTILE_AddTileData);
 *  - `S1; ...; Sn; return E;`: the run followed by `return E';` becomes
 *    `return F(args);` (`fold` when E' is E with a constant argument VC8 folded in:
 *    ARENA_TestFlag, 0053f470, whose `(flags & nParam) != 0` reads
 *    `flags >> 9 & 1` in ARENA_IsFlag0x200Set). The constant is read off E', the two
 *    are proved to compute the same value for every input (inlined-call-fold.ts), and
 *    E' must have the shape VC8 gives the folded test: a 32-bit read shifted by under
 *    16 and masked with 1.
 *
 * In a run the body's locals bind to site locals of their type that nothing outside
 * the run names, so the call loses nothing the function reads; their declarations go
 * when no use is left. An argument there is a literal, an enum constant, or a local
 * or parameter the run does not write and nothing takes the address of: the callee
 * reads its parameters once, the inlined copy at each use.
 *
 * Where a value is an enum constant on one side and the same integer on the other
 * (PLAYERMSG_GetMessageType's `& 3` reads `& SERVERSTATUS_BAD_PARAMS` in
 * SCMD_0x0B_Keepalive) the two match, for a value small enough to be the same in an
 * enum of any width and sign: the tree emits each enum as a typedef of its integer
 * and each constant as a constexpr of it. An argument of an integer type that differs
 * from its parameter's only in sign is taken when every use of the parameter cannot
 * tell the two apart: an `==`/`!=` against another 32-bit value, or the value stored
 * through a 32-bit integer pointer. A store `*(int *)p = v` matches `*(uint *)p = v`
 * for the same reason.
 *
 * Callees arrive as options: the decompiled body as the pipeline would parse it,
 * plus the name a call to it is spelled with.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CallExpr, CharLiteralExpr, CompoundStmt, CStyleCastExpr, DeclStmt, Expression,
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
import {
  bitValue, convert, inputValue, intTypeOf, sameBits, singleInputBit, viaBool,
  type BitValue, type IntType,
} from './inlined-call-fold.js';

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
  /** Enum constant -> value. */
  enumValues?: Record<string, number>;
}

export interface InlinedCallRestoreOptions extends PluginOptions, InlinedCallTables {
  callees?: InlinedCallee[];
  /** Match callees whose body names nothing but its parameters and small constants too. */
  unanchored?: boolean;
  onSite?: (e: { line: number; callee: string; form: InlinedCallForm }) => void;
}

export type InlinedCallForm = 'expression' | 'subscript' | 'select' | 'run' | 'fold';

interface Pattern {
  callee: InlinedCallee;
  /**
   * Whether the body names something besides its parameters and small constants.
   * An expression of nothing else is taken only where the caller vouches for the
   * site, as the codegen does for one with a single site in its unit.
   */
  anchored: boolean;
  params: Array<{ name: string; type: TypeNode; neutral: boolean }>;
  returnType: TypeNode;
  /** `return E;` */
  expr?: Expression;
  /** `if (C) return A; return B;` - each arm without the pointer cast to the return type, if any. */
  select?: { cond: Expression; then: Expression; else: Expression; castArms: boolean };
  /** `S1; ...; Sn; return L;` or `S1; ...; Sn; return E;`. */
  run?: {
    stmts: Statement[];
    locals: Map<string, TypeNode>;
    tail: { result: string } | { value: Expression };
    /** The parameters the statements read; one the tail alone reads can be folded. */
    stmtParams: Set<string>;
  };
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

/** Whether the body names something besides its parameters, locals and small constants. */
function hasAnchor(nodes: ASTNode[], params: ReadonlySet<string>): boolean {
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

/** Whether an assignment, an increment or `&` writes or exposes the identifier `name` under `root`. */
function writesName(root: ASTNode, name: string): boolean {
  const isName = (e: Expression) => { const u = unwrapParens(e); return u.kind === NodeKind.Identifier && (u as Identifier).name === name; };
  for (const n of traverseAST(root)) {
    if (n.kind === NodeKind.AssignExpr && isName((n as AssignExpr).left)) return true;
    if (n.kind === NodeKind.UnaryExpr && ['&', '++', '--'].includes((n as UnaryExpr).operator) && isName((n as UnaryExpr).operand)) return true;
    if (n.kind === NodeKind.PostfixExpr && isName((n as unknown as { operand: Expression }).operand)) return true;
  }
  return false;
}

/** `*(T *)E` where T is an integer type: T, else undefined. */
function integerStoreType(e: Expression, resolve?: TypedefResolver): IntType | undefined {
  const u = unwrapParens(e);
  if (u.kind !== NodeKind.UnaryExpr || (u as UnaryExpr).operator !== '*') return undefined;
  const c = unwrapParens((u as UnaryExpr).operand);
  if (c.kind !== NodeKind.CStyleCastExpr) return undefined;
  const s = shapeOfNode((c as CStyleCastExpr).type, 0, resolve);
  if (!s || s.stars !== 1) return undefined;
  return intTypeOf({ ...s, stars: 0 }, resolve);
}

/**
 * Whether every use of parameter `name` reads it the same as a 32-bit integer of
 * either sign: an operand of `==`/`!=` whose other side is a literal or a 32-bit
 * integer parameter, or the value stored through a 32-bit integer pointer.
 */
function signNeutral(roots: ASTNode[], name: string, params: ReadonlyMap<string, TypeNode>): boolean {
  const thirtyTwo = (e: Expression): boolean => {
    const u = unwrapParens(e);
    if (u.kind === NodeKind.IntegerLiteral) return true;
    if (u.kind !== NodeKind.Identifier) return false;
    const t = params.get((u as Identifier).name);
    return !!t && intTypeOf(shapeOfNode(t))?.bits === 32;
  };
  const isName = (e: Expression) => { const u = unwrapParens(e); return u.kind === NodeKind.Identifier && (u as Identifier).name === name; };
  let ok = true;
  const visit = (n: ASTNode, allowed: boolean): void => {
    if (n.kind === NodeKind.Identifier && (n as Identifier).name === name && !allowed) ok = false;
    if (n.kind === NodeKind.ParenExpr) { visit((n as ParenExpr).expression, allowed); return; }
    if (n.kind === NodeKind.BinaryExpr && ['==', '!='].includes((n as BinaryExpr).operator)) {
      const b = n as BinaryExpr;
      visit(b.left, isName(b.left) && thirtyTwo(b.right));
      visit(b.right, isName(b.right) && thirtyTwo(b.left));
      return;
    }
    if (n.kind === NodeKind.AssignExpr && (n as AssignExpr).operator === '=') {
      const a = n as AssignExpr;
      visit(a.left, false);
      visit(a.right, isName(a.right) && integerStoreType(a.left)?.bits === 32);
      return;
    }
    for (const c of getChildren(n)) visit(c, false);
  };
  for (const r of roots) visit(r, false);
  return ok;
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

/** Statements a run may hold: no declaration, jump, label or loop. */
function plainStatement(s: Statement): boolean {
  switch (s.kind) {
    case NodeKind.ExprStmt:
    case NodeKind.NullStmt:
      return true;
    case NodeKind.CompoundStmt:
      return (s as CompoundStmt).statements.every(plainStatement);
    case NodeKind.IfStmt: {
      const i = s as IfStmt;
      return !i.init && plainStatement(i.thenBranch) && (!i.elseBranch || plainStatement(i.elseBranch));
    }
    default:
      return false;
  }
}

function compileRun(fn: FunctionDecl, pattern: Pattern, stmts: Statement[]): Pattern | null {
  const locals = new Map<string, TypeNode>();
  let k = 0;
  for (; k < stmts.length && stmts[k].kind === NodeKind.DeclStmt; k++) {
    for (const d of (stmts[k] as DeclStmt).declarations) {
      if (d.kind !== NodeKind.VariableDecl) return null;
      const v = d as VariableDecl;
      if (v.initializer || v.specifiers.length > 0) return null;
      locals.set(v.name.name, v.type);
    }
  }
  const body = stmts.slice(k, -1);
  const last = stmts[stmts.length - 1];
  if (body.length === 0 || !last || last.kind !== NodeKind.ReturnStmt || !(last as ReturnStmt).value) return null;
  if (!body.every(plainStatement)) return null;
  const value = (last as ReturnStmt).value!;
  const uv = unwrapParens(value);
  const resultLocal = uv.kind === NodeKind.Identifier && locals.has((uv as Identifier).name) ? (uv as Identifier).name : undefined;
  if (resultLocal) {
    // The call's value is the local's, unconverted.
    const a = shapeOfNode(locals.get(resultLocal)!), b = shapeOfNode(fn.returnType);
    if (!a || !b || !sameShape(a, b)) return null;
  }
  const roots: ASTNode[] = [...body, value];
  // A local is assigned before anything reads it, or the copy would read what the site held.
  const seen = new Set<string>();
  for (const r of roots) {
    for (const n of traverseAST(r)) {
      if (n.kind === NodeKind.AssignExpr && (n as AssignExpr).operator === '=') {
        const l = unwrapParens((n as AssignExpr).left);
        if (l.kind === NodeKind.Identifier && locals.has((l as Identifier).name)) seen.add((l as Identifier).name);
      }
      if (n.kind === NodeKind.Identifier && locals.has((n as Identifier).name) && !seen.has((n as Identifier).name)) return null;
    }
  }
  const names = new Set(pattern.params.map(p => p.name));
  const used = new Set<string>();
  for (const r of roots) for (const n of traverseAST(r)) if (n.kind === NodeKind.Identifier) used.add((n as Identifier).name);
  if (pattern.params.some(p => !used.has(p.name))) return null;
  if (pattern.params.some(p => roots.some(r => writesName(r, p.name)))) return null;
  if (!hasAnchor(roots, new Set([...names, ...locals.keys()]))) return null;
  const stmtParams = new Set<string>();
  for (const s of body) for (const n of traverseAST(s)) if (n.kind === NodeKind.Identifier && names.has((n as Identifier).name)) stmtParams.add((n as Identifier).name);
  pattern.run = { stmts: body, locals, tail: resultLocal ? { result: resultLocal } : { value }, stmtParams };
  return pattern;
}

function compileUncached(callee: InlinedCallee): Pattern | null {
  const fn = parseWrapped(callee.returnType, callee.params, callee.body);
  if (!fn?.body) return null;
  const params: Pattern['params'] = [];
  for (const p of fn.parameters) {
    const name = paramName(p);
    if (!name) return null;
    params.push({ name, type: (p as unknown as VariableDecl).type, neutral: false });
  }
  if (params.length === 0) return null;
  const names = new Set(params.map(p => p.name));
  const paramTypes = new Map(params.map(p => [p.name, p.type] as const));
  for (const n of traverseAST(fn.body)) if (n.kind === NodeKind.LabelStmt || n.kind === NodeKind.GotoStmt) return null;

  const stmts = realStatements(fn.body);
  const pattern: Pattern = { callee, params, returnType: fn.returnType, anchored: true };
  const neutral = (roots: ASTNode[]) => { for (const p of params) p.neutral = signNeutral(roots, p.name, paramTypes); };
  // Locals in a one-expression body would be names a site cannot bind; a run binds them.
  if (stmts.some(s => s.kind === NodeKind.DeclStmt)) {
    const run = compileRun(fn, pattern, stmts);
    if (run) neutral([fn.body]);
    return run;
  }
  if (stmts.length === 1 && stmts[0].kind === NodeKind.ReturnStmt) {
    const e = (stmts[0] as ReturnStmt).value;
    if (!e || isLvalueRoot(e) || unwrapParens(e).kind === NodeKind.CStyleCastExpr) return null;
    pattern.expr = e;
  } else if ((stmts.length === 2 || stmts.length === 1) && stmts[0].kind === NodeKind.IfStmt
    && returnValue((stmts[0] as IfStmt).thenBranch)) {
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
    const run = compileRun(fn, pattern, stmts);
    if (run) neutral([fn.body]);
    return run;
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
  if (!hasAnchor(roots, names)) {
    // `-(a != b) & 3` is an operation, `a + b` hardly one; never a lone operator.
    let operators = 0;
    for (const r of roots) for (const n of traverseAST(r)) if (n.kind === NodeKind.BinaryExpr || n.kind === NodeKind.UnaryExpr) operators++;
    if (!pattern.expr || operators < 2) return null;
    pattern.anchored = false;
  }
  neutral(roots);
  return pattern;
}

type Bindings = Map<string, Expression>;

/** What matching needs beyond the two trees. */
interface UnifyEnv {
  enumValues: Readonly<Record<string, number>>;
  resolve?: TypedefResolver;
}

const NO_ENV: UnifyEnv = { enumValues: {} };

/** Exact structural equality of two subtrees, parentheses aside. */
function same(a: ASTNode, b: ASTNode, env: UnifyEnv = NO_ENV): boolean {
  return unify(a, b, undefined, new Map(), env);
}

/**
 * An unsuffixed int literal's value, or an enum constant's small enough to be the
 * same in an enum of any width and sign (each is a constexpr of its typedef).
 */
function intConstant(e: ASTNode, env: UnifyEnv): bigint | undefined {
  if (e.kind === NodeKind.IntegerLiteral) {
    const l = e as IntegerLiteralExpr;
    return l.suffix === '' && l.value <= 0x7fffffffn ? l.value : undefined;
  }
  if (e.kind === NodeKind.Identifier) {
    const v = env.enumValues[(e as Identifier).name];
    return v !== undefined && v >= 0 && v <= 0x7f ? BigInt(v) : undefined;
  }
  return undefined;
}

/**
 * Whether `site` is `pat` with each parameter in `params` replaced by one expression
 * (recorded in `bound`). Node kinds this does not know never match.
 */
function unify(pat: ASTNode, site: ASTNode, params: ReadonlySet<string> | undefined, bound: Bindings, env: UnifyEnv): boolean {
  const p = isExpressionKind(pat) ? unwrapParens(pat as Expression) : pat;
  const s = isExpressionKind(site) ? unwrapParens(site as Expression) : site;
  if (p.kind === NodeKind.Identifier && params?.has((p as Identifier).name)) {
    const name = (p as Identifier).name;
    const prev = bound.get(name);
    if (prev) return same(prev, s, env);
    bound.set(name, s as Expression);
    return true;
  }
  if (p.kind !== s.kind) {
    // An enum constant is the integer it names.
    const a = intConstant(p, env), b = intConstant(s, env);
    return a !== undefined && a === b;
  }
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
      return a.operator === b.operator && unify(a.left, b.left, params, bound, env) && unify(a.right, b.right, params, bound, env);
    }
    case NodeKind.UnaryExpr: {
      const a = p as UnaryExpr, b = s as UnaryExpr;
      return a.operator === b.operator && unify(a.operand, b.operand, params, bound, env);
    }
    case NodeKind.MemberExpr: {
      const a = p as MemberExpr, b = s as MemberExpr;
      return a.isArrow === b.isArrow && emit(a.member) === emit(b.member) && unify(a.object, b.object, params, bound, env);
    }
    case NodeKind.SubscriptExpr: {
      const a = p as SubscriptExpr, b = s as SubscriptExpr;
      return unify(a.array, b.array, params, bound, env) && unify(a.index, b.index, params, bound, env);
    }
    case NodeKind.CStyleCastExpr: {
      const a = p as CStyleCastExpr, b = s as CStyleCastExpr;
      return typeSpelling(a.type) === typeSpelling(b.type) && unify(a.expression, b.expression, params, bound, env);
    }
    case NodeKind.CallExpr: {
      const a = p as CallExpr, b = s as CallExpr;
      if (a.arguments.length !== b.arguments.length || !unify(a.callee, b.callee, params, bound, env)) return false;
      return a.arguments.every((x, i) => unify(x, b.arguments[i], params, bound, env));
    }
    case NodeKind.ConditionalExpr: {
      const ca = getChildren(p), cb = getChildren(s);
      return ca.length === cb.length && ca.every((x, i) => unify(x, cb[i], params, bound, env));
    }
    case NodeKind.AssignExpr: {
      const a = p as AssignExpr, b = s as AssignExpr;
      if (a.operator !== b.operator) return false;
      // `*(int *)p = v` and `*(uint *)p = v` store the same four bytes: the decompiler
      // spells the store with the stored value's type.
      const ta = a.operator === '=' ? integerStoreType(a.left, env.resolve) : undefined;
      const tb = ta ? integerStoreType(b.left, env.resolve) : undefined;
      const left = ta && tb && ta.bits === tb.bits
        ? unify(((unwrapParens(a.left) as UnaryExpr).operand as CStyleCastExpr).expression,
          (unwrapParens((unwrapParens(b.left) as UnaryExpr).operand) as CStyleCastExpr).expression, params, bound, env)
        : unify(a.left, b.left, params, bound, env);
      return left && unify(a.right, b.right, params, bound, env);
    }
    case NodeKind.ExprStmt:
      return unify((p as ExprStmt).expression, (s as ExprStmt).expression, params, bound, env);
    case NodeKind.ReturnStmt: {
      const a = (p as ReturnStmt).value, b = (s as ReturnStmt).value;
      return !a || !b ? !a && !b : unify(a, b, params, bound, env);
    }
    case NodeKind.CompoundStmt: {
      const a = realStatements(p as CompoundStmt), b = realStatements(s as CompoundStmt);
      return a.length === b.length && a.every((x, i) => unify(x, b[i], params, bound, env));
    }
    case NodeKind.IfStmt: {
      const a = p as IfStmt, b = s as IfStmt;
      if (a.init || b.init || !unify(a.condition, b.condition, params, bound, env)) return false;
      if (!unify(a.thenBranch, b.thenBranch, params, bound, env)) return false;
      return !a.elseBranch || !b.elseBranch ? !a.elseBranch && !b.elseBranch : unify(a.elseBranch, b.elseBranch, params, bound, env);
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
function argumentsFor(pattern: Pattern, bound: Bindings, shapeOf: ExprShape, env: UnifyEnv): Expression[] | undefined {
  const args: Expression[] = [];
  for (const p of pattern.params) {
    const arg = bound.get(p.name);
    if (!arg) return undefined;
    const fx = effectsOf(arg);
    if (fx.calls > 0 || fx.writes > 0) return undefined;
    const want = shapeOfNode(p.type, 0, env.resolve);
    if (!want) return undefined;
    const lit = arg.kind === NodeKind.UnaryExpr && (arg as UnaryExpr).operator === '-' ? unwrapParens((arg as UnaryExpr).operand) : arg;
    if (lit.kind === NodeKind.IntegerLiteral || intConstant(lit, env) !== undefined) {
      if (!isIntegral(want)) return undefined;
    } else {
      const have = shapeOf(arg);
      if (!have) return undefined;
      if (!sameShape(have, want)) {
        // Of either sign, a 32-bit integer reads the same where the callee cannot tell.
        const a = intTypeOf(have, env.resolve), b = intTypeOf(want, env.resolve);
        if (!p.neutral || a?.bits !== 32 || b?.bits !== 32) return undefined;
      }
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

/** `e` with each bound name replaced by a copy of its binding. */
function substitute(e: Expression, bound: ReadonlyMap<string, Expression>): Expression {
  const u = e as unknown as ASTNode;
  if (u.kind === NodeKind.Identifier && bound.has((u as Identifier).name)) return Expr.paren(cloneNode(bound.get((u as Identifier).name)!));
  const copy = cloneNode(e);
  const rec = (n: ASTNode): void => {
    const o = n as unknown as Record<string, unknown>;
    const children = new Set(getChildren(n));
    for (const key of Object.keys(o)) {
      const v = o[key];
      const swap = (c: ASTNode): ASTNode => {
        if (c.kind === NodeKind.Identifier && bound.has((c as Identifier).name)) return Expr.paren(cloneNode(bound.get((c as Identifier).name)!));
        rec(c);
        return c;
      };
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) if (v[i] && typeof v[i] === 'object' && children.has(v[i] as ASTNode)) v[i] = swap(v[i] as ASTNode);
      } else if (v && typeof v === 'object' && children.has(v as ASTNode)) {
        o[key] = swap(v as ASTNode);
      }
    }
  };
  rec(copy as unknown as ASTNode);
  return copy;
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
  unanchored = false,
): { fn: FunctionDecl | undefined; sites: InlinedCallSite[] } {
  const sites: InlinedCallSite[] = [];
  if (!fn.body) return { fn: undefined, sites };
  const patterns = callees.map(compileInlinedCallee).filter((p): p is Pattern => p !== null && (p.anchored || unanchored));
  if (patterns.length === 0) return { fn: undefined, sites };

  const body = cloneNode(fn.body);
  const typedefTargets = tables.typedefTargets ?? {};
  const resolve: TypedefResolver = name => typedefTargets[name];
  const env: UnifyEnv = { enumValues: tables.enumValues ?? {}, resolve };
  const localTypes = new Map<string, TypeNode>();
  const paramNames = new Set<string>();
  for (const p of fn.parameters) {
    const n = paramName(p);
    if (n) { localTypes.set(n, (p as unknown as VariableDecl).type); paramNames.add(n); }
  }
  const declNames = new Set<ASTNode>();
  for (const n of traverseAST(body)) {
    if (n.kind === NodeKind.VariableDecl) {
      localTypes.set((n as VariableDecl).name.name, (n as VariableDecl).type);
      declNames.add((n as VariableDecl).name);
    }
  }
  const shapeOf = createExprShape(localTypes, {
    globalTypes: tables.globalTypes, structFields: tables.structFields, fieldTypes: tables.fieldTypes, resolve,
  });
  const line = (n: ASTNode): number => n.location?.start.line ?? 0;
  /** Uses of a name under `roots`, its declarations aside. */
  const usesOf = (roots: ASTNode[], name: string): number => {
    let k = 0;
    for (const r of roots) for (const n of traverseAST(r)) if (n.kind === NodeKind.Identifier && (n as Identifier).name === name && !declNames.has(n)) k++;
    return k;
  };
  /** Site locals whose last uses a run took. */
  const released = new Set<string>();
  const returnShape = shapeOfNode(fn.returnType, 0, resolve);

  const tryExpression = (e: Expression): Expression | undefined => {
    for (const pat of patterns) {
      if (!pat.expr) continue;
      const names = new Set(pat.params.map(p => p.name));
      let bound: Bindings = new Map();
      if (unify(pat.expr, e, names, bound, env)) {
        const args = argumentsFor(pat, bound, shapeOf, env);
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
        if (unify(b.left, s.array, names, bound, env) && unify(b.right, s.index, names, bound, env)) {
          const args = argumentsFor(pat, bound, shapeOf, env);
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
    if (target.kind !== NodeKind.Identifier || !same(target, ea.left, env)) return undefined;
    const targetType = localTypes.get((target as Identifier).name);
    if (!targetType) return undefined;
    for (const pat of patterns) {
      if (!pat.select) continue;
      const names = new Set(pat.params.map(p => p.name));
      const bound: Bindings = new Map();
      if (!unify(pat.select.cond, s.condition, names, bound, env)) continue;
      if (!unify(pat.select.then, ta.right, names, bound, env) || !unify(pat.select.else, ea.right, names, bound, env)) continue;
      const args = argumentsFor(pat, bound, shapeOf, env);
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

  /**
   * The constant `q` stands for where `site` is the tail `value` with `q` folded in,
   * proved by evaluating both: undefined when they are not provably the same value.
   */
  const foldedConstant = (pat: Pattern, value: Expression, site: Expression, q: Pattern['params'][number], bound: Bindings): bigint | undefined => {
    const siteRet = intTypeOf(returnShape, resolve);
    const calleeShape = shapeOfNode(pat.returnType, 0, resolve);
    const calleeBool = !!calleeShape && calleeShape.stars === 0 && calleeShape.base === 'bool';
    const calleeRet = calleeBool ? undefined : intTypeOf(calleeShape, resolve);
    const paramType = intTypeOf(shapeOfNode(q.type, 0, resolve), resolve);
    if (!siteRet || (!calleeBool && !calleeRet) || !paramType) return undefined;
    const leaves: Array<{ expr: Expression; type: IntType }> = [];
    const leaf = (e: Expression): BitValue | undefined => {
      const i = leaves.findIndex(l => same(l.expr, e, env));
      if (i >= 0) return inputValue(i * 64, leaves[i].type);
      const fx = effectsOf(e);
      if (fx.calls > 0 || fx.writes > 0) return undefined;
      const t = intTypeOf(shapeOf(e), resolve);
      if (!t) return undefined;
      leaves.push({ expr: e, type: t });
      return inputValue((leaves.length - 1) * 64, t);
    };
    const bitEnv = { leaf, enumValues: env.enumValues, resolve };
    const s = bitValue(site, bitEnv);
    if (!s) return undefined;
    const want = convert(s, siteRet);
    const bit = singleInputBit(want);
    if (bit === undefined) return undefined;
    // The same value is not enough: the site must be what VC8 makes of the call. It
    // tests one bit of a 32-bit read as `read >> k & 1`, and reads the upper half
    // directly once k reaches 16 (ARENA_IsNoCubeRecipes, 0053fd10, holds the 32-bit
    // read shifted by 0x10 and is not the call). A narrower read
    // (`(byte)(char)flags >> 2 & 1`, ARENA_GetClientUpdateFlag, 0053fca0) is not either.
    const k = bit % 64;
    const read = leaves[Math.floor(bit / 64)];
    if (k >= 16 || read.type.bits !== 32 || unwrapParens(read.expr).kind === NodeKind.CStyleCastExpr) return undefined;
    const top = unwrapParens(site);
    if (top.kind !== NodeKind.BinaryExpr || (top as BinaryExpr).operator !== '&') return undefined;
    const one = unwrapParens((top as BinaryExpr).right);
    if (one.kind !== NodeKind.IntegerLiteral || (one as IntegerLiteralExpr).value !== 1n) return undefined;
    const shifted = unwrapParens((top as BinaryExpr).left);
    const operand = k === 0 ? shifted
      : shifted.kind === NodeKind.BinaryExpr && (shifted as BinaryExpr).operator === '>>'
        && unwrapParens((shifted as BinaryExpr).right).kind === NodeKind.IntegerLiteral
        && (unwrapParens((shifted as BinaryExpr).right) as IntegerLiteralExpr).value === BigInt(k)
        ? (shifted as BinaryExpr).left : undefined;
    if (!operand || !same(operand, read.expr, env)) return undefined;
    const c = 1n << BigInt(k);
    if (c >= 1n << BigInt(paramType.bits - (paramType.signed ? 1 : 0))) return undefined;
    const withC = new Map(bound);
    withC.set(q.name, Expr.cast(cloneNode(q.type), Expr.intLiteral(c, 16)));
    const v = bitValue(substitute(value, withC), bitEnv);
    if (!v) return undefined;
    const got = calleeBool ? viaBool(v, { bits: 8, signed: false }) : convert(v, calleeRet!);
    if (!got || !sameBits(convert(got, siteRet), want)) return undefined;
    return c;
  };

  /**
   * A run of `block`'s statements from `i` that is a callee's body: the statements
   * that replace it and how many it replaces.
   */
  const tryRun = (block: Statement[], i: number): { replace: number; with: Statement } | undefined => {
    for (const pat of patterns) {
      const run = pat.run;
      if (!run) continue;
      const n = run.stmts.length;
      if (i + n > block.length) continue;
      const vars = new Set([...pat.params.map(p => p.name), ...run.locals.keys()]);
      const bound: Bindings = new Map();
      let ok = true;
      for (let k = 0; k < n && ok; k++) ok = unify(run.stmts[k], block[i + k], vars, bound, env);
      if (!ok) continue;
      let replace = n;
      let folded: { name: string; value: bigint } | undefined;
      let ret: ReturnStmt | undefined;
      if ('value' in run.tail) {
        const r = block[i + n];
        if (!r || r.kind !== NodeKind.ReturnStmt || !(r as ReturnStmt).value) continue;
        ret = r as ReturnStmt;
        replace = n + 1;
        const tailValue = run.tail.value;
        const tailBound = new Map(bound);
        if (unify(tailValue, ret.value!, vars, tailBound, env)) {
          for (const [k, v] of tailBound) bound.set(k, v);
        } else {
          // VC8 folded a constant argument into the tail.
          const open = pat.params.filter(p => !bound.has(p.name));
          if (open.length !== 1 || run.stmtParams.has(open[0].name)) continue;
          const tailVars = [...vars].filter(v => v !== open[0].name);
          if (tailVars.some(v => run.locals.has(v) && !bound.has(v) && usesOf([tailValue], v) > 0)) continue;
          const c = foldedConstant(pat, tailValue, ret.value!, open[0], bound);
          if (c === undefined) continue;
          folded = { name: open[0].name, value: c };
          bound.set(open[0].name, Expr.intLiteral(c, c >= 10n ? 16 : 10));
        }
      }
      // The body's locals: distinct site locals of their type that nothing outside the run names.
      const runNodes = block.slice(i, i + replace);
      const siteLocals = new Map<string, string>();
      for (const [local, type] of run.locals) {
        const b = bound.get(local);
        if (!b) continue;
        const u = unwrapParens(b);
        if (u.kind !== NodeKind.Identifier) { ok = false; break; }
        const name = (u as Identifier).name;
        const t = localTypes.get(name);
        const ts = t && shapeOfNode(t, 0, resolve), want = shapeOfNode(type, 0, resolve);
        if (paramNames.has(name) || !ts || !want || !sameShape(ts, want) || [...siteLocals.values()].includes(name)) { ok = false; break; }
        siteLocals.set(local, name);
      }
      if (!ok) continue;
      const result = 'result' in run.tail ? siteLocals.get(run.tail.result) : undefined;
      if ('result' in run.tail && !result) continue;
      for (const name of siteLocals.values()) {
        if (name !== result && usesOf([body], name) !== usesOf(runNodes, name)) { ok = false; break; }
      }
      if (!ok) continue;
      // Arguments the callee reads once: unchanged through the run.
      const argBound: Bindings = new Map(pat.params.map(p => [p.name, bound.get(p.name)!] as const).filter(([, v]) => v));
      for (const [, a] of argBound) {
        const u = unwrapParens(a);
        if (u.kind === NodeKind.IntegerLiteral || intConstant(u, env) !== undefined) continue;
        if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '-' && unwrapParens((u as UnaryExpr).operand).kind === NodeKind.IntegerLiteral) continue;
        if (u.kind !== NodeKind.Identifier || !localTypes.has((u as Identifier).name)) { ok = false; break; }
        const name = (u as Identifier).name;
        if ([...siteLocals.values()].includes(name) || runNodes.some(s => writesName(s, name)) || hasAddressTaken(body, name)) { ok = false; break; }
      }
      if (!ok) continue;
      const args = argumentsFor(pat, argBound, shapeOf, env);
      if (!args) continue;
      const call = callOf(pat, args);
      const stmt = ret
        ? Stmt.return_(call)
        : Stmt.expr(Expr.assign(Expr.identifier(result!), call));
      (stmt as { leadingTrivia: unknown }).leadingTrivia = block[i].leadingTrivia;
      // The call's code is the run's: it starts where the run's first statement did,
      // which is where the original's addresses for the line (branch-layout) put it.
      (stmt as { location: unknown }).location = block[i].location;
      (call as { location: unknown }).location = block[i].location;
      for (const name of siteLocals.values()) if (name !== result) released.add(name);
      sites.push({ callee: pat.callee.callName, line: line(block[i]), form: folded ? 'fold' : 'run' });
      return { replace, with: stmt };
    }
    return undefined;
  };

  // Rewrite in place on the clone, outermost match first; a rewritten subtree is not
  // searched again. Positions an assignment writes, an address is taken of, or an
  // increment changes are not values and are skipped.
  const walk = (node: ASTNode, lvalue: boolean): ASTNode => {
    if (node.kind === NodeKind.CompoundStmt) {
      const block = (node as CompoundStmt).statements;
      for (let i = 0; i < block.length; i++) {
        const r = tryRun(block, i);
        if (r) block.splice(i, r.replace, r.with);
      }
    }
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
  // A local whose every use went into a call is declared for nothing.
  if (released.size > 0) dropUnused(body, released, name => usesOf([body], name) === 0);
  return { fn: updateNode(fn, { body } as Partial<FunctionDecl>), sites };
}

function hasAddressTaken(root: ASTNode, name: string): boolean {
  for (const n of traverseAST(root)) {
    if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
      const o = unwrapParens((n as UnaryExpr).operand);
      if (o.kind === NodeKind.Identifier && (o as Identifier).name === name) return true;
    }
  }
  return false;
}

function dropUnused(body: CompoundStmt, names: ReadonlySet<string>, unused: (name: string) => boolean): void {
  for (const n of traverseAST(body)) {
    if (n.kind !== NodeKind.CompoundStmt) continue;
    const block = n as CompoundStmt;
    block.statements = block.statements.flatMap((s): Statement[] => {
      if ((s as ASTNode).kind !== NodeKind.DeclStmt) return [s];
      const d = s as unknown as DeclStmt;
      const keep = d.declarations.filter(v => v.kind !== NodeKind.VariableDecl
        || !names.has((v as VariableDecl).name.name) || (v as VariableDecl).initializer || !unused((v as VariableDecl).name.name));
      if (keep.length === d.declarations.length) return [s];
      return keep.length === 0 ? [] : [{ ...d, declarations: keep } as unknown as Statement];
    });
  }
}

function createInlinedCallRestoreTransformer(options: InlinedCallRestoreOptions = {}): Transformer {
  const callees = options.callees ?? [];
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (callees.length === 0) return undefined;
      const { fn, sites } = restoreInlinedCalls(node, callees, options, options.unanchored);
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
