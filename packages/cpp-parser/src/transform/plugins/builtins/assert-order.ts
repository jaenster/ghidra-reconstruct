/**
 * Assert Order Plugin
 *
 * Blizzard's assertion is `if (!(cond)) { Halt(...); exit(-1); }` in front of the code it
 * guards. When the guarded code leaves (returns, breaks, ...), the decompiler often hands
 * the pair back the other way round:
 *
 *     if (cond) {                          if (!cond) {
 *       ...;                                 ERROR_UnrecoverableInternalError_Halt(...);
 *       return x;                 ->         exit(-1);
 *     }                                    }
 *     ERROR_..._Halt(...);                 ...;
 *     exit(-1);                            return x;
 *
 * VC8 lays the two out differently: the original jumps over the halt when cond holds
 * (ASYNCDATA_GetReadSize, 0040aa40: `je` over the halt), the inverted form jumps to it when
 * cond does not.
 *
 * The two are the same program only when the then-block cannot fall through into the halt,
 * so the rewrite applies only when
 *   - the if has no else, no init-statement and is not constexpr;
 *   - the halt call and the exit call are the next two statements, neither labelled;
 *   - the then-block certainly leaves: its last statement is a return, break, continue,
 *     goto, throw, a call to a function that does not return, or an if/else or block whose
 *     every end leaves;
 *   - no label inside the then-block is the target of a goto outside it, and the block holds
 *     no case label of an enclosing switch.
 * A then-block that declares names at its top level keeps its braces, so the names keep
 * their scope. The condition is negated by dropping a `!`, flipping `==`/`!=`, or else
 * wrapping it in `!(...)`; relational operators are not flipped (NaN).
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, FunctionDecl, CompoundStmt, ExprStmt, IfStmt, LabelStmt, GotoStmt, Statement,
  Expression, CallExpr, Identifier, QualifiedId, UnaryExpr, BinaryExpr, ParenExpr,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { TriviaKind } from '../../../lexer/trivia.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Stmt } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { DEFAULT_NORETURN_FUNCTIONS } from './goto-cleanup/types.js';
import { holdsFreeCase } from './goto-cleanup/paths.js';

export interface AssertOrderOptions extends PluginOptions {
  /** Further callees that never return, by unqualified name. */
  noreturnFunctions?: string[];
}

const HALT_CALLEES = new Set(['ERROR_UnrecoverableInternalError_Halt']);
const EXIT_CALLEES = new Set(['exit', '_exit']);

/** The last name segment of a callee: `A::B::f` and `f` both answer `f`. */
function calleeTail(e: Expression): string | null {
  if (e.kind === NodeKind.Identifier) return (e as Identifier).name;
  if (e.kind === NodeKind.QualifiedId) {
    const n = (e as QualifiedId).name;
    return n.kind === NodeKind.Identifier ? (n as Identifier).name : null;
  }
  return null;
}

function calledName(s: Statement): string | null {
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = (s as ExprStmt).expression;
  return e.kind === NodeKind.CallExpr ? calleeTail((e as CallExpr).callee) : null;
}

function isHaltStmt(s: Statement): boolean {
  const n = calledName(s);
  return n !== null && HALT_CALLEES.has(n);
}

function isExitStmt(s: Statement): boolean {
  const n = calledName(s);
  return n !== null && EXIT_CALLEES.has(n)
    && ((s as ExprStmt).expression as CallExpr).arguments.length === 1;
}

/**
 * Control certainly does not continue past `s`. Only the callee's name counts for a call;
 * a decompiler warning that a call does not return is not trusted.
 */
function leaves(s: Statement, noreturn: ReadonlySet<string>): boolean {
  switch (s.kind) {
    case NodeKind.ReturnStmt: case NodeKind.BreakStmt: case NodeKind.ContinueStmt: case NodeKind.GotoStmt:
      return true;
    case NodeKind.ExprStmt: {
      if ((s as ExprStmt).expression.kind === NodeKind.ThrowExpr) return true;
      const n = calledName(s);
      return n !== null && noreturn.has(n);
    }
    case NodeKind.CompoundStmt: {
      const l = (s as CompoundStmt).statements;
      return l.length > 0 && leaves(l[l.length - 1], noreturn);
    }
    case NodeKind.IfStmt: {
      const i = s as IfStmt;
      return !!i.elseBranch && leaves(i.thenBranch, noreturn) && leaves(i.elseBranch, noreturn);
    }
    case NodeKind.LabelStmt:
      return leaves((s as LabelStmt).statement, noreturn);
    default:
      return false;
  }
}

function unwrapParens(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** `!(e)` as a condition: drop a `!`, flip one equality, else wrap. */
export function negateCondition(e: Expression): Expression {
  const u = unwrapParens(e);
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') {
    // only ever used as a condition, where `x` and `!!x` test the same
    return unwrapParens((u as UnaryExpr).operand);
  }
  if (u.kind === NodeKind.BinaryExpr) {
    const b = u as BinaryExpr;
    if (b.operator === '==' || b.operator === '!=') {
      return { ...b, operator: b.operator === '==' ? '!=' : '==', leadingTrivia: [], trailingTrivia: [] };
    }
  }
  const needsParen = u.kind === NodeKind.BinaryExpr || u.kind === NodeKind.ConditionalExpr
    || u.kind === NodeKind.AssignExpr || u.kind === NodeKind.CommaExpr;
  const operand: Expression = needsParen
    ? ({ kind: NodeKind.ParenExpr, expression: u, location: e.location, leadingTrivia: [], trailingTrivia: [] } as ParenExpr)
    : u;
  return { kind: NodeKind.UnaryExpr, operator: '!', operand, location: e.location, leadingTrivia: [], trailingTrivia: [] } as UnaryExpr;
}

