/**
 * Global-Alias-Resolve Plugin
 *
 * Ghidra lets one address carry several labels. Exactly one is PRIMARY - the
 * one the listing shows and the decompiler prints - and the others are
 * secondary: an MSVC-decorated import name (`?rInitialWindowRect@@3UtagRECT@@A`),
 * an export ordinal (`Ordinal_24`), an analysis-derived name (`lpRect_007c9160`),
 * a user label kept beside a newer one. The generator defines one object per
 * address, under the primary name, so a reference spelled with a secondary
 * name has to be respelled with the primary or it names nothing (or, before
 * the fold, a second object with its own storage).
 *
 * The decompiler always prints the primary, so on Ghidra bodies this is a
 * no-op; it exists for every other source of a name (hand-written overrides,
 * an extraction that raced a rename).
 *
 * A body that declares a parameter or a local of the alias's name means that
 * declaration by every bare occurrence, so the name is dropped for the whole
 * body. Member names, declaration names and the tail of a qualified name are
 * never respelled.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Identifier,
  QualifiedId,
  MemberExpr,
  VariableDecl,
  ParameterDecl,
  FieldDecl,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface GlobalAliasResolveOptions extends PluginOptions {
  /**
   * Reference spelling of a secondary label (bare, or `Ns::name` for a label in
   * a namespace) -> the spelling of the address's primary label. No key is also
   * some other symbol's own spelling, so applying it is idempotent.
   */
  globalAliases?: Record<string, string>;
}

function declaredInBody(root: ASTNode): Set<string> {
  const names = new Set<string>();
  const add = (n: ASTNode | undefined) => {
    if (n && n.kind === NodeKind.Identifier) names.add((n as Identifier).name);
  };
  for (const d of findNodesByKind(root, NodeKind.ParameterDecl)) add((d as ParameterDecl).name);
  for (const d of findNodesByKind(root, NodeKind.VariableDecl)) add((d as VariableDecl).name);
  return names;
}

/** `A::B::c` for a QualifiedId of plain identifiers, else undefined. */
function qualifiedSpelling(q: QualifiedId): string | undefined {
  if (q.isGlobal || q.name.kind !== NodeKind.Identifier) return undefined;
  const parts: string[] = [];
  for (const part of q.qualifier) {
    if (part.kind !== NodeKind.Identifier) return undefined;
    parts.push((part as Identifier).name);
  }
  parts.push((q.name as Identifier).name);
  return parts.join('::');
}

function spellingNode(canonical: string, like: ASTNode): ASTNode {
  const segments = canonical.split('::');
  const tail = segments.pop()!;
  const nameNode: Identifier = {
    kind: NodeKind.Identifier,
    name: tail,
    location: like.location,
    leadingTrivia: segments.length === 0 ? (like.leadingTrivia ?? []) : [],
    trailingTrivia: segments.length === 0 ? (like.trailingTrivia ?? []) : [],
  } as unknown as Identifier;
  if (segments.length === 0) return nameNode;
  return {
    kind: NodeKind.QualifiedId,
    qualifier: segments.map(seg => ({
      kind: NodeKind.Identifier, name: seg, location: like.location, leadingTrivia: [], trailingTrivia: [],
    } as unknown as Identifier)),
    name: nameNode,
    isGlobal: false,
    location: like.location,
    leadingTrivia: like.leadingTrivia ?? [],
    trailingTrivia: like.trailingTrivia ?? [],
  } as unknown as QualifiedId;
}

function rewrite(aliases: Map<string, string>): Transformer {
  /** Each respelling this pass built, against the Identifier it replaced. */
  const builtFrom = new WeakMap<ASTNode, Identifier>();
  const restore = (child: ASTNode | undefined): Identifier | undefined =>
    child ? builtFrom.get(child) : undefined;

  return createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      if (n.kind === NodeKind.QualifiedId) {
        const q = n as QualifiedId;
        // No part of `X::alias` is a reference on its own; put every part back first.
        const back = restore(q.name);
        const qualifierBack = q.qualifier.map(p => restore(p) ?? p);
        const changed = !!back || qualifierBack.some((p, i) => p !== q.qualifier[i]);
        const base = changed
          ? updateNode(q, { name: back ?? q.name, qualifier: qualifierBack } as Partial<QualifiedId>) as QualifiedId
          : q;
        const spelled = qualifiedSpelling(base);
        const canonical = spelled !== undefined ? aliases.get(spelled) : undefined;
        if (canonical !== undefined && canonical !== spelled) return spellingNode(canonical, base);
        return changed ? base : undefined;
      }
      if (n.kind !== NodeKind.Identifier) return undefined;
      const id = n as Identifier;
      const canonical = aliases.get(id.name);
      if (canonical === undefined || canonical === id.name) return undefined;
      const built = spellingNode(canonical, id);
      builtFrom.set(built, id);
      return built;
    },

    visitMemberExpr(node: MemberExpr) {
      const back = restore(node.member);
      if (!back) return undefined;
      return updateNode(node, { member: back } as Partial<MemberExpr>);
    },

    visitVariableDecl(node: VariableDecl) {
      const back = restore(node.name);
      if (!back) return undefined;
      return updateNode(node, { name: back } as Partial<VariableDecl>);
    },

    visitParameterDecl(node: ParameterDecl) {
      const back = restore(node.name);
      if (!back) return undefined;
      return updateNode(node, { name: back } as Partial<ParameterDecl>);
    },

    visitFieldDecl(node: FieldDecl) {
      const back = restore(node.name);
      if (!back) return undefined;
      return updateNode(node, { name: back } as Partial<FieldDecl>);
    },
  });
}

function createGlobalAliasResolveTransformer(options: GlobalAliasResolveOptions = {}): Transformer {
  const configured = Object.entries(options.globalAliases ?? {});
  if (configured.length === 0) return (node: ASTNode) => node;
  return (root: ASTNode) => {
    const declared = declaredInBody(root);
    const live = new Map<string, string>();
    for (const [alias, canonical] of configured) {
      // A local or parameter of that name is what the bare spelling means here.
      if (!alias.includes('::') && declared.has(alias)) continue;
      live.set(alias, canonical);
    }
    if (live.size === 0) return root;
    return rewrite(live)(root);
  };
}

import { createPlugin } from '../registry.js';

export const globalAliasResolvePlugin: TransformPlugin = createPlugin(
  'global-alias-resolve',
  'Global Alias Resolve',
  "Respells a reference to a secondary Ghidra label with the address's primary label",
  (options?: PluginOptions) =>
    createGlobalAliasResolveTransformer(options as GlobalAliasResolveOptions),
  {
    // Before every pass that keys a table on a global's name.
    priority: 19,
    defaultEnabled: true,
    tags: ['cleanup', 'cpp'],
    version: '1.0.0',
  }
);
