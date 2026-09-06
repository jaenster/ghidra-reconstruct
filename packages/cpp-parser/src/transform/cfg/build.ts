/**
 * Build a control-flow graph over a region — one compound's statement list.
 *
 * The region is a SLICE of a function, not the whole of it, because that is the unit the
 * transform passes work on. Two consequences shape the design:
 *
 *   - A `goto` whose label is not defined in the region leaves it. So does a `break` with
 *     no enclosing loop/switch in the region. Both land on the synthetic `external` node
 *     rather than being dropped, so a comparison can see that an edge out still exists.
 *   - A label defined in the region may be targeted from OUTSIDE it, and a `case` whose
 *     `switch` is outside the region is reached by that switch's dispatch. Both are entry
 *     points of the region. Missing the second is the bug that deleted 170 switch arms.
 */

import { NodeKind } from '../../ast/kinds.js';
import type {
  CaseStmt,
  CompoundStmt,
  DefaultStmt,
  DoWhileStmt,
  ForRangeStmt,
  ForStmt,
  GotoStmt,
  IfStmt,
  LabelStmt,
  ReturnStmt,
  Statement,
  SwitchStmt,
  TryStmt,
  WhileStmt,
} from '../../ast/nodes.js';
import { emit } from '../../emit/index.js';
import type { Cfg, CfgNode, BuildCfgOptions } from './types.js';
import { countGotoTargets } from './labels.js';

/**
 * Canonical spelling of a statement's observable work, or null for scaffolding.
 *
 * Cached on the node: the transformer shallow-copies only the path it rewrites, so an
 * untouched subtree keeps its identity across candidates and re-emits nothing.
 */
const keyCache = new WeakMap<object, string | null>();

export function workKey(s: Statement): string | null {
  const hit = keyCache.get(s as object);
  if (hit !== undefined) return hit;
  const key = computeWorkKey(s);
  keyCache.set(s as object, key);
  return key;
}

function computeWorkKey(s: Statement): string | null {
  switch (s.kind) {
    case NodeKind.ExprStmt:
      return 'e:' + emit(s);
    case NodeKind.DeclStmt:
      return 'd:' + emit(s);
    case NodeKind.ReturnStmt: {
      const v = (s as ReturnStmt).value;
      // A bare `return;` is control flow, not work: it is what falling off the end of a
      // void body already does. These passes fabricate one wherever they turn an implicit
      // fallthrough into an explicit exit, and keying it would report every such rewrite
      // as having lost the edge into the exit. A `return;` inserted somewhere it does not
      // belong still gets caught — by the work AFTER it going unreachable.
      return v ? 'r:' + emit(v) : null;
    }
    case NodeKind.CaseStmt:
      // A case label IS work: it is the only evidence in the tree that this arm exists.
      return 'c:' + emit((s as CaseStmt).value);
    case NodeKind.DefaultStmt:
      return 'c:default';
    default:
      return null;
  }
}

interface Builder {
  nodes: CfgNode[];
  labelNodes: Map<string, number>;
  pendingGotos: { from: number; label: string }[];
  /** Case/default nodes whose enclosing switch is outside the region. */
  regionCaseEntries: number[];
  external: number;
  exit: number;
}

function addNode(b: Builder, stmt: Statement | null, role: CfgNode['role']): number {
  const id = b.nodes.length;
  b.nodes.push({ id, role, stmt, key: stmt ? workKey(stmt) : null, succ: [] });
  return id;
}

interface Ctx {
  /** Where `break` goes, or null when there is no enclosing loop/switch in the region. */
  breakTarget: number | null;
  /** Where `continue` goes, or null when there is no enclosing loop in the region. */
  continueTarget: number | null;
  /**
   * Case entries found here belong to this switch's dispatch. Null when no switch of the
   * region encloses us, which makes any case found an ENTRY POINT of the region.
   */
  caseSink: number[] | null;
}

/**
 * Build the graph for `stmts` followed by `next`, and return the id of the node control
 * reaches first. Statements are emitted right-to-left so that fallthrough is just the
 * continuation the previous step returned.
 */
function emitSeq(b: Builder, stmts: Statement[], next: number, ctx: Ctx): number {
  let cur = next;
  for (let i = stmts.length - 1; i >= 0; i--) {
    cur = emitStmt(b, stmts[i], cur, ctx);
  }
  return cur;
}

