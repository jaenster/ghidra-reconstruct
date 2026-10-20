/**
 * Goto census: every goto and label in a function, keyed by the function's ADDRESS.
 *
 * This is measurement only. It never changes the tree. It exists because every number the
 * structuring work is judged by has to be re-derived at the revision being measured, and
 * keyed by address - a name is not a key here (`MakeMissile` exists at 004c57b0 and at
 * 004cd540, and a census keyed by name attributed one's gotos to the other).
 *
 * Two sides are counted:
 *
 *   raw   the decompiler's own text (`codegen-snapshot/functions.ndjson`, field `decompiled`),
 *         parsed with the project's parser. Counted by label PREFIX only.
 *   tree  the emitted tree, one FunctionDecl per `// 1.14d: <addr>` comment. Every goto is
 *         CLASSIFIED (the survey's classes, from its AST position and CFG facts) and counted by
 *         prefix.
 *
 * The prefixes are every name family Ghidra authors, plus our own `__dupN` copies. The
 * acceptance metric covers all of them, not only `LAB_`.
 *
 * The classifier is the one `goto-design/survey.ts` used for the v1126 survey, ported as-is so
 * the census reproduces that survey's numbers on the same tree. Its class names are
 * heuristics from the AST shape; they are a way to read the counts, not a proof of anything.
 */

import {
  NodeKind,
  emit,
  type ASTNode,
  type FunctionDecl,
  type Statement,
} from '@ghidra-mcp/cpp-parser';
import { buildCfg } from '@ghidra-mcp/cpp-parser/transform/cfg/index';

type Any = any;

// ---------------------------------------------------------------------------------------
// Label prefixes
// ---------------------------------------------------------------------------------------

export type LabelPrefix =
  | 'dup'            // `<anything>__dupN` - a copy the generator made of a label it duplicated
  | 'LAB_'
  | 'switchD_caseD_' // switchD_<addr>_caseD_<n>
  | 'switchD_'
  | 'caseD_'
  | 'joined_r0x'
  | 'code_r0x'
  | 'override_jmp_'
  | 'function-symbol' // a goto whose target is a function's own symbol (a Ghidra boundary defect)
  | 'user';           // any other name: a user label in Ghidra, or one a pass renamed

/** Every prefix, in report order. */
export const LABEL_PREFIXES: LabelPrefix[] = [
  'LAB_', 'switchD_caseD_', 'switchD_', 'caseD_', 'joined_r0x', 'code_r0x', 'override_jmp_',
  'dup', 'function-symbol', 'user',
];

/** Prefixes Ghidra authors and the acceptance metric requires to reach zero. */
export const GHIDRA_LABEL_PREFIXES = new Set<LabelPrefix>([
  'LAB_', 'switchD_caseD_', 'switchD_', 'caseD_', 'joined_r0x', 'code_r0x', 'override_jmp_', 'dup',
]);

export function labelPrefix(name: string, functionSymbols?: ReadonlySet<string>): LabelPrefix {
  if (/__dup\d+$/.test(name)) return 'dup';
  if (name.startsWith('LAB_')) return 'LAB_';
  if (name.startsWith('switchD_')) return name.includes('_caseD_') ? 'switchD_caseD_' : 'switchD_';
  if (name.startsWith('caseD_')) return 'caseD_';
  if (name.startsWith('joined_r0x')) return 'joined_r0x';
  if (name.startsWith('code_r0x')) return 'code_r0x';
  if (name.startsWith('override_jmp_')) return 'override_jmp_';
  if (functionSymbols?.has(name)) return 'function-symbol';
  return 'user';
}

// ---------------------------------------------------------------------------------------
// Raw side: counts by prefix
// ---------------------------------------------------------------------------------------

export interface LabelCounts {
  gotos: number;
  labels: number;
  /** label name -> gotos to it */
  gotoTargets: Map<string, number>;
  labelNames: Set<string>;
  byPrefix: Partial<Record<LabelPrefix, number>>;
  /** `if (false)` statements - Ghidra's spelling of a block entered only by jumps. */
  ifFalse: number;
  /** `try` statements (SEH). The structurer refuses regions holding one; counted so they show. */
  tryStmts: number;
}

