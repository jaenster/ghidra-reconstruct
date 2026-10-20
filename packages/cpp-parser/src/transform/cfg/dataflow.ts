/**
 * Variable dataflow over the statement CFG: which assignments reach a point, and whether
 * a variable can change between two points.
 *
 * The flag lowerings (`pseudo-op-lower`) have to prove facts like "every path into this
 * condition last set OF here or there" and "nothing writes x between that assignment and
 * the condition". Answered by looking at neighbouring statements, those questions miss a
 * goto from the far end of the function; answered here, a goto is just an edge.
 *
 * The model is deliberately conservative:
 *   - A variable is a local or parameter, named by an identifier. Writes to a member of a
 *     local struct (`s.x = ...`) are writes of `s`.
 *   - A local whose address is taken anywhere (`&v`, or an array local, which decays) is
 *     ESCAPED: any call and any store through memory may write it.
 *   - Any name that is not a local (a global) is escaped by definition.
 *   - A write is KILLING only when it certainly happens and replaces the whole value: a
 *     top-level `v = e;` statement or a declaration. A write inside a condition, a `+=`, a
 *     `++`, or a write through `s.x` adds a definition without removing the others, and
 *     carries no right-hand side.
 *   - Every variable has a definition at function entry (`ENTRY_DEF`): its parameter value,
 *     or an indeterminate local. A use reached by it has no known value.
 */

import { NodeKind } from '../../ast/kinds.js';
import type {
  AssignExpr,
  ASTNode,
  CommaExpr,
  DeclStmt,
  DoWhileStmt,
  ExprStmt,
  Expression,
  ForStmt,
  Identifier,
  IfStmt,
  MemberExpr,
  PostfixExpr,
  ReturnStmt,
  Statement,
  SubscriptExpr,
  SwitchStmt,
  UnaryExpr,
  VariableDecl,
  WhileStmt,
} from '../../ast/nodes.js';
import { buildCfg } from './build.js';
import { countGotoTargets } from './labels.js';
import type { Cfg } from './types.js';

/** The definition every variable has on entry to the function. */
export const ENTRY_DEF = -1;

export interface Definition {
  node: number;
  /** Replaces the whole value on every execution of the node. */
  killing: boolean;
  /** `v = rhs` / `T v = rhs`: the value stored. Null for any other kind of write. */
  rhs: Expression | null;
}

export interface FunctionFlow {
  cfg: Cfg;
  /** The node a statement became, or undefined for a statement the graph does not hold. */
  nodeOf(stmt: Statement): number | undefined;
  /** The expressions a node evaluates itself (a condition, an expression statement). */
  ownExprs(node: number): Expression[];
  /** Variables the node may write, escaped ones included when it calls or stores. */
  writes(node: number): ReadonlySet<string>;
  /** Variables the node reads. */
  reads(node: number): ReadonlySet<string>;
  /** The definition of `v` the node makes, if any. */
  definition(node: number, v: string): Definition | undefined;
  /** Definitions of `v` that reach the START of `node`. ENTRY_DEF stands for the entry value. */
  reaching(node: number, v: string): ReadonlySet<number>;
  /** Nodes that read `v` with `defNode`'s definition among those reaching them. */
  usesOf(defNode: number, v: string): number[];
  /**
   * Can any of `vars` be written on a path that leaves `from` and arrives at `to`? Paths
   * stop at `to` and at every node in `stop`; `from` itself is not counted, nor is `to`.
   */
  writtenBetween(from: number, to: number, vars: Iterable<string>, stop?: ReadonlySet<number>): boolean;
  /** The nodes `writtenBetween` inspects: strictly inside some from-to path. */
  nodesBetween(from: number, to: number, stop?: ReadonlySet<number>): number[];
  /** True when the variable's address can be taken (and a call or store may write it). */
  isEscaped(v: string): boolean;
}

/** The identifier a write targets, through `.` and local-array `[]`; null for a memory store. */
function writeRoot(e: Expression): { name: string; whole: boolean } | null {
  let x: Expression = e;
  let whole = true;
  for (;;) {
    if (x.kind === NodeKind.ParenExpr) { x = (x as unknown as { expression: Expression }).expression; continue; }
    if (x.kind === NodeKind.Identifier) return { name: (x as Identifier).name, whole };
    if (x.kind === NodeKind.MemberExpr && !(x as MemberExpr).isArrow) { x = (x as MemberExpr).object; whole = false; continue; }
    if (x.kind === NodeKind.SubscriptExpr) { x = (x as SubscriptExpr).array; whole = false; continue; }
    return null;
  }
}

