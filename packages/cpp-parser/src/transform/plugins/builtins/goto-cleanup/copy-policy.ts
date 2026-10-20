/**
 * When is copying a tail to each goto site faithful to the source? (design section 3.2)
 *
 * The old rule was "the tail is at most 20 statements". Size is not evidence. A size limit
 * is exactly what smears a real `goto error` cleanup block across every site, and what
 * copied whole loops (as "1 statement") into ITEM_DeserializeFromBitBuffer. A tail is copied
 * only when there is evidence the SOURCE wrote it at each site - which is what MSVC's tail
 * merging (cross-jumping) undid. Size is only ever a ceiling on top of the evidence.
 *
 *   E3  macro / intrinsic expansion: the assert/halt sequence (`nLine = N; n =
 *       GetInstructionPointer(); Halt(.., n, nLine); exit(-1);`). Every assert in the
 *       source expanded it at its own site. No ceiling.
 *   E4  terminator tail: `return [expr]`, `break`, `continue` or a noreturn call, plus at
 *       most one phi move (an assignment) before it. At most 4 work nodes.
 *   E6  a short cross-jumped tail with no other explanation, where every site's prefix (the
 *       statement just before the jump, and the label's own fallthrough predecessor) is
 *       present and different from every other's - the phi move or argument setup MSVC
 *       left behind when it merged identical suffixes. At most 3 work nodes and
 *       (sites - 1) x tail <= 8. Accepted by the owner with these limits (design 11);
 *       counted on its own so it can be reviewed or reverted as a class.
 *
 * E1 (library source) and E2 (the Mac partner) need oracles this pass does not have; they
 * arrive with steps 9 and 7.4. E5 (condition-only blocks) is a fold, not a copy.
 *
 * A tail that matches no class is not copied: the goto stays, to be structured some other
 * way or kept and named. Labels and case labels are never copied at all (copy-safety.ts),
 * and the validator proves every copy that is made.
 */

import { NodeKind } from '../../../../ast/kinds.js';
import type { ASTNode, CompoundStmt, Expression, GotoStmt, Statement } from '../../../../ast/nodes.js';
import { getChildren, traverseAST } from '../../../../ast/visitor.js';
import { buildCfg } from '../../../cfg/build.js';
import { countGotoTargets } from '../../../cfg/labels.js';
import { emit } from '../../../../emit/index.js';
import { workNodes, holdsLabelOrCase } from './copy-safety.js';
import { isHaltStep } from '../../../cfg/bcfg.js';
import { recordStat } from './stats.js';
import { gotoReport } from './report.js';

/**
 * `move` is not a copy at all: one goto and nothing falling into the label, so the block
 * ends up in one place either way - the MOVE primitive (design 3.1). It needs no evidence.
 */
export type EvidenceClass = 'move' | 'E3' | 'E4' | 'E6';

export interface SiteInfo {
  /**
   * What distinguishes this site from the others, as text: the statement just before the
   * jump in its block (`s:...`), else - the jump being the first thing in its block - the
   * branch that leads there (`t:`/`f:` + the condition, `c:` + the case value). A branch
   * straight to a shared tail is the classic cross-jump site (`if (c) { f(); return 1; }`
   * compiled to `if (c) goto L`), and its condition is its prefix. Null when nothing
   * identifies the site.
   */
  prefix: string | null;
  /** The goto is the whole body of a `case`/`default` (rule 2: stacked labels, never a copy). */
  caseOnly?: boolean;
  /** The condition of the branch the goto is the first thing in (`if (c) goto L`). */
  branch?: Expression;
}

