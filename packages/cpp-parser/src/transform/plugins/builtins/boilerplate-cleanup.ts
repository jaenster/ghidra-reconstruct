/**
 * Boilerplate Pattern Cleanup Plugin
 *
 * Removes verbose compiler-inserted security boilerplate and simplifies
 * assertion patterns from Ghidra decompiler output.
 *
 * Transforms:
 * - uint32_t local_8 = DEFAULT_SECURITY_COOKIE ^ ...  →  [removed]
 * - Fog::Debug::GuardStack(...)                       →  [removed]
 * - if (condition) { nLine = ...; ERROR_Halt(...); }  →  D2_ASSERT(!(condition))
 * - if (val < min || max < val) { ERROR_Halt(...); }  →  D2_ASSERT_RANGE(val, min, max)
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Statement,
  Expression,
  VariableDecl,
  ExprStmt,
  IfStmt,
  CompoundStmt,
  AssignExpr,
  CallExpr,
  BinaryExpr,
  UnaryExpr,
  Identifier,
  QualifiedId,
  BuiltinType,
  IntegerLiteralExpr,
} from '../../../ast/nodes.js';
import { createTransformer, sequence, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions, InjectionContext } from '../types.js';

// ============================================
// HELPER TYPES
// ============================================

interface AssertionInfo {
  lineVar: string;
  addrVar: string;
  errorFunction: string;
}

interface RangeCheckInfo {
  variable: Expression;
  min: Expression;
  max: Expression;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Extract the fully qualified name from a callee expression
 * Handles: Identifier, QualifiedId, MemberExpr
 */
function extractCalleeName(expr: Expression): string {
  if (expr.kind === NodeKind.Identifier) {
    return (expr as Identifier).name;
  }

  if (expr.kind === NodeKind.QualifiedId) {
    const qual = expr as QualifiedId;
    const parts: string[] = [];

    // Build namespace path
    for (const q of qual.qualifier) {
      if (q.kind === NodeKind.Identifier) {
        parts.push((q as Identifier).name);
      }
    }

    // Add final name
    if (qual.name.kind === NodeKind.Identifier) {
      parts.push((qual.name as Identifier).name);
    }

    return parts.join('::');
  }

  if (expr.kind === NodeKind.MemberExpr) {
    const member = expr as any;
    const objectName = extractCalleeName(member.object);
    const memberName =
      member.member.kind === NodeKind.Identifier
        ? (member.member as Identifier).name
        : '';
    return objectName ? `${objectName}::${memberName}` : memberName;
  }

  return '';
}

/**
 * Check if an expression is a zero literal
 */
function isZeroLiteral(expr: Expression): boolean {
  if (expr.kind === NodeKind.IntegerLiteral) {
    return (expr as IntegerLiteralExpr).value === 0n;
  }
  return false;
}

/**
 * Unwrap parentheses from expression
 */
function unwrapParens(expr: Expression): Expression {
  while (expr.kind === NodeKind.ParenExpr) {
    expr = (expr as any).expression;
  }
  return expr;
}

/**
 * Check if a variable declaration is a security cookie initialization
 * Pattern: uint32_t local_X = DEFAULT_SECURITY_COOKIE ^ (uint32_t)&stack0xfffffffc
 */
