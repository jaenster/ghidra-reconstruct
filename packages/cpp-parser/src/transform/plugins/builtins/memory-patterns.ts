/**
 * Memory Pattern Plugin
 *
 * Detects and transforms common memory operation patterns.
 *
 * Detects:
 * - memset loops (zero-fill or fill with constant)
 * - memcpy loops (copy from source to dest)
 * - strlen loops (count until null terminator)
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  Statement,
  Identifier,
  WhileStmt,
  ForStmt,
  CompoundStmt,
  ExprStmt,
  AssignExpr,
  BinaryExpr,
  UnaryExpr,
  PostfixExpr,
  SubscriptExpr,
  IntegerLiteralExpr,
  CallExpr,
  DeclStmt,
  VariableDecl,
} from '../../../ast/nodes.js';
import {
  createTransformer,
  updateNode,
  sequence,
  type Transformer,
} from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

// ============================================
// TYPES
// ============================================

interface MemsetPattern {
  destination: Expression;
  value: Expression;
  count: Expression;
  loopVar: string;
}

interface MemcpyPattern {
  destination: Expression;
  source: Expression;
  count: Expression;
  loopVar: string;
}

// ============================================
// HELPERS
// ============================================

/**
 * Extract identifier name from expression
 */
function getIdentifierName(expr: Expression): string | null {
  if (expr.kind === NodeKind.Identifier) {
    return (expr as Identifier).name;
  }
  return null;
}

/**
 * Check if expression is a zero integer literal
 */
function isZero(expr: Expression): boolean {
  if (expr.kind === NodeKind.IntegerLiteral) {
    return (expr as IntegerLiteralExpr).value === 0n;
  }
  return false;
}

/**
 * Check if an expression is an increment of a variable
 */
function isIncrement(expr: Expression, varName: string): boolean {
  // Check for i++ or ++i
  if (expr.kind === NodeKind.PostfixExpr) {
    const postfix = expr as PostfixExpr;
    if (postfix.operator === '++') {
      const name = getIdentifierName(postfix.operand);
      return name === varName;
    }
  }

  if (expr.kind === NodeKind.UnaryExpr) {
    const unary = expr as UnaryExpr;
    if (unary.operator === '++') {
      const name = getIdentifierName(unary.operand);
      return name === varName;
    }
  }

  // Check for i += 1 or i = i + 1
  if (expr.kind === NodeKind.AssignExpr) {
    const assign = expr as AssignExpr;
    const leftName = getIdentifierName(assign.left);
    if (leftName !== varName) return false;

    if (assign.operator === '+=') {
      if (assign.right.kind === NodeKind.IntegerLiteral) {
        return (assign.right as IntegerLiteralExpr).value === 1n;
      }
    }
  }

  return false;
}

/**
 * Check if condition is "i < count" style
 */
function extractLoopBound(
  condition: Expression,
  loopVar: string
): Expression | null {
  if (condition.kind !== NodeKind.BinaryExpr) return null;

  const binary = condition as BinaryExpr;
  if (binary.operator !== '<' && binary.operator !== '<=') return null;

  const leftName = getIdentifierName(binary.left);
  if (leftName !== loopVar) return null;

  return binary.right;
}

/**
 * Check if a statement is an assignment to array[i] = value
 */
function extractArrayAssignment(
  stmt: Statement,
  loopVar: string
): { array: Expression; value: Expression } | null {
  if (stmt.kind !== NodeKind.ExprStmt) return null;

  const exprStmt = stmt as ExprStmt;
  if (exprStmt.expression.kind !== NodeKind.AssignExpr) return null;

  const assign = exprStmt.expression as AssignExpr;
  if (assign.operator !== '=') return null;

  // Check for array[i] pattern
  if (assign.left.kind === NodeKind.SubscriptExpr) {
    const subscript = assign.left as SubscriptExpr;
    const indexName = getIdentifierName(subscript.index);
    if (indexName === loopVar) {
      return {
        array: subscript.array,
        value: assign.right,
      };
    }
  }

  // Check for *(array + i) pattern
  if (assign.left.kind === NodeKind.UnaryExpr) {
    const unary = assign.left as UnaryExpr;
    if (unary.operator === '*') {
      if (unary.operand.kind === NodeKind.BinaryExpr) {
        const binary = unary.operand as BinaryExpr;
        if (binary.operator === '+') {
          const indexName =
            getIdentifierName(binary.right) || getIdentifierName(binary.left);
          if (indexName === loopVar) {
            const array =
              getIdentifierName(binary.right) === loopVar
                ? binary.left
                : binary.right;
            return { array, value: assign.right };
          }
        }
      }
    }
  }

  return null;
}

