/**
 * Indirect Call Cleanup Plugin
 *
 * Handles Ghidra's "Could not recover jumptable" warnings and related artifacts:
 * 1. Strips WARNING trivia from function bodies
 * 2. Cleans up struct field function pointer casts: (*(code*)pVar->fp)(args) → pVar->fp(args)
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  UnaryExpr,
  CallExpr,
  MemberExpr,
  CStyleCastExpr,
  ParenExpr,
  Identifier,
  PointerType,
  TypedefType,
} from '../../../ast/nodes.js';
import {
  createTransformer,
  updateNode,
  sequence,
  type Transformer,
} from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { TriviaKind } from '../../../lexer/trivia.js';
import type { Trivia } from '../../../lexer/trivia.js';

// ============================================
// 2a: WARNING TRIVIA STRIPPING
// ============================================

const WARNING_PATTERNS = [
  'WARNING: Could not recover jumptable',
  'WARNING: Treating indirect jump as call',
];

function containsWarning(text: string): boolean {
  return WARNING_PATTERNS.some(p => text.includes(p));
}

function filterWarningTrivia(trivia: Trivia[] | undefined): Trivia[] | undefined {
  if (!trivia || trivia.length === 0) return trivia;
  const filtered = trivia.filter(t => {
    if (t.kind !== TriviaKind.BlockComment && t.kind !== TriviaKind.LineComment) return true;
    return !containsWarning(t.text);
  });
  if (filtered.length === trivia.length) return trivia;
  return filtered.length > 0 ? filtered : undefined;
}

function stripJumptableWarnings(): Transformer {
  return createTransformer({
    visitNode(node) {
      const n = node as ASTNode & { leadingTrivia?: Trivia[]; trailingTrivia?: Trivia[] };
      if (!n.leadingTrivia && !n.trailingTrivia) return undefined;

      const newLeading = filterWarningTrivia(n.leadingTrivia);
      const newTrailing = filterWarningTrivia(n.trailingTrivia);

      if (newLeading === n.leadingTrivia && newTrailing === n.trailingTrivia) return undefined;

      return updateNode(node, {
        leadingTrivia: newLeading ?? [],
        trailingTrivia: newTrailing ?? [],
      });
    },
  });
}

// ============================================
// 2b: STRUCT FIELD FN-PTR CLEANUP
// ============================================

function unwrapParens(expr: Expression): Expression {
  while (expr.kind === NodeKind.ParenExpr) {
    expr = (expr as ParenExpr).expression;
  }
  return expr;
}

function isDeref(expr: Expression): UnaryExpr | null {
  expr = unwrapParens(expr);
  if (expr.kind === NodeKind.UnaryExpr) {
    const unary = expr as UnaryExpr;
    if (unary.operator === '*') {
      return unary;
    }
  }
  return null;
}

function isMemberExpr(expr: Expression): MemberExpr | null {
  expr = unwrapParens(expr);
  if (expr.kind === NodeKind.MemberExpr) {
    return expr as MemberExpr;
  }
  return null;
}

function isCastToCode(expr: Expression): CStyleCastExpr | null {
  expr = unwrapParens(expr);
  if (expr.kind !== NodeKind.CStyleCastExpr) return null;

  const cast = expr as CStyleCastExpr;
  const castType = cast.type;

  // Direct cast to (code): TypedefType with name "code"
  if (castType.kind === NodeKind.TypedefType) {
    const td = castType as TypedefType;
    if (td.name.kind === NodeKind.Identifier && (td.name as Identifier).name === 'code') {
      return cast;
    }
  }

  // Cast to (code*) or (code**): PointerType whose pointee eventually is "code"
  if (castType.kind === NodeKind.PointerType) {
    let inner = (castType as PointerType).pointee;
    // Unwrap one more pointer level for code**
    if (inner.kind === NodeKind.PointerType) {
      inner = (inner as PointerType).pointee;
    }
    if (inner.kind === NodeKind.TypedefType) {
      const td = inner as TypedefType;
      if (td.name.kind === NodeKind.Identifier && (td.name as Identifier).name === 'code') {
        return cast;
      }
    }
  }

  return null;
}

/**
 * Detect pattern: (*(code*)pVar->fpField)(args) → pVar->fpField(args)
 *
 * AST: CallExpr where callee = UnaryExpr(*, CastExpr(code*, MemberExpr(obj, field)))
 * Also: (*pVar->fpField)(args) → pVar->fpField(args) when no cast present
 */
function cleanStructFieldFnPtrs(): Transformer {
  return createTransformer({
    visitCallExpr(call: CallExpr) {
      const callee = unwrapParens(call.callee);

      // Must start with dereference
      const outerDeref = isDeref(callee);
      if (!outerDeref) return undefined;

      const derefOperand = unwrapParens(outerDeref.operand);

      // Pattern 1: (*(code*)pVar->fpField)(args)
      const codeCast = isCastToCode(derefOperand);
      if (codeCast) {
        const member = isMemberExpr(codeCast.expression);
        if (member) {
          return updateNode(call, {
            callee: member,
          });
        }
      }

      // Pattern 2: (*pVar->fpField)(args) — no cast, field already typed
      const member = isMemberExpr(derefOperand);
      if (member) {
        return updateNode(call, {
          callee: member,
        });
      }

      return undefined;
    },
  });
}

// ============================================
// PLUGIN DEFINITION
// ============================================

export interface IndirectCallCleanupOptions extends PluginOptions {}

export const indirectCallCleanupPlugin: TransformPlugin = {
  id: 'indirect-call-cleanup',
  name: 'Indirect Call Cleanup',
  description:
    'Strip Ghidra jumptable warnings, clean fn-ptr casts, simplify indirect calls',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 5, // Very early — strip warnings + simplify before other transforms
  tags: ['core', 'cleanup'],

  createTransformer(_options?: IndirectCallCleanupOptions) {
    return sequence(
      stripJumptableWarnings(),
      cleanStructFieldFnPtrs(),
    );
  },
};
