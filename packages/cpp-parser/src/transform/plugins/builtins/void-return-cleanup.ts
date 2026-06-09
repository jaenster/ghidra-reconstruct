/**
 * Void Return Cleanup Plugin
 *
 * Removes trailing `return;` from void functions.
 * Ghidra's decompiler always emits `return;` at the end of void functions,
 * which is redundant noise.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, FunctionDecl, BuiltinType, CompoundStmt } from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface VoidReturnCleanupOptions extends PluginOptions {}

function isVoidType(type: ASTNode): boolean {
  return type.kind === NodeKind.BuiltinType
    && (type as BuiltinType).name === 'void'
    && (type as BuiltinType).modifiers.length === 0;
}

function createVoidReturnCleanupTransformer(_options: VoidReturnCleanupOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body || node.body.statements.length === 0) return undefined;
      if (!isVoidType(node.returnType)) return undefined;

      const stmts = node.body.statements;
      const last = stmts[stmts.length - 1];

      if (last.kind !== NodeKind.ReturnStmt) return undefined;
      if ((last as any).value !== null) return undefined;

      const newBody = updateNode(node.body, {
        statements: stmts.slice(0, -1),
      } as Partial<CompoundStmt>);

      return updateNode(node, { body: newBody } as Partial<FunctionDecl>);
    },
  });
}

export const voidReturnCleanupPlugin: TransformPlugin = {
  id: 'void-return-cleanup',
  name: 'Void Return Cleanup',
  description: 'Removes trailing return; from void functions',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 90,
  tags: ['cleanup', 'declaration'],
  createTransformer: createVoidReturnCleanupTransformer,
};
