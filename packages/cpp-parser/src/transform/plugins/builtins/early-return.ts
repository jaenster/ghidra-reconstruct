/**
 * Early-Return (Guard Clause) Plugin
 *
 * Flattens deeply nested `if (cond) { ... } return X;` chains into early-exit
 * guard clauses, which is far more readable than the decompiler's nested style.
 *
 * Rule (applied to a block, repeatedly on its tail):
 *   {
 *     ...prefix
 *     if (C) { BODY }   // no else
 *     return X;         // immediately follows the if (the block's terminator)
 *   }
 * becomes
 *   {
 *     ...prefix
 *     if (!C) return X;
 *     BODY
 *     return X;         // only re-added if BODY can fall through
 *   }
 *
 * Applied to the user's quest-sync example this collapses a 4-deep nest into a
 * flat sequence of `if (state) return 0;` guards. Conservative: only no-`else`
 * ifs whose then-branch is a block, immediately before the terminal return, and
 * the same return value is reused — so it is semantics-preserving. Runs late so
 * it operates on already-cleaned conditions.
 *
 * With the original's addresses (`branchLayout`, see branch-layout/evidence.ts) a guard
 * with a value is not made where the binary contradicts it: a simple condition outside a
 * loop whose BODY's code lies before the return's. VC8 puts a leaving then-arm inline, so
 * there the nest is the form whose layout matches. Where the layout cannot tell the two
 * forms apart (an `&&`/`||` condition is the same control flow either way, an if inside a
 * loop, an arm without code of its own, a BODY that falls through into a copy of the
 * return, a void function's implicit end) the guard is made as before.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  Statement,
  CompoundStmt,
  IfStmt,
  ReturnStmt,
  BinaryExpr,
  UnaryExpr,
  ParenExpr,
  FunctionDecl,
  MethodDecl,
  BuiltinType,
  TypeNode,
} from '../../../ast/nodes.js';
import { createTransformer, cloneNode, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { getChildren } from '../../../ast/visitor.js';
import { LayoutReader, isLoop, type BranchLayoutEvidence } from './branch-layout/evidence.js';
import { conditionShape } from './branch-layout/index.js';

const FLIP: Record<string, BinaryExpr['operator']> = {
  '==': '!=', '!=': '==', '<': '>=', '>': '<=', '<=': '>', '>=': '<',
};

function unwrapParens(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** Logical negation, simplified: flip relational ops, drop a leading `!`, else wrap `!(...)`. */
function invert(e: Expression): Expression {
  const u = unwrapParens(e);
  if (u.kind === NodeKind.BinaryExpr) {
    const b = u as BinaryExpr;
    const flipped = FLIP[b.operator];
    if (flipped) return { ...b, operator: flipped, leadingTrivia: [], trailingTrivia: [] };
  }
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') {
    return (u as UnaryExpr).operand;
  }
  // wrap !(...); parenthesize binary/conditional/assignment to preserve precedence
  const needsParen =
    u.kind === NodeKind.BinaryExpr ||
    u.kind === NodeKind.ConditionalExpr ||
    u.kind === NodeKind.AssignExpr;
  const operand: Expression = needsParen
    ? ({ kind: NodeKind.ParenExpr, expression: u, location: e.location, leadingTrivia: [], trailingTrivia: [] } as ParenExpr)
    : u;
  return { kind: NodeKind.UnaryExpr, operator: '!', operand, location: e.location, leadingTrivia: [], trailingTrivia: [] } as UnaryExpr;
}

function isTerminator(s: Statement): boolean {
  return s.kind === NodeKind.ReturnStmt || s.kind === NodeKind.BreakStmt || s.kind === NodeKind.ContinueStmt;
}

/** Match a no-`else` `if (C) { BODY }` with a non-empty block body. */
function matchGuardIf(s: Statement): { ifs: IfStmt; cond: Expression; body: Statement[] } | null {
  if (s.kind !== NodeKind.IfStmt) return null;
  const ifs = s as IfStmt;
  if (ifs.elseBranch !== null || ifs.init) return null;
  if (ifs.thenBranch.kind !== NodeKind.CompoundStmt) return null;
  const body = (ifs.thenBranch as CompoundStmt).statements;
  if (body.length === 0) return null;
  return { ifs, cond: ifs.condition, body };
}

function makeGuard(srcIf: IfStmt, cond: Expression, ret: ReturnStmt): IfStmt {
  return {
    kind: NodeKind.IfStmt,
    condition: invert(cond),
    thenBranch: cloneNode(ret),
    elseBranch: null,
    isConstexpr: false,
    location: srcIf.location,
    leadingTrivia: srcIf.leadingTrivia || [],
    trailingTrivia: [],
  };
}

/** Whether a guard may replace `if (C) { BODY } ret`: always, unless the layout says otherwise. */
type GuardGate = (ifs: IfStmt, body: Statement[], ret: ReturnStmt) => boolean;

/**
 * Flatten one trailing guard:
 *   A) `... if (C) { BODY } return X;`          → `... if (!C) return X; BODY [return X]`
 *   B) `... if (C) { BODY }`  (voidContext)     → `... if (!C) return; BODY`   (implicit void end)
 */
