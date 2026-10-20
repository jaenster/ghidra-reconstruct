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
import { getChildren } from '../../../../ast/visitor.js';
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
}

export interface CopyFacts {
  /** One per goto to the label. */
  sites: SiteInfo[];
  /** The prefix of the label's own fallthrough entry (same encoding); it is a site for E6. */
  fallthroughPrefix?: string | null;
  /** Whether anything falls into the label at all (the label then keeps its tail). */
  hasFallthrough: boolean;
  noreturn: ReadonlySet<string>;
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

/** E4: [one phi move] + return / break / continue / noreturn call, at most 4 work nodes. */
export function isTerminatorTail(stmts: Statement[], noreturn: ReadonlySet<string>): boolean {
  const f = flat(stmts);
  if (!f || f.length === 0 || f.length > 2) return false;
  if (workNodes(stmts) > E4_CEILING) return false;
  const last = f[f.length - 1];
  const term = last.kind === NodeKind.ReturnStmt || last.kind === NodeKind.BreakStmt
    || last.kind === NodeKind.ContinueStmt || isNoreturnCall(last, noreturn);
  if (!term) return false;
  return f.length === 1 || isAssignment(f[0]);
}

function text(s: Statement): string {
  try { return emit(s as never).trim(); } catch { return '\u0000' + Math.random(); }
}

/** E6: short, few sites, and every site's prefix present and different from the others. */
function isCrossJumpTail(tail: Statement[], facts: CopyFacts): boolean {
  const size = workNodes(tail);
  if (size === 0 || size > E6_CEILING) return false;
  const sites = facts.sites.length + (facts.hasFallthrough ? 1 : 0);
  if ((sites - 1) * size > E6_VOLUME) return false;
  const prefixes: (string | null | undefined)[] = facts.sites.map(s => s.prefix);
  if (facts.hasFallthrough) prefixes.push(facts.fallthroughPrefix);
  if (prefixes.some(p => !p)) return false;
  if (new Set(prefixes).size !== prefixes.length) return false;
  return true;
}

/** The strongest evidence class the copy has, or null when it has none. */
export function copyIsFaithful(tail: Statement[], facts: CopyFacts): EvidenceClass | null {
  if (tail.length === 0 || holdsLabelOrCase(tail)) return null;
  if (facts.sites.length === 1 && !facts.hasFallthrough) return 'move';
  if (isHaltTail(tail, facts.noreturn)) return 'E3';
  if (isTerminatorTail(tail, facts.noreturn)) return 'E4';
  if (isCrossJumpTail(tail, facts)) return 'E6';
  return null;
}

function stmtKey(s: Statement): string | null {
  if (s.kind === NodeKind.LabelStmt || s.kind === NodeKind.CaseStmt || s.kind === NodeKind.DefaultStmt) return null;
  return 's:' + text(s);
}

/**
 * Walk the statements, handing each position the key of what leads into it: the previous
 * statement of its block, or - first in its block - the branch or case that leads there.
 */
function walkPositions(stmts: Statement[], at: (n: ASTNode, prefix: string | null) => boolean): void {
  const visit = (n: ASTNode, prefix: string | null): boolean => {
    if (!n || typeof n !== 'object') return false;
    if (at(n, prefix)) return true;
    switch (n.kind) {
      case NodeKind.CompoundStmt: {
        const list = (n as CompoundStmt).statements;
        for (let i = 0; i < list.length; i++) {
          if (visit(list[i] as ASTNode, i === 0 ? prefix : stmtKey(list[i - 1]))) return true;
        }
        return false;
      }
      case NodeKind.IfStmt: {
        const f = n as unknown as { condition: Expression; thenBranch: Statement; elseBranch: Statement | null };
        const c = text(f.condition as unknown as Statement);
        if (visit(f.thenBranch as ASTNode, 't:' + c)) return true;
        return f.elseBranch ? visit(f.elseBranch as ASTNode, 'f:' + c) : false;
      }
      case NodeKind.CaseStmt:
        return visit((n as unknown as { statement: Statement }).statement as ASTNode,
          'c:' + text((n as unknown as { value: Expression }).value as unknown as Statement));
      case NodeKind.DefaultStmt:
        return visit((n as unknown as { statement: Statement }).statement as ASTNode, 'c:default');
      case NodeKind.LabelStmt:
        return visit((n as unknown as { statement: Statement }).statement as ASTNode, prefix);
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
  walkPositions(stmts, (n, prefix) => {
    if (n.kind === NodeKind.GotoStmt && (n as GotoStmt).label.name === label) out.push({ prefix });
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

interface PendingCopy { handler: string; label: string; cls: EvidenceClass | 'none'; work: number; copies: number }
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
  pending().push({ handler, label, cls, work: workNodes(tail), copies });
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
    recordStat('copiedWorkNodes', c.work * c.copies);
    gotoReport({ event: 'copy', handler: c.handler, label: c.label, cls: c.cls, copies: c.copies, workNodes: c.work });
  }
}

