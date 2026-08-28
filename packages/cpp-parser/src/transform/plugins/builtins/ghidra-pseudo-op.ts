/**
 * Ghidra Pseudo-Operation Rename Plugin
 *
 * The decompiler prints a pseudo-operation where the instruction has no C
 * spelling. Most are only undeclared — the platform header can declare those and
 * the body is left alone. `NAN(x)` is different: the spelling collides with
 * <cmath>'s object-like `NAN` macro, so the preprocessor turns `NAN(dVar5)` into
 * a float constant applied to an argument ("expression cannot be used as a
 * function") before any declaration could help. It has to be renamed at the call,
 * where the AST still shows it is a call.
 *
 * Only a CALL is rewritten: an identifier named `NAN` that is not being called is
 * the <cmath> constant and must keep its meaning.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, CallExpr, Identifier } from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Expr } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface GhidraPseudoOpOptions extends PluginOptions {}

/** Ghidra spelling → the spelling d2_platform.h declares. */
const RENAMES: Record<string, string> = {
  NAN: 'D2_IsNaN',
};

function createGhidraPseudoOpTransformer(_options: GhidraPseudoOpOptions = {}): Transformer {
  return createTransformer({
    visitCallExpr(call: CallExpr): ASTNode | undefined {
      if (call.callee.kind !== NodeKind.Identifier) return undefined;
      const renamed = RENAMES[(call.callee as Identifier).name];
      if (!renamed) return undefined;
      return updateNode(call, { callee: Expr.identifier(renamed) } as Partial<CallExpr>);
    },
  });
}

export const ghidraPseudoOpPlugin: TransformPlugin = {
  id: 'ghidra-pseudo-op',
  name: 'Ghidra Pseudo-Operation Rename',
  description: 'Renames decompiler pseudo-ops whose Ghidra spelling collides with a standard macro',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 20,
  tags: ['cleanup', 'cpp'],
  createTransformer: createGhidraPseudoOpTransformer,
};