interface NodeFacts {
  own: Expression[];
  reads: Set<string>;
  writes: Set<string>;
  defs: Map<string, Definition>;
  clobbers: boolean;
}

/** Walk `e`, collecting reads and writes. `certain`: the expression always runs to completion. */
function scanExpr(e: Expression, facts: NodeFacts, node: number, certain: boolean, topLevel: boolean): void {
  const visit = (x: ASTNode | null | undefined, sure: boolean, top: boolean): void => {
    if (!x || typeof x !== 'object') return;
    switch (x.kind) {
      case NodeKind.Identifier:
        facts.reads.add((x as Identifier).name);
        return;
      case NodeKind.AssignExpr: {
        const a = x as AssignExpr;
        visit(a.right, sure, false);
        const root = writeRoot(a.left);
        if (!root) {
          facts.clobbers = true;
          visit(a.left, sure, false);
          return;
        }
        // The target's own subexpressions (an index) are reads; a compound assignment and
        // a partial write also read the old value.
        if (a.operator !== '=' || !root.whole) facts.reads.add(root.name);
        if (!root.whole) visitTargetIndices(a.left);
        facts.writes.add(root.name);
        const simple = top && sure && root.whole && a.operator === '=';
        const prev = facts.defs.get(root.name);
        facts.defs.set(root.name, {
          node,
          killing: (prev?.killing ?? false) || (sure && root.whole),
          rhs: simple ? a.right : null,
        });
        return;
      }
      case NodeKind.UnaryExpr: {
        const u = x as UnaryExpr;
        if (u.operator === '++' || u.operator === '--') {
          incDec(u.operand, sure);
          return;
        }
        visit(u.operand, sure, false);
        return;
      }
      case NodeKind.PostfixExpr:
        incDec((x as PostfixExpr).operand, sure);
        return;
      case NodeKind.CallExpr:
        facts.clobbers = true;
        break;
      case NodeKind.CommaExpr: {
        for (const sub of (x as CommaExpr).expressions) visit(sub, sure, top);
        return;
      }
      case NodeKind.BinaryExpr: {
        const b = x as unknown as { operator: string; left: Expression; right: Expression };
        visit(b.left, sure, false);
        // The right operand of && / || runs only sometimes.
        visit(b.right, sure && b.operator !== '&&' && b.operator !== '||', false);
        return;
      }
      case NodeKind.ConditionalExpr: {
        const c = x as unknown as { condition: Expression; thenExpr: Expression; elseExpr: Expression };
        visit(c.condition, sure, false);
        visit(c.thenExpr, false, false);
        visit(c.elseExpr, false, false);
        return;
      }
      case NodeKind.MemberExpr:
        visit((x as MemberExpr).object, sure, false);
        return;
      default:
        break;
    }
    for (const [k, v] of Object.entries(x)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'type') continue;
      if (Array.isArray(v)) { for (const it of v) if (it && typeof it === 'object' && 'kind' in it) visit(it as ASTNode, sure, false); }
      else if (v && typeof v === 'object' && 'kind' in (v as object)) visit(v as ASTNode, sure, false);
    }
  };
  const visitTargetIndices = (t: Expression): void => {
    let x: Expression = t;
    for (;;) {
      if (x.kind === NodeKind.ParenExpr) { x = (x as unknown as { expression: Expression }).expression; continue; }
      if (x.kind === NodeKind.MemberExpr && !(x as MemberExpr).isArrow) { x = (x as MemberExpr).object; continue; }
      if (x.kind === NodeKind.SubscriptExpr) { visit((x as SubscriptExpr).index, true, false); x = (x as SubscriptExpr).array; continue; }
      return;
    }
  };
  const incDec = (operand: Expression, sure: boolean): void => {
    const root = writeRoot(operand);
    if (!root) { facts.clobbers = true; visit(operand, sure, false); return; }
    facts.reads.add(root.name);
    facts.writes.add(root.name);
    const prev = facts.defs.get(root.name);
    facts.defs.set(root.name, { node, killing: (prev?.killing ?? false) || (sure && root.whole), rhs: null });
  };
  visit(e, certain, topLevel);
}