function emitStmt(b: Builder, s: Statement, next: number, ctx: Ctx): number {
  switch (s.kind) {
    case NodeKind.CompoundStmt:
      return emitSeq(b, (s as CompoundStmt).statements, next, ctx);

    case NodeKind.IfStmt: {
      const n = s as IfStmt;
      const id = addNode(b, s, 'stmt');
      const thenEntry = emitStmt(b, n.thenBranch, next, ctx);
      const elseEntry = n.elseBranch ? emitStmt(b, n.elseBranch, next, ctx) : next;
      b.nodes[id].succ = elseEntry === thenEntry ? [thenEntry] : [thenEntry, elseEntry];
      if (n.init) return emitStmt(b, n.init, id, ctx);
      return id;
    }

    case NodeKind.SwitchStmt: {
      const n = s as SwitchStmt;
      const id = addNode(b, s, 'stmt');
      const sink: number[] = [];
      const bodyEntry = emitStmt(b, n.body, next, {
        breakTarget: next,
        continueTarget: ctx.continueTarget,
        caseSink: sink,
      });
      // The dispatch reaches every case label. A switch with no `default` can also fall
      // straight past. `bodyEntry` is only reachable when a statement precedes the first
      // case label — Ghidra emits those, so keep the edge.
      const hasDefault = sink.some(cid => b.nodes[cid].stmt?.kind === NodeKind.DefaultStmt);
      const succ = new Set<number>(sink);
      if (!hasDefault) succ.add(next);
      succ.add(bodyEntry);
      b.nodes[id].succ = [...succ];
      if (n.init) return emitStmt(b, n.init, id, ctx);
      return id;
    }

    case NodeKind.CaseStmt:
    case NodeKind.DefaultStmt: {
      const inner = s.kind === NodeKind.CaseStmt
        ? (s as CaseStmt).statement
        : (s as DefaultStmt).statement;
      const id = addNode(b, s, 'stmt');
      b.nodes[id].succ = [emitStmt(b, inner, next, ctx)];
      if (ctx.caseSink) ctx.caseSink.push(id);
      else b.regionCaseEntries.push(id);
      return id;
    }

    case NodeKind.LabelStmt: {
      const n = s as LabelStmt;
      const id = addNode(b, s, 'stmt');
      b.nodes[id].succ = [emitStmt(b, n.statement, next, ctx)];
      b.labelNodes.set(n.label.name, id);
      return id;
    }

    case NodeKind.GotoStmt: {
      const id = addNode(b, s, 'stmt');
      b.pendingGotos.push({ from: id, label: (s as GotoStmt).label.name });
      return id;
    }

    case NodeKind.ReturnStmt: {
      const id = addNode(b, s, 'stmt');
      b.nodes[id].succ = [b.exit];
      return id;
    }

    case NodeKind.BreakStmt: {
      const id = addNode(b, s, 'stmt');
      b.nodes[id].succ = [ctx.breakTarget ?? b.external];
      return id;
    }

    case NodeKind.ContinueStmt: {
      const id = addNode(b, s, 'stmt');
      b.nodes[id].succ = [ctx.continueTarget ?? b.external];
      return id;
    }

    case NodeKind.WhileStmt: {
      const n = s as WhileStmt;
      const id = addNode(b, s, 'stmt');
      const bodyEntry = emitStmt(b, n.body, id, { ...ctx, breakTarget: next, continueTarget: id });
      b.nodes[id].succ = bodyEntry === next ? [next] : [bodyEntry, next];
      return id;
    }

    case NodeKind.DoWhileStmt: {
      const n = s as DoWhileStmt;
      const id = addNode(b, s, 'stmt');
      const bodyEntry = emitStmt(b, n.body, id, { ...ctx, breakTarget: next, continueTarget: id });
      b.nodes[id].succ = bodyEntry === next ? [next] : [bodyEntry, next];
      return bodyEntry;
    }

    case NodeKind.ForStmt: {
      const n = s as ForStmt;
      const condId = addNode(b, s, 'stmt');
      const incrId = addNode(b, null, 'stmt');
      b.nodes[incrId].succ = [condId];
      const bodyEntry = emitStmt(b, n.body, incrId, {
        ...ctx, breakTarget: next, continueTarget: incrId,
      });
      b.nodes[condId].succ = bodyEntry === next ? [next] : [bodyEntry, next];
      return n.init ? emitStmt(b, n.init, condId, ctx) : condId;
    }

    case NodeKind.ForRangeStmt: {
      const n = s as ForRangeStmt;
      const condId = addNode(b, s, 'stmt');
      const bodyEntry = emitStmt(b, n.body, condId, {
        ...ctx, breakTarget: next, continueTarget: condId,
      });
      b.nodes[condId].succ = bodyEntry === next ? [next] : [bodyEntry, next];
      return n.init ? emitStmt(b, n.init, condId, ctx) : condId;
    }

    case NodeKind.TryStmt: {
      // Every handler is reachable from anywhere in the body; modelling that precisely
      // buys nothing here, so treat body and handlers as alternatives from one node.
      const n = s as TryStmt;
      const id = addNode(b, s, 'stmt');
      const targets = [emitStmt(b, n.body, next, ctx)];
      for (const h of n.handlers) targets.push(emitStmt(b, h.body, next, ctx));
      b.nodes[id].succ = [...new Set(targets)];
      return id;
    }

    default: {
      const id = addNode(b, s, 'stmt');
      b.nodes[id].succ = [next];
      return id;
    }
  }
}

export function buildCfg(stmts: Statement[], options: BuildCfgOptions = {}): Cfg {
  const b: Builder = {
    nodes: [],
    labelNodes: new Map(),
    pendingGotos: [],
    regionCaseEntries: [],
    external: -1,
    exit: -1,
  };
  const entry = addNode(b, null, 'entry');
  b.exit = addNode(b, null, 'exit');
  b.external = addNode(b, null, 'external');

  const first = emitSeq(b, stmts, b.exit, { breakTarget: null, continueTarget: null, caseSink: null });
  b.nodes[entry].succ = [first];

  // Backward gotos target labels created after the goto (statements are emitted
  // right-to-left), so every goto edge is patched once the region is complete.
  for (const g of b.pendingGotos) {
    b.nodes[g.from].succ = [b.labelNodes.get(g.label) ?? b.external];
  }

  const extraEntries = [...b.regionCaseEntries];
  const inside = countGotoTargets(stmts);
  const outer = options.externalGotoCounts;
  for (const [name, id] of b.labelNodes) {
    // No whole-function counts AT ALL: assume every label is reachable from outside.
    // Deleting less than we could is a cost; deleting something live is a defect. A map
    // that was supplied and simply has no entry for this label means ZERO gotos, not
    // "unknown" — reading those two the same way protects every dead label forever.
    if (!outer || (outer.get(name) ?? 0) > (inside.get(name) ?? 0)) extraEntries.push(id);
  }
  return { nodes: b.nodes, entry, exit: b.exit, external: b.external, extraEntries };
}