/** goto counts per label over `roots`. */
function gotoCounts(roots: readonly ASTNode[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of roots) {
    for (const n of traverseAST(r)) {
      if (n.kind === NodeKind.GotoStmt) {
        const l = (n as GotoStmt).label.name;
        m.set(l, (m.get(l) ?? 0) + 1);
      }
    }
  }
  return m;
}

function labelsIn(root: ASTNode): string[] {
  const out: string[] = [];
  for (const n of traverseAST(root)) {
    if (n.kind === NodeKind.LabelStmt) out.push((n as LabelStmt).label.name);
  }
  return out;
}

/** Keep comments and directives, drop the blank lines: the statement moves into a block. */
function commentsOnly(s: Statement): Statement {
  const keep = (t: typeof s.leadingTrivia) =>
    (t ?? []).filter(x => x.kind === TriviaKind.LineComment || x.kind === TriviaKind.BlockComment
      || x.kind === TriviaKind.Directive);
  const lead = keep(s.leadingTrivia);
  return lead.length === (s.leadingTrivia ?? []).length ? s : updateNode(s, { leadingTrivia: lead } as Partial<Statement>);
}

interface Ctx {
  noreturn: ReadonlySet<string>;
  /** goto counts over the whole function. */
  gotos: ReadonlyMap<string, number>;
}

/** The statements that replace `stmts[i..i+2]`, or null when the shape there does not qualify. */
function rewriteAt(stmts: readonly Statement[], i: number, ctx: Ctx): Statement[] | null {
  if (i + 2 >= stmts.length || stmts[i].kind !== NodeKind.IfStmt) return null;
  const ifs = stmts[i] as IfStmt;
  const halt = stmts[i + 1];
  const exit = stmts[i + 2];
  if (!isHaltStmt(halt) || !isExitStmt(exit)) return null;
  if (ifs.elseBranch || ifs.init || ifs.isConstexpr) return null;

  const then = ifs.thenBranch;
  const body: Statement[] = then.kind === NodeKind.CompoundStmt ? [...(then as CompoundStmt).statements] : [then];
  if (body.length === 0 || !leaves(body[body.length - 1], ctx.noreturn)) return null;
  if (holdsFreeCase(body)) return null;
  const inner = gotoCounts([then]);
  for (const l of labelsIn(then)) {
    if ((ctx.gotos.get(l) ?? 0) > (inner.get(l) ?? 0)) return null;
  }

  const guard = updateNode(ifs, {
    condition: negateCondition(ifs.condition),
    thenBranch: Stmt.compound([commentsOnly(halt), commentsOnly(exit)]),
    elseBranch: null,
  } as Partial<IfStmt>);
  const declares = body.some(s => s.kind === NodeKind.DeclStmt);
  const guarded: Statement[] = declares
    ? [then.kind === NodeKind.CompoundStmt ? then : Stmt.compound(body)]
    : body;
  return [guard, ...guarded];
}

function rewriteList(stmts: readonly Statement[], ctx: Ctx): { stmts: Statement[]; count: number } | null {
  const out: Statement[] = [];
  let count = 0;
  for (let i = 0; i < stmts.length; i++) {
    const r = rewriteAt(stmts, i, ctx);
    if (r) {
      out.push(...r);
      count++;
      i += 2;
    } else {
      out.push(stmts[i]);
    }
  }
  return count ? { stmts: out, count } : null;
}

function rewriteFunction(fn: FunctionDecl, noreturn: ReadonlySet<string>, stats: { reordered: number }): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  const ctx: Ctx = { noreturn, gotos: gotoCounts([fn.body]) };
  let n = 0;
  const t = createTransformer({
    visitCompoundStmt(block: CompoundStmt): ASTNode | undefined {
      const r = rewriteList(block.statements, ctx);
      if (!r) return undefined;
      n += r.count;
      return updateNode(block, { statements: r.stmts } as Partial<CompoundStmt>);
    },
  });
  const body = t(fn.body) as CompoundStmt;
  if (n === 0) return undefined;
  stats.reordered += n;
  return updateNode(fn, { body } as Partial<FunctionDecl>);
}

export function reorderAsserts_forTest(fn: FunctionDecl, noreturnFunctions: string[] = []): { fn: FunctionDecl; reordered: number } {
  const stats = { reordered: 0 };
  const out = rewriteFunction(fn, new Set([...DEFAULT_NORETURN_FUNCTIONS, ...noreturnFunctions]), stats);
  return { fn: out ?? fn, reordered: stats.reordered };
}

function createAssertOrderTransformer(options: AssertOrderOptions = {}): Transformer {
  const noreturn = new Set([...DEFAULT_NORETURN_FUNCTIONS, ...(options.noreturnFunctions ?? [])]);
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, noreturn, { reordered: 0 });
    },
  });
}

export const assertOrderPlugin: TransformPlugin = {
  id: 'assert-order',
  name: 'Assert Order',
  description:
    'Puts an assertion halt that follows a leaving if-block back in front of the code it guards: if (c) { ...; return; } Halt; exit; -> if (!c) { Halt; exit; } ...; return;',
  version: '1.0.0',
  defaultEnabled: true,
  // After halt-site-fold (930) has given every halt its final shape and after the goto passes
  // and unreferenced-label drop (986), so only labels something still jumps to remain.
  priority: 987,
  tags: ['cleanup', 'assertion'],
  createTransformer: createAssertOrderTransformer,
};
