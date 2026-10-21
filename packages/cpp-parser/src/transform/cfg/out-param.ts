/**
 * Out-parameters: a pointer parameter the function stores through before it reads
 * through it, on every path that returns.
 *
 * `SBigNew(BigData **ppBigData)` writes `*ppBigData` on both of its paths and never
 * reads it first, so whatever its caller left in `*ppBigData` is dead the moment the
 * call is made. MSVC reserves a local's slot with `PUSH ECX` - which also stores ECX
 * there - and the decompiler prints that store (`pNewBigInt = pData;` before
 * `SBigNew(&pNewBigInt)` in SHA1_FromBigIntBytes 0052a270). Whether such a store can be
 * dropped is a question about the CALLEE, and this answers it from the callee's own body.
 *
 * The analysis is a forward must-analysis over the callee's control-flow graph with one
 * bit, "the pointee has been written":
 *   - a store `*p = e` / `p[0] = e` (through casts), executed unconditionally by its node,
 *     sets it, with the width the store writes;
 *   - passing `p` to a call whose own parameter is an out-parameter of at least that
 *     width sets it (the answer is asked recursively, cycles answer no);
 *   - comparing `p` with null (`p == 0`, `!p`, `if (p)`) is neither;
 *   - any other mention of `p` while the bit may be clear is a read: not an out-parameter;
 *   - a node that calls a function that does not return ends its path;
 *   - every path that reaches the function's exit must have the bit set.
 * Anything the graph does not model (try blocks, range-for) answers no.
 */

import { NodeKind } from '../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CallExpr, CStyleCastExpr, Expression, Identifier,
  ParenExpr, Statement, SubscriptExpr, UnaryExpr, IntegerLiteralExpr, QualifiedId,
} from '../../ast/nodes.js';
import { emit } from '../../emit/index.js';
import { buildFunctionFlow } from './dataflow.js';

export interface OutParamContext {
  /** Width in bytes of the object a pointer parameter points at (its declared pointee), or null. */
  pointeeWidth: (paramIndex: number) => number | null;
  /** Bytes a value of the spelled type occupies, or null. */
  typeSize: (spelling: string) => number | null;
  /** A callee's out-parameter width at an argument position, or null when it is not one. */
  calleeOut: (callee: string, index: number) => number | null;
  /** Functions that do not return (bare or qualified names; the last segment is matched too). */
  noreturn: ReadonlySet<string>;
}

const unparen = (e: Expression): Expression => {
  let x = e;
  while (x.kind === NodeKind.ParenExpr) x = (x as ParenExpr).expression;
  return x;
};
const uncast = (e: Expression): { inner: Expression; casts: CStyleCastExpr[] } => {
  const casts: CStyleCastExpr[] = [];
  let x = unparen(e);
  while (x.kind === NodeKind.CStyleCastExpr) { casts.push(x as CStyleCastExpr); x = unparen((x as CStyleCastExpr).expression); }
  return { inner: x, casts };
};
const isName = (e: Expression, p: string) => {
  const x = uncast(e).inner;
  return x.kind === NodeKind.Identifier && (x as Identifier).name === p;
};
const isZero = (e: Expression) => {
  const x = uncast(e).inner;
  return (x.kind === NodeKind.IntegerLiteral && (x as IntegerLiteralExpr).value === 0n) || x.kind === NodeKind.NullptrLiteral;
};

/** Name a call's callee is spelled with (`A::B::f` or `f`), or null for a computed callee. */
export function calleeSpelling(c: CallExpr): string | null {
  const x = unparen(c.callee);
  if (x.kind === NodeKind.Identifier) return (x as Identifier).name;
  if (x.kind === NodeKind.QualifiedId) {
    const q = x as QualifiedId;
    if (q.name.kind !== NodeKind.Identifier) return null;
    const parts = q.qualifier.map(s => (s as Identifier).name);
    if (parts.some(s => typeof s !== 'string')) return null;
    return [...parts, (q.name as Identifier).name].join('::');
  }
  return null;
}

