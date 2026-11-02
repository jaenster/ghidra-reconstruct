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
 *     early-exit (return/break/continue; not goto, see below) — split the `||` chain into one
 *     guard per operand, hoisting each comma operand's assignments first:
 *       if (A || (x = e, !x) || B) return R;
 *         →  if (A) return R;
 *            x = e; if (!x) return R;
 *            if (B) return R;
 *
 *     With the original's addresses (`branchLayout`), a guard returning a value whose
 *     return VC8 laid out after the rest of the block - as it lays out every `||`
 *     guard's exit - nests the rest instead (outside a loop, the rest leaving):
 *       if (A || (x = e, !x)) return R; REST
 *         →  if (!A) { x = e; if (x) { REST } } return R;
 *     The split guards would each put a copy of the return inline, ahead of REST.
 *
 *  3. While-condition with side effects (`&&` chain containing a comma) — turn
 *     the loop into `while (true)` with the condition re-expressed as break
 *     guards at the top of the body (preserves continue: it re-runs the guards):
 *       while (A && (x = e, x)) BODY;
 *         →  while (true) { if (!A) break; x = e; if (!x) break; BODY }
 *
 * Runs EARLY (priority 13) so later passes (branchless-select, early-return,
 * etc.) operate on the flattened, single-purpose statements, and once more LATE
 * (`commaExpandLatePlugin`, priority 59) on what goto structuring produced: a guard
 * whose exit is a `goto` is left to goto-cleanup, which turns it into the negated,
 * no-else form that 2b/2c lower by nesting.
 *
 * Every lowering keeps the order of evaluation: a comma operand's left side runs only
 * on the path where `&&`/`||` evaluates that operand, exactly once.
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
import { LayoutReader, isLoop, type BranchLayoutEvidence } from './branch-layout/evidence.js';
import { leaves } from './assert-order.js';
import { DEFAULT_NORETURN_FUNCTIONS } from './goto-cleanup/types.js';
import { holdsFreeCase } from './goto-cleanup/paths.js';
import { getChildren, traverseAST } from '../../../ast/visitor.js';
import type { FunctionDecl } from '../../../ast/nodes.js';

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
 * Build a nested guard chain from a short-circuit operand list, hoisting each
 * operand's comma side effects at the point they actually execute. One level of
 * nesting per operand (no else → no branch duplication). Used for:
 *   - negated OR-guard `if (!(A || B)) E;` (negate=true, body = early-exit):
 *       if (!A) { <B assigns> if (!B) E; }
 *   - AND-chain        `if (A && B) BODY;` (negate=false, body = then-branch):
 *       if (A) { <B assigns> if (B) BODY }
 * invert() collapses the !-of-! so `!(!nParam)` renders as `nParam`. Each if keeps the
 * source if's position: they are its conditional branches, and the layout evidence
 * (branch-layout/evidence.ts) reads an if's branch by the line of its keyword.
 */
function buildNestedChain(
  ops: Expression[],
  body: Statement,
  leadingTrivia: ASTNode['leadingTrivia'],
  negate: boolean,
  location: ASTNode['location'],
): Statement[] {
  const { assigns, cond } = splitComma(ops[0]);
  const guardCond = negate ? invert(cond) : cond;
  const head: Statement[] = assigns.map(makeExprStmt);
  const thenBranch: Statement =
    ops.length === 1
      ? cloneNode(body)
      : ({
          kind: NodeKind.CompoundStmt,
          statements: buildNestedChain(ops.slice(1), body, [], negate, location),
          location: body.location,
          leadingTrivia: [],
          trailingTrivia: [],
        } as CompoundStmt);
  head.push({
    kind: NodeKind.IfStmt,
    condition: guardCond,
    thenBranch,
    elseBranch: null,
    isConstexpr: false,
    location,
    leadingTrivia: leadingTrivia || [],
    trailingTrivia: [],
  } as IfStmt);
  return head;
}

