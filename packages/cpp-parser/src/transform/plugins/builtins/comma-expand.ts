/**
 * Comma-Expand Plugin
 *
 * The decompiler loves packing assignments + tests into a single expression
 * with the comma operator and short-circuit `&&`/`||`. The result is unreadable:
 *
 *   if (!pGame || pGame->eType != UNIT_MONSTER ||
 *       (pMon = (D2*)pGame->pData->pAiGeneral, !pMon) ||
 *       (pCur = ((D2**)pMon->List)[4], !pCur)) {
 *     return nullptr;
 *   }
 *
 *   while (pSize && (nRes = GetPacketSize(p, pSize, &n), nRes)) { ... }
 *
 * This plugin lowers the comma operator back into ordinary statements, solving
 * three patterns:
 *
 *  1. Unconditional hoist (the side effects always run, so just split them out):
 *       (a, b, c);            →  a; b; c;
 *       return (a, b, c);     →  a; b; return c;
 *       x = (a, b, c);        →  a; b; x = c;
 *       if ((a, b, c)) {...}  →  a; b; if (c) {...}
 *
 *  2. Short-circuit OR-guard with side effects, where the then-branch is a bare
 *     early-exit (return/break/continue/goto) — split the `||` chain into one
 *     guard per operand, hoisting each comma operand's assignments first:
 *       if (A || (x = e, !x) || B) return R;
 *         →  if (A) return R;
 *            x = e; if (!x) return R;
 *            if (B) return R;
 *
 *  3. While-condition with side effects (`&&` chain containing a comma) — turn
 *     the loop into `while (true)` with the condition re-expressed as break
 *     guards at the top of the body (preserves continue: it re-runs the guards):
 *       while (A && (x = e, x)) BODY;
 *         →  while (true) { if (!A) break; x = e; if (!x) break; BODY }
 *
 * Runs EARLY (priority 13) so later passes (branchless-select, early-return,
 * etc.) operate on the flattened, single-purpose statements.
 *
 * Conservative gates: patterns 2 and 3 only fire when the chain actually
 * contains a comma side effect — a plain `if (a || b) return;` is left alone.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  Statement,
  CompoundStmt,
  ExprStmt,
  ReturnStmt,
  IfStmt,
  WhileStmt,
  BreakStmt,
  BinaryExpr,
  UnaryExpr,
  ParenExpr,
  AssignExpr,
  BoolLiteralExpr,
} from '../../../ast/nodes.js';
import { createTransformer, cloneNode, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

const FLIP: Record<string, BinaryExpr['operator']> = {
  '==': '!=', '!=': '==', '<': '>=', '>': '<=', '<=': '>', '>=': '<',
};

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** Logical negation, simplified: flip relational ops, drop a leading `!`, else wrap `!(...)`. */
function invert(e: Expression): Expression {
  const u = unwrap(e);
  if (u.kind === NodeKind.BinaryExpr) {
    const b = u as BinaryExpr;
    const flipped = FLIP[b.operator];
    if (flipped) return { ...b, operator: flipped, leadingTrivia: [], trailingTrivia: [] };
  }
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') {
    return (u as UnaryExpr).operand;
  }
  const needsParen =
    u.kind === NodeKind.BinaryExpr ||
    u.kind === NodeKind.ConditionalExpr ||
    u.kind === NodeKind.AssignExpr ||
    u.kind === NodeKind.CommaExpr;
  const operand: Expression = needsParen
    ? ({ kind: NodeKind.ParenExpr, expression: u, location: e.location, leadingTrivia: [], trailingTrivia: [] } as ParenExpr)
    : u;
  return { kind: NodeKind.UnaryExpr, operator: '!', operand, location: e.location, leadingTrivia: [], trailingTrivia: [] } as UnaryExpr;
}

function makeExprStmt(expr: Expression): ExprStmt {
  return {
    kind: NodeKind.ExprStmt,
    expression: { ...expr, leadingTrivia: [], trailingTrivia: [] },
    location: expr.location,
    leadingTrivia: [],
    trailingTrivia: [],
  };
}

function makeGuard(cond: Expression, exit: Statement, leadingTrivia: ASTNode['leadingTrivia']): IfStmt {
  return {
    kind: NodeKind.IfStmt,
    condition: cond,
    thenBranch: cloneNode(exit),
    elseBranch: null,
    isConstexpr: false,
    location: exit.location,
    leadingTrivia: leadingTrivia || [],
    trailingTrivia: [],
  };
}

/**
 * The parser models the comma operator as a left-associative `BinaryExpr` with
 * operator `,` (there is a CommaExpr node kind but the parser does not emit it),
 * so `(a, b, c)` is BinaryExpr(',', BinaryExpr(',', a, b), c).
 */
function binOp(e: Expression): string | null {
  return e.kind === NodeKind.BinaryExpr ? (e as BinaryExpr).operator : null;
}

function isComma(e: Expression): boolean {
  return binOp(unwrap(e)) === ',';
}

/** Flatten a left-associative binary chain of the given operator into its operands. */
function flattenChain(e: Expression, op: string): Expression[] {
  const u = unwrap(e);
  if (binOp(u) === op) {
    const b = u as BinaryExpr;
    return [...flattenChain(b.left, op), ...flattenChain(b.right, op)];
  }
  return [e];
}

/** Split a chain operand `(assign1, assign2, ..., cond)` into its side effects + final test. */
function splitComma(operand: Expression): { assigns: Expression[]; cond: Expression } {
  const parts = flattenChain(operand, ',');
  if (parts.length <= 1) return { assigns: [], cond: operand };
  return { assigns: parts.slice(0, -1), cond: parts[parts.length - 1] };
}

function hasCommaOperand(ops: Expression[]): boolean {
  return ops.some(isComma);
}

