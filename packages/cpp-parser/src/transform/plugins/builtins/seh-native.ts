/**
 * SEH-Native Plugin
 *
 * `seh-lowering` turns a recovered MSVC `__try` into a `D2SehScope`: a real fs:[0]
 * registration GCC can build, since GCC has no `__try`. Under MSVC that runtime is
 * a stub and the block would run unprotected, while MSVC has the original
 * construct itself. This pass gives every lowered scope its native spelling beside
 * the lowering, chosen by the preprocessor:
 *
 *     // __try / __except (EXCEPTION_EXECUTE_HANDLER): scope table ...
 *     #if defined(_MSC_VER)
 *     __try {
 *       <try>
 *     } __except (1) {
 *     }
 *     #else
 *     D2SehScope __seh0{1};
 *     if (D2_SEH_SETJMP(__seh0) == 0) { __seh0.Enter(); <try> } else { }
 *     #endif
 *
 * and for a `__finally` scope (the lambda, the scope block, the normal-path call):
 *
 *     #if defined(_MSC_VER)
 *     __try { <try> } __finally { <block> }
 *     #else
 *     auto __finally0 = [&] { <block> };
 *     { D2SehScope __seh0{__finally0}; __seh0.Enter(); <try> }
 *     __finally0();
 *     #endif
 *
 * The GCC branch is the lowering exactly as it was. The native branch is the same
 * statements without the scope's own calls (`Enter`, the `D2_SEH_FENCE` compiler
 * fences, which a `__try` does not need), and `__finally` runs on the normal path
 * by itself, so the explicit call is the lowering's alone. It runs after every
 * pass that edits statements, so the two branches share settled statements.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, CompoundStmt, DeclStmt, ExprStmt, Expression, FunctionDecl, Identifier, IfStmt,
  Statement, VariableDecl, SehTryStmt, PpConditionalStmt, CallExpr, MemberExpr, BinaryExpr,
  InitListExpr, TypedefType,
} from '../../../ast/nodes.js';
import { Stmt } from '../../../ast/factory.js';
import { cloneNode, createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

/** The preprocessor condition the native branch is compiled under. */
export const SEH_NATIVE_CONDITION = 'defined(_MSC_VER)';

const FENCE = 'D2_SEH_FENCE';

function identName(e: ASTNode | null | undefined): string | undefined {
  if (!e) return undefined;
  if (e.kind === NodeKind.Identifier) return (e as Identifier).name;
  if (e.kind === NodeKind.ParenExpr) return identName((e as unknown as { expression: Expression }).expression);
  return undefined;
}

/** `D2SehScope NAME{init}` - the scope declaration; its name and initializer. */
function scopeDecl(s: Statement | undefined): { name: string; init: Expression } | undefined {
  if (!s || s.kind !== NodeKind.DeclStmt) return undefined;
  const d = s as DeclStmt;
  if (d.declarations.length !== 1 || d.declarations[0].kind !== NodeKind.VariableDecl) return undefined;
  const v = d.declarations[0] as VariableDecl;
  if (v.type.kind !== NodeKind.TypedefType || identName((v.type as TypedefType).name as ASTNode) !== 'D2SehScope') return undefined;
  const init = v.initializer as Expression | null | undefined;
  if (!init) return undefined;
  const elems = init.kind === NodeKind.InitListExpr ? (init as InitListExpr).elements : [init];
  if (elems.length !== 1) return undefined;
  return { name: v.name.name, init: elems[0] as Expression };
}

/** `NAME.Enter();` */
function isEnter(s: Statement | undefined, name: string): boolean {
  if (!s || s.kind !== NodeKind.ExprStmt) return false;
  const c = (s as ExprStmt).expression;
  if (c.kind !== NodeKind.CallExpr || (c as CallExpr).arguments.length !== 0) return false;
  const m = (c as CallExpr).callee;
  return m.kind === NodeKind.MemberExpr && !(m as MemberExpr).isArrow
    && identName((m as MemberExpr).object) === name && identName((m as MemberExpr).member as ASTNode) === 'Enter';
}

/** `CALLEE()` as a statement, for a bare callee name. */
function isBareCall(s: Statement | undefined, callee: string): boolean {
  if (!s || s.kind !== NodeKind.ExprStmt) return false;
  const c = (s as ExprStmt).expression;
  return c.kind === NodeKind.CallExpr && (c as CallExpr).arguments.length === 0 && identName((c as CallExpr).callee) === callee;
}

/** The statements, deep-copied, with every compiler fence removed at any depth. */
function withoutFences(stmts: Statement[]): Statement[] {
  const strip = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    const node = n as Record<string, unknown>;
    if (node.kind === NodeKind.CompoundStmt) {
      const c = node as unknown as CompoundStmt;
      c.statements = c.statements.filter(s => !isBareCall(s, FENCE));
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
      if (Array.isArray(v)) v.forEach(strip);
      else if (v && typeof v === 'object') strip(v);
    }
  };
  const copy = stmts.filter(s => !isBareCall(s, FENCE)).map(s => cloneNode(s));
  copy.forEach(strip);
  return copy;
}

