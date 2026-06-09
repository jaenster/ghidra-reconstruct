/**
 * Loop Canonicalization Plugin
 *
 * Transforms increment/decrement patterns and while loops into
 * canonical C++ forms.
 *
 * Transforms:
 * - i = i + 1  →  i++
 * - i = i - 1  →  i--
 * - i = i + N  →  i += N
 * - i = i - N  →  i -= N
 * - while loops with init/update → for loops (future)
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  AssignExpr,
  BinaryExpr,
  Expression,
  Identifier,
  IntegerLiteralExpr,
  PostfixExpr,
  Statement,
  CompoundStmt,
  WhileStmt,
  ExprStmt,
  ForStmt,
  DeclStmt,
  VariableDecl,
} from '../../../ast/nodes.js';
import {
  createTransformer,
  createKindTransformer,
  updateNode,
  nodesEqual,
  sequence,
  type Transformer,
} from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

// ============================================
// HELPERS
// ============================================

/**
 * Check if two expressions refer to the same identifier
 */
function sameIdentifier(a: Expression, b: Expression): boolean {
  if (a.kind === NodeKind.Identifier && b.kind === NodeKind.Identifier) {
    return (a as Identifier).name === (b as Identifier).name;
  }
  return false;
}

/**
 * Check if expression is an integer literal with given value
 */
function isIntLiteral(expr: Expression, value?: bigint): boolean {
  if (expr.kind !== NodeKind.IntegerLiteral) return false;
  if (value !== undefined) {
    return (expr as IntegerLiteralExpr).value === value;
  }
  return true;
}

/**
 * Get the integer value from a literal, or null
 */
function getIntValue(expr: Expression): bigint | null {
  if (expr.kind === NodeKind.IntegerLiteral) {
    return (expr as IntegerLiteralExpr).value;
  }
  return null;
}

// ============================================
// INCREMENT/DECREMENT TRANSFORMATION
// ============================================

/**
 * Transform i = i + 1 to i++ and i = i - 1 to i--
 * Also handles i = i + N to i += N
 */
function createIncrementTransformer(): Transformer {
  return createKindTransformer(NodeKind.AssignExpr, (node) => {
    const assign = node as AssignExpr;

    // Only handle simple assignment
    if (assign.operator !== '=') return undefined;

    // Right side must be binary expression
    if (assign.right.kind !== NodeKind.BinaryExpr) return undefined;

    const binary = assign.right as BinaryExpr;

    // Must be + or -
    if (binary.operator !== '+' && binary.operator !== '-') return undefined;

    // Check if left side of assignment matches left or right side of binary
    const assignTarget = assign.left;
    const isAddingToSelf = sameIdentifier(assignTarget, binary.left);
    const isSubtractingFromSelf = sameIdentifier(assignTarget, binary.left);

    if (!isAddingToSelf && !isSubtractingFromSelf) {
      // Also check for "1 + i" pattern (commutative for addition)
      if (binary.operator === '+' && sameIdentifier(assignTarget, binary.right)) {
        // i = 1 + i → handled below with swapped operands
        const otherOperand = binary.left;
        const intValue = getIntValue(otherOperand);

        if (intValue === 1n) {
          // i = 1 + i → i++
          return {
            kind: NodeKind.PostfixExpr,
            operator: '++',
            operand: assignTarget,
            location: assign.location,
            leadingTrivia: assign.leadingTrivia,
            trailingTrivia: assign.trailingTrivia,
          } as PostfixExpr;
        }

        if (intValue !== null) {
          // i = N + i → i += N
          return updateNode(assign, {
            operator: '+=',
            right: otherOperand,
          }) as AssignExpr;
        }
      }
      return undefined;
    }

    // i = i + something or i = i - something
    const otherOperand = binary.right;
    const intValue = getIntValue(otherOperand);

    if (intValue === 1n) {
      // i = i + 1 → i++ or i = i - 1 → i--
      const op = binary.operator === '+' ? '++' : '--';
      return {
        kind: NodeKind.PostfixExpr,
        operator: op,
        operand: assignTarget,
        location: assign.location,
        leadingTrivia: assign.leadingTrivia,
        trailingTrivia: assign.trailingTrivia,
      } as PostfixExpr;
    }

    if (intValue !== null || otherOperand.kind === NodeKind.Identifier) {
      // i = i + N → i += N or i = i - N → i -= N
      const compoundOp = binary.operator === '+' ? '+=' : '-=';
      return updateNode(assign, {
        operator: compoundOp,
        right: otherOperand,
      }) as AssignExpr;
    }

    return undefined;
  });
}

// ============================================
// WHILE TO FOR TRANSFORMATION
// ============================================

export interface WhileToForOptions extends PluginOptions {
  /** Enable while-to-for conversion (default: false - experimental) */
  enabled?: boolean;
}

