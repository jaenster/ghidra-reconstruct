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
 *
 * A Ghidra LOCAL literally named `this` is the other case, and it is NOT the
 * hidden argument. `preprocessGhidraCode` legalizes its DECLARATION (`BigBuffer
 * *this;` → `BigBuffer *self;`) because `this` cannot be declared in C++, but a
 * bare `this` in an expression has no preceding type and stays as written. The
 * declaration and the uses then denote one variable under two spellings, and
 * binding the uses to the first parameter throws away the local's type as well:
 * `BigBuffer_Rand` declared an unused `BigBuffer* self` and read every one of its
 * fields off `uint *pnResult`. So when the body declares `self`, that is what the
 * `this` expressions mean, and the parameter name never gets a look in.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, Identifier, ThisExpr, VariableDecl } from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

/** The name `preprocessGhidraCode` gives a local Ghidra called `this`. */
const LEGALIZED_LOCAL_THIS = 'self';

export interface ThisParamRewriteOptions extends PluginOptions {
  /** Name to use for `this` in the emitted free function. Unset → leave `this` alone. */
  thisName?: string;
}

/** Does this body declare a variable of the given name? */
function declaresLocal(root: ASTNode, name: string): boolean {
  for (const n of traverseAST(root)) {
    if (n.kind !== NodeKind.VariableDecl) continue;
    if ((n as VariableDecl).name?.name === name) return true;
  }
  return false;
}

function createThisParamRewriteTransformer(options: ThisParamRewriteOptions = {}): Transformer {
  const paramName = options.thisName;
  if (!paramName) return (node: ASTNode) => node;

  return (root: ASTNode) => {
    const name = declaresLocal(root, LEGALIZED_LOCAL_THIS)
      ? LEGALIZED_LOCAL_THIS
      : paramName;
    return createTransformer({
      visitNode(n: ASTNode): ASTNode | undefined {
        if (n.kind !== NodeKind.ThisExpr) return undefined;
        const t = n as ThisExpr;
        const id: Identifier = {
          kind: NodeKind.Identifier,
          name,
          location: t.location,
          leadingTrivia: t.leadingTrivia ?? [],
          trailingTrivia: t.trailingTrivia ?? [],
        };
        return id;
      },
    })(root);
  };
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
