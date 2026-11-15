/**
 * Link Retest For Plugin
 *
 * The walk to a list's last node written `for (; p && p->next; p = p->next) BODY` compiles
 * under VC8 to a loop rotated with its whole test at the bottom: the link is loaded and
 * tested, then copied into p and p tested again (`mov ecx, [eax+4]; test ecx, ecx; je out;
 * mov eax, ecx; test eax, eax; jne top`), though p is known non-null there. The decompiler
 * folds the copy and prints either of
 *
 *     do { n = p->next; if (!n) break; p = n; } while (n);        (WALL2_InsertUnitDraw 004dd600)
 *     while (p && (p = p->next)) BODY                              (D2WINTEXTBOX_GetLastLineIndex 004fbd20)
 *
 * and VC8, compiling those, tests the link once a turn and jumps back. Where the original's
 * facts show the second test:
 *   - the do-while: the break test and the loop's own test are TESTs of two different
 *     registers (the link, then the copy), branchLayout `tests` of the two lines;
 *   - the while: the code after the loop is a return copy the loop's bottom falls into while
 *     the loop's own conditional jump lands on it too, so the loop ends on a conditional jump;
 * the loop is written as the for above.
 *
 * Value-preserving. The do-while ends on the last node with n null; the for ends on the same
 * node (p is non-null on entry: the do-while read p->next unconditionally). The while ends
 * with p null, the for on the last node, so p must not be read after the loop before it is
 * written again; the for counts the same turns (one per node after the first). n is dropped
 * with its declaration and must be named nowhere else; BODY must not name n or write p.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, BreakStmt, CompoundStmt, DeclStmt, DoWhileStmt, Expression, ExprStmt, FunctionDecl,
  Identifier, IfStmt, MemberExpr, ParenExpr, ReturnStmt, Statement, UnaryExpr, VariableDecl, WhileStmt,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { Expr, Stmt } from '../../../ast/factory.js';
import { createTransformer, cloneNode, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { sameExpr } from './rotated-for-loop.js';
import type { BranchLayoutEvidence } from './branch-layout/evidence.js';

export interface LinkRetestForOptions extends PluginOptions {
  branchLayout?: BranchLayoutEvidence | null;
  onSite?: (e: { line: number; form: 'do' | 'while'; pointer: string }) => void;
}

const unparen = (e: Expression): Expression => {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
};

/** A non-null test of a plain name (`x`, `x != 0`): the name, else null. */
function truthOf(e: Expression): string | null {
  const u = unparen(e);
  if (u.kind === NodeKind.Identifier) return (u as Identifier).name;
  if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '!=') {
    const b = u as BinaryExpr, r = unparen(b.right);
    const zero = r.kind === NodeKind.NullptrLiteral || (r.kind === NodeKind.IntegerLiteral && BigInt((r as unknown as { value: bigint }).value) === 0n);
    if (zero && unparen(b.left).kind === NodeKind.Identifier) return (unparen(b.left) as Identifier).name;
  }
  return null;
}

/** `!x` / `x == 0`: x, else null. */
function falsityOf(e: Expression): string | null {
  const u = unparen(e);
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') {
    const o = unparen((u as UnaryExpr).operand);
    return o.kind === NodeKind.Identifier ? (o as Identifier).name : null;
  }
  if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '==') {
    const b = u as BinaryExpr, r = unparen(b.right);
    const zero = r.kind === NodeKind.NullptrLiteral || (r.kind === NodeKind.IntegerLiteral && BigInt((r as unknown as { value: bigint }).value) === 0n);
    if (zero && unparen(b.left).kind === NodeKind.Identifier) return (unparen(b.left) as Identifier).name;
  }
  return null;
}

