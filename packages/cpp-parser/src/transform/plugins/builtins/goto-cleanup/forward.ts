/**
 * Forward goto handlers: cascading gotos, unconditional goto, loop-body goto.
 */

import { NodeKind } from '../../../../ast/kinds.js';
import type {
  CompoundStmt,
  DoWhileStmt,
  ForStmt,
  IfStmt,
  Statement,
  WhileStmt,
} from '../../../../ast/nodes.js';
import { updateNode } from '../../../transformer.js';
import type { GotoInfo, LabelInfo } from './types.js';
import {
  buildThenBranch,
  collectIdentifierNames,
  createBreakStmt,
  createFlagAssignStmt,
  createFlagDecl,
  createIfNotFlag,
  generateUniqueName,
  getLoopBody,
  hasTopLevelDeclOrLabel,
  negateCondition,
} from './helpers.js';
import { stripTerminalGoto } from './cross-scope.js';

/**
 * Build cascading nesting for gotos that are all top-level-if or cross-scope-terminal.
 * Processes gotos from last to first, building nested if/else chains.
 *
 * For top-level-if: `if (cond) goto L;` → negate condition, wrap between in if(!cond)
 * For end-of-if-then / cross-scope-terminal: strip goto from thenBranch, set between as else
 */
export function buildGeneralizedCascade(
  stmts: Statement[],
  sorted: GotoInfo[],
  labelIndex: number,
  tail: Statement[],
): Statement[] {
  // Start with the innermost content (between last goto and label)
  let result: Statement[] = stmts.slice(sorted[sorted.length - 1].index + 1, labelIndex);

  // Process from last goto to first
  for (let g = sorted.length - 1; g >= 0; g--) {
    const gotoInfo = sorted[g];
    const ifStmt = gotoInfo.ifStmt!;

    if (gotoInfo.context === 'top-level-if') {
      // Negate condition, wrap between in if(!cond)
      const negated = negateCondition(ifStmt.condition);

      if (result.length > 0) {
        const thenBranch = buildThenBranch(result, ifStmt);
        const wrappedIf: IfStmt = {
          kind: NodeKind.IfStmt,
          condition: negated,
          thenBranch,
          elseBranch: null,
          isConstexpr: false,
          location: ifStmt.location,
          leadingTrivia: ifStmt.leadingTrivia,
          trailingTrivia: ifStmt.trailingTrivia,
        } as IfStmt;
        result = [wrappedIf];
      } else {
        result = [];
      }
    } else {
      // end-of-if-then or cross-scope-terminal: strip goto, set between as else
      const strippedThen = stripTerminalGoto(ifStmt.thenBranch, gotoInfo.label);

      if (result.length > 0) {
        const elseBranch = buildThenBranch(result, ifStmt);

        if (strippedThen) {
          const newIf = updateNode(ifStmt, {
            thenBranch: strippedThen,
            elseBranch,
          });
          result = [newIf as Statement];
        } else {
          // Then branch was entirely goto → negate and use between as body
          const negated = negateCondition(ifStmt.condition);
          const wrappedIf: IfStmt = {
            kind: NodeKind.IfStmt,
            condition: negated,
            thenBranch: elseBranch,
            elseBranch: null,
            isConstexpr: false,
            location: ifStmt.location,
            leadingTrivia: ifStmt.leadingTrivia,
            trailingTrivia: ifStmt.trailingTrivia,
          } as IfStmt;
          result = [wrappedIf];
        }
      } else {
        // No between code
        if (strippedThen) {
          const newIf = updateNode(ifStmt, {
            thenBranch: strippedThen,
            elseBranch: null,
          });
          result = [newIf as Statement];
        } else {
          result = [];
        }
      }
    }

    // Prepend the "between" content from previous goto (or start) to this goto
    if (g > 0) {
      const between = stmts.slice(sorted[g - 1].index + 1, gotoInfo.index);
      result = [...between, ...result];
    }
  }

  // Prepend everything before the first goto
  const prefix = stmts.slice(0, sorted[0].index);

  return [...prefix, ...result, ...tail];
}