/**
 * The width a store through `target` writes when `target` is `*p` / `p[0]` with p the
 * parameter (casts on p allowed: `*(int *)p`), else null. `declared` is p's own pointee width.
 */
function storeWidth(target: Expression, p: string, declared: number | null, ctx: OutParamContext): number | null {
  const t = unparen(target);
  let ptr: Expression | null = null;
  if (t.kind === NodeKind.UnaryExpr && (t as UnaryExpr).operator === '*') ptr = (t as UnaryExpr).operand;
  else if (t.kind === NodeKind.SubscriptExpr) {
    const s = t as SubscriptExpr;
    const k = uncast(s.index).inner;
    if (k.kind === NodeKind.IntegerLiteral && (k as IntegerLiteralExpr).value === 0n) ptr = s.array;
  }
  if (!ptr) return null;
  const { inner, casts } = uncast(ptr);
  if (inner.kind !== NodeKind.Identifier || (inner as Identifier).name !== p) return null;
  if (casts.length === 0) return declared;
  // The outermost cast is the pointer type the store goes through.
  const spelled = emit(casts[0].type as never).replace(/\s+/g, ' ').trim();
  const m = /^(.*\S)\s*\*$/.exec(spelled);
  return m ? ctx.typeSize(m[1]) : null;
}

interface NodeEffect { use: boolean; store: number | null; noreturn: boolean }

/** What one node's own expressions do to p. */
function effectOf(exprs: Expression[], p: string, declared: number | null, ctx: OutParamContext, isCondition: boolean): NodeEffect {
  const eff: NodeEffect = { use: false, store: null, noreturn: false };
  const visit = (e: ASTNode, certain: boolean, truth: boolean): void => {
    const x = e as Expression;
    switch (x.kind) {
      case NodeKind.Identifier:
        if ((x as Identifier).name === p) { if (!truth) eff.use = true; }
        return;
      case NodeKind.ParenExpr:
        visit((x as ParenExpr).expression, certain, truth);
        return;
      case NodeKind.CStyleCastExpr:
        visit((x as CStyleCastExpr).expression, certain, truth);
        return;
      case NodeKind.AssignExpr: {
        const a = x as AssignExpr;
        visit(a.right, certain, false);
        const w = a.operator === '=' ? storeWidth(a.left, p, declared, ctx) : null;
        if (w !== null) {
          if (certain && (eff.store === null || w > eff.store)) eff.store = w;
          return;
        }
        visit(a.left, certain, false);
        return;
      }
      case NodeKind.UnaryExpr: {
        const u = x as UnaryExpr;
        if (u.operator === '!' && isName(u.operand, p)) return;
        visit(u.operand, certain, false);
        return;
      }
      case NodeKind.BinaryExpr: {
        const b = x as BinaryExpr;
        if ((b.operator === '==' || b.operator === '!=') &&
            ((isName(b.left, p) && isZero(b.right)) || (isName(b.right, p) && isZero(b.left)))) return;
        if (b.operator === '&&' || b.operator === '||') {
          visit(b.left, certain, true);
          visit(b.right, false, true);
          return;
        }
        visit(b.left, certain, false);
        visit(b.right, certain, false);
        return;
      }
      case NodeKind.ConditionalExpr: {
        const c = x as unknown as { condition: Expression; thenExpr: Expression; elseExpr: Expression };
        visit(c.condition, certain, true);
        visit(c.thenExpr, false, false);
        visit(c.elseExpr, false, false);
        return;
      }
      case NodeKind.CallExpr: {
        const c = x as CallExpr;
        const name = calleeSpelling(c);
        visit(c.callee, certain, false);
        c.arguments.forEach((arg, i) => {
          if (isName(arg, p) && name) {
            const w = ctx.calleeOut(name, i);
            if (w !== null) { if (certain && (eff.store === null || w > eff.store)) eff.store = w; return; }
          }
          visit(arg, certain, false);
        });
        if (name && (ctx.noreturn.has(name) || ctx.noreturn.has(name.split('::').pop()!))) eff.noreturn = true;
        return;
      }
      default:
        for (const [k, v] of Object.entries(x as unknown as Record<string, unknown>)) {
          if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'type') continue;
          for (const ch of Array.isArray(v) ? v : [v]) {
            if (ch && typeof ch === 'object' && typeof (ch as { kind?: unknown }).kind === 'string') visit(ch as ASTNode, certain, false);
          }
        }
    }
  };
  for (const e of exprs) visit(e, true, isCondition);
  return eff;
}