export interface CopyFacts {
  /** One per goto to the label. */
  sites: SiteInfo[];
  /** The prefix of the label's own fallthrough entry (same encoding); it is a site for E6. */
  fallthroughPrefix?: string | null;
  /** Whether anything falls into the label at all (the label then keeps its tail). */
  hasFallthrough: boolean;
  noreturn: ReadonlySet<string>;
  /**
   * For E6's non-terminating rule (section 11, 2026-10-20 audit): the label the copy is
   * made for (null for a join sunk into arms, which has none), the region holding the tail,
   * and the tail as it sits in that region - the A2 check walks the region's graph.
   */
  label?: string | null;
  region?: Statement[];
  tailInRegion?: Statement[];
  /** The tail's last statement is a `return` the handler made up (its fall-off is the void end). */
  fabricatedReturn?: boolean;
  /**
   * The tail is a join sunk into the arms before it, not the block at `label`: the label's
   * instruction facts describe the jumps to the label, not the join, so A1/A3 do not apply.
   */
  sunkJoin?: boolean;
}

/**
 * How control enters each label of the function being transformed, read from the
 * instructions at extraction (LabelFlow): set by the plugin for the duration of one
 * function, null when the snapshot predates the field.
 */
export interface LabelFlowFacts {
  back: number;
  first: string;
  pushedArgs: boolean;
}
const FLOW_KEY = Symbol.for('ghidra-mcp:goto-label-flow');
export function setGotoLabelFlow(flow: Record<string, LabelFlowFacts> | null): void {
  (globalThis as Record<symbol, unknown>)[FLOW_KEY] = flow;
}
function labelFlowFor(label: string | null | undefined): LabelFlowFacts | null {
  if (!label) return null;
  const m = (globalThis as Record<symbol, unknown>)[FLOW_KEY] as Record<string, LabelFlowFacts> | null | undefined;
  return m?.[label] ?? null;
}

const E4_CEILING = 4;
const E6_CEILING = 3;
const E6_VOLUME = 8;

function strip(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as unknown as { expression: Expression }).expression;
  return e;
}

function calleeName(s: Statement): string | null {
  if (s.kind !== NodeKind.ExprStmt) return null;
  let e = strip((s as unknown as { expression: Expression }).expression);
  if (e.kind === NodeKind.AssignExpr) e = strip((e as unknown as { right: Expression }).right);
  if (e.kind !== NodeKind.CallExpr) return null;
  const c = strip((e as unknown as { callee: Expression }).callee) as unknown as { kind: string; name?: unknown };
  if (c.kind === NodeKind.Identifier) return c.name as string;
  if (c.kind === NodeKind.QualifiedId) return ((c.name as { name?: string })?.name) ?? null;
  return null;
}

function isNoreturnCall(s: Statement, noreturn: ReadonlySet<string>): boolean {
  const n = calleeName(s);
  return n !== null && noreturn.has(n);
}

function isAssignment(s: Statement): boolean {
  if (s.kind !== NodeKind.ExprStmt) return false;
  return strip((s as unknown as { expression: Expression }).expression).kind === NodeKind.AssignExpr;
}

/** Flatten compounds: the statements of a tail in execution order (no control flow). */
function flat(stmts: Statement[]): Statement[] | null {
  const out: Statement[] = [];
  for (const s of stmts) {
    if (s.kind === NodeKind.CompoundStmt) {
      const inner = flat((s as CompoundStmt).statements);
      if (!inner) return null;
      out.push(...inner);
    } else if (s.kind === NodeKind.NullStmt) {
      continue;
    } else {
      out.push(s);
    }
  }
  return out;
}

/**
 * E3: the halt sequence. Only constant line assignments, the instruction-pointer read, and
 * calls that halt; the last statement does not return.
 */
export function isHaltTail(stmts: Statement[], noreturn: ReadonlySet<string>): boolean {
  const f = flat(stmts);
  if (!f || f.length === 0) return false;
  if (!isNoreturnCall(f[f.length - 1], noreturn)) return false;
  return f.every(s => isHaltStep(s, noreturn));
}

/** Fog's stack-cookie check, `Fog::Debug::GuardStack()`: the epilogue MSVC emits before a return. */
function isGuardStack(s: Statement): boolean {
  if (s.kind !== NodeKind.ExprStmt) return false;
  const e = strip((s as unknown as { expression: Expression }).expression);
  return e.kind === NodeKind.CallExpr && calleeName(s) === 'GuardStack'
    && ((e as unknown as { arguments: Expression[] }).arguments ?? []).length === 0;
}

