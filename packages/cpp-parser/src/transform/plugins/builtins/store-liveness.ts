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
  Expression, ParenExpr, MemberExpr, SubscriptExpr, CallExpr, CStyleCastExpr, DeclStmt,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { calleeSpelling } from '../../cfg/out-param.js';
import { isPure } from './pseudo-op-lower.js';

type Fate = 'kill' | 'read' | 'none';

/**
 * Calls that overwrite a variable through its address: `f(.., &v, ..)` where the callee
 * stores all of v before it reads it is a store to v, not a read.
 */
export interface OutCalls {
  /** Bytes the callee stores through argument `index` (a non-null `&local`) before reading, or null. */
  outWidth: (callee: string, index: number) => number | null;
  /** Bytes the variable occupies. */
  width: number;
}

const unparenExpr = (e: Expression): Expression => {
  let x = e;
  while (x.kind === NodeKind.ParenExpr) x = (x as ParenExpr).expression;
  return x;
};
const uncastExpr = (e: Expression): Expression => {
  let x = unparenExpr(e);
  while (x.kind === NodeKind.CStyleCastExpr) x = unparenExpr((x as CStyleCastExpr).expression);
  return x;
};

/**
 * The expression a statement evaluates is one call (or a call assigned to something else)
 * handed `&name` at an argument the callee overwrites whole, `name` appears nowhere else in
 * the statement, and the other arguments have no effects: the call stores v before anything
 * can read it.
 */
function outCallKills(s: Statement, name: string, out: OutCalls): boolean {
  let e: Expression | null = null;
  if (s.kind === NodeKind.ExprStmt) e = (s as ExprStmt).expression;
  else if (s.kind === NodeKind.DeclStmt) {
    const ds = (s as DeclStmt).declarations;
    const v = ds.length === 1 && ds[0].kind === NodeKind.VariableDecl ? ds[0] as VariableDecl : null;
    e = v?.initializer && v.initializer.kind !== NodeKind.InitListExpr ? v.initializer as Expression : null;
  }
  if (!e) return false;
  let x = uncastExpr(e);
  if (x.kind === NodeKind.AssignExpr && (x as AssignExpr).operator === '=') x = uncastExpr((x as AssignExpr).right);
  if (x.kind !== NodeKind.CallExpr) return false;
  const call = x as CallExpr;
  const callee = calleeSpelling(call);
  if (!callee) return false;
  let count = 0;
  for (const n of traverseAST(s)) if (n.kind === NodeKind.Identifier && (n as Identifier).name === name) count++;
  if (count !== 1) return false;
  const at = call.arguments.findIndex(a => {
    const u = uncastExpr(a);
    return u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '&'
      && unparenExpr((u as UnaryExpr).operand).kind === NodeKind.Identifier
      && (unparenExpr((u as UnaryExpr).operand) as Identifier).name === name;
  });
  if (at < 0) return false;
  if (call.arguments.some((a, k) => k !== at && !isPure(a))) return false;
  const w = out.outWidth(callee, at);
  return w !== null && w >= out.width;
}

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
function fate(s: Statement, name: string, out?: OutCalls): Fate {
  if (!mentions(s, name)) return jumps(s) ? 'read' : 'none';
  if (out && !jumps(s) && outCallKills(s, name, out)) return 'kill';
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
      const t = fateOf(i.thenBranch, name, out);
      const e = i.elseBranch ? fateOf(i.elseBranch, name, out) : 'none';
      if (t === 'read' || e === 'read') return 'read';
      // One arm overwriting is not enough: the other still carries the value on.
      return t === 'kill' && e === 'kill' ? 'kill' : 'none';
    }
    case NodeKind.CompoundStmt:
      return fateSeq((s as CompoundStmt).statements, name, out);
    default:
      return 'read';
  }
}

function fateOf(s: Statement, name: string, out?: OutCalls): Fate {
  return s.kind === NodeKind.CompoundStmt ? fateSeq((s as CompoundStmt).statements, name, out) : fate(s, name, out);
}

