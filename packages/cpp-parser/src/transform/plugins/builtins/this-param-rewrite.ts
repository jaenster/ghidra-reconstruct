/**
 * This-Param-Rewrite Plugin
 *
 * Ghidra's decompiler spells the hidden ECX argument of a `__thiscall` function
 * as `this`. The generator emits those functions as free functions, where `this`
 * is not in scope — so every occurrence has to become the name the signature
 * gave that argument (`pThis` when Ghidra itself named the parameter `this`,
 * otherwise the first parameter's emitted name).
 *
 * Only the `this` EXPRESSION is rewritten. A `this` inside a string literal, or
 * in one of the stack-frame comments the generator emits above the body
 * (`//   this: ECX:4 (int32_t)`), is not a ThisExpr and is left alone — which a
 * `\bthis\b` text substitution could not do.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, Identifier, ThisExpr } from '../../../ast/nodes.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface ThisParamRewriteOptions extends PluginOptions {
  /** Name to use for `this` in the emitted free function. Unset → leave `this` alone. */
  thisName?: string;
}

function createThisParamRewriteTransformer(options: ThisParamRewriteOptions = {}): Transformer {
  const thisName = options.thisName;
  if (!thisName) return (node: ASTNode) => node;

  return createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      if (n.kind !== NodeKind.ThisExpr) return undefined;
      const t = n as ThisExpr;
      const id: Identifier = {
        kind: NodeKind.Identifier,
        name: thisName,
        location: t.location,
        leadingTrivia: t.leadingTrivia ?? [],
        trailingTrivia: t.trailingTrivia ?? [],
      };
      return id;
    },
  });
}

import { createPlugin } from '../registry.js';

export const thisParamRewritePlugin: TransformPlugin = createPlugin(
  'this-param-rewrite',
  'This Param Rewrite',
  'Rewrites the `this` expression of a __thiscall body to the free function\'s corresponding parameter name',
  (options?: PluginOptions) =>
    createThisParamRewriteTransformer(options as ThisParamRewriteOptions),
  {
    priority: 46,
    defaultEnabled: true,
    tags: ['cleanup', 'cpp'],
    version: '1.0.0',
  }
);