/**
 * E4: [one phi move] + return / break / continue / noreturn call, at most 4 work nodes. A
 * `GuardStack()` right before the return is the epilogue's cookie check, part of the return
 * (rule 3 of the 2026-10-20 E6 audit: `GuardStack(); return v;` is `return v`, not E6).
 */
export function isTerminatorTail(stmts: Statement[], noreturn: ReadonlySet<string>): boolean {
  let f = flat(stmts);
  if (f && f.length >= 2 && f[f.length - 1].kind === NodeKind.ReturnStmt && isGuardStack(f[f.length - 2])) {
    f = [...f.slice(0, -2), f[f.length - 1]];
  }
  if (!f || f.length === 0 || f.length > 2) return false;
  if (workNodes(f) > E4_CEILING) return false;
  const last = f[f.length - 1];
  const term = last.kind === NodeKind.ReturnStmt || last.kind === NodeKind.BreakStmt
    || last.kind === NodeKind.ContinueStmt || isNoreturnCall(last, noreturn);
  if (!term) return false;
  return f.length === 1 || isAssignment(f[0]);
}

function text(s: Statement): string {
  try { return emit(s as never).trim(); } catch { return '\u0000' + Math.random(); }
}

/** The tail ends in a jump the source wrote: return / break / continue / a noreturn call. */
function terminates(tail: Statement[], facts: CopyFacts): boolean {
  const f = flat(tail);
  if (!f || !f.length) return false;
  const last = f[f.length - 1];
  if (last.kind === NodeKind.ReturnStmt) return !facts.fabricatedReturn;
  return last.kind === NodeKind.BreakStmt || last.kind === NodeKind.ContinueStmt || isNoreturnCall(last, facts.noreturn);
}

const FLAG_CONSUMER = /^J(?!MP$)[A-Z]+$/;

/**
 * Instruction evidence that MSVC merged copies the source wrote at each site (the
 * 2026-10-20 audit, rule 1):
 *   A1  a jump into the label comes from a HIGHER address - the tail was laid out before a
 *       site that comes later in the source, which only cross-jumping does;
 *   A3  the label's first instruction consumes what each site set up itself: a Jcc reading
 *       the flags each site's compare left, or a CALL whose arguments every way in pushed.
 */
function instructionEvidence(label: string | null | undefined): boolean {
  const f = labelFlowFor(label);
  if (!f) return false;
  if (f.back > 0) return true;
  if (FLAG_CONSUMER.test(f.first)) return true;
  return f.first === 'CALL' && f.pushedArgs;
}

/**
 * A2: the point the tail continues to is also entered by a path that neither runs through
 * the tail nor is one of the jumps being structured - a sibling arm jumping past it, a loop
 * entry, another goto. Then the tail is the end of SOME paths into a join, and the copy
 * restores per-path code. A tail whose end is reached only through it (or through the skip
 * that jumps to it) is one block written once: the copy is wrong.
 */
