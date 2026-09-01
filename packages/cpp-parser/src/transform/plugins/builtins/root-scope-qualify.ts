/**
 * Root-Scope-Qualify Plugin
 *
 * Ghidra hangs a data symbol under a namespace it inferred from the owning
 * class/module, but the generator emits that symbol at ROOT scope (the namespace
 * was dropped as an invalid C++ component, folded into its parent, or collapsed
 * away). A body reference then keeps the namespace qualifier and C++ resolves it
 * inside the namespace, which does not declare it:
 *
 *     error: 'vftable' is not a member of 'crashy'
 *
 * When the symbol tables say the name lives at root scope and the qualifier's
 * scope does NOT declare it, the reference is rewritten to the root-qualified
 * form `::vftable`. Decided per QualifiedId node from the symbol tables — a name
 * that IS a member of the qualifying scope is left alone.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, Identifier, QualifiedId, TemplateType } from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface RootScopeQualifyOptions extends PluginOptions {
  /** Names of data symbols the generator emits at global scope */
  rootScopeSymbols?: string[];
  /** Fully qualified names of symbols that really do live in a namespace ("crashy::Report::vftable") */
  scopedSymbols?: string[];
}

function qualifierText(parts: (Identifier | TemplateType)[]): string | undefined {
  const names: string[] = [];
  for (const p of parts) {
    if (p.kind !== NodeKind.Identifier) return undefined;
    names.push((p as Identifier).name);
  }
  return names.join('::');
}

function createRootScopeQualifyTransformer(options: RootScopeQualifyOptions = {}): Transformer {
  const rootScope = new Set(options.rootScopeSymbols ?? []);
  const scoped = new Set(options.scopedSymbols ?? []);
  if (rootScope.size === 0) return (node: ASTNode) => node;

  return createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      if (n.kind !== NodeKind.QualifiedId) return undefined;
      const q = n as QualifiedId;
      if (q.isGlobal || q.qualifier.length === 0) return undefined;
      if (q.name.kind !== NodeKind.Identifier) return undefined;

      const name = (q.name as Identifier).name;
      if (!rootScope.has(name)) return undefined;

      const scope = qualifierText(q.qualifier);
      if (scope === undefined) return undefined;
      // The qualifying scope really declares it — the reference is correct.
      if (scoped.has(`${scope}::${name}`)) return undefined;

      return updateNode(q, { qualifier: [], isGlobal: true } as Partial<QualifiedId>);
    },
  });
}

import { createPlugin } from '../registry.js';

export const rootScopeQualifyPlugin: TransformPlugin = createPlugin(
  'root-scope-qualify',
  'Root Scope Qualify',
  'Rewrites a namespace-qualified reference to a root-scope symbol as ::name when the qualifying scope does not declare it',
  (options?: PluginOptions) => createRootScopeQualifyTransformer(options as RootScopeQualifyOptions),
  {
    priority: 48,
    defaultEnabled: true,
    tags: ['cleanup', 'cpp'],
    version: '1.0.0',
  }
);