export function countLabels(body: ASTNode, functionSymbols?: ReadonlySet<string>): LabelCounts {
  const r: LabelCounts = { gotos: 0, labels: 0, gotoTargets: new Map(), labelNames: new Set(), byPrefix: {}, ifFalse: 0, tryStmts: 0 };
  const walk = (n: Any): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const c of n) walk(c); return; }
    if (typeof n.kind !== 'string') return;
    if (n.kind === NodeKind.GotoStmt) {
      const name = n.label.name;
      r.gotos++;
      r.gotoTargets.set(name, (r.gotoTargets.get(name) ?? 0) + 1);
      const p = labelPrefix(name, functionSymbols);
      r.byPrefix[p] = (r.byPrefix[p] ?? 0) + 1;
    } else if (n.kind === NodeKind.LabelStmt) {
      r.labels++;
      r.labelNames.add(n.label.name);
    } else if (n.kind === NodeKind.TryStmt) {
      r.tryStmts++;
    } else if (n.kind === NodeKind.IfStmt && n.condition?.kind === NodeKind.BoolLiteral && n.condition.value === false) {
      r.ifFalse++;
    }
    for (const k of Object.keys(n)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'parent') continue;
      const c = n[k];
      if (c && typeof c === 'object') walk(c);
    }
  };
  walk(body);
  return r;
}

// ---------------------------------------------------------------------------------------
// Tree side: classification (ported from goto-design/survey.ts)
// ---------------------------------------------------------------------------------------

export type GotoClass =
  | 'undefined-label' | 'dead-goto' | 'irreducible' | 'continue' | 'loop-back-edge'
  | 'loop-back-edge-nested' | 'exit-epilogue' | 'exit-cleanup-tail' | 'switch-next-case'
  | 'switch-goto-case' | 'switch-shared-tail' | 'multi-level-break' | 'loop-break'
  | 'loop-exit' | 'switch-exit' | 'if-unstructured' | 'jump-into-loop' | 'into-other-block';

export interface GotoRow {
  label: string;
  prefix: LabelPrefix;
  cls: GotoClass;
  line: number;
  sharedBy: number;
  fallthroughIn: boolean;
  tailStmts: number;
  tailEnd: string;
  inIfFalse: boolean;
}

const LOOPS = new Set<string>([NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForStmt, NodeKind.ForRangeStmt]);

interface Frame { node: Any; field: string; index: number }
interface Site { stmt: Any; chain: Frame[] }

function children(s: Any): [string, number, Any][] {
  const r: [string, number, Any][] = [];
  switch (s.kind) {
    case NodeKind.CompoundStmt: s.statements.forEach((c: Any, i: number) => r.push(['stmts', i, c])); break;
    case NodeKind.IfStmt: r.push(['then', 0, s.thenBranch]); if (s.elseBranch) r.push(['else', 0, s.elseBranch]); break;
    case NodeKind.SwitchStmt: case NodeKind.WhileStmt: case NodeKind.DoWhileStmt: case NodeKind.ForStmt: case NodeKind.ForRangeStmt:
      r.push(['body', 0, s.body]); break;
    case NodeKind.CaseStmt: case NodeKind.DefaultStmt: case NodeKind.LabelStmt: r.push(['stmt', 0, s.statement]); break;
    case NodeKind.TryStmt: r.push(['body', 0, s.body]); s.handlers.forEach((h: Any, i: number) => r.push(['h', i, h.body])); break;
  }
  return r;
}

function collect(s: Any, chain: Frame[], gotos: Site[], labels: Map<string, Site>): void {
  if (s.kind === NodeKind.GotoStmt) gotos.push({ stmt: s, chain });
  if (s.kind === NodeKind.LabelStmt) labels.set(s.label.name, { stmt: s, chain });
  for (const [f, i, c] of children(s)) collect(c, [...chain, { node: s, field: f, index: i }], gotos, labels);
}

function countStmts(s: Any): number {
  if (!s) return 0;
  let n = (s.kind === NodeKind.CompoundStmt || s.kind === NodeKind.LabelStmt || s.kind === NodeKind.NullStmt) ? 0 : 1;
  for (const [, , c] of children(s)) n += countStmts(c);
  return n;
}
const TERM = new Set<string>([NodeKind.ReturnStmt, NodeKind.GotoStmt, NodeKind.BreakStmt, NodeKind.ContinueStmt]);
function innermost(s: Any): Any { while (s && s.kind === NodeKind.LabelStmt) s = s.statement; return s; }
function kindName(s: Any) { return String(s.kind).replace('Stmt', '').toLowerCase(); }