function endIsShared(facts: CopyFacts): boolean {
  const region = facts.region, tail = facts.tailInRegion;
  if (!region || !tail || !tail.length) return false;
  let cfg;
  // Labels are entry points only for the gotos the region itself holds: an entry from
  // outside it is not known here, and not knowing means no evidence.
  try { cfg = buildCfg(region, { noreturn: facts.noreturn, externalGotoCounts: countGotoTargets(region), commaConditions: true }); } catch { return false; }
  const inTail = new Set<object>();
  for (const s of tail) for (const n of traverseAST(s as ASTNode)) inTail.add(n);
  const tailNodes = new Set<number>();
  // A node of a comma condition stands for the if or loop it belongs to.
  const at = (nd: { stmt: Statement | null; owner?: Statement }) => nd.stmt ?? nd.owner ?? null;
  for (const nd of cfg.nodes) { const s = at(nd); if (s && inTail.has(s as object)) tailNodes.add(nd.id); }
  if (!tailNodes.size) return false;
  const JUMPS = new Set<string>([NodeKind.GotoStmt, NodeKind.ReturnStmt, NodeKind.BreakStmt, NodeKind.ContinueStmt]);
  const ends = new Set<number>();
  for (const id of tailNodes) {
    const nd = cfg.nodes[id];
    if (nd.stmt && JUMPS.has(nd.stmt.kind)) continue;
    for (const s of nd.succ) {
      if (!tailNodes.has(s) && s !== cfg.exit && s !== cfg.external) ends.add(s);
    }
  }
  if (!ends.size) return false;
  // The end point, through the scaffolding the tail falls into (a `break`, a label, a
  // `goto` on to the join): another way into any of it is another way into the join.
  const SCAFFOLD = new Set<string>([NodeKind.BreakStmt, NodeKind.ContinueStmt, NodeKind.GotoStmt, NodeKind.LabelStmt, NodeKind.NullStmt]);
  const chain = new Set<number>();
  const todo = [...ends];
  while (todo.length) {
    const p = todo.pop()!;
    if (chain.has(p)) continue;
    chain.add(p);
    const nd = cfg.nodes[p];
    if (nd.stmt && SCAFFOLD.has(nd.stmt.kind) && nd.succ.length === 1) todo.push(nd.succ[0]);
  }
  // The other way in must be a SIBLING of the sites: it comes from inside the smallest
  // statement holding every site and the tail - another arm of the same switch or if-chain
  // jumping past the tail. A path that bypasses the whole construct (the false edge of an
  // enclosing if) is no evidence that the arms each wrote the tail (the audit's 0061bee0).
  const scope = siblingScope(region, tail, facts);
  for (const p of chain) {
    if (p === cfg.exit || p === cfg.external) continue;
    for (const nd of cfg.nodes) {
      if (tailNodes.has(nd.id) || chain.has(nd.id) || !nd.succ.includes(p)) continue;
      if (nd.stmt?.kind === NodeKind.GotoStmt && facts.label && (nd.stmt as GotoStmt).label.name === facts.label) continue;
      const s = at(nd);
      if (!s || (scope && !scope.has(s as object))) continue;
      return true;
    }
  }
  return false;
}

/**
 * The sites are the default leaves of a compare tree: every one is `if (x OP K) goto L` on
 * the same operand against a literal. That is a switch's default edge written as
 * comparisons (the compare-tree recovery of step 8 turns it back into a switch), and the
 * tail at L is its default arm, written once (rule 2; the audit's 00505a80).
 */
function compareTreeDefault(facts: CopyFacts): boolean {
  if (facts.sites.length < 2) return false;
  let x: string | null = null;
  for (const s of facts.sites) {
    if (!s.branch) return false;
    const e = strip(s.branch);
    if (e.kind !== NodeKind.BinaryExpr) return false;
    const b = e as unknown as { operator: string; left: Expression; right: Expression };
    if (!['==', '!=', '<', '<=', '>', '>='].includes(b.operator)) return false;
    const lit = (y: Expression) => { let u = strip(y); while (u.kind === NodeKind.CStyleCastExpr) u = strip((u as unknown as { expression: Expression }).expression); return u.kind === NodeKind.IntegerLiteral || u.kind === NodeKind.CharLiteral; };
    const side = lit(b.right) ? b.left : lit(b.left) ? b.right : null;
    if (!side) return false;
    const t = text(side as unknown as Statement);
    if (x === null) x = t; else if (x !== t) return false;
  }
  return true;
}

/**
 * Every statement inside the smallest statement of `region` that holds all the copy's sites
 * (the gotos to the label; for a sunk join, the if before it) and the tail. Null: the whole
 * region.
 */