/** Every `&v` in the body, and every local declared as an array. */
function escapedLocals(body: ASTNode): Set<string> {
  const out = new Set<string>();
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) { for (const i of x) walk(i); return; }
    if (!x || typeof x !== 'object') return;
    const n = x as ASTNode;
    if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
      const r = writeRoot((n as UnaryExpr).operand);
      if (r) out.add(r.name);
    }
    if (n.kind === NodeKind.VariableDecl) {
      const t = (n as VariableDecl).type as unknown as { kind: NodeKind };
      if (t && t.kind === NodeKind.ArrayType) out.add((n as VariableDecl).name.name);
    }
    for (const [k, v] of Object.entries(n)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
      if (v && typeof v === 'object') walk(v);
    }
  };
  walk(body);
  return out;
}

/**
 * Build the dataflow facts for a function body. `locals` names the parameters and every
 * local the body declares; any other identifier is treated as a global (escaped).
 */
export function buildFunctionFlow(body: Statement[], locals: ReadonlySet<string>): FunctionFlow {
  // Every label of the function is in the region, so no label counts as an outside entry.
  const cfg = buildCfg(body, { externalGotoCounts: countGotoTargets(body) });
  const escaped = escapedLocals(body as unknown as ASTNode);
  const isEscaped = (v: string) => !locals.has(v) || escaped.has(v);

  const stmtNode = new Map<object, number>();
  const facts: NodeFacts[] = cfg.nodes.map(n => {
    const f: NodeFacts = { own: [], reads: new Set(), writes: new Set(), defs: new Map(), clobbers: false };
    const s = n.stmt;
    if (s) stmtNode.set(s as object, n.id);
    if (!s) {
      if (n.expr) { f.own.push(n.expr); scanExpr(n.expr, f, n.id, true, false); }
      return f;
    }
    switch (s.kind) {
      case NodeKind.ExprStmt: {
        const e = (s as ExprStmt).expression;
        f.own.push(e);
        scanExpr(e, f, n.id, true, true);
        break;
      }
      case NodeKind.DeclStmt:
        for (const d of (s as DeclStmt).declarations) {
          if (d.kind !== NodeKind.VariableDecl) continue;
          const v = d as VariableDecl;
          const init = v.initializer && v.initializer.kind !== NodeKind.InitListExpr ? v.initializer as Expression : null;
          if (init) { f.own.push(init); scanExpr(init, f, n.id, true, false); }
          else if (v.initializer) scanExpr(v.initializer as unknown as Expression, f, n.id, true, false);
          f.writes.add(v.name.name);
          f.defs.set(v.name.name, { node: n.id, killing: true, rhs: init });
        }
        break;
      case NodeKind.IfStmt:
        f.own.push((s as IfStmt).condition);
        scanExpr((s as IfStmt).condition, f, n.id, true, false);
        break;
      case NodeKind.SwitchStmt:
        f.own.push((s as SwitchStmt).condition);
        scanExpr((s as SwitchStmt).condition, f, n.id, true, false);
        break;
      case NodeKind.WhileStmt:
        f.own.push((s as WhileStmt).condition);
        scanExpr((s as WhileStmt).condition, f, n.id, true, false);
        break;
      case NodeKind.DoWhileStmt:
        f.own.push((s as DoWhileStmt).condition);
        scanExpr((s as DoWhileStmt).condition, f, n.id, true, false);
        break;
      case NodeKind.ForStmt: {
        const c = (s as ForStmt).condition;
        if (c) { f.own.push(c); scanExpr(c, f, n.id, true, false); }
        break;
      }
      case NodeKind.ReturnStmt: {
        const v = (s as ReturnStmt).value;
        if (v) { f.own.push(v); scanExpr(v, f, n.id, true, false); }
        break;
      }
      case NodeKind.TryStmt:
      case NodeKind.ForRangeStmt:
        // Not modelled: assume the node may do anything.
        f.clobbers = true;
        for (const v of locals) f.writes.add(v);
        break;
      default:
        break;
    }
    return f;
  });

  // Escaped variables are written by every call and store through memory.
  const allEscaped = new Set<string>([...escaped]);
  const writesOf = facts.map(f => {
    if (!f.clobbers) return f.writes;
    const w = new Set(f.writes);
    for (const v of allEscaped) w.add(v);
    return w;
  });
  const isWrittenBy = (node: number, v: string) => writesOf[node].has(v) || (facts[node].clobbers && !locals.has(v));

  const preds: number[][] = cfg.nodes.map(() => []);
  for (const n of cfg.nodes) for (const s of n.succ) preds[s].push(n.id);

  /**
   * Nodes strictly inside some path from `from` to `to` that passes through neither
   * again, nor a `stop` node: forward-reachable from `from` AND backward-reachable from `to`.
   * A branch that never reaches `to` cannot change what `to` sees.
   */
  const onPathsBetween = (from: number, to: number, stop?: ReadonlySet<number>): number[] => {
    const blocked = (id: number) => id === to || id === from || (stop?.has(id) ?? false);
    const fwd = new Set<number>();
    const fstack = cfg.nodes[from].succ.filter(id => !blocked(id));
    while (fstack.length) {
      const id = fstack.pop()!;
      if (fwd.has(id)) continue;
      fwd.add(id);
      for (const s of cfg.nodes[id].succ) if (!blocked(s)) fstack.push(s);
    }
    const out: number[] = [];
    const bwd = new Set<number>();
    const bstack = preds[to].filter(id => !blocked(id));
    while (bstack.length) {
      const id = bstack.pop()!;
      if (bwd.has(id)) continue;
      bwd.add(id);
      if (fwd.has(id)) out.push(id);
      for (const p of preds[id]) if (!blocked(p)) bstack.push(p);
    }
    return out;
  };

  const reachCache = new Map<string, Array<Set<number>>>();
  const reachingAll = (v: string): Array<Set<number>> => {
    const hit = reachCache.get(v);
    if (hit) return hit;
    const IN: Array<Set<number>> = cfg.nodes.map(() => new Set<number>());
    const OUT: Array<Set<number>> = cfg.nodes.map(() => new Set<number>());
    IN[cfg.entry].add(ENTRY_DEF);
    // Extra entries (none when every label is in the region) see the entry value too.
    for (const e of cfg.extraEntries) IN[e].add(ENTRY_DEF);
    const transfer = (id: number) => {
      const out = new Set<number>();
      const d = facts[id].defs.get(v);
      const killed = d?.killing ?? false;
      if (!killed) for (const x of IN[id]) out.add(x);
      if (d || isWrittenBy(id, v)) out.add(id);
      return out;
    };
    const work: number[] = cfg.nodes.map(n => n.id);
    const queued = new Set(work);
    while (work.length) {
      const id = work.shift()!;
      queued.delete(id);
      if (id !== cfg.entry) {
        const inn = new Set<number>(id === cfg.entry ? [ENTRY_DEF] : []);
        if (cfg.extraEntries.includes(id)) inn.add(ENTRY_DEF);
        for (const p of preds[id]) for (const x of OUT[p]) inn.add(x);
        IN[id] = inn;
      }
      const out = transfer(id);
      if (out.size !== OUT[id].size || [...out].some(x => !OUT[id].has(x))) {
        OUT[id] = out;
        for (const s of cfg.nodes[id].succ) if (!queued.has(s)) { queued.add(s); work.push(s); }
      }
    }
    reachCache.set(v, IN);
    return IN;
  };

  return {
    cfg,
    nodeOf: (stmt) => stmtNode.get(stmt as object),
    ownExprs: (node) => facts[node].own,
    writes: (node) => writesOf[node],
    reads: (node) => facts[node].reads,
    definition: (node, v) => {
      const d = facts[node].defs.get(v);
      if (d) return d;
      return isWrittenBy(node, v) ? { node, killing: false, rhs: null } : undefined;
    },
    reaching: (node, v) => reachingAll(v)[node],
    usesOf: (defNode, v) => {
      const IN = reachingAll(v);
      const out: number[] = [];
      for (const n of cfg.nodes) if (facts[n.id].reads.has(v) && IN[n.id].has(defNode)) out.push(n.id);
      return out;
    },
    writtenBetween: (from, to, vars, stop) => {
      const vs = [...vars];
      return onPathsBetween(from, to, stop).some(id => vs.some(v => isWrittenBy(id, v)));
    },
    nodesBetween: (from, to, stop) => onPathsBetween(from, to, stop),
    isEscaped,
  };
}
