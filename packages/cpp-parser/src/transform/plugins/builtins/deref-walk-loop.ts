/**
 * Deref Walk Loop Plugin
 *
 * A walk to the tail link of a list tests the link itself in the original. SERR_AddStormFacility
 * (0041c0f0) compares through the pointer on every round:
 *
 *   41c0f3  CMP dword ptr [gpErrorModuleList], 0
 *   41c104  MOV ESI, dword ptr [ESI]
 *   41c106  ADD ESI, 8
 *   41c109  CMP dword ptr [ESI], 0
 *   41c10c  JNZ 0x41c104
 *
 * The decompiler gives the link's value a variable of its own, loaded before the loop and
 * again at the end of each round:
 *
 *   ppTailLink = &gpErrorModuleList;
 *   pNewNode = gpErrorModuleList;
 *   while (pNewNode) {
 *     ppTailLink = &(*ppTailLink)->pNext;
 *     pNewNode = *ppTailLink;
 *   }
 *
 * which VC8 compiles to a load and a TEST of a register. The walk is written over the link:
 *
 *   ppTailLink = &gpErrorModuleList;
 *   while (*ppTailLink) {
 *     ppTailLink = &(*ppTailLink)->pNext;
 *   }
 *
 * Rewritten only when this is proven:
 *  - the loop is `while (p) { pp = &(*pp)->f; p = *pp; }`, p and pp distinct locals whose
 *    address is never taken, declared once;
 *  - the statement right before it stores `*pp` into p, or stores G into p right after a
 *    statement that stores `&G` into pp (the same spelling of G), so p equals *pp at every
 *    test of the condition;
 *  - p is dead after the loop: the function has no goto or label, and in the loop's block
 *    the first later statement naming p stores into it a value that does not name p, with
 *    no break, continue or goto before it. A block that ends without naming p again
 *    qualifies only as the function's own body.
 * The store before the loop goes (a declaration keeps its name, without the value).
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CompoundStmt, DeclStmt, ExprStmt, Expression, FunctionDecl, Identifier,
  ParameterDecl, Statement, UnaryExpr, VariableDecl, WhileStmt,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { Expr } from '../../../ast/factory.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface DerefWalkLoopOptions extends PluginOptions {}

function unwrap(e: Expression): Expression {
  let x = e;
  while (x.kind === NodeKind.ParenExpr) x = (x as unknown as { expression: Expression }).expression;
  return x;
}

function identName(e: Expression | null | undefined): string | null {
  if (!e) return null;
  const u = unwrap(e);
  return u.kind === NodeKind.Identifier ? (u as Identifier).name : null;
}

/** `*pp` with pp the named identifier. */
function isDeref(e: Expression, pp: string): boolean {
  const u = unwrap(e);
  return u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '*' && identName((u as UnaryExpr).operand) === pp;
}

/** The store of `s`: `x = v;` or `T x = v;` (one declarator), as name and value. */
function storeOf(s: Statement): { name: string; value: Expression } | null {
  if (s.kind === NodeKind.ExprStmt) {
    const e = unwrap((s as ExprStmt).expression);
    if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
    const name = identName((e as AssignExpr).left);
    return name ? { name, value: (e as AssignExpr).right } : null;
  }
  if (s.kind === NodeKind.DeclStmt) {
    const ds = s as DeclStmt;
    if (ds.declarations.length !== 1 || ds.declarations[0].kind !== NodeKind.VariableDecl) return null;
    const v = ds.declarations[0] as VariableDecl;
    if (!v.initializer || v.directInit || v.copyListInit || v.initializer.kind === NodeKind.InitListExpr) return null;
    return { name: v.name.name, value: v.initializer as Expression };
  }
  return null;
}

/** `pp = &(*pp)->f;`, as f; else null. */
function stepField(s: Statement, pp: string): string | null {
  const st = storeOf(s);
  if (!st || s.kind !== NodeKind.ExprStmt || st.name !== pp) return null;
  const v = unwrap(st.value);
  if (v.kind !== NodeKind.UnaryExpr || (v as UnaryExpr).operator !== '&') return null;
  const m = unwrap((v as UnaryExpr).operand);
  if (m.kind !== NodeKind.MemberExpr) return null;
  const me = m as unknown as { object: Expression; isArrow: boolean; member: Identifier };
  if (!me.isArrow || !isDeref(me.object, pp)) return null;
  return me.member?.name ?? null;
}

function names(n: ASTNode | null | undefined, v: string): boolean {
  if (!n) return false;
  for (const x of traverseAST(n)) if (x.kind === NodeKind.Identifier && (x as Identifier).name === v) return true;
  return false;
}

/** Locals and parameters declared exactly once whose address is never taken. */
function plainLocals(fn: FunctionDecl): Set<string> {
  const seen = new Map<string, number>();
  const add = (n: string) => seen.set(n, (seen.get(n) ?? 0) + 1);
  for (const p of fn.parameters as ParameterDecl[]) if (p.name) add(p.name.name);
  for (const x of traverseAST(fn.body!)) {
    if (x.kind !== NodeKind.DeclStmt) continue;
    for (const d of (x as DeclStmt).declarations) if (d.kind === NodeKind.VariableDecl) add((d as VariableDecl).name.name);
  }
  const addressed = new Set<string>();
  for (const x of traverseAST(fn.body!)) {
    if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '&') {
      const n = identName((x as UnaryExpr).operand);
      if (n) addressed.add(n);
    }
  }
  return new Set([...seen].filter(([n, c]) => c === 1 && !addressed.has(n)).map(([n]) => n));
}