// ============================================
// MEMSET DETECTION
// ============================================

/**
 * Detect memset pattern in a for loop
 *
 * Pattern:
 *   for (i = 0; i < n; i++) {
 *     dest[i] = 0;
 *   }
 */
function detectMemsetInFor(forStmt: ForStmt): MemsetPattern | null {
  // Check if body is a compound statement with single assignment
  if (forStmt.body.kind !== NodeKind.CompoundStmt) return null;

  const body = forStmt.body as CompoundStmt;
  if (body.statements.length !== 1) return null;

  // Get loop variable from init
  let loopVar: string | null = null;

  if (forStmt.init?.kind === NodeKind.DeclStmt) {
    const declStmt = forStmt.init as DeclStmt;
    if (declStmt.declarations.length === 1) {
      const decl = declStmt.declarations[0];
      if (decl.kind === NodeKind.VariableDecl) {
        const varDecl = decl as VariableDecl;
        // Check if initialized to 0
        if (varDecl.initializer && isZero(varDecl.initializer)) {
          loopVar = varDecl.name.name;
        }
      }
    }
  } else if (forStmt.init?.kind === NodeKind.ExprStmt) {
    const exprStmt = forStmt.init as ExprStmt;
    if (exprStmt.expression.kind === NodeKind.AssignExpr) {
      const assign = exprStmt.expression as AssignExpr;
      if (assign.operator === '=' && isZero(assign.right)) {
        loopVar = getIdentifierName(assign.left);
      }
    }
  }

  if (!loopVar) return null;

  // Check condition
  if (!forStmt.condition) return null;
  const count = extractLoopBound(forStmt.condition, loopVar);
  if (!count) return null;

  // Check increment
  if (!forStmt.increment) return null;
  if (!isIncrement(forStmt.increment, loopVar)) return null;

  // Check body assignment
  const assignment = extractArrayAssignment(body.statements[0], loopVar);
  if (!assignment) return null;

  return {
    destination: assignment.array,
    value: assignment.value,
    count,
    loopVar,
  };
}

/**
 * Create memset call from pattern
 */
function createMemsetCall(
  pattern: MemsetPattern,
  originalLocation: ASTNode['location'],
  leadingTrivia: ASTNode['leadingTrivia'],
  trailingTrivia: ASTNode['trailingTrivia']
): CallExpr {
  const memsetId: Identifier = {
    kind: NodeKind.Identifier,
    name: 'memset',
    location: originalLocation,
    leadingTrivia: [],
    trailingTrivia: [],
  };

  return {
    kind: NodeKind.CallExpr,
    callee: memsetId,
    arguments: [pattern.destination, pattern.value, pattern.count],
    location: originalLocation,
    leadingTrivia,
    trailingTrivia,
  };
}

// ============================================
// TRANSFORM FUNCTIONS
// ============================================

/**
 * Transform memset loops to memset calls
 */
function createMemsetTransformer(addComment: boolean): Transformer {
  return createTransformer({
    visitForStmt(forStmt) {
      const pattern = detectMemsetInFor(forStmt);
      if (!pattern) return undefined;

      // Only transform if filling with a constant
      if (
        pattern.value.kind !== NodeKind.IntegerLiteral &&
        pattern.value.kind !== NodeKind.CharLiteral
      ) {
        return undefined;
      }

      const memsetCall = createMemsetCall(
        pattern,
        forStmt.location,
        forStmt.leadingTrivia,
        forStmt.trailingTrivia
      );

      // Wrap in expression statement
      const exprStmt: ExprStmt = {
        kind: NodeKind.ExprStmt,
        expression: memsetCall,
        location: forStmt.location,
        leadingTrivia: forStmt.leadingTrivia,
        trailingTrivia: forStmt.trailingTrivia,
      };

      // TODO: If addComment, we'd add a comment with the original loop
      // This requires extending the trivia system

      return exprStmt;
    },
  });
}

/**
 * Detect memcpy pattern in a for loop
 *
 * Pattern:
 *   for (i = 0; i < n; i++) {
 *     dest[i] = src[i];
 *   }
 */