/**
 * Handle unconditional goto + dead code elimination (Pattern 3).
 */
export function handleUnconditionalGoto(
  stmts: Statement[],
  gotoInfo: GotoInfo,
  labelInfo: LabelInfo,
  eliminateDeadCode: boolean,
): Statement[] | null {
  const gotoIndex = gotoInfo.index;
  const labelIndex = labelInfo.index;
  const tail = labelInfo.tailStatements;

  if (!eliminateDeadCode) return null;

  // Remove the goto and everything between goto and label (dead code)
  const prefix = stmts.slice(0, gotoIndex);
  const suffix = stmts.slice(labelIndex + 1);

  return [...prefix, ...tail, ...suffix];
}

/**
 * Handle loop body goto → break replacement (Pattern 5).
 * Supports for, while, and do-while loops.
 */
export function handleLoopBodyGoto(
  stmts: Statement[],
  gotoInfos: GotoInfo[],
  labelInfo: LabelInfo,
  usedNames: Set<string>,
): Statement[] | null {
  // Only handle single loop-body goto for now
  if (gotoInfos.length !== 1) return null;
  const gotoInfo = gotoInfos[0];
  if (!gotoInfo.loopStmt || !gotoInfo.ifStmt || gotoInfo.loopGotoIndex === undefined) return null;

  const loopStmt = gotoInfo.loopStmt;
  const loopIndex = gotoInfo.index;
  const labelIndex = labelInfo.index;
  const tail = labelInfo.tailStatements;
  const loopGotoIndex = gotoInfo.loopGotoIndex;

  // Get loop body
  const loopBody = getLoopBody(loopStmt);
  if (!loopBody || loopBody.kind !== NodeKind.CompoundStmt) return null;
  const bodyCompound = loopBody as CompoundStmt;

  const between = stmts.slice(loopIndex + 1, labelIndex);

  if (between.length === 0) {
    // Simple case: no code between loop and label → just replace goto with break
    const breakStmt = createBreakStmt(gotoInfo.ifStmt.thenBranch);
    const rewrittenIf = updateNode(gotoInfo.ifStmt, {
      thenBranch: breakStmt,
      elseBranch: null,
    });

    const newBodyStmts = bodyCompound.statements.map((s, idx) =>
      idx === loopGotoIndex ? rewrittenIf : s
    );
    const newBody = updateNode(bodyCompound, { statements: newBodyStmts });
    const updatedLoop = updateNode(loopStmt, { body: newBody } as any);

    const prefix = stmts.slice(0, loopIndex);
    return [...prefix, updatedLoop, ...tail];
  }

  // Complex case: code between loop and label → flag+break+guard
  if (hasTopLevelDeclOrLabel(between)) return null;

  const flagName = generateUniqueName('found', usedNames);
  const flagDecl = createFlagDecl(flagName, loopStmt);
  const assignStmt = createFlagAssignStmt(flagName, gotoInfo.ifStmt.thenBranch);
  const breakStmt = createBreakStmt(gotoInfo.ifStmt.thenBranch);
  const thenBranch = buildThenBranch([assignStmt, breakStmt], gotoInfo.ifStmt.thenBranch);

  const rewrittenIf = updateNode(gotoInfo.ifStmt, {
    thenBranch,
    elseBranch: null,
  });

  const newBodyStmts = bodyCompound.statements.map((s, idx) =>
    idx === loopGotoIndex ? rewrittenIf : s
  );
  const newBody = updateNode(bodyCompound, { statements: newBodyStmts });
  const updatedLoop = updateNode(loopStmt, { body: newBody } as any);
  const guardIf = createIfNotFlag(flagName, between, loopStmt as Statement);

  const prefix = stmts.slice(0, loopIndex);
  return [...prefix, flagDecl, updatedLoop, guardIf, ...tail];
}