function fateSeq(list: readonly Statement[], name: string, out?: OutCalls): Fate {
  for (const s of list) {
    const f = fate(s, name, out);
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

/** Parent of every statement under `body`, by the fields statements hang from. */
function statementParents(body: CompoundStmt): Map<Statement, Statement> {
  const parent = new Map<Statement, Statement>();
  const walk = (s: Statement): void => {
    for (const f of STMT_FIELDS) {
      const v = (s as unknown as Record<string, unknown>)[f];
      if (Array.isArray(v)) { for (const c of v) if (isStatementNode(c)) { parent.set(c, s); walk(c); } }
      else if (isStatementNode(v)) { parent.set(v, s); walk(v); }
    }
  };
  walk(body);
  return parent;
}

const isLoop = (s: Statement): boolean =>
  s.kind === NodeKind.WhileStmt || s.kind === NodeKind.DoWhileStmt || s.kind === NodeKind.ForStmt;

/**
 * Forward from statement `index` of `block`: does every path overwrite `name` whole before
 * any statement names it otherwise, or leave the function? `&name` met on the way is a read
 * (whatever is handed the address may read through it).
 */
function overwrittenFrom(body: CompoundStmt, block: CompoundStmt, index: number, name: string,
  parent: Map<Statement, Statement>, out?: OutCalls): boolean {
  let cur: CompoundStmt = block;
  let at = index;
  for (;;) {
    const f = fateSeq(cur.statements.slice(at + 1), name, out);
    if (f === 'kill') return true;
    if (f === 'read') return false;
    if (cur === body) return true;
    // Leave the block: climb to the next enclosing block and go on after the statement
    // that holds it. A loop could bring control back round to a read before the store.
    let child: Statement = cur;
    let up = parent.get(child);
    while (up && up.kind !== NodeKind.CompoundStmt) {
      if (isLoop(up) || up.kind === NodeKind.SwitchStmt) return false;
      child = up;
      up = parent.get(child);
    }
    if (!up) return false;
    cur = up as CompoundStmt;
    at = cur.statements.indexOf(child);
    if (at < 0) return false;
  }
}

/**
 * True when the value statement `index` of `block` stores into `name` cannot be read: every
 * path from there overwrites `name` whole first, or returns.
 */
export function storeIsDead(body: CompoundStmt, block: CompoundStmt, index: number, name: string): boolean {
  if (untracked(body, name)) return false;
  return overwrittenFrom(body, block, index, name, statementParents(body));
}

/**
 * The same for the initializer of `name`'s declaration, statement `index` of `block`.
 *
 * A store that is not the declaration's must refuse once `&name` is taken anywhere: the
 * address may have been kept before the store, and a call after it read through the copy.
 * Nothing can hold the address before the declaration runs, though, so every `&name` that
 * can reach the initializer's value is one the forward walk meets, and it is a read there:
 * `uint32_t eItemFlags = 0; ITEM_SetServerSideFlag(&eItemFlags, 0x20, 1);` (00561e70) reads
 * the 0 through the pointer. Only a declaration inside a loop can see an address taken on an
 * earlier pass round it, so there a taken address still refuses. With `out`, a call that
 * overwrites the variable through `&name` before reading it (an out-parameter) is a store.
 */
export function initializerIsDead(body: CompoundStmt, block: CompoundStmt, index: number, name: string, out?: OutCalls): boolean {
  let decls = 0;
  let taken = false;
  for (const n of traverseAST(body)) {
    if (n.kind === NodeKind.VariableDecl && (n as VariableDecl).name.name === name) decls++;
    if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&' && addressOfLocal((n as UnaryExpr).operand, name)) taken = true;
  }
  if (decls > 1) return false;
  const parent = statementParents(body);
  if (taken) {
    for (let s = parent.get(block); s; s = parent.get(s)) if (isLoop(s)) return false;
  }
  return overwrittenFrom(body, block, index, name, parent, out);
}
