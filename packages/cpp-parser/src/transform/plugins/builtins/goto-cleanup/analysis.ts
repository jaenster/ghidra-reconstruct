/**
 * Label and goto analysis for the goto cleanup plugin.
 */

import { NodeKind } from '../../../../ast/kinds.js';
import type {
  ASTNode,
  CallExpr,
  CaseStmt,
  CompoundStmt,
  DefaultStmt,
  DoWhileStmt,
  ExprStmt,
  ForStmt,
  GotoStmt,
  Identifier,
  IfStmt,
  LabelStmt,
  QualifiedId,
  Statement,
  SwitchStmt,
  WhileStmt,
} from '../../../../ast/nodes.js';
import { traverseAST } from '../../../../ast/visitor.js';
import { TriviaKind } from '../../../../lexer/trivia.js';
import type { GotoInfo, LabelInfo, LabelKind, NestedLabelInfo, RequiredGotoCleanupOptions } from './types.js';
import { DEFAULT_NORETURN_FUNCTIONS } from './types.js';
import { getGotoLabel, isLoopStmt, isSimpleLabelName, getLoopBody } from './helpers.js';
import { alwaysTerminatesWithGoto, countGotosToLabel } from './cross-scope.js';

/**
 * Count all gotos targeting each label recursively within a set of statements.
 */
