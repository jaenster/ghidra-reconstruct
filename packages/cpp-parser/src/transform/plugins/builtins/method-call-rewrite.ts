/**
 * Method Call Rewrite Plugin
 *
 * Transforms flat C function calls into C++ method calls when the
 * function has been identified as a method of a class.
 *
 * Five rewrite rules:
 *
 * Rule 1 — External call site rewriting (in any function):
 *   DRLG_Init(pDrlg, nAct)  →  pDrlg->Init(nAct)
 *
 * Rule 2 — Body this-param rewriting (inside a converted method):
 *   pDrlg->nAct  →  this->nAct
 *
 * Rule 3 — Same-class method call simplification (inside a converted method):
 *   DRLG_Alloc(pDrlg, x)  →  this->Alloc(x)
 *
 * Rule 5 — Strip unnecessary this-> (inside a converted method):
 *   this->member  →  member  (when no local/param shadows the name)
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  CallExpr,
  MemberExpr,
  Identifier,
  QualifiedId,
  ParenExpr,
  UnaryExpr,
  IntegerLiteralExpr,
  CStyleCastExpr,
  VariableDecl,
  ParameterDecl,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import {
  createTransformer,
  updateNode,
  type Transformer,
} from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

// ============================================
// TYPES
// ============================================

export interface MethodCallMapping {
  className: string;
  methodName: string;
  thisParam: number;
  originalName: string;
}

export interface MethodCallRewriteOptions extends PluginOptions {
  /** All method conversion mappings keyed by original function name */
  methodMappings?: Record<string, MethodCallMapping>;

  /** Per-function context: set when we're inside a converted method's body */
  currentFunction?: {
    className: string;
    thisParamName: string;
  };

  /** Root AST node — used for pre-scanning declared names (Rule 5) */
  rootAST?: ASTNode;
}

// ============================================
// TRANSFORMER
// ============================================

/**
 * Pre-scan the AST to collect all declared local variable and parameter names.
 * Used by Rule 5 to avoid stripping this-> when a local shadows the member name.
 */
function collectDeclaredNames(root: ASTNode, thisParamName?: string): Set<string> {
  const names = new Set<string>();
  for (const node of traverseAST(root)) {
    if (node.kind === NodeKind.VariableDecl) {
      const varDecl = node as VariableDecl;
      if (varDecl.name?.kind === NodeKind.Identifier) {
        names.add((varDecl.name as Identifier).name);
      }
    } else if (node.kind === NodeKind.ParameterDecl) {
      const paramDecl = node as ParameterDecl;
      if (paramDecl.name?.kind === NodeKind.Identifier) {
        const paramName = (paramDecl.name as Identifier).name;
        // Skip the this-param itself
        if (paramName !== thisParamName) {
          names.add(paramName);
        }
      }
    }
  }
  return names;
}