function leavesSideways(s: Statement): boolean {
  for (const x of traverseAST(s)) {
    if (x.kind === NodeKind.BreakStmt || x.kind === NodeKind.ContinueStmt || x.kind === NodeKind.GotoStmt) return true;
  }
  return false;
}

/** p's value after `stmts[from - 1]` is never read: overwritten first, or the function ends. */
function deadAfter(stmts: Statement[], from: number, p: string, functionBody: boolean): boolean {
  for (let k = from; k < stmts.length; k++) {
    const s = stmts[k];
    if (!names(s, p)) {
      if (leavesSideways(s)) return false;
      continue;
    }
    const st = storeOf(s);
    return !!st && s.kind === NodeKind.ExprStmt && st.name === p && !names(st.value, p);
  }
  return functionBody;
}

function rewriteBlock(block: CompoundStmt, locals: Set<string>, functionBody: boolean): CompoundStmt | null {
  const stmts = block.statements;
  for (let i = 1; i < stmts.length; i++) {
    const w = stmts[i];
    if (w.kind !== NodeKind.WhileStmt) continue;
    const loop = w as WhileStmt;
    const p = identName(loop.condition as Expression);
    if (!p || !locals.has(p) || loop.body.kind !== NodeKind.CompoundStmt) continue;
    const body = (loop.body as CompoundStmt).statements;
    if (body.length !== 2) continue;
    const first = storeOf(body[0]);
    if (!first || !locals.has(first.name) || first.name === p) continue;
    const pp = first.name;
    if (!stepField(body[0], pp)) continue;
    const reload = storeOf(body[1]);
    if (!reload || body[1].kind !== NodeKind.ExprStmt || reload.name !== p || !isDeref(reload.value, pp)) continue;
    // p equals *pp before the first test.
    const init = storeOf(stmts[i - 1]);
    if (!init || init.name !== p) continue;
    let holds = isDeref(init.value, pp);
    if (!holds && i >= 2) {
      const link = storeOf(stmts[i - 2]);
      const lv = link && link.name === pp ? unwrap(link.value) : null;
      holds = !!lv && lv.kind === NodeKind.UnaryExpr && (lv as UnaryExpr).operator === '&'
        && emit(unwrap((lv as UnaryExpr).operand)) === emit(unwrap(init.value));
    }
    if (!holds || !deadAfter(stmts, i + 1, p, functionBody)) continue;

    const deref = Expr.unary('*', Expr.identifier(pp));
    const newLoop = updateNode(loop, {
      condition: deref,
      body: updateNode(loop.body as CompoundStmt, { statements: [body[0]] } as Partial<CompoundStmt>),
    } as Partial<WhileStmt>);
    const before = stmts[i - 1];
    let initReplacement: Statement[] = [];
    if (before.kind === NodeKind.DeclStmt) {
      const ds = before as DeclStmt;
      const v = ds.declarations[0] as VariableDecl;
      initReplacement = [updateNode(ds, { declarations: [updateNode(v, { initializer: undefined } as Partial<VariableDecl>)] } as Partial<DeclStmt>)];
    }
    const out = [...stmts.slice(0, i - 1), ...initReplacement, newLoop, ...stmts.slice(i + 1)];
    return updateNode(block, { statements: out } as Partial<CompoundStmt>);
  }
  return null;
}

function rewriteFunction(fn: FunctionDecl): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  for (const x of traverseAST(fn.body)) {
    if (x.kind === NodeKind.GotoStmt || x.kind === NodeKind.LabelStmt) return undefined;
  }
  const locals = plainLocals(fn);
  let changed = false;
  const visit = (n: ASTNode, functionBody: boolean): ASTNode => {
    let node = n;
    if (node.kind === NodeKind.CompoundStmt) {
      const block = node as CompoundStmt;
      const kids = block.statements.map(s => visit(s, false) as Statement);
      let cur = kids.some((k, i) => k !== block.statements[i]) ? updateNode(block, { statements: kids } as Partial<CompoundStmt>) : block;
      for (let r = rewriteBlock(cur, locals, functionBody); r; r = rewriteBlock(cur, locals, functionBody)) { cur = r; changed = true; }
      return cur;
    }
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'location') continue;
      if (v && typeof v === 'object' && 'kind' in (v as object) && isStmt(v as ASTNode)) {
        const nv = visit(v as ASTNode, false);
        if (nv !== v) patch[k] = nv;
      }
    }
    if (Object.keys(patch).length) node = updateNode(node, patch as Partial<ASTNode>);
    return node;
  };
  const body = visit(fn.body, true) as CompoundStmt;
  return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
}

function isStmt(n: ASTNode): boolean {
  switch (n.kind) {
    case NodeKind.CompoundStmt: case NodeKind.IfStmt: case NodeKind.WhileStmt: case NodeKind.DoWhileStmt:
    case NodeKind.ForStmt: case NodeKind.SwitchStmt: case NodeKind.CaseStmt: case NodeKind.DefaultStmt:
    case NodeKind.LabelStmt:
      return true;
    default:
      return false;
  }
}

function createDerefWalkLoopTransformer(_options: DerefWalkLoopOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node);
    },
  });
}

export const derefWalkLoopPlugin: TransformPlugin = {
  id: 'deref-walk-loop',
  name: 'Deref Walk Loop',
  description: 'A walk to a list\'s tail link tests the link through the pointer, not a copy of it reloaded each round',
  version: '1.0.0',
  defaultEnabled: true,
  // After loop-copy-sink (62.7), on the loop's final statements; after copy-coalesce (62.75), before shift-def (62.8).
  priority: 62.77,
  tags: ['matching'],
  createTransformer: createDerefWalkLoopTransformer,
};

export { createDerefWalkLoopTransformer };