function detectMemcpyInFor(forStmt: ForStmt): MemcpyPattern | null {
  // Check if body is a compound statement with single assignment
  if (forStmt.body.kind !== NodeKind.CompoundStmt) return null;

  const body = forStmt.body as CompoundStmt;
  if (body.statements.length !== 1) return null;

  // Get loop variable from init
  let loopVar: string | null = null;

  if (forStmt.init?.kind === NodeKind.DeclStmt) {
    const declStmt = forStmt.init as DeclStmt;
    if (declStmt.declarations.length === 1) {
      const decl = declStmt.declarations[0];
      if (decl.kind === NodeKind.VariableDecl) {
        const varDecl = decl as VariableDecl;
        if (varDecl.initializer && isZero(varDecl.initializer)) {
          loopVar = varDecl.name.name;
        }
      }
    }
  } else if (forStmt.init?.kind === NodeKind.ExprStmt) {
    const exprStmt = forStmt.init as ExprStmt;
    if (exprStmt.expression.kind === NodeKind.AssignExpr) {
      const assign = exprStmt.expression as AssignExpr;
      if (assign.operator === '=' && isZero(assign.right)) {
        loopVar = getIdentifierName(assign.left);
      }
    }
  }

  if (!loopVar) return null;

  // Check condition
  if (!forStmt.condition) return null;
  const count = extractLoopBound(forStmt.condition, loopVar);
  if (!count) return null;

  // Check increment
  if (!forStmt.increment) return null;
  if (!isIncrement(forStmt.increment, loopVar)) return null;

  // Check body assignment: dest[i] = src[i]
  const stmt = body.statements[0];
  if (stmt.kind !== NodeKind.ExprStmt) return null;

  const exprStmt = stmt as ExprStmt;
  if (exprStmt.expression.kind !== NodeKind.AssignExpr) return null;

  const assign = exprStmt.expression as AssignExpr;
  if (assign.operator !== '=') return null;

  // Both sides must be subscript with loopVar
  let dest: Expression | null = null;
  let src: Expression | null = null;

  if (assign.left.kind === NodeKind.SubscriptExpr) {
    const subscript = assign.left as SubscriptExpr;
    const indexName = getIdentifierName(subscript.index);
    if (indexName === loopVar) {
      dest = subscript.array;
    }
  }

  if (assign.right.kind === NodeKind.SubscriptExpr) {
    const subscript = assign.right as SubscriptExpr;
    const indexName = getIdentifierName(subscript.index);
    if (indexName === loopVar) {
      src = subscript.array;
    }
  }

  if (!dest || !src) return null;

  return {
    destination: dest,
    source: src,
    count,
    loopVar,
  };
}

/**
 * Create memcpy call from pattern
 */
function createMemcpyCall(
  pattern: MemcpyPattern,
  originalLocation: ASTNode['location'],
  leadingTrivia: ASTNode['leadingTrivia'],
  trailingTrivia: ASTNode['trailingTrivia']
): CallExpr {
  const memcpyId: Identifier = {
    kind: NodeKind.Identifier,
    name: 'memcpy',
    location: originalLocation,
    leadingTrivia: [],
    trailingTrivia: [],
  };

  return {
    kind: NodeKind.CallExpr,
    callee: memcpyId,
    arguments: [pattern.destination, pattern.source, pattern.count],
    location: originalLocation,
    leadingTrivia,
    trailingTrivia,
  };
}

/**
 * Transform memcpy loops to memcpy calls
 */
function createMemcpyTransformer(): Transformer {
  return createTransformer({
    visitForStmt(forStmt) {
      const pattern = detectMemcpyInFor(forStmt);
      if (!pattern) return undefined;

      const memcpyCall = createMemcpyCall(
        pattern,
        forStmt.location,
        forStmt.leadingTrivia,
        forStmt.trailingTrivia
      );

      // Wrap in expression statement
      const exprStmt: ExprStmt = {
        kind: NodeKind.ExprStmt,
        expression: memcpyCall,
        location: forStmt.location,
        leadingTrivia: forStmt.leadingTrivia,
        trailingTrivia: forStmt.trailingTrivia,
      };

      return exprStmt;
    },
  });
}

// ============================================
// STRLEN DETECTION
// ============================================

interface StrlenPattern {
  str: Expression;
  counterVar: string;
}

/**
 * Detect strlen pattern in a while loop
 *
 * Pattern:
 *   i = 0;
 *   while (str[i] != '\0') { i++; }
 *   // i now contains strlen
 *
 * Or:
 *   while (str[i] != 0) { i = i + 1; }
 */
