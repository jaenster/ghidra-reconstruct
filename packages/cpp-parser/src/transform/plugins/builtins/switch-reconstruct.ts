/**
 * Switch Reconstruction Plugin
 *
 * Reconstructs switch statements from if-else-if chains that compare
 * the same variable to constant values.
 *
 * Transforms:
 * ```c
 * if (x == 1) {
 *   body1;
 * } else if (x == 2) {
 *   body2;
 * } else if (x == 3) {
 *   body3;
 * } else {
 *   default_body;
 * }
 * ```
 *
 * Into:
 * ```c
 * switch (x) {
 *   case 1:
 *     body1;
 *     break;
 *   case 2:
 *     body2;
 *     break;
 *   case 3:
 *     body3;
 *     break;
 *   default:
 *     default_body;
 * }
 * ```
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  Statement,
  IfStmt,
  SwitchStmt,
  CaseStmt,
  DefaultStmt,
  CompoundStmt,
  BreakStmt,
  BinaryExpr,
  Identifier,
  IntegerLiteralExpr,
  CharLiteralExpr,
  MemberExpr,
} from '../../../ast/nodes.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { emit } from '../../../emit/emitter.js';

// ============================================
// TYPES
// ============================================

interface SwitchCase {
  value: Expression;
  body: Statement;
}

interface SwitchChain {
  /** The variable being compared */
  switchExpr: Expression;
  /** All the cases found */
  cases: SwitchCase[];
  /** The default branch (else without condition) */
  defaultBody: Statement | null;
  /** Original location info */
  location: ASTNode['location'];
}

// ============================================
// HELPERS
// ============================================

/**
 * Check if an expression is a constant value suitable for a case label.
 *
 * An identifier only qualifies when it NAMES AN ENUMERATOR. The earlier rule
 * ("could be an enum constant - allow it") accepted any identifier, so a chain
 * of `if (pClickedAnim == gpAnimImgCharCreateAmazon)` over `D2ControlStrc*`
 * globals became `switch (pClickedAnim) { case gpAnimImgCharCreateAmazon: }` —
 * ill-formed C++ at any type, and a construct Ghidra never emitted. The caller
 * supplies the enumerator names, so the guess becomes a lookup; with no set
 * supplied nothing is knowably constant and only literals qualify.
 */
function isConstantValue(expr: Expression, enumConstants: ReadonlySet<string>): boolean {
  switch (expr.kind) {
    case NodeKind.IntegerLiteral:
    case NodeKind.CharLiteral:
      return true;
    case NodeKind.Identifier:
      return enumConstants.has((expr as Identifier).name);
    case NodeKind.UnaryExpr:
      // Allow negated constants like -1
      const unary = expr as any;
      return unary.operator === '-' && isConstantValue(unary.operand, enumConstants);
    default:
      return false;
  }
}

/**
 * Check if two expressions refer to the same variable/location
 */
function expressionsEqual(a: Expression, b: Expression): boolean {
  // Compare by emitting to string - simple but effective
  try {
    const strA = emit(a as any);
    const strB = emit(b as any);
    return strA === strB;
  } catch {
    return false;
  }
}

/**
 * Check if expression is a simple variable/member access suitable for switch
 */
function isSwitchableExpression(expr: Expression): boolean {
  switch (expr.kind) {
    case NodeKind.Identifier:
      return true;
    case NodeKind.MemberExpr:
      return true;
    case NodeKind.SubscriptExpr:
      return true;
    case NodeKind.ParenExpr:
      return isSwitchableExpression((expr as any).expression);
    default:
      return false;
  }
}

/**
 * Extract comparison info from a condition
 * Returns { variable, constant } if condition is `variable == constant` or `constant == variable`
 */
function extractEqualityComparison(
  condition: Expression,
  enumConstants: ReadonlySet<string>
): { variable: Expression; constant: Expression } | null {
  // Unwrap parentheses
  while (condition.kind === NodeKind.ParenExpr) {
    condition = (condition as any).expression;
  }

  if (condition.kind !== NodeKind.BinaryExpr) {
    return null;
  }

  const binary = condition as BinaryExpr;

  // Must be equality comparison
  if (binary.operator !== '==') {
    return null;
  }

  const left = binary.left;
  const right = binary.right;

  // Case: variable == constant
  if (isSwitchableExpression(left) && isConstantValue(right, enumConstants)) {
    return { variable: left, constant: right };
  }

  // Case: constant == variable
  if (isConstantValue(left, enumConstants) && isSwitchableExpression(right)) {
    return { variable: right, constant: left };
  }

  return null;
}

/**
 * Extract all cases from an if-else-if chain
 */
