/**
 * New Result Temp Plugin
 *
 * Storm's list allocators construct a node in freshly allocated memory and keep NULL when
 * the allocation fails. SSYSTEM_ListAllocNode (0041c840) prints
 *
 *     int** pNode = SMemAlloc(nDataSize + 0xc, ...);
 *     if (pNode) { *pNode = 0; pNode[1] = 0; } else { pNode = 0; }
 *
 * The original holds the allocation in one register and the result in another (`mov esi,eax`
 * after the stores; `xor esi,esi` on the null path): the source was a placement-new, whose
 * result is a value of its own, `p = t ? (construct t, t) : 0`. Written with one variable,
 * VC8 keeps one register. So the allocation goes to a temporary and the result is assigned
 * at the end of the constructing arm:
 *
 *     int** pNodeNew = SMemAlloc(...);
 *     int** pNode;
 *     if (pNodeNew) { *pNodeNew = 0; pNodeNew[1] = 0; pNode = pNodeNew; } else { pNode = 0; }
 *
 * Made only when
 *   - p is a local, declared once with a single pointer type, never addressed;
 *   - the initialiser (or the assignment `p = E;` right before the if) is a call, possibly
 *     cast, that does not name p;
 *   - the if tests p against null and nothing else; one arm is exactly `p = 0;` and the other
 *     is only stores through p (`*p = v`, `p[i] = v`, `p->f = v`), none of which names p
 *     anywhere but as the root of its target.
 * Then every store writes through t the address p held, p ends each arm with the value it
 * had, and t is a fresh name nothing reads after the if: the value is the same.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CompoundStmt, CStyleCastExpr, DeclStmt, Expression, ExprStmt, FunctionDecl,
  Identifier, IfStmt, MemberExpr, ParameterDecl, Statement, SubscriptExpr, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { Decl, Stmt, Expr } from '../../../ast/factory.js';
import { createTransformer, updateNode, cloneNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { nullTest } from './null-getter.js';

export type NewResultTempOptions = PluginOptions;

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as unknown as { expression: Expression }).expression;
  return e;
}

function names(n: ASTNode, name: string): boolean {
  for (const x of traverseAST(n)) if (x.kind === NodeKind.Identifier && (x as Identifier).name === name) return true;
  return false;
}

function isNull(e: Expression): boolean {
  let x = unwrap(e);
  while (x.kind === NodeKind.CStyleCastExpr) x = unwrap((x as CStyleCastExpr).expression);
  if (x.kind === NodeKind.NullptrLiteral) return true;
  if (x.kind === NodeKind.IntegerLiteral) return (x as { value: bigint }).value === 0n;
  return x.kind === NodeKind.Identifier && (x as Identifier).name === 'NULL';
}

function isCall(e: Expression): boolean {
  let x = unwrap(e);
  while (x.kind === NodeKind.CStyleCastExpr) x = unwrap((x as CStyleCastExpr).expression);
  return x.kind === NodeKind.CallExpr;
}

function body(s: Statement | null): Statement[] | null {
  if (!s) return null;
  return s.kind === NodeKind.CompoundStmt ? (s as CompoundStmt).statements : [s];
}

function assignOf(s: Statement): AssignExpr | null {
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = unwrap((s as ExprStmt).expression);
  return e.kind === NodeKind.AssignExpr ? e as AssignExpr : null;
}

/** `p = 0;` */
function nullsP(s: Statement, p: string): boolean {
  const a = assignOf(s);
  if (!a || a.operator !== '=') return false;
  const l = unwrap(a.left);
  return l.kind === NodeKind.Identifier && (l as Identifier).name === p && isNull(a.right);
}

/** The target's root when it stores through p: `*p`, `p[i]`, `p->f`, and members of those. */
function storesThrough(target: Expression, p: string): boolean {
  let x = unwrap(target);
  let through = false;
  for (;;) {
    if (x.kind === NodeKind.MemberExpr) {
      const m = x as MemberExpr;
      if (m.isArrow) through = true;
      x = unwrap(m.object);
    } else if (x.kind === NodeKind.SubscriptExpr) {
      const s = x as SubscriptExpr;
      if (names(s.index, p)) return false;
      through = true;
      x = unwrap(s.array);
    } else if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '*') {
      through = true;
      x = unwrap((x as UnaryExpr).operand);
    } else break;
  }
  return through && x.kind === NodeKind.Identifier && (x as Identifier).name === p;
}