function siblingScope(region: Statement[], tail: Statement[], facts: CopyFacts): Set<object> | null {
  const parent = new Map<object, object | null>();
  const root = { kind: NodeKind.CompoundStmt, statements: region } as unknown as ASTNode;
  const visit = (n: ASTNode, p: object | null): void => {
    if (!n || typeof n !== 'object') return;
    parent.set(n, p);
    for (const c of getChildren(n)) if (String(c.kind).endsWith('Stmt')) visit(c, n);
  };
  visit(root, null);
  const anchors: object[] = [tail[0]];
  if (facts.sunkJoin) {
    const list = parent.get(tail[0]) as CompoundStmt | undefined;
    const i = list?.statements?.indexOf(tail[0]) ?? -1;
    if (i > 0) anchors.push(list!.statements[i - 1]);
  } else if (facts.label) {
    for (const s of region) for (const n of traverseAST(s as ASTNode)) {
      if (n.kind === NodeKind.GotoStmt && (n as GotoStmt).label.name === facts.label) anchors.push(n);
    }
  }
  const chainOf = (o: object): object[] => {
    const out: object[] = [];
    for (let c: object | null | undefined = o; c; c = parent.get(c)) out.unshift(c);
    return out;
  };
  const chains = anchors.map(chainOf);
  if (chains.some(c => c.length === 0 || c[0] !== root)) return null;
  let lca: object = root;
  for (let d = 0; ; d++) {
    const v = chains[0][d];
    if (!v || !chains.every(c => c[d] === v)) break;
    lca = v;
  }
  if (lca === root) return null;
  const out = new Set<object>();
  for (const n of traverseAST(lca as ASTNode)) out.add(n);
  return out;
}

/** A goto site that is a `case`/`default` holding nothing but the goto (rule 2). */
function caseOnlySite(facts: CopyFacts): boolean {
  if (facts.sites.some(s => s.caseOnly)) return true;
  if (compareTreeDefault(facts)) return true;
  // A switch case label reached by the default edge: stacked labels, not a copy.
  return !!facts.label && /_caseD_/.test(facts.label) && facts.sites.some(s => s.prefix === 'c:default');
}

/**
 * E6: short, few sites, and every site's prefix present and different from the others.
 * Since the 2026-10-20 audit (design 11): never when a site is a case holding only the goto
 * (those are stacked labels or a break), and a tail that does not end in a jump the source
 * wrote needs instruction evidence (A1/A3) or a shared end point (A2).
 */
function isCrossJumpTail(tail: Statement[], facts: CopyFacts): 'evidenced' | 'unproven' | null {
  const size = workNodes(tail);
  if (size === 0 || size > E6_CEILING) return null;
  const sites = facts.sites.length + (facts.hasFallthrough ? 1 : 0);
  if ((sites - 1) * size > E6_VOLUME) return null;
  const prefixes: (string | null | undefined)[] = facts.sites.map(s => s.prefix);
  if (facts.hasFallthrough) prefixes.push(facts.fallthroughPrefix);
  if (prefixes.some(p => !p)) return null;
  if (new Set(prefixes).size !== prefixes.length) return null;
  if (caseOnlySite(facts)) return null;
  const evidence = (!facts.sunkJoin && instructionEvidence(facts.label)) || endIsShared(facts);
  if (!terminates(tail, facts) && !evidence) return null;
  return evidence ? 'evidenced' : 'unproven';
}

/** The strongest evidence class the copy has, or null when it has none. */
export function copyIsFaithful(tail: Statement[], facts: CopyFacts): EvidenceClass | null {
  if (tail.length === 0 || holdsLabelOrCase(tail)) return null;
  if (facts.sites.length === 1 && !facts.hasFallthrough) return 'move';
  if (isHaltTail(tail, facts.noreturn)) return 'E3';
  if (isTerminatorTail(tail, facts.noreturn)) return 'E4';
  const e6 = isCrossJumpTail(tail, facts);
  if (e6) { e6Evidence.set(tail, e6); return 'E6'; }
  return null;
}

/** Per judged tail: whether its E6 had instruction or join evidence (A1-A3) or none (rule 4). */
const e6Evidence = new WeakMap<Statement[], 'evidenced' | 'unproven'>();