function flattenOnce(block: CompoundStmt, voidContext: boolean, gate: GuardGate | null): CompoundStmt | null {
  const s = block.statements;
  const n = s.length;
  if (n < 1) return null;
  const last = s[n - 1];

  // Case A: explicit trailing return after the guard
  if (n >= 2 && last.kind === NodeKind.ReturnStmt) {
    const g = matchGuardIf(s[n - 2]);
    if (g && (!gate || gate(g.ifs, g.body, last as ReturnStmt))) {
      const ret = last as ReturnStmt;
      const guard = makeGuard(g.ifs, g.cond, ret);
      const bodyFallsThrough = !isTerminator(g.body[g.body.length - 1]);
      const tail: Statement[] = bodyFallsThrough ? [cloneNode(ret)] : [];
      return { ...block, statements: [...s.slice(0, n - 2), guard, ...g.body, ...tail] };
    }
  }

  // Case B: void function ends with the guard (implicit `return;`)
  if (voidContext) {
    const g = matchGuardIf(last);
    if (g) {
      const voidRet: ReturnStmt = {
        kind: NodeKind.ReturnStmt, value: null, location: last.location, leadingTrivia: [], trailingTrivia: [],
      };
      const guard = makeGuard(g.ifs, g.cond, voidRet);
      // no terminal return appended — the function falls off its (void) end
      return { ...block, statements: [...s.slice(0, n - 1), guard, ...g.body] };
    }
  }

  return null;
}

function flattenBody(block: CompoundStmt, voidContext: boolean, gate: GuardGate | null): CompoundStmt | null {
  let cur = block;
  let changed = false;
  for (let i = 0; i < 256; i++) {
    const next = flattenOnce(cur, voidContext, gate);
    if (!next) break;
    cur = next;
    changed = true;
  }
  return changed ? cur : null;
}

function isVoidReturn(t: TypeNode): boolean {
  return t.kind === NodeKind.BuiltinType && (t as BuiltinType).name === 'void';
}

/** Lines of the ifs inside a loop. */
function loopIfLines(root: ASTNode): Set<number> {
  const out = new Set<number>();
  const go = (n: ASTNode, inLoop: boolean): void => {
    if (n.kind === NodeKind.IfStmt && inLoop) out.add(n.location.start.line);
    const loop = inLoop || isLoop(n);
    for (const k of getChildren(n)) go(k, loop);
  };
  go(root, false);
  return out;
}

/** The gate for one function, read from its body before any guard is made. */
function layoutGate(ev: BranchLayoutEvidence, body: CompoundStmt): GuardGate {
  const reader = new LayoutReader(ev, body);
  const inLoop = loopIfLines(body);
  return (ifs, stmts, ret) => {
    // A bare `return;` has no code of its own: no evidence either way, as in case B.
    if (!ret.value) return true;
    // BODY falling through takes a copy of the return; VC8 merges the two identical tails,
    // and which copy keeps the code is not the layout's to say.
    if (!isTerminator(stmts[stmts.length - 1])) return true;
    // `&&`/`||` guards have the nest's control flow (De Morgan), and a leaving arm in a
    // loop is laid out apart from either form: the layout cannot tell them apart.
    if (conditionShape(ifs.condition).kind !== 'simple' || inLoop.has(ifs.location.start.line)) return true;
    const cb = reader.cbranch(ifs);
    if (cb === null) return true;
    const r = reader.entry([ret], cb), b = reader.entry(stmts, cb);
    return r === null || b === null || r < b;
  };
}

function createEarlyReturnTransformer(gate: GuardGate | null): Transformer {
  return createTransformer({
    visitNode(node: ASTNode): ASTNode | undefined {
      // Any block: flatten explicit-trailing-return guards (Case A).
      if (node.kind === NodeKind.CompoundStmt) {
        return flattenBody(node as CompoundStmt, false, gate) ?? undefined;
      }
      // Function/method bodies: if void-returning, also flatten the implicit-end guard (Case B).
      if (node.kind === NodeKind.FunctionDecl || node.kind === NodeKind.MethodDecl) {
        const fn = node as FunctionDecl | MethodDecl;
        if (fn.body && isVoidReturn(fn.returnType)) {
          const nb = flattenBody(fn.body, true, gate);
          if (nb) return updateNode(fn, { body: nb });
        }
      }
      return undefined;
    },
  });
}

/** Per function: the gate is read from the body as the passes before left it. */
function createGatedTransformer(ev: BranchLayoutEvidence): Transformer {
  return createTransformer({
    visitNode(node: ASTNode): ASTNode | undefined {
      if (node.kind !== NodeKind.FunctionDecl && node.kind !== NodeKind.MethodDecl) return undefined;
      const fn = node as FunctionDecl | MethodDecl;
      if (!fn.body) return undefined;
      return createEarlyReturnTransformer(layoutGate(ev, fn.body))(fn);
    },
  });
}

export interface EarlyReturnOptions extends PluginOptions {
  /** The original's addresses (branch-layout/evidence.ts); absent: every guard is made. */
  branchLayout?: BranchLayoutEvidence | null;
}

/**
 * Early-Return (Guard Clause) Plugin
 *
 * Flattens nested `if (C) { ... } return X;` into `if (!C) return X; ...`.
 */
export const earlyReturnPlugin: TransformPlugin = {
  id: 'early-return',
  name: 'Early Return (Guard Clauses)',
  description:
    'Flatten nested if (C) { ... } return X; chains into early-exit guard clauses (if (!C) return X; ...)',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 60, // late: after structural cleanups (goto-cleanup, loop passes) so conditions are clean
  tags: ['core', 'readability', 'control-flow'],

  createTransformer(options?: EarlyReturnOptions) {
    const ev = options?.branchLayout;
    return ev ? createGatedTransformer(ev) : createEarlyReturnTransformer(null);
  },
};
