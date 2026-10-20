/**
 * The translation validator, applied to every candidate a goto handler produces.
 *
 * `preservesReachableWork` (process.ts) is a reachability net: it catches deleted code, and
 * nothing else - it ignores conditions, so a rewrite that swaps two arms or sends a copy to
 * the wrong join passes it. `isUnfolding` (transform/cfg/equivalence.ts) proves the candidate
 * performs the same work and the same tests in the same order on every path. A candidate it
 * cannot prove is a candidate whose correctness nothing has established.
 *
 * Modes (`setGotoValidatorMode`, or GHIDRA_GOTO_VALIDATOR=off|log|enforce):
 *   log      prove every candidate, count and report each refusal, keep the candidate.
 *            For auditing the existing handlers without changing the output.
 *   enforce  a refused candidate is dropped and the goto stays.
 *   off      skip the proof.
 */

import type { Statement } from '../../../../ast/nodes.js';
import { NodeKind } from '../../../../ast/kinds.js';
import { emit } from '../../../../emit/index.js';
import { isUnfolding } from '../../../cfg/index.js';
import { countGotosInStatements } from './analysis.js';
import { recordStat } from './stats.js';
import { gotoReport, gotoReportEnabled, gotoReportPairs } from './report.js';

export type GotoValidatorMode = 'off' | 'log' | 'enforce';

const MODE_KEY = Symbol.for('ghidra-mcp:goto-cleanup-validator-mode');
const EXACT_KEY = Symbol.for('ghidra-mcp:goto-cleanup-exact-gotos');

export function setGotoValidatorMode(mode: GotoValidatorMode | null): void {
  (globalThis as Record<symbol, unknown>)[MODE_KEY] = mode;
}

export function gotoValidatorMode(): GotoValidatorMode {
  const set = (globalThis as Record<symbol, unknown>)[MODE_KEY] as GotoValidatorMode | null | undefined;
  if (set) return set;
  const env = process.env.GHIDRA_GOTO_VALIDATOR;
  return env === 'off' || env === 'enforce' || env === 'log' ? env : 'enforce';
}

/**
 * Whole-function goto counts that stay EXACT through a round.
 *
 * The counts the handlers read are computed once per whole-AST round, so after a rewrite
 * inside a compound they over-count the labels it touched - safe for the handlers (an
 * over-count only defers), but for the validator an over-count turns a label into a false
 * entry point and refuses a correct rewrite. This copy is updated by every candidate that
 * is kept.
 */
export function setExactGotoCounts(counts: Map<string, number> | null): void {
  (globalThis as Record<symbol, unknown>)[EXACT_KEY] = counts;
}

function exactGotoCounts(): Map<string, number> | null {
  return ((globalThis as Record<symbol, unknown>)[EXACT_KEY] as Map<string, number> | null | undefined) ?? null;
}

/** Gotos to `label` in the whole function, exact through the round (null: not known). */
export function exactGotoCount(label: string): number | null {
  const m = exactGotoCounts();
  return m ? (m.get(label) ?? 0) : null;
}

/** Record that `after` replaced `before`: every label's count moves by the difference. */
export function noteRewrite(before: Statement[], after: Statement[]): void {
  const exact = exactGotoCounts();
  if (!exact) return;
  const a = countGotosInStatements(before), b = countGotosInStatements(after);
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    const d = (b.get(name) ?? 0) - (a.get(name) ?? 0);
    if (d) exact.set(name, (exact.get(name) ?? 0) + d);
  }
}

export interface ValidateContext {
  /** Falling off the end of this compound is the function's (void) return. */
  followIsExit: boolean;
  /** Calls that do not return, as the handlers believe them. */
  noreturn: ReadonlySet<string>;
}

const PAIR_TEXT_LIMIT = 200_000;

function regionText(stmts: Statement[]): string {
  try {
    return emit({ kind: NodeKind.CompoundStmt, statements: stmts, leadingTrivia: [], trailingTrivia: [] } as never);
  } catch {
    return '';
  }
}

/** True when the candidate may be kept under the current mode. */
export function validateCandidate(before: Statement[], candidate: Statement[], handler: string, ctx: ValidateContext): boolean {
  const mode = gotoValidatorMode();
  if (mode === 'off') return true;
  const counts = exactGotoCounts() ?? countGotosInStatements(before);
  const r = isUnfolding(before, candidate, {
    externalGotoCounts: counts, followIsExit: ctx.followIsExit, noreturn: ctx.noreturn, haltException: true,
  });
  if (r.ok) {
    recordStat('cfVerified');
    if (gotoReportPairs()) {
      const b = regionText(before), a = regionText(candidate);
      if (b.length + a.length < PAIR_TEXT_LIMIT) {
        gotoReport({ event: 'cf-proved', handler, followIsExit: ctx.followIsExit, entries: externalEntries(before, counts), before: b, after: a });
      }
    }
    return true;
  }
  recordStat('cfVerifyFail');
  if (gotoReportEnabled()) {
    const ev: Record<string, unknown> = { event: 'cf-refused', handler, mode, reason: r.reason, followIsExit: ctx.followIsExit };
    if (gotoReportPairs()) {
      ev.entries = externalEntries(before, counts);
      ev.before = regionText(before).slice(0, PAIR_TEXT_LIMIT);
      ev.after = regionText(candidate).slice(0, PAIR_TEXT_LIMIT);
    }
    gotoReport(ev);
  }
  return mode !== 'enforce';
}

/** Labels of the region that are targeted from outside it. */
function externalEntries(stmts: Statement[], counts: Map<string, number>): string[] {
  const inside = countGotosInStatements(stmts);
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const node = n as { kind?: string; label?: { name: string } };
    if (node.kind === NodeKind.LabelStmt && node.label) {
      const name = node.label.name;
      if ((counts.get(name) ?? 0) > (inside.get(name) ?? 0)) out.push(name);
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
      if (v && typeof v === 'object') walk(v);
    }
  };
  walk(stmts);
  return out;
}
