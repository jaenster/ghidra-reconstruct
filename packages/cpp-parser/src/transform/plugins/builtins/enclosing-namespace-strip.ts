/**
 * Enclosing-Namespace-Strip Plugin
 *
 * Ghidra spells a call site with the callee's whole namespace path. Inside
 * `namespace A::B::C`, `A::B::C::Foo()` is just `Foo()` and `A::B::X()` is
 * `B::X()` — the enclosing scopes are already open.
 *
 * Stripping is collision-aware. Inside `D2Common::Unit::Monster`, the reference
 * `D2Common::Path::DynamicPath::GetYPos` must NOT shorten to
 * `Path::DynamicPath::GetYPos`, because `D2Common::Unit::Path` exists and C++
 * binds the leading `Path` to it — a namespace with no `DynamicPath` in it. So a
 * prefix is only dropped when the segment that becomes the new leading qualifier
 * cannot be intercepted by a sibling reachable from a deeper enclosing scope.
 *
 * This was a `RegExp` built from the enclosing namespace's text and run over the
 * whole emitted file. It re-derived the segment list by splitting a rendered
 * `"A::B::C"` string, and it could not tell a reference from a declaration, a
 * comment or a string literal — it needed an explicit `line.startsWith('namespace ')`
 * exemption to avoid eating the file's own namespace header. Decided on the
 * QualifiedId's qualifier list, none of that is reachable.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, Identifier, QualifiedId, TemplateType } from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface EnclosingNamespaceStripOptions extends PluginOptions {
  /** Segments of the namespace block the code is emitted inside. */
  enclosingSegments?: string[];
  /** Every namespace that exists, so an interception can be detected. */
  knownNamespaces?: string[];
}

function segmentName(part: Identifier | TemplateType): string | undefined {
  return part.kind === NodeKind.Identifier ? (part as Identifier).name : undefined;
}

function createEnclosingNamespaceStripTransformer(
  options: EnclosingNamespaceStripOptions = {}
): Transformer {
  const enclosing = options.enclosingSegments ?? [];
  const known = new Set(options.knownNamespaces ?? []);
  if (enclosing.length === 0) return (node) => node;

  /**
   * Dropping `enclosing[0..k)` leaves `lead` as the new leading qualifier. That is
   * unsafe when a deeper enclosing scope declares a child of the same name.
   */
  const canStrip = (k: number, lead: string): boolean => {
    if (known.size === 0) return true;
    for (let j = k + 1; j <= enclosing.length; j++) {
      if (known.has(`${enclosing.slice(0, j).join('::')}::${lead}`)) return false;
    }
    return true;
  };

  return createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      if (n.kind !== NodeKind.QualifiedId) return undefined;
      const q = n as QualifiedId;
      if (q.isGlobal) return undefined;              // `::name` is explicit
      if (q.qualifier.length === 0) return undefined;

      const names: string[] = [];
      for (const part of q.qualifier) {
        const name = segmentName(part);
        if (name === undefined) return undefined;    // a template qualifier: leave it
        names.push(name);
      }

      const nameSegment = q.name.kind === NodeKind.Identifier
        ? (q.name as Identifier).name
        : undefined;

      // Longest matching prefix first, exactly as the reference resolves.
      const max = Math.min(names.length, enclosing.length);
      for (let k = max; k > 0; k--) {
        let matches = true;
        for (let i = 0; i < k; i++) {
          if (names[i] !== enclosing[i]) { matches = false; break; }
        }
        if (!matches) continue;

        const lead = k < names.length ? names[k] : nameSegment;
        if (lead === undefined) return undefined;
        if (!canStrip(k, lead)) continue;

        const kept = q.qualifier.slice(k);
        if (kept.length === 0) {
          if (q.name.kind !== NodeKind.Identifier) return undefined;
          const name = q.name as Identifier;
          return updateNode(name, {
            leadingTrivia: [...(q.leadingTrivia ?? []), ...(name.leadingTrivia ?? [])],
            trailingTrivia: [...(name.trailingTrivia ?? []), ...(q.trailingTrivia ?? [])],
          } as Partial<Identifier>);
        }
        return updateNode(q, { qualifier: kept } as Partial<QualifiedId>);
      }
      return undefined;
    },
  });
}

import { createPlugin } from '../registry.js';

export const enclosingNamespaceStripPlugin: TransformPlugin = createPlugin(
  'enclosing-namespace-strip',
  'Enclosing Namespace Strip',
  'Drops the enclosing namespace prefix from a qualified reference when the shortened form still resolves to the same entity',
  (options?: PluginOptions) =>
    createEnclosingNamespaceStripTransformer(options as EnclosingNamespaceStripOptions),
  {
    // Runs LAST. Shortening a reference is a spelling decision, and every pass
    // that resolves a callee or a slot by its written name — call-arg-cast,
    // assign-cast, funcptr-arg-cast — must still see the full path. Its
    // predecessor ran on the finished file text, which put it after everything;
    // that ordering is preserved deliberately. It also has to follow
    // namespace-shadow-qualify (49), whose `::` prefix is explicit and must not
    // be shortened away.
    priority: 900,
    defaultEnabled: true,
    // 'core': the emitted file opens its namespace block whatever preset is in
    // force, so a reference's qualifier has to be spelled relative to that block
    // in every preset. This is not optional tidying.
    tags: ['core', 'cleanup', 'cpp'],
    version: '1.0.0',
  }
);