/** A bare early-exit statement (possibly wrapped in a single-statement block). */
function asEarlyExit(s: Statement): Statement | null {
  let t: Statement = s;
  if (t.kind === NodeKind.CompoundStmt) {
    const body = (t as CompoundStmt).statements;
    if (body.length !== 1) return null;
    t = body[0];
  }
  if (
    t.kind === NodeKind.ReturnStmt ||
    t.kind === NodeKind.BreakStmt ||
    t.kind === NodeKind.ContinueStmt ||
    t.kind === NodeKind.GotoStmt
  ) {
    return t;
  }
  return null;
}

/**
 * Pattern 1 + 2 at statement level. Returns a replacement statement list, or
 * null if the statement is not a comma/short-circuit pattern.
 */
function expandStatement(s: Statement): Statement[] | null {
  // Pattern 2: if (OR-chain with a comma side effect) <early-exit>;
  if (s.kind === NodeKind.IfStmt) {
    const ifs = s as IfStmt;
    if (ifs.elseBranch === null && !ifs.init) {
      const exit = asEarlyExit(ifs.thenBranch);
      if (exit) {
        const ops = flattenChain(ifs.condition, '||');
        if (ops.length >= 2 && hasCommaOperand(ops)) {
          const out: Statement[] = [];
          ops.forEach((op, i) => {
            const { assigns, cond } = splitComma(op);
            for (const a of assigns) out.push(makeExprStmt(a));
            const guard = makeGuard(cond, exit, i === 0 ? ifs.leadingTrivia : []);
            out.push(guard);
          });
          return out;
        }
      }
    }
    // Pattern 1d: if ((a, b, c)) — whole condition is a comma (unconditional)
    if (isComma(ifs.condition)) {
      const { assigns, cond } = splitComma(ifs.condition);
      return [...assigns.map(makeExprStmt), updateNode(ifs, { condition: cond })];
    }
    return null;
  }

  // Pattern 1a: (a, b, c);  and  1c: x = (a, b, c);
  if (s.kind === NodeKind.ExprStmt) {
    const e = unwrap((s as ExprStmt).expression);
    if (isComma(e)) {
      return flattenChain(e, ',').map(makeExprStmt);
    }
    if (e.kind === NodeKind.AssignExpr) {
      const a = e as AssignExpr;
      if (isComma(a.right)) {
        const { assigns, cond } = splitComma(a.right);
        return [...assigns.map(makeExprStmt), makeExprStmt(updateNode(a, { right: cond }))];
      }
    }
    return null;
  }

  // Pattern 1b: return (a, b, c);
  if (s.kind === NodeKind.ReturnStmt) {
    const r = s as ReturnStmt;
    if (r.value && isComma(r.value)) {
      const { assigns, cond } = splitComma(r.value);
      return [...assigns.map(makeExprStmt), updateNode(r, { value: cond })];
    }
    return null;
  }

  return null;
}

function expandBlock(block: CompoundStmt): CompoundStmt | null {
  const out: Statement[] = [];
  let changed = false;
  for (const s of block.statements) {
    const repl = expandStatement(s);
    if (repl) {
      out.push(...repl);
      changed = true;
    } else {
      out.push(s);
    }
  }
  return changed ? updateNode(block, { statements: out }) : null;
}

/**
 * Pattern 3: while (AND-chain containing a comma side effect) BODY
 *   → while (true) { <break guards>; BODY }
 */
function expandWhile(w: WhileStmt): WhileStmt | null {
  const ops = flattenChain(w.condition, '&&');
  if (ops.length < 1 || !hasCommaOperand(ops)) return null;

  const guards: Statement[] = [];
  for (const op of ops) {
    const { assigns, cond } = splitComma(op);
    for (const a of assigns) guards.push(makeExprStmt(a));
    const brk: BreakStmt = { kind: NodeKind.BreakStmt, location: op.location, leadingTrivia: [], trailingTrivia: [] };
    guards.push(makeGuard(invert(cond), brk, []));
  }

  const bodyStmts: Statement[] =
    w.body.kind === NodeKind.CompoundStmt ? (w.body as CompoundStmt).statements : [w.body];

  const trueLit: BoolLiteralExpr = {
    kind: NodeKind.BoolLiteral,
    value: true,
    location: w.condition.location,
    leadingTrivia: [],
    trailingTrivia: [],
  };
  const newBody: CompoundStmt = {
    kind: NodeKind.CompoundStmt,
    statements: [...guards, ...bodyStmts],
    location: w.body.location,
    leadingTrivia: w.body.leadingTrivia || [],
    trailingTrivia: [],
  };
  return updateNode(w, { condition: trueLit, body: newBody });
}

function createCommaExpandTransformer(): Transformer {
  return createTransformer({
    visitNode(node: ASTNode): ASTNode | undefined {
      if (node.kind === NodeKind.CompoundStmt) {
        return expandBlock(node as CompoundStmt) ?? undefined;
      }
      if (node.kind === NodeKind.WhileStmt) {
        return expandWhile(node as WhileStmt) ?? undefined;
      }
      return undefined;
    },
  });
}

export interface CommaExpandOptions extends PluginOptions {
  // Reserved for future options
}

/**
 * Comma-Expand Plugin
 *
 * Lowers comma-operator / short-circuit side-effect packing back into readable
 * sequential statements and guard clauses.
 */
export const commaExpandPlugin: TransformPlugin = {
  id: 'comma-expand',
  name: 'Comma Expression Expansion',
  description:
    'Lower comma-operator and short-circuit side effects into sequential statements and guard clauses',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 13, // early: so later passes see flattened single-purpose statements
  tags: ['core', 'readability', 'control-flow'],

  createTransformer(_options?: CommaExpandOptions) {
    return createCommaExpandTransformer();
  },
};