function createMethodCallRewriteTransformer(options?: MethodCallRewriteOptions): Transformer {
  const mappings = options?.methodMappings ?? {};
  const currentFn = options?.currentFunction;

  if (Object.keys(mappings).length === 0 && !currentFn) {
    // Nothing to do — return identity
    return (node: ASTNode) => node;
  }

  // Pre-scan for declared names (Rule 5)
  // When rootAST is not provided, Rule 5 is disabled (we can't know what names are declared)
  const hasRootAST = !!options?.rootAST;
  const declaredNames = currentFn && hasRootAST
    ? collectDeclaredNames(options!.rootAST!, currentFn.thisParamName)
    : new Set<string>();

  const extractCalleeNames = (callee: Expression): { unqualified: string; qualified?: string } | null => {
    if (callee.kind === NodeKind.Identifier) {
      const id = callee as Identifier;
      return { unqualified: id.name, qualified: id.name };
    }
    if (callee.kind === NodeKind.QualifiedId) {
      const qid = callee as QualifiedId;
      if (qid.name.kind !== NodeKind.Identifier) return null;
      const unqualified = (qid.name as Identifier).name;
      const qualifiers = qid.qualifier;
      if (qualifiers.every(q => q.kind === NodeKind.Identifier)) {
        const prefix = (qualifiers as Identifier[]).map(q => q.name).join('::');
        const qualified = (qid.isGlobal ? '::' : '') + (prefix ? `${prefix}::` : '') + unqualified;
        return { unqualified, qualified };
      }
      return { unqualified };
    }
    return null;
  };

  /** Detect null-like this-args: nullptr, NULL, 0, 0x0, (Type*)0x0 */
  const isNullLike = (expr: Expression): boolean => {
    if (expr.kind === NodeKind.NullptrLiteral) return true;
    if (expr.kind === NodeKind.Identifier && (expr as Identifier).name === 'NULL') return true;
    if (expr.kind === NodeKind.IntegerLiteral && (expr as IntegerLiteralExpr).value === 0n) return true;
    if (expr.kind === NodeKind.CStyleCastExpr) {
      const cast = expr as CStyleCastExpr;
      return isNullLike(cast.expression);
    }
    // Unwrap parens: (0), ((Type*)0x0)
    if (expr.kind === NodeKind.ParenExpr) {
      return isNullLike((expr as ParenExpr).expression);
    }
    return false;
  };

  const unwrapAddressOf = (expr: Expression): { object: Expression; useArrow: boolean } => {
    let current: Expression = expr;
    while (current.kind === NodeKind.ParenExpr) {
      current = (current as ParenExpr).expression;
    }
    if (current.kind === NodeKind.UnaryExpr) {
      const unary = current as UnaryExpr;
      if (unary.operator === '&') {
        return { object: unary.operand, useArrow: false };
      }
    }
    return { object: expr, useArrow: true };
  };

  return createTransformer({
    visitIdentifier(node: Identifier) {
      // Rule 2: this-param → this (only inside converted method body)
      if (currentFn && node.name === currentFn.thisParamName) {
        return updateNode(node, { name: 'this' });
      }
      return undefined;
    },

    visitMemberExpr(node: MemberExpr) {
      // Rule 5: strip this->member → member (when no name collision)
      // Requires rootAST for safe pre-scanning of declared names
      if (!currentFn || !hasRootAST) return undefined;
      if (!node.isArrow) return undefined;

      // Check if object is `this` (either Identifier("this") or ThisExpr)
      const obj = node.object;
      const isThis = (obj.kind === NodeKind.Identifier && (obj as Identifier).name === 'this')
        || obj.kind === NodeKind.ThisExpr;
      if (!isThis) return undefined;

      // Get member name
      if (node.member.kind !== NodeKind.Identifier) return undefined;
      const memberName = (node.member as Identifier).name;

      // Safety: don't strip if a local/param shadows the member name
      if (declaredNames.has(memberName)) return undefined;

      // Replace this->member with just the member identifier
      return updateNode(node.member as Identifier, {
        leadingTrivia: node.leadingTrivia ?? [],
      }) as ASTNode;
    },

    visitCallExpr(call: CallExpr) {
      // Rules 1+3: function call → method call
      const names = extractCalleeNames(call.callee as Expression);
      if (!names) return undefined;

      const mapping = names.qualified
        ? (mappings[names.qualified] ?? mappings[names.unqualified])
        : mappings[names.unqualified];
      if (!mapping) return undefined;

      const thisArgIdx = mapping.thisParam;
      const args = call.arguments ?? [];
      if (args.length <= thisArgIdx) return undefined;

      const thisArg = args[thisArgIdx];
      const remainingArgs = args.filter((_, i) => i !== thisArgIdx);

      // Rule 4: null this-arg → static call ClassName::Method(remaining_args)
      if (isNullLike(thisArg)) {
        const classId: Identifier = {
          kind: NodeKind.Identifier,
          name: mapping.className,
          location: call.location,
          leadingTrivia: [],
          trailingTrivia: [],
        };
        const methodId: Identifier = {
          kind: NodeKind.Identifier,
          name: mapping.methodName,
          location: call.location,
          leadingTrivia: [],
          trailingTrivia: [],
        };
        const qualifiedCall: QualifiedId = {
          kind: NodeKind.QualifiedId,
          qualifier: [classId],
          name: methodId,
          isGlobal: false,
          location: call.location,
          leadingTrivia: call.callee.leadingTrivia ?? [],
          trailingTrivia: [],
        };
        return updateNode(call, {
          callee: qualifiedCall,
          arguments: remainingArgs,
        });
      }

      // Rule 3: same-class → use `this` as the object
      const isOwnClass = currentFn && mapping.className === currentFn.className;
      const objectInfo = isOwnClass
        ? {
          object: {
            kind: NodeKind.Identifier,
            name: 'this',
            location: call.location,
            leadingTrivia: [],
            trailingTrivia: [],
          } as Expression,
          useArrow: true,
        }
        : unwrapAddressOf(thisArg);

      // Create method name identifier
      const methodId: Identifier = {
        kind: NodeKind.Identifier,
        name: mapping.methodName,
        location: call.location,
        leadingTrivia: [],
        trailingTrivia: [],
      };

      // Create member expression: object->method
      const memberExpr: MemberExpr = {
        kind: NodeKind.MemberExpr,
        object: objectInfo.object,
        member: methodId,
        isArrow: objectInfo.useArrow,
        location: call.location,
        leadingTrivia: [],
        trailingTrivia: [],
      };

      return updateNode(call, {
        callee: memberExpr,
        arguments: remainingArgs,
      });
    },
  });
}

// ============================================
// PLUGIN DEFINITION
// ============================================

/**
 * Method Call Rewrite Plugin
 *
 * Transforms flat C function calls into C++ method calls.
 */
export const methodCallRewritePlugin: TransformPlugin = {
  id: 'method-call-rewrite',
  name: 'Method Call Rewrite',
  description:
    'Transform flat C function calls into C++ method calls (e.g., DRLG_Init(pDrlg, nAct) → pDrlg->Init(nAct))',
  version: '1.0.0',
  defaultEnabled: false, // Only active when mappings provided via pluginOptions
  priority: 25, // Before vtable-calls (30)
  tags: ['cpp', 'cleanup'],

  createTransformer(options?: MethodCallRewriteOptions) {
    return createMethodCallRewriteTransformer(options);
  },
};