function isSecurityCookieDecl(decl: VariableDecl): boolean {
  // Check type is uint32_t
  if (decl.type.kind !== NodeKind.BuiltinType) return false;
  const type = decl.type as BuiltinType;
  if (type.name !== 'uint32_t') return false;

  // Check has initializer
  if (!decl.initializer) return false;

  // Check initializer is XOR expression
  if (decl.initializer.kind !== NodeKind.BinaryExpr) return false;
  const binary = decl.initializer as BinaryExpr;
  if (binary.operator !== '^') return false;

  // Check left is DEFAULT_SECURITY_COOKIE
  if (binary.left.kind !== NodeKind.Identifier) return false;
  if ((binary.left as Identifier).name !== 'DEFAULT_SECURITY_COOKIE') return false;

  // Check right side involves a stack variable
  // (could be cast, address-of, etc. - we'll be lenient here)
  let right = unwrapParens(binary.right);

  // Unwrap cast if present
  if (right.kind === NodeKind.CStyleCastExpr) {
    right = (right as any).expression;
  }

  // Check for address-of operator
  if (right.kind === NodeKind.UnaryExpr) {
    const unary = right as UnaryExpr;
    if (unary.operator === '&') {
      const operand = unwrapParens(unary.operand);
      if (operand.kind === NodeKind.Identifier) {
        const varName = (operand as Identifier).name;
        // Stack variables start with "stack0x" or "local_"
        if (varName.startsWith('stack0x') || varName.startsWith('local_')) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Check if an expression statement is a GuardStack call
 * Pattern: Fog::Debug::GuardStack(...) with 1 or 2 arguments
 */
function isGuardStackCall(stmt: ExprStmt): boolean {
  // Check expression is a call
  if (stmt.expression.kind !== NodeKind.CallExpr) return false;
  const call = stmt.expression as CallExpr;

  // Extract callee name
  const calleeName = extractCalleeName(call.callee);

  // Check function name contains GuardStack
  if (!calleeName.includes('GuardStack')) return false;

  // Check it's in Fog::Debug namespace (or any namespace ending with Debug)
  const namespaceParts = calleeName.split('::');
  const hasDebugNamespace = namespaceParts.some(part => part === 'Debug');
  if (!hasDebugNamespace) return false;

  // Accept 1 or 2 arguments (reconstructed code varies)
  if (call.arguments.length < 1 || call.arguments.length > 2) return false;

  return true;
}

/**
 * Check if a statement is assertion boilerplate
 * Pattern:
 *   nLine = 0x...;
 *   nAddress = Fog::ErrorManager::GetAddress(0x...);
 *   Fog::ErrorManager::ERROR_*(...);
 */
function isAssertionBoilerplate(stmt: Statement): AssertionInfo | null {
  // Check compound statement
  if (stmt.kind !== NodeKind.CompoundStmt) return null;
  const body = stmt as CompoundStmt;

  // Need at least 3 statements
  if (body.statements.length < 3) return null;

  // Check first statement: variable = hex_literal
  const stmt1 = body.statements[0];
  if (stmt1.kind !== NodeKind.ExprStmt) return null;
  const expr1 = (stmt1 as ExprStmt).expression;
  if (expr1.kind !== NodeKind.AssignExpr) return null;
  const assign1 = expr1 as AssignExpr;
  if (assign1.left.kind !== NodeKind.Identifier) return null;
  const lineVar = (assign1.left as Identifier).name;
  if (!lineVar.toLowerCase().includes('line')) return null;
  if (assign1.right.kind !== NodeKind.IntegerLiteral) return null;

  // Check second statement: variable = GetAddress(...)
  const stmt2 = body.statements[1];
  if (stmt2.kind !== NodeKind.ExprStmt) return null;
  const expr2 = (stmt2 as ExprStmt).expression;
  if (expr2.kind !== NodeKind.AssignExpr) return null;
  const assign2 = expr2 as AssignExpr;
  if (assign2.left.kind !== NodeKind.Identifier) return null;
  const addrVar = (assign2.left as Identifier).name;
  if (!addrVar.toLowerCase().includes('address')) return null;
  if (assign2.right.kind !== NodeKind.CallExpr) return null;
  const call2 = assign2.right as CallExpr;
  const calleeName2 = extractCalleeName(call2.callee);
  if (!calleeName2.includes('GetAddress')) return null;

  // Check third statement: ERROR_* call
  const stmt3 = body.statements[2];
  if (stmt3.kind !== NodeKind.ExprStmt) return null;
  const expr3 = (stmt3 as ExprStmt).expression;
  if (expr3.kind !== NodeKind.CallExpr) return null;
  const call3 = expr3 as CallExpr;
  const calleeName3 = extractCalleeName(call3.callee);
  if (!calleeName3.includes('ERROR_')) return null;

  return {
    lineVar,
    addrVar,
    errorFunction: calleeName3,
  };
}

/**
 * Parse a range check pattern from a condition
 * Pattern: val < min || max < val  or  (int)val < min || max < (int)val
 */
function parseRangeCheck(condition: Expression): RangeCheckInfo | null {
  const cond = unwrapParens(condition);

  // Check for OR expression
  if (cond.kind !== NodeKind.BinaryExpr) return null;
  const binary = cond as BinaryExpr;
  if (binary.operator !== '||') return null;

  // Unwrap left and right
  const left = unwrapParens(binary.left);
  const right = unwrapParens(binary.right);

  // Both should be comparisons
  if (left.kind !== NodeKind.BinaryExpr || right.kind !== NodeKind.BinaryExpr) {
    return null;
  }

  const leftComp = left as BinaryExpr;
  const rightComp = right as BinaryExpr;

  // Pattern 1: val < min || max < val
  if (leftComp.operator === '<' && rightComp.operator === '<') {
    // Extract variable (should be same in both)
    const leftVar = unwrapCast(unwrapParens(leftComp.left));
    const rightVal = unwrapCast(unwrapParens(rightComp.right));

    // Check if they're the same variable
    if (isSameExpression(leftVar, rightVal)) {
      return {
        variable: leftVar,
        min: unwrapParens(leftComp.right),
        max: unwrapParens(rightComp.left),
      };
    }
  }

  // Pattern 2: min > val || val > max
  if (leftComp.operator === '>' && rightComp.operator === '>') {
    const leftVal = unwrapCast(unwrapParens(leftComp.right));
    const rightVar = unwrapCast(unwrapParens(rightComp.left));

    if (isSameExpression(leftVal, rightVar)) {
      return {
        variable: leftVal,
        min: unwrapParens(leftComp.left),
        max: unwrapParens(rightComp.right),
      };
    }
  }

  return null;
}

/**
 * Unwrap cast expressions to get the inner expression
 */
function unwrapCast(expr: Expression): Expression {
  let current = expr;
  while (
    current.kind === NodeKind.CStyleCastExpr ||
    current.kind === NodeKind.StaticCastExpr
  ) {
    current = (current as any).expression;
    current = unwrapParens(current);
  }
  return current;
}

/**
 * Check if two expressions are the same (simple structural equality)
 */
function isSameExpression(a: Expression, b: Expression): boolean {
  if (a.kind !== b.kind) return false;

  if (a.kind === NodeKind.Identifier && b.kind === NodeKind.Identifier) {
    return (a as Identifier).name === (b as Identifier).name;
  }

  // For more complex expressions, we'd need deeper comparison
  // For now, just handle identifiers
  return false;
}

/**
 * Create a negation expression
 */
function createNegation(expr: Expression, original: ASTNode): UnaryExpr {
  return {
    kind: NodeKind.UnaryExpr,
    operator: '!',
    operand: expr,
    location: original.location,
    leadingTrivia: original.leadingTrivia || [],
    trailingTrivia: original.trailingTrivia || [],
  };
}

/**
 * Create a macro call statement
 * Example: D2_ASSERT(!(condition))
 */
function createMacroCallStmt(
  macroName: string,
  args: Expression[],
  original: ASTNode
): ExprStmt {
  const callExpr: CallExpr = {
    kind: NodeKind.CallExpr,
    callee: {
      kind: NodeKind.Identifier,
      name: macroName,
      location: original.location,
      leadingTrivia: [],
      trailingTrivia: [],
    } as Identifier,
    arguments: args,
    location: original.location,
    leadingTrivia: [],
    trailingTrivia: [],
  };

  return {
    kind: NodeKind.ExprStmt,
    expression: callExpr,
    location: original.location,
    leadingTrivia: original.leadingTrivia || [],
    trailingTrivia: original.trailingTrivia || [],
  };
}

// ============================================
// TRANSFORMERS
// ============================================

/**
 * Remove security cookie declarations
 * Pattern: uint32_t local_X = DEFAULT_SECURITY_COOKIE ^ ...
 */
function createSecurityCookieRemover(): Transformer {
  return createTransformer({
    visitVariableDecl(decl: VariableDecl): VariableDecl | undefined {
      if (isSecurityCookieDecl(decl)) {
        return undefined; // Remove this declaration
      }
      return undefined; // Keep unchanged
    },
  });
}

/**
 * Remove GuardStack calls
 * Pattern: Fog::Debug::GuardStack(...)
 */
function createGuardStackRemover(): Transformer {
  return createTransformer({
    visitNode(node: ASTNode): ASTNode | undefined {
      // Only handle expression statements
      if (node.kind !== NodeKind.ExprStmt) {
        return undefined;
      }

      const stmt = node as ExprStmt;
      if (isGuardStackCall(stmt)) {
        return undefined; // Remove this statement
      }
      return undefined; // Keep unchanged
    },
  });
}

/**
 * Simplify assertion boilerplate to macros
 * Patterns:
 * - General: if (cond) { nLine = ...; ERROR_Halt(...); } → D2_ASSERT(!(cond))
 * - Range: if (val < min || max < val) { ... } → D2_ASSERT_RANGE(val, min, max)
 */
function createAssertionSimplifier(): Transformer {
  return createTransformer({
    visitIfStmt(ifStmt: IfStmt): Statement | undefined {
      // Check if body matches assertion boilerplate
      const assertInfo = isAssertionBoilerplate(ifStmt.thenBranch);
      if (!assertInfo) {
        return undefined; // Not assertion boilerplate
      }

      // Check for range check pattern first (more specific)
      const rangeCheck = parseRangeCheck(ifStmt.condition);
      if (rangeCheck) {
        return createMacroCallStmt(
          'D2_ASSERT_RANGE',
          [rangeCheck.variable, rangeCheck.min, rangeCheck.max],
          ifStmt
        );
      }

      // General assertion: negate condition and wrap in D2_ASSERT
      return createMacroCallStmt(
        'D2_ASSERT',
        [createNegation(ifStmt.condition, ifStmt)],
        ifStmt
      );
    },
  });
}

// ============================================
// AST HELPERS
// ============================================

/**
 * Walk the AST to check if any D2_ASSERT or D2_ASSERT_RANGE macro calls exist.
 * Used to conditionally inject macro definitions only when needed.
 */
function astContainsAssertMacro(node: ASTNode): boolean {
  if (node.kind === NodeKind.CallExpr) {
    const call = node as CallExpr;
    if (call.callee.kind === NodeKind.Identifier) {
      const name = (call.callee as Identifier).name;
      if (name === 'D2_ASSERT' || name === 'D2_ASSERT_RANGE') {
        return true;
      }
    }
  }

  // Walk children
  for (const key of Object.keys(node)) {
    const val = (node as unknown as Record<string, unknown>)[key];
    if (val && typeof val === 'object') {
      if (Array.isArray(val)) {
        for (const item of val) {
          if (item && typeof item === 'object' && 'kind' in item && astContainsAssertMacro(item as ASTNode)) {
            return true;
          }
        }
      } else if ('kind' in val && astContainsAssertMacro(val as ASTNode)) {
        return true;
      }
    }
  }

  return false;
}

// ============================================
// PLUGIN DEFINITION
// ============================================

export interface BoilerplateCleanupOptions extends PluginOptions {
  /** Remove security cookie declarations and verification (default: true) */
  removeSecurityCookies?: boolean;

  /** Simplify assertion boilerplate to macros (default: true) */
  simplifyAssertions?: boolean;
}

/**
 * Boilerplate Pattern Cleanup Plugin
 *
 * Removes verbose compiler-inserted security boilerplate and simplifies
 * assertion patterns from Ghidra decompiler output.
 */
export const boilerplateCleanupPlugin: TransformPlugin = {
  id: 'boilerplate-cleanup',
  name: 'Boilerplate Pattern Cleanup',
  description:
    'Remove security cookies and simplify assertion boilerplate to macros',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 500, // After goto-cleanup (300-450), before final output
  tags: ['cleanup', 'ghidra', 'decompiler'],

  createTransformer(options?: BoilerplateCleanupOptions) {
    const opts = options ?? {};
    const transforms: Transformer[] = [];

    if (opts.removeSecurityCookies !== false) {
      transforms.push(createSecurityCookieRemover());
      transforms.push(createGuardStackRemover());
    }

    if (opts.simplifyAssertions !== false) {
      transforms.push(createAssertionSimplifier());
    }

    return sequence(...transforms);
  },

  createInjectionTransformer(options?: BoilerplateCleanupOptions) {
    const baseTransformer = this.createTransformer(options);
    const opts = options ?? {};

    return (node: ASTNode, context: InjectionContext) => {
      // Run transformations first
      const result = baseTransformer(node);

      // Only inject D2_ASSERT macros if the transform actually produced any
      if (opts.simplifyAssertions !== false && !context.has('d2-assert-macros') && astContainsAssertMacro(result)) {
        context.inject({
          id: 'd2-assert-macros',
          type: 'preamble',
          code: `
// Assertion macros (simplified from ERROR boilerplate)
#ifndef D2_ASSERT
#define D2_ASSERT(condition) \\
  do { \\
    if (!(condition)) { \\
      Fog::ErrorManager::ERROR_UnrecoverableInternalError_Halt( \\
        __FILE__, __LINE__, #condition \\
      ); \\
    } \\
  } while (0)
#endif

#ifndef D2_ASSERT_RANGE
#define D2_ASSERT_RANGE(value, min, max) \\
  D2_ASSERT((value) >= (min) && (value) <= (max))
#endif
`,
          priority: 100,
        });
      }

      return result;
    };
  },

  staticInjections: [
    {
      id: 'security-cookie-constant',
      type: 'macro',
      code: '#define DEFAULT_SECURITY_COOKIE 0xBB40E64E',
      priority: 50,
    },
  ],
};