function labelTail(site: Site): { stmts: number; endsIn: string } {
  let k = site.chain.length - 1;
  while (k >= 0 && site.chain[k].node.kind === NodeKind.LabelStmt) k--;
  if (k < 0) return { stmts: 0, endsIn: '?' };
  const fr = site.chain[k];
  if (fr.node.kind !== NodeKind.CompoundStmt) {
    const inner = innermost(site.stmt);
    return { stmts: countStmts(inner), endsIn: TERM.has(inner.kind) ? kindName(inner) : 'single' };
  }
  const list = fr.node.statements as Any[];
  let n = 0, endsIn = 'falloff';
  for (let i = fr.index; i < list.length; i++) {
    const s = innermost(list[i]);
    n += countStmts(s);
    if (TERM.has(s.kind)) { endsIn = kindName(s); break; }
  }
  return { stmts: n, endsIn };
}
function isCaseStart(s: Any): boolean {
  while (s) {
    if (s.kind === NodeKind.CaseStmt || s.kind === NodeKind.DefaultStmt) return true;
    if (s.kind === NodeKind.LabelStmt) { s = s.statement; continue; }
    return false;
  }
  return false;
}
function lcaDepth(a: Frame[], b: Frame[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i].node === b[i].node && a[i].field === b[i].field && a[i].index === b[i].index) i++;
  return i;
}

function dominators(nodes: Any[], roots: number[]) {
  const n = nodes.length;
  const preds: number[][] = Array.from({ length: n }, () => []);
  nodes.forEach((nd: Any) => nd.succ.forEach((s: number) => preds[s].push(nd.id)));
  const seen = new Uint8Array(n), order: number[] = [];
  const pre = new Int32Array(n).fill(-1), post = new Int32Array(n).fill(-1);
  let pc = 0, qc = 0;
  const VROOT = -1;
  for (const r of roots) {
    if (seen[r]) continue;
    const stack: [number, number][] = [[r, 0]]; seen[r] = 1; pre[r] = pc++;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const succ = nodes[top[0]].succ;
      if (top[1] < succ.length) {
        const s = succ[top[1]++];
        if (!seen[s]) { seen[s] = 1; pre[s] = pc++; stack.push([s, 0]); }
      } else { post[top[0]] = qc++; order.push(top[0]); stack.pop(); }
    }
  }
  const rpo = order.slice().reverse();
  const idx = new Int32Array(n).fill(-1); rpo.forEach((v, i) => idx[v] = i);
  const idom = new Int32Array(n).fill(-2);
  for (const r of roots) idom[r] = VROOT;
  const intersect = (a: number, b: number) => {
    while (a !== b) {
      if (a === VROOT || b === VROOT) return VROOT;
      while (a !== VROOT && b !== VROOT && idx[a] > idx[b]) a = idom[a];
      while (a !== VROOT && b !== VROOT && idx[b] > idx[a]) b = idom[b];
      if (a === VROOT || b === VROOT) return VROOT;
    }
    return a;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const v of rpo) {
      if (roots.includes(v)) continue;
      let nd = -2;
      for (const p of preds[v]) { if (idom[p] === -2) continue; nd = nd === -2 ? p : intersect(p, nd); }
      if (nd !== -2 && idom[v] !== nd) { idom[v] = nd; changed = true; }
    }
  }
  const dom = (a: number, b: number) => {
    let x = b;
    while (x !== VROOT && x !== -2) { if (x === a) return true; x = idom[x]; }
    return false;
  };
  return { preds, pre, post, dom };
}