function sehTry(at: ASTNode, body: Statement[], kind: 'except' | 'finally', filter: Expression | null, handler: Statement[]): SehTryStmt {
  return {
    kind: NodeKind.SehTryStmt, location: at.location, leadingTrivia: [], trailingTrivia: [],
    body: Stmt.compound(body), handlerKind: kind, filter, handler: Stmt.compound(handler),
  } as unknown as SehTryStmt;
}

/** Native in the `#if`, the lowering in the `#else`; the lowering's first comment goes above both. */
function conditional(native: Statement, lowered: Statement[]): PpConditionalStmt {
  const first = lowered[0];
  const lead = first.leadingTrivia ?? [];
  first.leadingTrivia = [];
  return {
    kind: NodeKind.PpConditionalStmt, location: first.location, leadingTrivia: lead, trailingTrivia: [],
    condition: SEH_NATIVE_CONDITION, thenStatements: [native], elseStatements: lowered,
  } as unknown as PpConditionalStmt;
}

/**
 * `D2SehScope S{f}; if (D2_SEH_SETJMP(S) == 0) { S.Enter(); <try> } else { }` at
 * `i`: the replacement, or undefined.
 */
function exceptAt(stmts: Statement[], i: number): Statement | undefined {
  const decl = scopeDecl(stmts[i]);
  const ifs = stmts[i + 1];
  if (!decl || decl.init.kind !== NodeKind.IntegerLiteral && decl.init.kind !== NodeKind.UnaryExpr) return undefined;
  if (!ifs || ifs.kind !== NodeKind.IfStmt) return undefined;
  const st = ifs as IfStmt;
  const cond = st.condition as Expression;
  if (cond.kind !== NodeKind.BinaryExpr || (cond as BinaryExpr).operator !== '==') return undefined;
  const setjmp = (cond as BinaryExpr).left;
  if (setjmp.kind !== NodeKind.CallExpr || identName((setjmp as CallExpr).callee) !== 'D2_SEH_SETJMP'
      || identName((setjmp as CallExpr).arguments[0]) !== decl.name) return undefined;
  if (st.thenBranch.kind !== NodeKind.CompoundStmt) return undefined;
  const body = (st.thenBranch as CompoundStmt).statements;
  if (!isEnter(body[0], decl.name)) return undefined;
  const handler = st.elseBranch && st.elseBranch.kind === NodeKind.CompoundStmt
    ? (st.elseBranch as CompoundStmt).statements : [];
  const native = sehTry(st, withoutFences(body.slice(1)), 'except', cloneNode(decl.init), withoutFences(handler));
  return conditional(native, [stmts[i], ifs]);
}

/**
 * `auto F = [&] { <block> }; { D2SehScope S{F}; S.Enter(); <try> } F();` at `i`:
 * the replacement, or undefined.
 */
function finallyAt(stmts: Statement[], i: number): Statement | undefined {
  const lam = stmts[i];
  const block = stmts[i + 1];
  const call = stmts[i + 2];
  if (!lam || lam.kind !== NodeKind.DeclStmt || !block || block.kind !== NodeKind.CompoundStmt) return undefined;
  const ld = (lam as DeclStmt).declarations;
  if (ld.length !== 1 || ld[0].kind !== NodeKind.VariableDecl) return undefined;
  const fv = ld[0] as VariableDecl;
  const init = fv.initializer as Expression | null | undefined;
  if (!init || init.kind !== NodeKind.LambdaExpr) return undefined;
  const fname = fv.name.name;
  const inner = (block as CompoundStmt).statements;
  const decl = scopeDecl(inner[0]);
  if (!decl || identName(decl.init) !== fname || !isEnter(inner[1], decl.name)) return undefined;
  if (!isBareCall(call, fname)) return undefined;
  const lambdaBody = (init as unknown as { body: CompoundStmt }).body;
  const native = sehTry(block, withoutFences(inner.slice(2)), 'finally', null, withoutFences(lambdaBody.statements));
  return conditional(native, [lam, block, call]);
}

function rewriteList(stmts: Statement[]): Statement[] | undefined {
  let changed = false;
  const out: Statement[] = [];
  for (let i = 0; i < stmts.length; i++) {
    const f = finallyAt(stmts, i);
    if (f) { out.push(f); i += 2; changed = true; continue; }
    const e = exceptAt(stmts, i);
    if (e) { out.push(e); i += 1; changed = true; continue; }
    out.push(stmts[i]);
  }
  return changed ? out : undefined;
}

export function createSehNativeTransformer(_options?: PluginOptions): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;
      let changed = false;
      const inner = createTransformer({
        visitCompoundStmt(c: CompoundStmt): ASTNode | undefined {
          const r = rewriteList(c.statements);
          if (!r) return undefined;
          changed = true;
          return { ...c, statements: r } as CompoundStmt;
        },
      });
      const body = inner(node.body);
      return changed ? { ...node, body } as FunctionDecl : undefined;
    },
  });
}

export const sehNativePlugin: TransformPlugin = {
  id: 'seh-native',
  name: 'SEH Native Spelling',
  description: 'Gives every D2SehScope lowering its native MSVC __try/__except/__finally beside it, under #if defined(_MSC_VER)',
  version: '1.0.0',
  defaultEnabled: true,
  // After every pass that edits statements (assert-order 987), so both branches
  // carry statements already settled; only the warning-comment strip (990) follows.
  priority: 989,
  tags: ['cleanup'],
  createTransformer: createSehNativeTransformer,
};
