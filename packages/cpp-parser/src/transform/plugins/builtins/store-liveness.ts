/**
 * Whether a store to a local can still be read: the question two passes ask before they
 * drop a store the decompiler printed but the source never made (a halt's stale line, a
 * stack probe's return address).
 *
 * Forward over the statements that follow the store, in the order they run: the store is
 * dead when every path overwrites the whole variable before anything reads it, or leaves
 * the function. Anything this cannot follow (a loop around the store, a jump, a switch, a
 * variable whose address is taken) counts as a read.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, CompoundStmt, ExprStmt, IfStmt, Statement, AssignExpr, Identifier, UnaryExpr, VariableDecl,
  Expression, ParenExpr, MemberExpr, SubscriptExpr,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';

type Fate = 'kill' | 'read' | 'none';

const STMT_FIELDS = ['statements', 'thenBranch', 'elseBranch', 'body', 'statement', 'init'] as const;

function isStatementNode(v: unknown): v is Statement {
  return !!v && typeof v === 'object' && typeof (v as ASTNode).kind === 'string'
    && ((v as ASTNode).kind as string).endsWith('Stmt');
}

function mentions(node: ASTNode, name: string): boolean {
  for (const n of traverseAST(node)) {
    if (n.kind === NodeKind.Identifier && (n as Identifier).name === name) return true;
  }
  return false;
}

function jumps(node: ASTNode): boolean {
  for (const n of traverseAST(node)) {
    if (n.kind === NodeKind.GotoStmt || n.kind === NodeKind.LabelStmt) return true;
  }
  return false;
}

/** What `s` does to `name` on the way through it. */
function fate(s: Statement, name: string): Fate {
  if (!mentions(s, name)) return jumps(s) ? 'read' : 'none';
  switch (s.kind) {
    case NodeKind.ExprStmt: {
      const e = (s as ExprStmt).expression;
      if (e.kind === NodeKind.AssignExpr && (e as AssignExpr).operator === '='
          && (e as AssignExpr).left.kind === NodeKind.Identifier
          && ((e as AssignExpr).left as Identifier).name === name
          && !mentions((e as AssignExpr).right, name)) return 'kill';
      return 'read';
    }
    case NodeKind.IfStmt: {
      const i = s as IfStmt;
      if (i.init || mentions(i.condition, name)) return 'read';
      const t = fateOf(i.thenBranch, name);
      const e = i.elseBranch ? fateOf(i.elseBranch, name) : 'none';
      if (t === 'read' || e === 'read') return 'read';
      // One arm overwriting is not enough: the other still carries the value on.
      return t === 'kill' && e === 'kill' ? 'kill' : 'none';
    }
    case NodeKind.CompoundStmt:
      return fateSeq((s as CompoundStmt).statements, name);
    default:
      return 'read';
  }
}

function fateOf(s: Statement, name: string): Fate {
  return s.kind === NodeKind.CompoundStmt ? fateSeq((s as CompoundStmt).statements, name) : fate(s, name);
}

function fateSeq(list: readonly Statement[], name: string): Fate {
  for (const s of list) {
    const f = fate(s, name);
    if (f !== 'none') return f;
  }
  return 'none';
}

/** `name`, or a part of it reached without going through a pointer: `name.f`, `name[i]`. */
function addressOfLocal(e: Expression, name: string): boolean {
  let cur = e;
  for (;;) {
    switch (cur.kind) {
      case NodeKind.ParenExpr: cur = (cur as ParenExpr).expression; break;
      case NodeKind.MemberExpr:
        if ((cur as MemberExpr).isArrow) return false;
        cur = (cur as MemberExpr).object;
        break;
      case NodeKind.SubscriptExpr: cur = (cur as SubscriptExpr).array; break;
      case NodeKind.Identifier: return (cur as Identifier).name === name;
      default: return false;
    }
  }
}

/** Is `&name` taken, or `name` declared more than once? Then no store to it is followed. */
function untracked(body: CompoundStmt, name: string): boolean {
  let decls = 0;
  for (const n of traverseAST(body)) {
    if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&' && addressOfLocal((n as UnaryExpr).operand, name)) {
      return true;
    }
    if (n.kind === NodeKind.VariableDecl && (n as VariableDecl).name.name === name) decls++;
  }
  return decls > 1;
}

/**
 * True when the value statement `index` of `block` stores into `name` cannot be read: every
 * path from there overwrites `name` whole first, or returns.
 */
export function storeIsDead(body: CompoundStmt, block: CompoundStmt, index: number, name: string): boolean {
  if (untracked(body, name)) return false;
  const parent = new Map<Statement, Statement>();
  const walk = (s: Statement): void => {
    for (const f of STMT_FIELDS) {
      const v = (s as unknown as Record<string, unknown>)[f];
      if (Array.isArray(v)) { for (const c of v) if (isStatementNode(c)) { parent.set(c, s); walk(c); } }
      else if (isStatementNode(v)) { parent.set(v, s); walk(v); }
    }
  };
  walk(body);

  let cur: CompoundStmt = block;
  let at = index;
  for (;;) {
    const f = fateSeq(cur.statements.slice(at + 1), name);
    if (f === 'kill') return true;
    if (f === 'read') return false;
    if (cur === body) return true;
    // Leave the block: climb to the next enclosing block and go on after the statement
    // that holds it. A loop could bring control back round to a read before the store.
    let child: Statement = cur;
    let up = parent.get(child);
    while (up && up.kind !== NodeKind.CompoundStmt) {
      if (up.kind === NodeKind.WhileStmt || up.kind === NodeKind.DoWhileStmt || up.kind === NodeKind.ForStmt
          || up.kind === NodeKind.SwitchStmt) return false;
      child = up;
      up = parent.get(child);
    }
    if (!up) return false;
    cur = up as CompoundStmt;
    at = cur.statements.indexOf(child);
    if (at < 0) return false;
  }
}
