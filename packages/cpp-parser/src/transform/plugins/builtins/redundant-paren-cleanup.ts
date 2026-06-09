/**
 * Redundant Parenthesis Cleanup Plugin
 *
 * Strips unnecessary ParenExpr nodes produced by Ghidra's decompiler.
 * These add visual noise without semantic value.
 *
 * Transforms:
 * - if ((expr))       → if (expr)
 * - while ((expr))    → while (expr)
 * - switch ((expr))   → switch (expr)
 * - do {} while ((e)) → do {} while (e)
 * - for (;(e);)       → for (;e;)
 * - ((expr))          → (expr)  [nested ParenExpr]
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, IfStmt, WhileStmt, ForStmt, DoWhileStmt, SwitchStmt,
  ParenExpr,
} from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface RedundantParenCleanupOptions extends PluginOptions {}

function unwrapParen(node: ASTNode): ASTNode {
  if (node.kind === NodeKind.ParenExpr) {
    return (node as ParenExpr).expression;
  }
  return node;
}

function isParen(node: ASTNode): boolean {
  return node.kind === NodeKind.ParenExpr;
}

function createRedundantParenCleanupTransformer(_options: RedundantParenCleanupOptions = {}): Transformer {
  return createTransformer({
    visitIfStmt(node: IfStmt): ASTNode | undefined {
      if (!isParen(node.condition)) return undefined;
      return updateNode(node, { condition: unwrapParen(node.condition) } as Partial<IfStmt>);
    },

    visitWhileStmt(node: WhileStmt): ASTNode | undefined {
      if (!isParen(node.condition)) return undefined;
      return updateNode(node, { condition: unwrapParen(node.condition) } as Partial<WhileStmt>);
    },

    visitDoWhileStmt(node: DoWhileStmt): ASTNode | undefined {
      if (!isParen(node.condition)) return undefined;
      return updateNode(node, { condition: unwrapParen(node.condition) } as Partial<DoWhileStmt>);
    },

    visitSwitchStmt(node: SwitchStmt): ASTNode | undefined {
      if (!isParen(node.condition)) return undefined;
      return updateNode(node, { condition: unwrapParen(node.condition) } as Partial<SwitchStmt>);
    },

    visitForStmt(node: ForStmt): ASTNode | undefined {
      const newCond = node.condition && isParen(node.condition) ? unwrapParen(node.condition) : node.condition;
      if (newCond === node.condition) return undefined;
      return updateNode(node, { condition: newCond } as Partial<ForStmt>);
    },

    // Nested ParenExpr: ((expr)) → (expr)
    visitParenExpr(node: ParenExpr): ASTNode | undefined {
      if (!isParen(node.expression)) return undefined;
      return updateNode(node, { expression: unwrapParen(node.expression) } as Partial<ParenExpr>);
    },
  });
}

export const redundantParenCleanupPlugin: TransformPlugin = {
  id: 'redundant-paren-cleanup',
  name: 'Redundant Parenthesis Cleanup',
  description: 'Strips unnecessary ParenExpr from conditions and nested contexts',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 56,
  tags: ['cleanup', 'cosmetic'],
  createTransformer: createRedundantParenCleanupTransformer,
};