function extractSwitchChain(ifStmt: IfStmt, enumConstants: ReadonlySet<string>): SwitchChain | null {
  const cases: SwitchCase[] = [];
  let switchExpr: Expression | null = null;
  let currentIf: IfStmt | null = ifStmt;
  let defaultBody: Statement | null = null;

  while (currentIf) {
    const comparison = extractEqualityComparison(currentIf.condition, enumConstants);

    if (!comparison) {
      // Non-equality condition breaks the chain
      return null;
    }

    // First case establishes the switch variable
    if (!switchExpr) {
      switchExpr = comparison.variable;
    } else {
      // Subsequent cases must compare the same variable
      if (!expressionsEqual(switchExpr, comparison.variable)) {
        return null;
      }
    }

    cases.push({
      value: comparison.constant,
      body: currentIf.thenBranch,
    });

    // Check the else branch
    const elseBranch = currentIf.elseBranch;

    if (!elseBranch) {
      // No else branch - end of chain
      break;
    }

    if (elseBranch.kind === NodeKind.IfStmt) {
      // Continue with else-if
      currentIf = elseBranch as IfStmt;
    } else {
      // Final else (default case)
      defaultBody = elseBranch;
      break;
    }
  }

  // Need at least 2 cases for a valid switch (minCases check happens in transformer)
  if (cases.length < 2 || !switchExpr) {
    return null;
  }

  return {
    switchExpr,
    cases,
    defaultBody,
    location: ifStmt.location,
  };
}

/**
 * Create a break statement with a source location
 */
function createBreakStmt(location: any): BreakStmt {
  return {
    kind: NodeKind.BreakStmt,
    location,
    leadingTrivia: [],
    trailingTrivia: [],
  };
}

/**
 * Add break statement to a case body if needed
 */
function addBreakToBody(body: Statement): Statement {
  // If body is already a compound statement, add break at the end
  if (body.kind === NodeKind.CompoundStmt) {
    const compound = body as CompoundStmt;
    const lastStmt = compound.statements[compound.statements.length - 1];

    // Don't add break if already ends with break, return, or continue
    if (
      lastStmt &&
      (lastStmt.kind === NodeKind.BreakStmt ||
        lastStmt.kind === NodeKind.ReturnStmt ||
        lastStmt.kind === NodeKind.ContinueStmt)
    ) {
      return body;
    }

    return {
      ...compound,
      statements: [...compound.statements, createBreakStmt(body.location)],
    };
  }

  // For single statements, wrap in compound and add break
  // Unless it's a return/break/continue
  if (
    body.kind === NodeKind.BreakStmt ||
    body.kind === NodeKind.ReturnStmt ||
    body.kind === NodeKind.ContinueStmt
  ) {
    return body;
  }

  return {
    kind: NodeKind.CompoundStmt,
    statements: [body, createBreakStmt(body.location)],
    location: body.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as CompoundStmt;
}

/**
 * Create a switch statement from a chain
 */
function createSwitchFromChain(chain: SwitchChain): SwitchStmt {
  const statements: Statement[] = [];
  const location = chain.location;

  // Create case statements
  for (const c of chain.cases) {
    const caseStmt: CaseStmt = {
      kind: NodeKind.CaseStmt,
      value: c.value,
      statement: addBreakToBody(c.body),
      location,
      leadingTrivia: [],
      trailingTrivia: [],
    };
    statements.push(caseStmt);
  }

  // Create default statement if present
  if (chain.defaultBody) {
    const defaultStmt: DefaultStmt = {
      kind: NodeKind.DefaultStmt,
      statement: chain.defaultBody,
      location,
      leadingTrivia: [],
      trailingTrivia: [],
    };
    statements.push(defaultStmt);
  }

  // Create the switch body
  const body: CompoundStmt = {
    kind: NodeKind.CompoundStmt,
    statements,
    location,
    leadingTrivia: [],
    trailingTrivia: [],
  };

  // Create the switch statement
  return {
    kind: NodeKind.SwitchStmt,
    condition: chain.switchExpr,
    body,
    location,
    leadingTrivia: [],
    trailingTrivia: [],
  };
}

// ============================================
// TRANSFORMER
// ============================================

/**
 * Create the switch reconstruction transformer
 */
function createSwitchReconstructor(options: SwitchReconstructOptions): Transformer {
  const minCases = options.minCases ?? 3;
  const enumConstants = new Set(options.enumConstants ?? []);

  return createTransformer({
    visitIfStmt(ifStmt) {
      // Try to extract a switch chain from this if statement
      const chain = extractSwitchChain(ifStmt, enumConstants);

      if (!chain) {
        return undefined;
      }

      // Check minimum cases threshold
      if (chain.cases.length < minCases) {
        return undefined;
      }

      // Convert to switch
      return createSwitchFromChain(chain);
    },
  });
}

// ============================================
// PLUGIN DEFINITION
// ============================================

export interface SwitchReconstructOptions extends PluginOptions {
  /** Minimum number of cases to convert to switch (default: 3) */
  minCases?: number;
  /**
   * Names of enumerators (Ghidra ENUM datatype values). Only an identifier in
   * this set is accepted as a case label; every other identifier names an
   * object, which is not a constant expression.
   */
  enumConstants?: string[];
}

/**
 * Switch Reconstruction Plugin
 *
 * Reconstructs switch statements from if-else-if chains
 * where all branches compare the same variable to constants.
 */
export const switchReconstructPlugin: TransformPlugin = {
  id: 'switch-reconstruct',
  name: 'Switch Reconstruction',
  description:
    'Reconstruct switch statements from if-else-if chains comparing the same variable to constants',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 45, // After vtable but before ternary simplify
  tags: ['core', 'control-flow', 'readability'],

  createTransformer(options?: SwitchReconstructOptions) {
    return createSwitchReconstructor(options ?? {});
  },
};
