/**
 * Namespace-Shadow-Qualify Plugin
 *
 * Ghidra spells a cross-module reference with the qualifier of the namespace the
 * callee lives in, e.g. `Game::Launcher::LAUNCHER_DeleteCharacterFiles`. That is
 * correct at ROOT scope, but the reference is emitted inside another namespace
 * block, and C++ unqualified lookup for the FIRST qualifier segment walks the
 * enclosing scopes outward and stops at the first one that declares it:
 *
 *     namespace D2Client::CharSel {           // D2Client::Game exists (SCmd)
 *       Game::Launcher::LAUNCHER_...          // `Game` binds to D2Client::Game
 *     }                                       // error: 'D2Client::Game::Launcher'
 *                                             //        has not been declared
 *
 * The reference must then be root-qualified — `::Game::Launcher::...` — but only
 * when it really is shadowed. Decided per QualifiedId from the project namespace
 * table: the qualifier must name a real root namespace, an enclosing scope must
 * intercept its first segment, and that interception must not itself lead to the
 * full qualifier (in which case the reference resolves, to the sibling scope the
 * generator meant). Anything else is left alone — blanket root-qualification was
 * measured and is a net loss.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, Identifier, QualifiedId, TemplateType } from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface NamespaceShadowQualifyOptions extends PluginOptions {
  /** The namespace block this body is emitted inside ("D2Client::CharSel") */
  enclosingNamespace?: string;
  /** Every namespace path the project emits, each ancestor included */
  knownNamespaces?: string[];
}

function qualifierText(parts: (Identifier | TemplateType)[]): string[] | undefined {
  const names: string[] = [];
  for (const p of parts) {
    if (p.kind !== NodeKind.Identifier) return undefined;
    names.push((p as Identifier).name);
  }
  return names;
}

/**
 * The namespace table is project-wide and the caller hands the same options
 * object to every function body, so the derived scope list and lookup cache are
 * built once per (options object) rather than once per body.
 */
const transformerCache = new WeakMap<object, Transformer>();

function createNamespaceShadowQualifyTransformer(
  options: NamespaceShadowQualifyOptions = {},
): Transformer {
  const cached = transformerCache.get(options);
  if (cached) return cached;
  const transformer = buildTransformer(options);
  transformerCache.set(options, transformer);
  return transformer;
}

function buildTransformer(options: NamespaceShadowQualifyOptions): Transformer {
  const enclosing = options.enclosingNamespace;
  const known = new Set(options.knownNamespaces ?? []);
  if (!enclosing || known.size === 0) return (node: ASTNode) => node;

  // Enclosing scopes innermost-first: ["D2Client::CharSel", "D2Client"].
  const segs = enclosing.split('::').filter(Boolean);
  const scopes: string[] = [];
  for (let i = segs.length; i > 0; i--) scopes.push(segs.slice(0, i).join('::'));

  // Every contiguous run of the enclosing path — "D2Net::Client", "Client",
  // "D2Net". A qualifier spelled as one of these names a scope the reference is
  // already INSIDE, so it always resolves and can never be shadowed. The guard
  // is load-bearing: Ghidra carries doubled-segment namespaces (`D2Net::D2Net`,
  // `D2Game::Quests::Quests::A1Q0`), and without it `D2Net::Client::f` inside
  // `namespace D2Net::Client` looks shadowed by `D2Net::D2Net` and gets a root
  // qualifier the later redundant-prefix strip then mangles into `::f`.
  const ownScopes = new Set<string>();
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j <= segs.length; j++) ownScopes.add(segs.slice(i, j).join('::'));
  }

  const cache = new Map<string, boolean>();
  const isShadowed = (qual: string): boolean => {
    const hit = cache.get(qual);
    if (hit !== undefined) return hit;
    let shadowed = false;
    // The qualifier has to denote a real root namespace, or root-qualifying it
    // would only trade one unresolved name for another.
    if (known.has(qual) && !ownScopes.has(qual)) {
      const first = qual.slice(0, qual.indexOf('::') === -1 ? qual.length : qual.indexOf('::'));
      for (const scope of scopes) {
        // Lookup stops at the first enclosing scope that declares `first`.
        if (!known.has(`${scope}::${first}`)) continue;
        // It resolves — to the sibling scope, which is what the generator meant.
        shadowed = !known.has(`${scope}::${qual}`);
        break;
      }
    }
    cache.set(qual, shadowed);
    return shadowed;
  };

  return createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      if (n.kind !== NodeKind.QualifiedId) return undefined;
      const q = n as QualifiedId;
      if (q.isGlobal || q.qualifier.length === 0) return undefined;

      const parts = qualifierText(q.qualifier);
      if (parts === undefined) return undefined;

      if (!isShadowed(parts.join('::'))) return undefined;
      return updateNode(q, { isGlobal: true } as Partial<QualifiedId>);
    },
  });
}

import { createPlugin } from '../registry.js';

export const namespaceShadowQualifyPlugin: TransformPlugin = createPlugin(
  'namespace-shadow-qualify',
  'Namespace Shadow Qualify',
  'Root-qualifies a namespace-qualified reference whose leading qualifier is shadowed by a nested namespace of an enclosing scope',
  (options?: PluginOptions) =>
    createNamespaceShadowQualifyTransformer(options as NamespaceShadowQualifyOptions),
  {
    priority: 49,
    defaultEnabled: true,
    tags: ['cleanup', 'cpp'],
    version: '1.0.0',
  }
);