/**
 * Out-parameter widths of a function body: parameter index -> the bytes every returning
 * path writes through it before reading through it. Parameters that are not out-parameters
 * are absent.
 */
export function outParamWidths(body: Statement[], params: readonly string[], ctx: OutParamContext): Map<number, number> {
  const out = new Map<number, number>();
  let flow: ReturnType<typeof buildFunctionFlow>;
  try {
    flow = buildFunctionFlow(body, new Set(params));
  } catch {
    return out;
  }
  const { cfg } = flow;
  // Unmodelled statements answer no for every parameter.
  for (const n of cfg.nodes) {
    const k = n.stmt?.kind;
    if (k === NodeKind.TryStmt || k === NodeKind.ForRangeStmt) return out;
  }
  const preds: number[][] = cfg.nodes.map(() => []);
  for (const n of cfg.nodes) for (const s of n.succ) preds[s].push(n.id);

  params.forEach((p, index) => {
    const declared = ctx.pointeeWidth(index);
    if (declared === null) return;
    const effects = cfg.nodes.map(n => {
      const s = n.stmt;
      const cond = !!s && (s.kind === NodeKind.IfStmt || s.kind === NodeKind.WhileStmt || s.kind === NodeKind.DoWhileStmt || s.kind === NodeKind.ForStmt);
      return effectOf(flow.ownExprs(n.id), p, declared, ctx, cond);
    });
    // Must-analysis: inState[n] = AND of the predecessors' out states; width = min over paths.
    // null = not yet known (top). The entry starts clear.
    const IN: (number | 0 | null)[] = cfg.nodes.map(() => null);   // 0 = clear, k>0 = written with width k
    const OUT: (number | 0 | null)[] = cfg.nodes.map(() => null);
    const meet = (a: number | 0 | null, b: number | 0 | null): number | 0 | null =>
      a === null ? b : b === null ? a : Math.min(a, b) as number | 0;
    const work: number[] = [cfg.entry];
    IN[cfg.entry] = 0;
    const transfer = (id: number): number | 0 | null => {
      const i = IN[id];
      if (i === null) return null;
      const e = effects[id];
      // A path through a call that does not return never reaches the exit.
      if (e.noreturn) return Number.MAX_SAFE_INTEGER;
      if (e.store !== null) return Math.max(i, e.store);
      return i;
    };
    let guard = 0;
    while (work.length && guard++ < 200000) {
      const id = work.pop()!;
      if (id !== cfg.entry) {
        let v: number | 0 | null = null;
        for (const pr of preds[id]) v = meet(v, OUT[pr]);
        IN[id] = v;
      }
      const o = transfer(id);
      if (o !== OUT[id]) {
        OUT[id] = o;
        for (const s of cfg.nodes[id].succ) work.push(s);
      }
    }
    if (work.length) return;
    // A read while the pointee may still hold the caller's value: not an out-parameter.
    for (const n of cfg.nodes) {
      if (effects[n.id].use && IN[n.id] === 0) return;
    }
    let atExit: number | 0 | null = null;
    for (const pr of preds[cfg.exit]) atExit = meet(atExit, OUT[pr]);
    // Fallthrough off the end also reaches the exit through the graph's own edges.
    if (atExit === null || atExit === 0 || atExit === Number.MAX_SAFE_INTEGER) return;
    // Every returning path wrote at least `declared`'s worth? Report the narrowest store.
    out.set(index, atExit);
  });
  return out;
}
