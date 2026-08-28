/**
 * Array-Global-Address-Of Plugin
 *
 * Ghidra names an array data symbol `<base>_ARRAY_<address>` and then takes its
 * address when passing it as a pointer. `&arr` is a pointer-to-ARRAY (`T(*)[N]`)
 * and does not convert to the `T*` the callee wants, while the array name alone
 * already decays to `T*` — so the `&` is dropped.
 *
 * `&arr[i]` must keep its `&`: that is the address of one ELEMENT and is already
 * the right type. The predecessor regex re-implemented that distinction as a
 * `(?!\s*\[)` lookahead; here the operand simply is a SubscriptExpr instead of an
 * Identifier, so the question is answered by the parse rather than guessed at.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, Identifier, UnaryExpr } from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

const ARRAY_GLOBAL_RE = /_ARRAY_[0-9a-fA-F]+$/;

function createArrayGlobalAddressOfTransformer(): Transformer {
  return createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      if (n.kind !== NodeKind.UnaryExpr) return undefined;
      const u = n as UnaryExpr;
      if (u.operator !== '&') return undefined;
      if (u.operand.kind !== NodeKind.Identifier) return undefined;

      const id = u.operand as Identifier;
      if (!ARRAY_GLOBAL_RE.test(id.name)) return undefined;

      return updateNode(id, {
        leadingTrivia: [...(u.leadingTrivia ?? []), ...(id.leadingTrivia ?? [])],
        trailingTrivia: [...(id.trailingTrivia ?? []), ...(u.trailingTrivia ?? [])],
      } as Partial<Identifier>);
    },
  });
}

import { createPlugin } from '../registry.js';

export const arrayGlobalAddressOfPlugin: TransformPlugin = createPlugin(
  'array-global-address-of',
  'Array Global Address Of',
  'Drops the spurious & on a Ghidra <name>_ARRAY_<hex> global, keeping it on element addresses (&arr[i])',
  () => createArrayGlobalAddressOfTransformer(),
  {
    priority: 46,
    defaultEnabled: true,
    tags: ['cleanup', 'cpp'],
    version: '1.0.0',
  }
);