function stmtKey(s: Statement): string | null {
  // A label (goto or case) is scaffolding: what precedes the next statement is the work it
  // labels.
  while (s.kind === NodeKind.LabelStmt || s.kind === NodeKind.CaseStmt || s.kind === NodeKind.DefaultStmt) {
    s = (s as unknown as { statement: Statement }).statement;
  }
  if (s.kind === NodeKind.NullStmt) return null;
  return 's:' + text(s);
}

/**
 * Walk the statements, handing each position the key of what leads into it: the previous
 * statement of its block, or - first in its block - the branch or case that leads there.
 */
function walkPositions(stmts: Statement[], at: (n: ASTNode, prefix: string | null, branch: Expression | null) => boolean): void {
  const visit = (n: ASTNode, prefix: string | null, branch: Expression | null = null): boolean => {
    if (!n || typeof n !== 'object') return false;
    if (at(n, prefix, branch)) return true;
    switch (n.kind) {
      case NodeKind.CompoundStmt: {
        const list = (n as CompoundStmt).statements;
        for (let i = 0; i < list.length; i++) {
          if (visit(list[i] as ASTNode, i === 0 ? prefix : stmtKey(list[i - 1]), i === 0 ? branch : null)) return true;
        }
        return false;
      }
      case NodeKind.IfStmt: {
        const f = n as unknown as { condition: Expression; thenBranch: Statement; elseBranch: Statement | null };
        const c = text(f.condition as unknown as Statement);
        if (visit(f.thenBranch as ASTNode, 't:' + c, f.condition)) return true;
        return f.elseBranch ? visit(f.elseBranch as ASTNode, 'f:' + c, f.condition) : false;
      }
      case NodeKind.CaseStmt:
        return visit((n as unknown as { statement: Statement }).statement as ASTNode,
          'c:' + text((n as unknown as { value: Expression }).value as unknown as Statement));
      case NodeKind.DefaultStmt:
        return visit((n as unknown as { statement: Statement }).statement as ASTNode, 'c:default');
      case NodeKind.LabelStmt:
        return visit((n as unknown as { statement: Statement }).statement as ASTNode, prefix, branch);
      default:
        // Loop bodies, switch bodies: entered by the construct, which identifies nothing.
        for (const c of getChildren(n)) if (String(c.kind).endsWith('Stmt') && visit(c, null)) return true;
        return false;
    }
  };
  visit({ kind: NodeKind.CompoundStmt, statements: stmts } as unknown as ASTNode, null);
}

/** The prefix of each `goto label`. */
export function gotoSitesFor(stmts: Statement[], label: string): SiteInfo[] {
  const out: SiteInfo[] = [];
  // Gotos that are a case's whole body: `case 4: goto L;`.
  const caseOnly = new Set<ASTNode>();
  for (const s of stmts) {
    for (const n of traverseAST(s as ASTNode)) {
      if (n.kind !== NodeKind.CaseStmt && n.kind !== NodeKind.DefaultStmt) continue;
      let inner = (n as unknown as { statement: Statement }).statement;
      while (inner.kind === NodeKind.CaseStmt || inner.kind === NodeKind.DefaultStmt) inner = (inner as unknown as { statement: Statement }).statement;
      if (inner.kind === NodeKind.GotoStmt) caseOnly.add(inner as ASTNode);
    }
  }
  walkPositions(stmts, (n, prefix, branch) => {
    if (n.kind === NodeKind.GotoStmt && (n as GotoStmt).label.name === label) out.push({ prefix, caseOnly: caseOnly.has(n), branch: branch ?? undefined });
    return false;
  });
  return out;
}

/**
 * Where the label sits: whether control can fall into it (then the original stays where it
 * is) and the prefix of that fallthrough entry - E6 counts it as one more site.
 */