export function countGotosInStatements(statements: Statement[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const stmt of statements) {
    for (const node of traverseAST(stmt as ASTNode)) {
      if (node.kind === NodeKind.GotoStmt) {
        const label = (node as GotoStmt).label.name;
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/**
 * Build LabelInfo for each label in the compound statement.
 */
export function analyzeLabels(
  stmts: Statement[],
  options: RequiredGotoCleanupOptions,
): Map<string, LabelInfo> {
  const labels = new Map<string, LabelInfo>();

  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i];
    if (stmt.kind !== NodeKind.LabelStmt) continue;
    const labelStmt = stmt as LabelStmt;
    const name = labelStmt.label.name;
    if (!isSimpleLabelName(name)) continue;

    // tail = [labelStmt.statement, ...stmts after label to end]
    const tail: Statement[] = [labelStmt.statement, ...stmts.slice(i + 1)];
    const kind = classifyLabelTail(tail, options);

    // Strip the Ghidra noreturn WARNING comment — it has served its purpose
    // for flow classification and would be confusing in the restructured output
    if (kind === 'exit-noreturn') {
      stripNoreturnWarnings(tail);
    }

    labels.set(name, { name, index: i, tailStatements: tail, kind });
  }

  return labels;
}

/**
 * Classify the tail of a label to determine what kind of exit it is.
 */
export function classifyLabelTail(
  tail: Statement[],
  options: RequiredGotoCleanupOptions,
): LabelKind {
  if (tail.length === 0) return 'fallthrough';

  const last = tail[tail.length - 1];

  // Check if the last statement is a return
  if (last.kind === NodeKind.ReturnStmt) {
    if (tail.length === 1) return 'exit-return';
    return 'cleanup-return';
  }

  // Check for noreturn
  if (isNoreturnTail(tail, options)) {
    return 'exit-noreturn';
  }

  // Tail has statements but doesn't end with return/noreturn.
  // This is valid in void functions — treat as cleanup with implicit return.
  return 'cleanup-fallthrough';
}

/**
 * Check if a sequence of statements ends in a noreturn call.
 */
function isNoreturnTail(
  tail: Statement[],
  options: RequiredGotoCleanupOptions,
): boolean {
  if (tail.length === 0) return false;

  // Check for Ghidra WARNING comment on any statement in tail
  if (options.detectGhidraNoreturn) {
    for (const stmt of tail) {
      if (hasGhidraNoreturnWarning(stmt)) return true;
    }
  }

  // Check if last statement is a call to a known noreturn function
  const last = tail[tail.length - 1];
  if (last.kind === NodeKind.ExprStmt) {
    const expr = (last as ExprStmt).expression;
    if (expr.kind === NodeKind.CallExpr) {
      const callee = (expr as CallExpr).callee;
      if (callee.kind === NodeKind.Identifier) {
        const name = (callee as Identifier).name;
        if (DEFAULT_NORETURN_FUNCTIONS.has(name)) return true;
        if (options.noreturnFunctions.includes(name)) return true;
      }
      if (callee.kind === NodeKind.QualifiedId) {
        const qid = callee as QualifiedId;
        const terminalName = qid.name;
        if (terminalName.kind === NodeKind.Identifier) {
          const name = (terminalName as Identifier).name;
          if (DEFAULT_NORETURN_FUNCTIONS.has(name)) return true;
          if (options.noreturnFunctions.includes(name)) return true;
        }
      }
    }
  }

  return false;
}

/**
 * Check if a statement has the Ghidra "WARNING: Subroutine does not return" comment.
 */
function hasGhidraNoreturnWarning(stmt: Statement): boolean {
  if (!stmt.leadingTrivia) return false;
  for (const trivia of stmt.leadingTrivia) {
    if (trivia.kind === TriviaKind.BlockComment || trivia.kind === TriviaKind.LineComment) {
      if (trivia.text.includes('WARNING: Subroutine does not return')) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Remove Ghidra "WARNING: Subroutine does not return" comments from tail statements.
 * Called after the comment has been used for flow classification — keeping it in
 * the restructured output would be confusing since the goto has been eliminated.
 */
function stripNoreturnWarnings(tail: Statement[]): void {
  for (const stmt of tail) {
    if (!stmt.leadingTrivia) continue;
    const filtered = stmt.leadingTrivia.filter(trivia => {
      if (trivia.kind !== TriviaKind.BlockComment && trivia.kind !== TriviaKind.LineComment) return true;
      return !trivia.text.includes('WARNING: Subroutine does not return');
    });
    if (filtered.length !== stmt.leadingTrivia.length) {
      (stmt as any).leadingTrivia = filtered.length > 0 ? filtered : undefined;
    }
  }
}

/**
 * Analyze all gotos targeting labels within the same compound statement.
 * Returns a map from label name to array of GotoInfo.
 */
export function analyzeGotos(
  stmts: Statement[],
  labels: Map<string, LabelInfo>,
): Map<string, GotoInfo[]> {
  const gotos = new Map<string, GotoInfo[]>();

  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i];

    // Pattern: if (cond) goto L;  (top-level-if)
    if (stmt.kind === NodeKind.IfStmt) {
      const ifStmt = stmt as IfStmt;
      if (!ifStmt.elseBranch) {
        const label = getGotoLabel(ifStmt.thenBranch);
        if (label && labels.has(label) && i < labels.get(label)!.index) {
          const arr = gotos.get(label) ?? [];
          arr.push({ index: i, context: 'top-level-if', label, ifStmt, gotoCount: 1 });
          gotos.set(label, arr);
          continue;
        }
      }

      // Pattern: end-of-if-then goto (goto as last stmt of thenBranch)
      if (!ifStmt.elseBranch && ifStmt.thenBranch.kind === NodeKind.CompoundStmt) {
        const body = ifStmt.thenBranch as CompoundStmt;
        if (body.statements.length > 0) {
          const lastInThen = body.statements[body.statements.length - 1];
          const label = getGotoLabel(lastInThen);
          if (label && labels.has(label) && i < labels.get(label)!.index) {
            const arr = gotos.get(label) ?? [];
            arr.push({ index: i, context: 'end-of-if-then', label, ifStmt, gotoCount: 1 });
            gotos.set(label, arr);
            continue;
          }
        }
      }

      // Pattern: cross-scope terminal goto (thenBranch always terminates with goto L)
      if (!ifStmt.elseBranch) {
        for (const [labelName, labelInfo] of labels) {
          if (i >= labelInfo.index) continue;
          if (alwaysTerminatesWithGoto(ifStmt.thenBranch, labelName)) {
            const gCount = countGotosToLabel(ifStmt.thenBranch, labelName);
            const arr = gotos.get(labelName) ?? [];
            arr.push({ index: i, context: 'cross-scope-terminal', label: labelName, ifStmt, gotoCount: gCount });
            gotos.set(labelName, arr);
            break; // only match first label
          }
        }
        continue;
      }
    }

    // Pattern: bare goto L;  (unconditional)
    if (stmt.kind === NodeKind.GotoStmt) {
      const label = (stmt as GotoStmt).label.name;
      if (labels.has(label) && i < labels.get(label)!.index) {
        const arr = gotos.get(label) ?? [];
        arr.push({ index: i, context: 'unconditional', label, gotoCount: 1 });
        gotos.set(label, arr);
        continue;
      }
    }

    // Pattern: loop body containing if (cond) goto L;
    if (isLoopStmt(stmt)) {
      const body = getLoopBody(stmt);
      if (body && body.kind === NodeKind.CompoundStmt) {
        const loopBody = body as CompoundStmt;
        for (let j = 0; j < loopBody.statements.length; j++) {
          const loopStmtInner = loopBody.statements[j];
          if (loopStmtInner.kind === NodeKind.IfStmt) {
            const innerIf = loopStmtInner as IfStmt;
            if (!innerIf.elseBranch) {
              const label = getGotoLabel(innerIf.thenBranch);
              if (label && labels.has(label) && i < labels.get(label)!.index) {
                const arr = gotos.get(label) ?? [];
                arr.push({
                  index: i,
                  context: 'loop-body',
                  label,
                  ifStmt: innerIf,
                  loopStmt: stmt as ForStmt | WhileStmt | DoWhileStmt,
                  loopGotoIndex: j,
                  gotoCount: 1,
                });
                gotos.set(label, arr);
              }
            }
          }
        }
      }
    }
  }

  return gotos;
}

/**
 * Discover labels nested inside if/else branches, loop bodies, switch cases, etc.
 * These are invisible to the top-level analyzeLabels() which only scans direct children.
 */
export function discoverNestedLabels(
  stmts: Statement[],
  topLevelLabels: Map<string, LabelInfo>,
  options: RequiredGotoCleanupOptions,
): Map<string, NestedLabelInfo> {
  const result = new Map<string, NestedLabelInfo>();

  function walkCompound(compound: Statement[]) {
    for (let i = 0; i < compound.length; i++) {
      const stmt = compound[i];
      if (stmt.kind === NodeKind.LabelStmt) {
        const labelStmt = stmt as LabelStmt;
        const name = labelStmt.label.name;
        if (isSimpleLabelName(name) && !topLevelLabels.has(name) && !result.has(name)) {
          const tail: Statement[] = [labelStmt.statement, ...compound.slice(i + 1)];
          const kind = classifyLabelTail(tail, options);
          result.set(name, { name, tailStatements: tail, kind });
        }
      } else if (stmt.kind === NodeKind.CaseStmt || stmt.kind === NodeKind.DefaultStmt) {
        // A label as the FIRST statement of a case/default (e.g. `case N: LBL: ...`)
        // — its tail extends through the following sibling statements in this same
        // compound (up to the next case/default), not just the label's inner statement.
        const inner = (stmt as CaseStmt | DefaultStmt).statement;
        if (inner.kind === NodeKind.LabelStmt) {
          const labelStmt = inner as LabelStmt;
          const name = labelStmt.label.name;
          if (isSimpleLabelName(name) && !topLevelLabels.has(name) && !result.has(name)) {
            const siblings: Statement[] = [];
            for (let j = i + 1; j < compound.length; j++) {
              if (compound[j].kind === NodeKind.CaseStmt || compound[j].kind === NodeKind.DefaultStmt) break;
              siblings.push(compound[j]);
            }
            const tail: Statement[] = [labelStmt.statement, ...siblings];
            const kind = classifyLabelTail(tail, options);
            result.set(name, { name, tailStatements: tail, kind });
          }
        }
      }
      // Recurse into the statement regardless (it may contain deeper labels)
      walkStmt(compound[i]);
    }
  }

  function walkStmt(stmt: Statement) {
    if (stmt.kind === NodeKind.CompoundStmt) {
      walkCompound((stmt as CompoundStmt).statements);
    } else if (stmt.kind === NodeKind.IfStmt) {
      const ifStmt = stmt as IfStmt;
      walkStmt(ifStmt.thenBranch);
      if (ifStmt.elseBranch) walkStmt(ifStmt.elseBranch);
    } else if (stmt.kind === NodeKind.ForStmt) {
      walkStmt((stmt as ForStmt).body);
    } else if (stmt.kind === NodeKind.WhileStmt) {
      walkStmt((stmt as WhileStmt).body);
    } else if (stmt.kind === NodeKind.DoWhileStmt) {
      walkStmt((stmt as DoWhileStmt).body);
    } else if (stmt.kind === NodeKind.SwitchStmt) {
      walkStmt((stmt as SwitchStmt).body);
    } else if (stmt.kind === NodeKind.CaseStmt) {
      walkStmt((stmt as CaseStmt).statement);
    } else if (stmt.kind === NodeKind.DefaultStmt) {
      walkStmt((stmt as DefaultStmt).statement);
    } else if (stmt.kind === NodeKind.LabelStmt) {
      // Bare label not inside a compound — tail is just the inner statement
      const labelStmt = stmt as LabelStmt;
      const name = labelStmt.label.name;
      if (isSimpleLabelName(name) && !topLevelLabels.has(name) && !result.has(name)) {
        const tail: Statement[] = [labelStmt.statement];
        const kind = classifyLabelTail(tail, options);
        result.set(name, { name, tailStatements: tail, kind });
      }
      walkStmt(labelStmt.statement);
    }
  }

  // Walk the top-level statements via walkCompound so labels wrapped directly in a
  // case/default at this level (e.g. `case N: LBL: ...`) get a sibling-aware tail.
  // Direct LabelStmt children are still filtered out by the topLevelLabels check.
  walkCompound(stmts);

  return result;
}