/**
 * Detect and transform while loops that follow for-loop patterns
 *
 * Pattern:
 *   int i = 0;
 *   while (i < n) {
 *     ...
 *     i++;
 *   }
 *
 * Becomes:
 *   for (int i = 0; i < n; i++) {
 *     ...
 *   }
 */
function createWhileToForTransformer(options: WhileToForOptions = {}): Transformer {
  if (options.enabled === false) {
    return (node) => node;
  }

  return createTransformer({
    visitCompoundStmt(compound) {
      const newStatements: Statement[] = [];
      let modified = false;

      for (let i = 0; i < compound.statements.length; i++) {
        const stmt = compound.statements[i];
        const nextStmt = compound.statements[i + 1];

        // Look for pattern: declaration followed by while
        if (
          stmt.kind === NodeKind.DeclStmt &&
          nextStmt?.kind === NodeKind.WhileStmt
        ) {
          const declStmt = stmt as DeclStmt;
          const whileStmt = nextStmt as WhileStmt;

          // Check if declaration is a single variable with initializer
          if (declStmt.declarations.length === 1) {
            const decl = declStmt.declarations[0];
            if (decl.kind === NodeKind.VariableDecl) {
              const varDecl = decl as VariableDecl;

              // Check if the while body is a compound statement
              if (whileStmt.body.kind === NodeKind.CompoundStmt) {
                const whileBody = whileStmt.body as CompoundStmt;

                // Check if the last statement is an increment of our variable
                const lastStmt = whileBody.statements[whileBody.statements.length - 1];
                const increment = extractIncrement(lastStmt, varDecl.name.name);

                if (increment) {
                  // Found the pattern! Transform to for loop
                  const forBody = {
                    ...whileBody,
                    // Remove the increment from the body
                    statements: whileBody.statements.slice(0, -1),
                  } as CompoundStmt;

                  const forStmt: ForStmt = {
                    kind: NodeKind.ForStmt,
                    init: declStmt,
                    condition: whileStmt.condition,
                    increment,
                    body: forBody,
                    location: declStmt.location,
                    leadingTrivia: declStmt.leadingTrivia,
                    trailingTrivia: whileStmt.trailingTrivia,
                  };

                  newStatements.push(forStmt);
                  i++; // Skip the while statement
                  modified = true;
                  continue;
                }
              }
            }
          }
        }

        newStatements.push(stmt);
      }

      if (modified) {
        return updateNode(compound, { statements: newStatements });
      }

      return undefined;
    },
  });
}

/**
 * Extract an increment expression from a statement if it matches the variable
 */
function extractIncrement(stmt: Statement, varName: string): Expression | null {
  if (stmt.kind !== NodeKind.ExprStmt) return null;

  const exprStmt = stmt as ExprStmt;
  const expr = exprStmt.expression;

  // Check for i++ or ++i
  if (expr.kind === NodeKind.PostfixExpr) {
    const postfix = expr as PostfixExpr;
    if (postfix.operator === '++' || postfix.operator === '--') {
      if (postfix.operand.kind === NodeKind.Identifier) {
        if ((postfix.operand as Identifier).name === varName) {
          return expr;
        }
      }
    }
  }

  // Check for i = i + 1 style (compound assignments)
  if (expr.kind === NodeKind.AssignExpr) {
    const assign = expr as AssignExpr;
    if (assign.operator === '+=' || assign.operator === '-=') {
      if (assign.left.kind === NodeKind.Identifier) {
        if ((assign.left as Identifier).name === varName) {
          return expr;
        }
      }
    }
  }

  return null;
}

// ============================================
// PLUGIN DEFINITION
// ============================================

export interface LoopCanonicalizeOptions extends PluginOptions {
  /** Convert i = i + 1 to i++ (default: true) */
  incrementDecrement?: boolean;

  /** Convert while to for when pattern matches (default: false, experimental) */
  whileToFor?: boolean;
}

/**
 * Loop Canonicalization Plugin
 *
 * Transforms common increment/decrement patterns and loops into
 * more idiomatic C++ forms.
 */
export const loopCanonicalizePlugin: TransformPlugin = {
  id: 'loop-canonicalize',
  name: 'Loop Canonicalization',
  description:
    'Canonicalize loop patterns: i = i + 1 → i++, i = i - 1 → i--, and optionally while → for',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 40, // Run after name cleanup but before most other transforms
  tags: ['core', 'cleanup', 'loops'],

  createTransformer(options?: LoopCanonicalizeOptions) {
    const opts = options ?? {};
    const transforms: Transformer[] = [];

    // Increment/decrement is on by default
    if (opts.incrementDecrement !== false) {
      transforms.push(createIncrementTransformer());
    }

    // While-to-for is off by default (experimental)
    if (opts.whileToFor) {
      transforms.push(createWhileToForTransformer({ enabled: true }));
    }

    return sequence(...transforms);
  },
};