/** A store's target with its root `from` renamed `to` (members and indices left alone). */
function renameRoot(target: Expression, from: string, to: string): Expression {
  const x = target;
  switch (x.kind) {
    case NodeKind.ParenExpr:
      return updateNode(x, { expression: renameRoot((x as unknown as { expression: Expression }).expression, from, to) } as Partial<Expression>);
    case NodeKind.MemberExpr:
      return updateNode(x as MemberExpr, { object: renameRoot((x as MemberExpr).object, from, to) } as Partial<MemberExpr>);
    case NodeKind.SubscriptExpr:
      return updateNode(x as SubscriptExpr, { array: renameRoot((x as SubscriptExpr).array, from, to) } as Partial<SubscriptExpr>);
    case NodeKind.UnaryExpr:
      return updateNode(x as UnaryExpr, { operand: renameRoot((x as UnaryExpr).operand, from, to) } as Partial<UnaryExpr>);
    case NodeKind.Identifier:
      return (x as Identifier).name === from ? { ...(x as Identifier), name: to } : x;
    default:
      return x;
  }
}

/** The null test with p renamed: `p`, `!p`, `p == 0`, `p != 0`. */
function renameTest(cond: Expression, from: string, to: string): Expression {
  const x = cond;
  switch (x.kind) {
    case NodeKind.ParenExpr:
      return updateNode(x, { expression: renameTest((x as unknown as { expression: Expression }).expression, from, to) } as Partial<Expression>);
    case NodeKind.UnaryExpr:
      return updateNode(x as UnaryExpr, { operand: renameTest((x as UnaryExpr).operand, from, to) } as Partial<UnaryExpr>);
    case NodeKind.BinaryExpr:
      return updateNode(x, { left: renameTest((x as unknown as { left: Expression }).left, from, to) } as Partial<Expression>);
    case NodeKind.Identifier:
      return (x as Identifier).name === from ? { ...(x as Identifier), name: to } : x;
    default:
      return x;
  }
}

function freshName(fn: FunctionDecl, base: string): string {
  const used = new Set<string>();
  for (const x of traverseAST(fn)) if (x.kind === NodeKind.Identifier) used.add((x as Identifier).name);
  let n = `${base}New`;
  for (let k = 2; used.has(n); k++) n = `${base}New${k}`;
  return n;
}

interface Local { decl: VariableDecl; stmt: DeclStmt }

/** The single declaration of each local of `fn`, by name; a name declared twice, or a parameter, is absent. */
function localsOf(fn: FunctionDecl): Map<string, Local> {
  const out = new Map<string, Local>();
  const twice = new Set<string>();
  for (const p of fn.parameters as ParameterDecl[]) if (p.name) twice.add(p.name.name);
  for (const x of traverseAST(fn.body!)) {
    if (x.kind !== NodeKind.DeclStmt) continue;
    for (const d of (x as DeclStmt).declarations) {
      if (d.kind !== NodeKind.VariableDecl) continue;
      const v = d as VariableDecl;
      if (out.has(v.name.name)) twice.add(v.name.name);
      out.set(v.name.name, { decl: v, stmt: x as DeclStmt });
    }
  }
  for (const n of twice) out.delete(n);
  return out;
}

function pointerType(t: TypeNode): boolean {
  let x = t;
  while (x.kind === NodeKind.QualifiedType) x = (x as unknown as { type: TypeNode }).type;
  return x.kind === NodeKind.PointerType;
}

function addressed(fn: FunctionDecl, p: string): boolean {
  for (const x of traverseAST(fn.body!)) {
    if (x.kind !== NodeKind.UnaryExpr || (x as UnaryExpr).operator !== '&') continue;
    const o = unwrap((x as UnaryExpr).operand);
    if (o.kind === NodeKind.Identifier && (o as Identifier).name === p) return true;
  }
  return false;
}

/** The rewritten statement list, or null when no site in it fits. */
function rewriteList(list: Statement[], fn: FunctionDecl, locals: Map<string, Local>): Statement[] | null {
  let changed = false;
  const out: Statement[] = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const next = list[i + 1];
    const site = next && next.kind === NodeKind.IfStmt ? siteAt(s, next as IfStmt, fn, locals) : null;
    if (!site) { out.push(s); continue; }
    out.push(...site);
    i++;
    changed = true;
  }
  return changed ? out : null;
}