/** `x = e;`: the pair, else null. */
function storeOf(s: Statement): { x: string; e: Expression } | null {
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = unparen((s as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
  const l = unparen((e as AssignExpr).left);
  return l.kind === NodeKind.Identifier ? { x: (l as Identifier).name, e: (e as AssignExpr).right } : null;
}

/** `p->f` with p the given name: true. */
function linkOf(e: Expression, p: string): boolean {
  const u = unparen(e);
  if (u.kind !== NodeKind.MemberExpr || !(u as MemberExpr).isArrow) return false;
  const o = unparen((u as MemberExpr).object);
  return o.kind === NodeKind.Identifier && (o as Identifier).name === p;
}

function bodyOf(s: Statement): Statement[] {
  return s.kind === NodeKind.CompoundStmt ? [...(s as CompoundStmt).statements] : [s];
}

function names(roots: readonly ASTNode[], name: string): number {
  let n = 0;
  for (const r of roots) for (const x of traverseAST(r)) if (x.kind === NodeKind.Identifier && (x as Identifier).name === name) n++;
  return n;
}

function writes(roots: readonly ASTNode[], name: string): boolean {
  for (const r of roots) {
    for (const x of traverseAST(r)) {
      if (x.kind === NodeKind.AssignExpr) {
        const l = unparen((x as AssignExpr).left);
        if (l.kind === NodeKind.Identifier && (l as Identifier).name === name) return true;
      }
      if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '&') {
        const o = unparen((x as UnaryExpr).operand);
        if (o.kind === NodeKind.Identifier && (o as Identifier).name === name) return true;
      }
    }
  }
  return false;
}

function holdsJumpOrLabel(roots: readonly ASTNode[]): boolean {
  for (const r of roots) for (const x of traverseAST(r)) {
    if (x.kind === NodeKind.GotoStmt || x.kind === NodeKind.LabelStmt || x.kind === NodeKind.BreakStmt
      || x.kind === NodeKind.ContinueStmt || x.kind === NodeKind.ReturnStmt) return true;
  }
  return false;
}

/** `for (; p && p->f; p = p->f) body`. */
function retestFor(p: string, link: Expression, body: Statement[], at: Statement): Statement {
  const cond = Expr.binary(Expr.identifier(p), '&&', cloneNode(link) as Expression);
  const step = Expr.assign(Expr.identifier(p), cloneNode(link) as Expression);
  const f = Stmt.for_(null, cond, step, Stmt.compound(body));
  return { ...f, location: at.location, leadingTrivia: at.leadingTrivia } as Statement;
}

/**
 * `p` is not read after the statement at `i` before a store to it, in the rest of the
 * list: the first statement after it naming p must be a plain store `p = e` with e not
 * naming p. Statements of enclosing blocks are not looked at: only a list ending in a
 * return (or the function body) is accepted.
 */
function deadAfter(list: readonly Statement[], i: number, p: string, isBody: boolean): boolean {
  const after = list.slice(i + 1);
  for (const s of after) {
    if (names([s], p) === 0) continue;
    const st = storeOf(s);
    return !!st && st.x === p && names([st.e], p) === 0;
  }
  return isBody || (after.length > 0 && after[after.length - 1].kind === NodeKind.ReturnStmt);
}

function rewriteList(list: Statement[], ev: BranchLayoutEvidence, fnBody: CompoundStmt, isBody: boolean,
  opts: LinkRetestForOptions, drop: Set<string>): Statement[] | null {
  let changed = false;
  const out = [...list];
  for (let i = 0; i < out.length; i++) {
    const s = out[i];
    if (s.kind === NodeKind.DoWhileStmt) {
      // do { n = p->f; if (!n) break; p = n; } while (n);
      const d = s as DoWhileStmt;
      const b = bodyOf(d.body);
      if (b.length !== 3) continue;
      const s0 = storeOf(b[0]);
      if (!s0) continue;
      const n = s0.x;
      const g = b[1];
      if (g.kind !== NodeKind.IfStmt || (g as IfStmt).elseBranch || falsityOf((g as IfStmt).condition) !== n) continue;
      const gb = bodyOf((g as IfStmt).thenBranch);
      if (gb.length !== 1 || gb[0].kind !== NodeKind.BreakStmt) continue;
      const s2 = storeOf(b[2]);
      if (!s2 || unparen(s2.e).kind !== NodeKind.Identifier || (unparen(s2.e) as Identifier).name !== n) continue;
      const p = s2.x;
      if (p === n || !linkOf(s0.e, p) || truthOf(d.condition) !== n) continue;
      // n is named only here and in a bare declaration.
      const total = names([fnBody], n);
      if (total !== 4 + declCount(fnBody, n)) continue;
      // The facts: the break test and the loop's test are TESTs of two registers.
      const tb = ev.tests?.get(g.location?.start.line ?? -1);
      const tl = ev.tests?.get(d.condition.location?.start.line ?? -1);
      if (!tb || !tl || tb.length !== 1 || tl.length !== 1) continue;
      if (tb[0].mnemonic !== 'TEST' || tl[0].mnemonic !== 'TEST' || tb[0].reg === '-' || tl[0].reg === '-' || tb[0].reg === tl[0].reg) continue;
      out[i] = retestFor(p, s0.e, [], s);
      drop.add(n);
      opts.onSite?.({ line: s.location?.start.line ?? 0, form: 'do', pointer: p });
      changed = true;
      continue;
    }
    if (s.kind === NodeKind.WhileStmt) {
      // while (p && (p = p->f)) BODY
      const w = s as WhileStmt;
      const c = unparen(w.condition);
      if (c.kind !== NodeKind.BinaryExpr || (c as BinaryExpr).operator !== '&&') continue;
      const p = truthOf((c as BinaryExpr).left);
      const r = unparen((c as BinaryExpr).right);
      if (!p || r.kind !== NodeKind.AssignExpr || (r as AssignExpr).operator !== '=') continue;
      const l = unparen((r as AssignExpr).left);
      if (l.kind !== NodeKind.Identifier || (l as Identifier).name !== p || !linkOf((r as AssignExpr).right, p)) continue;
      const body = bodyOf(w.body);
      if (writes(body, p) || holdsJumpOrLabel(body)) continue;
      if (!deadAfter(out, i, p, isBody)) continue;
      // The facts: the loop's jump lands on the return copy after it, which its bottom falls into.
      const next = out[i + 1];
      if (!next || next.kind !== NodeKind.ReturnStmt) continue;
      const line = s.location?.start.line ?? -1;
      const e = ev.edges?.filter(x => x.line === line && x.keyword === 'while');
      if (!e || e.length !== 1) continue;
      const copy = ev.returns?.find(x => x.start === e[0].target);
      if (!copy || copy.fallsIn !== true || !copy.jumpsIn?.includes(e[0].jcc)) continue;
      const offs = ev.lines.get(next.location?.start.line ?? -1) ?? [];
      if (!offs.some(o => o >= copy.start && o <= copy.ret)) continue;
      out[i] = retestFor(p, (r as AssignExpr).right, body, s);
      opts.onSite?.({ line, form: 'while', pointer: p });
      changed = true;
    }
  }
  return changed ? out : null;
}

function declCount(root: ASTNode, n: string): number {
  let k = 0;
  for (const x of traverseAST(root)) {
    if (x.kind !== NodeKind.DeclStmt) continue;
    const ds = (x as DeclStmt).declarations;
    if (ds.length === 1 && ds[0].kind === NodeKind.VariableDecl && (ds[0] as VariableDecl).name.name === n && !(ds[0] as VariableDecl).initializer) k++;
  }
  return k;
}

/** Remove n's bare declarations in place (the body is a fresh clone). */
function dropDecl(root: ASTNode, n: string): void {
  for (const x of traverseAST(root)) {
    if (x.kind !== NodeKind.CompoundStmt) continue;
    const list = (x as CompoundStmt).statements as Statement[];
    for (let k = list.length - 1; k >= 0; k--) {
      const st = list[k];
      if (st.kind !== NodeKind.DeclStmt) continue;
      const ds = (st as DeclStmt).declarations;
      if (ds.length === 1 && ds[0].kind === NodeKind.VariableDecl && (ds[0] as VariableDecl).name.name === n && !(ds[0] as VariableDecl).initializer) list.splice(k, 1);
    }
  }
}

function createLinkRetestForTransformer(options: LinkRetestForOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body || !options.branchLayout) return undefined;
      const body = cloneNode(fn.body) as CompoundStmt;
      let changed = false;
      const drop = new Set<string>();
      const visit = (blk: CompoundStmt, isBody: boolean): void => {
        const r = rewriteList(blk.statements as Statement[], options.branchLayout!, body, isBody, options, drop);
        if (r) { (blk as { statements: Statement[] }).statements = r; changed = true; }
        for (const st of blk.statements) {
          for (const x of traverseAST(st)) if (x.kind === NodeKind.CompoundStmt && x !== blk) visitOnce(x as CompoundStmt);
        }
      };
      const seen = new Set<ASTNode>();
      const visitOnce = (b: CompoundStmt): void => {
        if (seen.has(b)) return;
        seen.add(b);
        const r = rewriteList(b.statements as Statement[], options.branchLayout!, body, false, options, drop);
        if (r) { (b as { statements: Statement[] }).statements = r; changed = true; }
      };
      seen.add(body);
      visit(body, true);
      for (const n of drop) dropDecl(body, n);
      return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

export const linkRetestForPlugin: TransformPlugin = {
  id: 'link-retest-for',
  name: 'Link Retest For',
  description: 'A walk to the last node whose original re-tests the copied pointer is written as for (; p && p->next; p = p->next)',
  version: '1.0.0',
  defaultEnabled: true,
  // With the late matching loop shapes (tail-walk-reread, rotated-step-while are earlier).
  priority: 989.986,
  tags: ['matching'],
  createTransformer: (options: LinkRetestForOptions = {}) => createLinkRetestForTransformer(options),
};