function sccs(nodes: Any[]) {
  const n = nodes.length; let index = 0;
  const idx = new Int32Array(n).fill(-1), low = new Int32Array(n), on = new Uint8Array(n), comp = new Int32Array(n).fill(-1);
  const st: number[] = []; let c = 0;
  for (let v0 = 0; v0 < n; v0++) {
    if (idx[v0] !== -1) continue;
    const work: [number, number][] = [[v0, 0]];
    idx[v0] = low[v0] = index++; st.push(v0); on[v0] = 1;
    while (work.length) {
      const top = work[work.length - 1]; const v = top[0]; const succ = nodes[v].succ;
      if (top[1] < succ.length) {
        const w = succ[top[1]++];
        if (idx[w] === -1) { idx[w] = low[w] = index++; st.push(w); on[w] = 1; work.push([w, 0]); }
        else if (on[w]) low[v] = Math.min(low[v], idx[w]);
      } else {
        work.pop();
        if (work.length) { const u = work[work.length - 1][0]; low[u] = Math.min(low[u], low[v]); }
        if (low[v] === idx[v]) { let w; do { w = st.pop()!; on[w] = 0; comp[w] = c; } while (w !== v); c++; }
      }
    }
  }
  return comp;
}

/** Classify every goto in one function body. */
export function classifyGotos(fn: FunctionDecl, functionSymbols?: ReadonlySet<string>): GotoRow[] {
  const body = fn.body as Any;
  if (!body) return [];
  const gotos: Site[] = []; const labels = new Map<string, Site>();
  collect(body, [], gotos, labels);
  if (!gotos.length) return [];
  const cfg = buildCfg(body.statements as Statement[], {});
  const nodeOf = new Map<Any, number>();
  for (const nd of cfg.nodes) if (nd.stmt && !nodeOf.has(nd.stmt)) nodeOf.set(nd.stmt, nd.id);
  const { preds, pre, post, dom } = dominators(cfg.nodes, [cfg.entry]);
  const comp = sccs(cfg.nodes);
  const compEntries = new Map<number, Set<number>>(); const compSize = new Map<number, number>();
  for (const nd of cfg.nodes) compSize.set(comp[nd.id], (compSize.get(comp[nd.id]) ?? 0) + 1);
  for (const nd of cfg.nodes) for (const s of nd.succ) if (comp[s] !== comp[nd.id] && compSize.get(comp[s])! > 1) {
    if (!compEntries.has(comp[s])) compEntries.set(comp[s], new Set());
    compEntries.get(comp[s])!.add(s);
  }
  const irrComp = (c: number) => (compEntries.get(c)?.size ?? 0) > 1;
  const gcount = new Map<string, number>();
  for (const g of gotos) gcount.set(g.stmt.label.name, (gcount.get(g.stmt.label.name) ?? 0) + 1);

  const rows: GotoRow[] = [];
  for (const g of gotos) {
    const name = g.stmt.label.name;
    const L = labels.get(name);
    const base = {
      label: name, prefix: labelPrefix(name, functionSymbols), line: g.stmt.location?.start?.line ?? 0,
      sharedBy: gcount.get(name) ?? 0,
    };
    if (!L) {
      rows.push({ ...base, cls: 'undefined-label', fallthroughIn: false, tailStmts: 0, tailEnd: '?', inIfFalse: false });
      continue;
    }
    const d = lcaDepth(g.chain, L.chain);
    const lp = L.chain[L.chain.length - 1];
    const gAtLcaFrame = g.chain[L.chain.length - 1];
    const labelEncloses = d >= L.chain.length - 1 && !!gAtLcaFrame && gAtLcaFrame.node === lp?.node;
    const crossedUp = g.chain.slice(d + 1).map(f => f.node.kind);
    const crossedDown = L.chain.slice(d + 1).map(f => f.node.kind);
    const upLoops = crossedUp.filter(k => LOOPS.has(k)).length;
    const downLoops = crossedDown.filter(k => LOOPS.has(k)).length;
    const upSwitch = crossedUp.filter(k => k === NodeKind.SwitchStmt).length;
    const gLoops = g.chain.filter(f => LOOPS.has(f.node.kind)).map(f => f.node);
    let siblingCase = false, caseFallthroughLike = false, labelAtCaseStart = false;
    for (let k = 0; k < Math.min(g.chain.length, L.chain.length) - 1; k++) {
      if (g.chain[k].node !== L.chain[k].node) break;
      if (g.chain[k].node.kind === NodeKind.SwitchStmt && g.chain[k + 1].node === L.chain[k + 1].node
        && g.chain[k + 1].node.kind === NodeKind.CompoundStmt) {
        const list = g.chain[k + 1].node.statements as Any[];
        const grp = (i: number) => { let c = 0; for (let j = 0; j <= i; j++) if (isCaseStart(list[j])) c++; return c; };
        const gi = g.chain[k + 1].index, li = L.chain[k + 1].index;
        const gg = grp(gi), lg = grp(li);
        if (gg !== lg) {
          siblingCase = true;
          labelAtCaseStart = isCaseStart(list[li]) || (li > 0 && isCaseStart(list[li - 1]) === false && grp(li - 1) !== lg);
          if (lg === gg + 1) caseFallthroughLike = true;
        }
      }
    }
    const gid = nodeOf.get(g.stmt)!, lid = nodeOf.get(L.stmt)!;
    const reachable = pre[gid] >= 0;
    const retreating = pre[lid] >= 0 && pre[lid] <= pre[gid] && post[lid] >= post[gid];
    const backEdge = retreating && dom(lid, gid);
    const inIrr = irrComp(comp[lid]) && (comp[gid] !== comp[lid] || (retreating && !backEdge));
    const nonGotoPreds = preds[lid].filter(p => cfg.nodes[p].stmt?.kind !== NodeKind.GotoStmt).length;
    const tail = labelTail(L);
    const atTop = L.chain.length === 1 || L.chain.every(f => f.node.kind === NodeKind.CompoundStmt || f.node.kind === NodeKind.LabelStmt);
    let loopHeadLabel = false;
    const lpar = L.chain[L.chain.length - 1];
    const lgp = L.chain[L.chain.length - 2];
    if (lpar && lpar.node.kind === NodeKind.CompoundStmt && lgp && LOOPS.has(lgp.node.kind)) {
      if (lpar.index === 0) loopHeadLabel = true;
    }
    let breakTarget = false;
    if (labelEncloses && upLoops >= 1 && lp.node.kind === NodeKind.CompoundStmt) {
      const prev = lp.node.statements[lp.index - 1];
      if (prev && LOOPS.has(innermost(prev).kind)) breakTarget = true;
    }
    const inIfFalse = L.chain.some(f => f.node.kind === NodeKind.IfStmt && f.field === 'then'
      && f.node.condition?.kind === NodeKind.BoolLiteral && f.node.condition.value === false);
    let cls: GotoClass;
    const contTail = labelEncloses && lgp && LOOPS.has(lgp.node.kind) && gLoops.includes(lgp.node) && tail.endsIn === 'falloff' && tail.stmts <= 3;
    const exitTail = tail.endsIn === 'return' || (atTop && tail.endsIn === 'falloff' && tail.stmts <= 4);
    if (!reachable) cls = 'dead-goto';
    else if (inIrr || (retreating && !backEdge)) cls = 'irreducible';
    else if (retreating) cls = loopHeadLabel && gLoops.includes(lgp?.node) ? 'continue' : (labelEncloses ? 'loop-back-edge' : 'loop-back-edge-nested');
    else if (exitTail) cls = tail.stmts <= 4 ? 'exit-epilogue' : 'exit-cleanup-tail';
    else if (siblingCase) cls = caseFallthroughLike && labelAtCaseStart ? 'switch-next-case' : (labelAtCaseStart ? 'switch-goto-case' : 'switch-shared-tail');
    else if (contTail) cls = 'continue';
    else if (labelEncloses) {
      if (upLoops >= 2) cls = 'multi-level-break';
      else if (upLoops === 1) cls = breakTarget ? 'loop-break' : 'loop-exit';
      else if (upSwitch >= 1) cls = 'switch-exit';
      else cls = 'if-unstructured';
    } else cls = downLoops >= 1 ? 'jump-into-loop' : 'into-other-block';
    rows.push({ ...base, cls, fallthroughIn: nonGotoPreds > 0, tailStmts: tail.stmts, tailEnd: tail.endsIn, inIfFalse });
  }
  return rows;
}

/** The `// 1.14d: <addr>` comment the emitter writes above every function definition. */
export function functionAddress(fn: ASTNode): string | null {
  for (const t of (fn as Any).leadingTrivia ?? []) {
    const m = /\/\/\s*1\.14d:\s*([0-9a-fA-F]{8})\b/.exec(t.text ?? '');
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/** Emitted text, for callers that want to print a site. Never throws. */
export function safeEmit(n: ASTNode): string {
  try { return emit(n as Any); } catch { return ''; }
}