function detectStrlenInWhile(whileStmt: WhileStmt): StrlenPattern | null {
  // Condition should be: str[i] != 0  or  *(str + i) != 0
  const condition = whileStmt.condition;
  if (condition.kind !== NodeKind.BinaryExpr) return null;

  const binary = condition as BinaryExpr;
  if (binary.operator !== '!=') return null;

  // Right should be 0 or '\0'
  if (!isZero(binary.right)) return null;

  // Left should be array access
  let str: Expression | null = null;
  let indexVar: string | null = null;

  if (binary.left.kind === NodeKind.SubscriptExpr) {
    const subscript = binary.left as SubscriptExpr;
    str = subscript.array;
    indexVar = getIdentifierName(subscript.index);
  } else if (binary.left.kind === NodeKind.UnaryExpr) {
    const unary = binary.left as UnaryExpr;
    if (unary.operator === '*' && unary.operand.kind === NodeKind.BinaryExpr) {
      const inner = unary.operand as BinaryExpr;
      if (inner.operator === '+') {
        indexVar = getIdentifierName(inner.right) || getIdentifierName(inner.left);
        str = getIdentifierName(inner.right) === indexVar ? inner.left : inner.right;
      }
    }
  }

  if (!str || !indexVar) return null;

  // Body should be just an increment
  let body = whileStmt.body;
  if (body.kind === NodeKind.CompoundStmt) {
    const compound = body as CompoundStmt;
    if (compound.statements.length !== 1) return null;
    body = compound.statements[0];
  }

  if (body.kind !== NodeKind.ExprStmt) return null;

  const exprStmt = body as ExprStmt;
  if (!isIncrement(exprStmt.expression, indexVar)) return null;

  return {
    str,
    counterVar: indexVar,
  };
}

/**
 * Create strlen call from pattern
 */
function createStrlenCall(
  pattern: StrlenPattern,
  originalLocation: ASTNode['location'],
  leadingTrivia: ASTNode['leadingTrivia'],
  trailingTrivia: ASTNode['trailingTrivia']
): AssignExpr {
  const strlenId: Identifier = {
    kind: NodeKind.Identifier,
    name: 'strlen',
    location: originalLocation,
    leadingTrivia: [],
    trailingTrivia: [],
  };

  const call: CallExpr = {
    kind: NodeKind.CallExpr,
    callee: strlenId,
    arguments: [pattern.str],
    location: originalLocation,
    leadingTrivia: [],
    trailingTrivia: [],
  };

  const counterVar: Identifier = {
    kind: NodeKind.Identifier,
    name: pattern.counterVar,
    location: originalLocation,
    leadingTrivia,
    trailingTrivia: [],
  };

  return {
    kind: NodeKind.AssignExpr,
    operator: '=',
    left: counterVar,
    right: call,
    location: originalLocation,
    leadingTrivia,
    trailingTrivia,
  };
}

/**
 * Transform strlen loops to strlen calls
 */
function createStrlenTransformer(): Transformer {
  return createTransformer({
    visitWhileStmt(whileStmt) {
      const pattern = detectStrlenInWhile(whileStmt);
      if (!pattern) return undefined;

      const strlenAssign = createStrlenCall(
        pattern,
        whileStmt.location,
        whileStmt.leadingTrivia,
        whileStmt.trailingTrivia
      );

      // Wrap in expression statement
      const exprStmt: ExprStmt = {
        kind: NodeKind.ExprStmt,
        expression: strlenAssign,
        location: whileStmt.location,
        leadingTrivia: whileStmt.leadingTrivia,
        trailingTrivia: whileStmt.trailingTrivia,
      };

      return exprStmt;
    },
  });
}

// ============================================
// PLUGIN DEFINITION
// ============================================

export interface MemoryPatternsOptions extends PluginOptions {
  /** Detect and transform memset loops (default: true) */
  memset?: boolean;

  /** Detect and transform memcpy loops (default: true) */
  memcpy?: boolean;

  /** Detect and transform strlen loops (default: true) */
  strlen?: boolean;

  /** Add comment with original loop (default: false) */
  addOriginalComment?: boolean;
}

/**
 * Memory Pattern Plugin
 *
 * Detects common memory operation loops and transforms them
 * to standard library calls.
 */
export const memoryPatternsPlugin: TransformPlugin = {
  id: 'memory-patterns',
  name: 'Memory Pattern Detection',
  description:
    'Detect memset/memcpy/strlen loops and transform to standard library calls',
  version: '1.1.0',
  defaultEnabled: false, // Off by default as it's more aggressive
  priority: 80, // Run late, after other simplifications
  tags: ['patterns', 'optimization'],

  createTransformer(options?: MemoryPatternsOptions) {
    const opts = options ?? {};
    const transforms: Transformer[] = [];

    if (opts.memset !== false) {
      transforms.push(createMemsetTransformer(opts.addOriginalComment ?? false));
    }

    if (opts.memcpy !== false) {
      transforms.push(createMemcpyTransformer());
    }

    if (opts.strlen !== false) {
      transforms.push(createStrlenTransformer());
    }

    return sequence(...transforms);
  },
};