/** `T* p = E; if (p) S else p = 0;` (or `p = E;` with p declared elsewhere) rewritten; null when it does not fit. */
function siteAt(first: Statement, ifs: IfStmt, fn: FunctionDecl, locals: Map<string, Local>): Statement[] | null {
  let p: string;
  let init: Expression;
  let declared: boolean;
  if (first.kind === NodeKind.DeclStmt) {
    const ds = first as DeclStmt;
    if (ds.declarations.length !== 1 || ds.declarations[0].kind !== NodeKind.VariableDecl) return null;
    const v = ds.declarations[0] as VariableDecl;
    if (!v.initializer || v.initializer.kind === NodeKind.InitListExpr || v.directInit || v.specifiers.length) return null;
    p = v.name.name;
    init = v.initializer as Expression;
    declared = true;
  } else {
    const a = assignOf(first);
    if (!a || a.operator !== '=') return null;
    const l = unwrap(a.left);
    if (l.kind !== NodeKind.Identifier) return null;
    p = (l as Identifier).name;
    init = a.right;
    declared = false;
  }
  const local = locals.get(p);
  if (!local || !pointerType(local.decl.type)) return null;
  if (!isCall(init) || names(init, p) || addressed(fn, p)) return null;
  if (ifs.init) return null;
  const t = nullTest(ifs.condition);
  if (!t || t.p.name !== p) return null;
  const thenList = body(ifs.thenBranch), elseList = body(ifs.elseBranch);
  if (!thenList || !elseList) return null;
  const [nullArm, buildArm] = t.nullWhenTrue ? [thenList, elseList] : [elseList, thenList];
  if (nullArm.length !== 1 || !nullsP(nullArm[0], p) || buildArm.length === 0) return null;
  for (const st of buildArm) {
    const a = assignOf(st);
    if (!a || !storesThrough(a.left, p) || names(a.right, p)) return null;
  }

  const tmp = freshName(fn, p);
  const tmpDecl = Decl.variable(tmp, cloneNode(local.decl.type) as TypeNode, cloneNode(init) as Expression);
  const lead = first.leadingTrivia;
  const tmpStmt = { ...Stmt.declStmt([tmpDecl]), leadingTrivia: lead } as Statement;
  const pDecl = declared
    ? [Stmt.declStmt([updateNode(local.decl, { initializer: null } as Partial<VariableDecl>)]) as Statement]
    : [];
  const built = [
    ...buildArm.map(st => {
      const a = assignOf(st)!;
      const e = (st as ExprStmt).expression;
      const moved = updateNode(a, { left: renameRoot(a.left, p, tmp) } as Partial<AssignExpr>);
      return updateNode(st as ExprStmt, { expression: e === a ? moved : updateNode(e, { expression: moved } as Partial<Expression>) } as Partial<ExprStmt>);
    }),
    Stmt.expr(Expr.assign(Expr.identifier(p), Expr.identifier(tmp))),
  ];
  const wrap = (orig: Statement | null, stmts: Statement[]): Statement =>
    orig && orig.kind === NodeKind.CompoundStmt ? updateNode(orig as CompoundStmt, { statements: stmts } as Partial<CompoundStmt>) : Stmt.compound(stmts);
  const cond = renameTest(ifs.condition, p, tmp);
  const rewritten = t.nullWhenTrue
    ? updateNode(ifs, { condition: cond, elseBranch: wrap(ifs.elseBranch, built) } as Partial<IfStmt>)
    : updateNode(ifs, { condition: cond, thenBranch: wrap(ifs.thenBranch, built) } as Partial<IfStmt>);
  return [tmpStmt, ...pDecl, rewritten];
}

function rewriteFunction(fn: FunctionDecl): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  const locals = localsOf(fn);
  if (locals.size === 0) return undefined;
  let changed = false;
  const visit = createTransformer({
    visitCompoundStmt(c: CompoundStmt): ASTNode | undefined {
      const out = rewriteList(c.statements, fn, locals);
      if (!out) return undefined;
      changed = true;
      return updateNode(c, { statements: out } as Partial<CompoundStmt>);
    },
  });
  const body = visit(fn.body) as CompoundStmt;
  return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
}

function createNewResultTempTransformer(_options: NewResultTempOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node);
    },
  });
}

export const newResultTempPlugin: TransformPlugin = {
  id: 'new-result-temp',
  name: 'New Result Temp',
  description: 'An allocation constructed in place and kept null on failure: the allocation in a temporary, the result assigned after construction',
  version: '1.0.0',
  defaultEnabled: true,
  // After decl-init-merge (60) and decl-scope-sink (62) have joined the declaration with
  // the allocation, beside field-pointer-fold (62.5).
  priority: 62.6,
  tags: ['matching'],
  createTransformer: createNewResultTempTransformer,
};

export { createNewResultTempTransformer };