export function labelFallthrough(stmts: Statement[], label: string, canFallThrough: (s: Statement) => boolean): { hasFallthrough: boolean; prefix: string | null } {
  let found: { hasFallthrough: boolean; prefix: string | null } | null = null;
  // The statement before the label decides whether anything falls into it.
  const before = new Map<ASTNode, Statement | null>();
  const mark = (list: Statement[]) => list.forEach((c, i) => before.set(c as ASTNode, i > 0 ? list[i - 1] : null));
  mark(stmts);
  const all = (n: ASTNode): void => {
    if (!n || typeof n !== 'object') return;
    if (n.kind === NodeKind.CompoundStmt) mark((n as CompoundStmt).statements);
    for (const c of getChildren(n)) if (String(c.kind).endsWith('Stmt')) all(c);
  };
  stmts.forEach(s => all(s as ASTNode));
  walkPositions(stmts, (n, prefix) => {
    if (n.kind !== NodeKind.LabelStmt || (n as unknown as { label: { name: string } }).label.name !== label) return false;
    const prev = before.get(n);
    found = { hasFallthrough: prev === undefined || prev === null || canFallThrough(prev), prefix };
    return true;
  });
  return found ?? { hasFallthrough: true, prefix: null };
}

// ---------------------------------------------------------------------------------------
// Mode and accounting
// ---------------------------------------------------------------------------------------

export type CopyPolicyMode = 'log' | 'enforce';
const MODE_KEY = Symbol.for('ghidra-mcp:goto-copy-policy-mode');

export function setCopyPolicyMode(mode: CopyPolicyMode | null): void {
  (globalThis as Record<symbol, unknown>)[MODE_KEY] = mode;
}

export function copyPolicyMode(): CopyPolicyMode {
  const set = (globalThis as Record<symbol, unknown>)[MODE_KEY] as CopyPolicyMode | null | undefined;
  if (set) return set;
  return process.env.GHIDRA_GOTO_COPY_POLICY === 'log' ? 'log' : 'enforce';
}

/**
 * Ask the policy about one copy a handler is about to make. Returns the class (or 'none'
 * in log mode, where every copy is allowed and only classified), or null to decline.
 */
export function judgeCopy(tail: Statement[], facts: CopyFacts): EvidenceClass | 'none' | null {
  const cls = copyIsFaithful(tail, facts);
  if (cls === null && copyPolicyMode() === 'enforce') return null;
  return cls ?? 'none';
}

interface PendingCopy { handler: string; label: string; cls: EvidenceClass | 'none'; work: number; copies: number; e6?: 'evidenced' | 'unproven' }
const PENDING_KEY = Symbol.for('ghidra-mcp:goto-copy-pending');
function pending(): PendingCopy[] {
  const g = globalThis as Record<symbol, unknown>;
  return (g[PENDING_KEY] ??= []) as PendingCopy[];
}

/**
 * A handler announces the copy its candidate makes. It only COUNTS once `accept()` keeps
 * the candidate (`commitCopies`); a refused candidate's copies are dropped (`takeCopies`).
 */
export function announceCopy(handler: string, label: string, cls: EvidenceClass | 'none', tail: Statement[], copies: number): void {
  pending().push({ handler, label, cls, work: workNodes(tail), copies, e6: cls === 'E6' ? (e6Evidence.get(tail) ?? 'unproven') : undefined });
}

export function takeCopies(): PendingCopy[] {
  const p = pending().splice(0);
  return p;
}

export function commitCopies(copies: PendingCopy[]): void {
  for (const c of copies) {
    if (c.cls === 'move') {
      recordStat('movedBlocks', 1);
      gotoReport({ event: 'move', handler: c.handler, label: c.label, workNodes: c.work });
      continue;
    }
    recordStat(c.cls === 'none' ? 'copyNone' : (`copy${c.cls}` as 'copyE3' | 'copyE4' | 'copyE6'), c.copies);
    if (c.cls === 'E6') recordStat(c.e6 === 'evidenced' ? 'copyE6Evidenced' : 'copyE6Unproven', c.copies);
    recordStat('copiedWorkNodes', c.work * c.copies);
    gotoReport({ event: 'copy', handler: c.handler, label: c.label, cls: c.cls, copies: c.copies, workNodes: c.work, ...(c.e6 ? { e6: c.e6 } : {}) });
  }
}