/**
 * Pattern 1 + 2 at statement level. Returns a replacement statement list, or
 * null if the statement is not a comma/short-circuit pattern.
 */
function expandStatement(s: Statement, layout: LayoutCtx | null = null): Statement[] | null {
  // Pattern 2: if (OR-chain with a comma side effect) <early-exit>;
  if (s.kind === NodeKind.IfStmt) {
    const ifs = s as IfStmt;
    if (ifs.elseBranch === null && !ifs.init) {
      const exit = asEarlyExit(ifs.thenBranch);
      if (exit) {
        const ops = flattenChain(ifs.condition, '||');
        // Not for a goto: one guard per operand is one goto per operand, and the jumps
        // were one in the binary. `if (A || (X, B)) goto L; R` has no comma-free form with
        // one jump and no flag that is local to the if - the comma-free form nests R under
        // the negated condition, which is goto-cleanup's job. So the condition is kept for
        // now; once the goto is structured it reaches the late run of this pass as
        // `if (!(A || (X, B))) { R }` (2b) or `if (!A && (X, !B)) { R }` (2c), which nest
        // without copying anything. A goto that survives structuring keeps its comma.
        if (ops.length >= 2 && hasCommaOperand(ops) && exit.kind !== NodeKind.GotoStmt) {
          const out: Statement[] = [];
          const together = layout ? sharedGuards(ifs, ops, exit, layout) : null;
          let pending: Expression[] = [];
          const flush = (): void => {
            if (pending.length === 0) return;
            let cond = pending[0];
            for (const c of pending.slice(1)) cond = orOf(cond, c);
            out.push(makeGuard(cond, exit, out.length === 0 ? ifs.leadingTrivia : []));
            pending = [];
          };
          ops.forEach((op, i) => {
            const { assigns, cond } = splitComma(op);
            if (assigns.length > 0) flush();
            for (const a of assigns) out.push(makeExprStmt(a));
            pending.push(cond);
            if (!together || !together[i]) flush();
          });
          flush();
          return out;
        }
      }
      // Pattern 2b: negated OR-guard  if (!(A || B || ...)) BODY;  - BODY runs when every
      // operand is false, so it nests as `if (!A) { <B assigns> if (!B) BODY }`. Any
      // then-branch: with no else, nesting copies nothing. (goto-cleanup produces this
      // shape from a goto guard the early run left alone.)
      const neg = unwrap(ifs.condition);
      if (neg.kind === NodeKind.UnaryExpr && (neg as UnaryExpr).operator === '!') {
        const negOps = flattenChain((neg as UnaryExpr).operand, '||');
        if (negOps.length >= 2 && hasCommaOperand(negOps)) {
          return buildNestedChain(negOps, exit ?? ifs.thenBranch, ifs.leadingTrivia, true, ifs.location);
        }
      }
      // Pattern 2c: AND-chain with a comma side effect  if (A && (v=X, B)) BODY;
      // (any then-branch; no else, so nesting can't duplicate a branch)
      const andOps = flattenChain(ifs.condition, '&&');
      if (andOps.length >= 2 && hasCommaOperand(andOps)) {
        return buildNestedChain(andOps, ifs.thenBranch, ifs.leadingTrivia, false, ifs.location);
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

/** `a || b`, an operand that binds looser than `||` parenthesised. */
function orOf(a: Expression, b: Expression): Expression {
  const wrap = (e: Expression): Expression => {
    const u = unwrap(e);
    const op = binOp(u);
    const loose = u.kind === NodeKind.AssignExpr || u.kind === NodeKind.ConditionalExpr || op === ',';
    return loose ? ({ kind: NodeKind.ParenExpr, expression: u, location: e.location, leadingTrivia: [], trailingTrivia: [] } as ParenExpr) : e;
  };
  return { kind: NodeKind.BinaryExpr, operator: '||', left: wrap(a), right: wrap(b), location: a.location, leadingTrivia: [], trailingTrivia: [] } as BinaryExpr;
}

/** Leaf operands of the `&&`/`||` operators in `e`, as the branch facts count them. */
function leafOperandCount(e: Expression): number {
  let n = 1;
  for (const x of traverseAST(e)) {
    if (x.kind === NodeKind.BinaryExpr && ['&&', '||'].includes((x as BinaryExpr).operator)) n++;
  }
  return n;
}

/**
 * Per operand of `if (o1 || o2 || ...) EXIT` that comma-expand splits, whether its test goes
 * into one guard with the next operand: the original's exit code lies after both operands'
 * tests. One guard per test puts each guard's exit right after its own test, and VC8
 * cross-jumps the copies into one; a leading guard that leaves before the registers the rest
 * needs are saved keeps a copy of its own, which the original, with a register pushed before
 * the first test and every test jumping to one return, does not show (ITEMEVENT_LifeTap
 * 005c6530). Null without per-operand facts or when the exit's place is unknown; an operand
 * with an assignment always starts a guard of its own.
 */
function sharedGuards(ifs: IfStmt, ops: Expression[], exit: Statement, layout: LayoutCtx): boolean[] | null {
  const line = ifs.location?.start.line ?? 0;
  if (layout.loopIfs.has(line)) return null;
  const counts = ops.map(op => leafOperandCount(splitComma(op).cond));
  const facts = layout.reader.operandBranches(ifs);
  const cb = layout.reader.cbranch(ifs);
  if (!facts || cb === null || facts.length !== counts.reduce((a, b) => a + b, 0)) return null;
  const at = layout.reader.entry([exit], cb) ?? (exit.kind === NodeKind.ReturnStmt ? layout.reader.returnCopy(exit as ReturnStmt) : null);
  if (at === null) return null;
  const ranges: [number, number][] = [];
  let k = 0;
  for (const c of counts) {
    const segs = facts.slice(k, k + c).flat();
    k += c;
    if (segs.length === 0) return null;
    ranges.push([Math.min(...segs), Math.max(...segs)]);
  }
  // Two tests go into one guard when the exit lies past both: each jumps forward to it, as
  // the tests of one `||` do. A test after the exit jumps back to it, as a guard of its own
  // cross-jumped into the earlier copy does.
  return ops.map((_, i) => i < ops.length - 1 && at > ranges[i + 1][1]);
}

/** The original's layout for the function being expanded (early run only). */
interface LayoutCtx {
  reader: LayoutReader;
  /** Lines of the ifs inside a loop. */
  loopIfs: Set<number>;
}

function labelsIn(stmts: readonly Statement[]): boolean {
  for (const s of stmts) for (const n of traverseAST(s)) if (n.kind === NodeKind.LabelStmt) return true;
  return false;
}

/**
 * `if (A || (x = e, B)) return R; REST` where the return lies after REST in the original:
 * `if (!A) { x = e; if (!B) { REST } } return R;`, or null.
 */
function nestOrGuard(ifs: IfStmt, rest: readonly Statement[], ctx: LayoutCtx): Statement[] | null {
  if (rest.length === 0 || ifs.elseBranch || ifs.init) return null;
  const exit = asEarlyExit(ifs.thenBranch);
  if (!exit || exit.kind !== NodeKind.ReturnStmt || !(exit as ReturnStmt).value) return null;
  const ops = flattenChain(ifs.condition, '||');
  if (ops.length < 2 || !hasCommaOperand(ops)) return null;
  const line = ifs.location?.start.line ?? 0;
  if (ctx.loopIfs.has(line)) return null;
  if (!leaves(rest[rest.length - 1], new Set(DEFAULT_NORETURN_FUNCTIONS))) return null;
  if (labelsIn(rest) || holdsFreeCase([...rest])) return null;
  const cb = ctx.reader.cbranch(ifs);
  if (cb === null) return null;
  const r = ctx.reader.entry([exit], cb), b = ctx.reader.entry(rest, cb);
  if (r === null || b === null || r < b) return null;
  const body: CompoundStmt = { kind: NodeKind.CompoundStmt, statements: [...rest], location: rest[0].location, leadingTrivia: [], trailingTrivia: [] };
  return [...buildNestedChain(ops, body, ifs.leadingTrivia, true, ifs.location), exit];
}

function expandBlock(block: CompoundStmt, layout: LayoutCtx | null = null): CompoundStmt | null {
  const out: Statement[] = [];
  let changed = false;
  for (let i = 0; i < block.statements.length; i++) {
    const s = block.statements[i];
    if (layout && s.kind === NodeKind.IfStmt) {
      const nested = nestOrGuard(s as IfStmt, block.statements.slice(i + 1), layout);
      if (nested) {
        out.push(...nested);
        changed = true;
        break;
      }
    }
    const repl = expandStatement(s, layout);
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

function createCommaExpandTransformer(ev: BranchLayoutEvidence | null = null): Transformer {
  let layout: LayoutCtx | null = null;
  // A single bottom-up pass. `onChange` fires whenever a node is rewritten so
  // the caller can iterate to a fixpoint.
  const onePass = (root: ASTNode, onChange: () => void): ASTNode =>
    createTransformer({
      visitNode(node: ASTNode): ASTNode | undefined {
        if (node.kind === NodeKind.CompoundStmt) {
          const r = expandBlock(node as CompoundStmt, layout);
          if (r) { onChange(); return r; }
          return undefined;
        }
        if (node.kind === NodeKind.WhileStmt) {
          const r = expandWhile(node as WhileStmt);
          if (r) { onChange(); return r; }
          return undefined;
        }
        return undefined;
      },
    })(root);

  // Re-run until a pass finds no more comma/short-circuit messes to lower, so
  // cases revealed by an earlier expansion are also caught. Bounded for safety.
  const fixpoint = (root: ASTNode): ASTNode => {
    let cur = root;
    for (let pass = 0; pass < 16; pass++) {
      let changed = false;
      cur = onePass(cur, () => { changed = true; });
      if (!changed) break;
    }
    return cur;
  };
  if (!ev) return fixpoint;
  // With the layout, each function is expanded with a reader of its body as it came in.
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      const loopIfs = new Set<number>();
      const go = (n: ASTNode, inLoop: boolean): void => {
        if (n.kind === NodeKind.IfStmt && inLoop && n.location) loopIfs.add(n.location.start.line);
        for (const k of getChildren(n)) go(k, inLoop || isLoop(n));
      };
      go(fn.body, false);
      layout = { reader: new LayoutReader(ev, fn.body), loopIfs };
      try {
        const body = fixpoint(fn.body);
        return body === fn.body ? undefined : updateNode(fn, { body } as Partial<FunctionDecl>);
      } finally {
        layout = null;
      }
    },
  });
}

export interface CommaExpandOptions extends PluginOptions {
  /** The original's addresses (branch-layout/evidence.ts); absent: every `||` guard is split. */
  branchLayout?: BranchLayoutEvidence | null;
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

  createTransformer(options?: CommaExpandOptions) {
    return createCommaExpandTransformer(options?.branchLayout ?? null);
  },
};

/**
 * The same lowering after goto structuring (goto-cleanup 55, loop-rotation-undo 56,
 * short-circuit-fold 57, dead-branch-cleanup 58) and before early-return (60): an
 * `if (A || (X, B)) goto L;` the early run left alone has by now become the negated
 * no-else form when goto-cleanup structured it.
 */
export const commaExpandLatePlugin: TransformPlugin = {
  ...commaExpandPlugin,
  id: 'comma-expand-late',
  name: 'Comma Expression Expansion (after goto structuring)',
  priority: 59,
};
