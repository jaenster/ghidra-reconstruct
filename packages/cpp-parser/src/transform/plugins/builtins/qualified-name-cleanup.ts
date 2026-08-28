/**
 * Qualified-Name-Cleanup Plugin
 *
 * Three artefacts Ghidra leaves on the names it emits, all decided on the name
 * node itself so the same characters inside a string literal or a comment are
 * never touched:
 *
 *  - A namespace segment repeated back-to-back, because the symbol's own class
 *    namespace is also the module namespace: `Dungeon::Dungeon::GetFunc` →
 *    `Dungeon::GetFunc`. Collapsed on the QualifiedId's qualifier list, so a
 *    genuine `A::A` (a nested type named after its parent) is only collapsed
 *    when the two segments really are adjacent duplicates.
 *
 *  - A CRT/compiler-helper namespace Ghidra recovered from the MSVC PDB —
 *    `VisualStudio::sprintf`, `compiler::memcpy`. Those modules are not emitted,
 *    so the qualifier is dropped; when nothing is left the reference becomes the
 *    bare name.
 *
 *  - The `_exref` suffix Ghidra appends to an import-thunk reference
 *    (`Fog_10021_exref`); the emitted declaration carries the undecorated name.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, Identifier, QualifiedId, TemplateType } from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface QualifiedNameCleanupOptions extends PluginOptions {
  /** Namespace segments to drop from any qualified reference. */
  dropQualifiers?: string[];
  /** Collapse `A::A::name` to `A::name` (default true) */
  collapseDuplicateQualifiers?: boolean;
  /** Strip the trailing `_exref` import-thunk suffix from identifiers (default true) */
  stripExrefSuffix?: boolean;
}

const DEFAULT_DROPPED_QUALIFIERS = ['VisualStudio', 'compiler'];

const EXREF_SUFFIX = '_exref';

function segmentName(part: Identifier | TemplateType): string | undefined {
  return part.kind === NodeKind.Identifier ? (part as Identifier).name : undefined;
}

function cleanQualifier(
  qualifier: (Identifier | TemplateType)[],
  dropped: Set<string>,
  collapseDuplicates: boolean
): (Identifier | TemplateType)[] | undefined {
  const out: (Identifier | TemplateType)[] = [];
  let changed = false;

  for (const part of qualifier) {
    const name = segmentName(part);
    if (name !== undefined && dropped.has(name)) {
      changed = true;
      continue;
    }
    if (collapseDuplicates && name !== undefined && out.length > 0) {
      const prev = segmentName(out[out.length - 1]);
      if (prev === name) {
        changed = true;
        continue;
      }
    }
    out.push(part);
  }

  return changed ? out : undefined;
}

function createQualifiedNameCleanupTransformer(
  options: QualifiedNameCleanupOptions = {}
): Transformer {
  const dropped = new Set(options.dropQualifiers ?? DEFAULT_DROPPED_QUALIFIERS);
  const collapseDuplicates = options.collapseDuplicateQualifiers ?? true;
  const stripExref = options.stripExrefSuffix ?? true;

  return createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      if (n.kind === NodeKind.Identifier) {
        if (!stripExref) return undefined;
        const id = n as Identifier;
        if (!id.name.endsWith(EXREF_SUFFIX)) return undefined;
        const base = id.name.slice(0, -EXREF_SUFFIX.length);
        if (base.length === 0) return undefined;
        return updateNode(id, { name: base } as Partial<Identifier>);
      }

      if (n.kind !== NodeKind.QualifiedId) return undefined;
      const q = n as QualifiedId;
      if (q.qualifier.length === 0) return undefined;

      const cleaned = cleanQualifier(q.qualifier, dropped, collapseDuplicates);
      if (!cleaned) return undefined;

      // Nothing qualifies the name any more — emit it bare, unless the
      // reference was explicitly root-qualified (`::name`), which must stay.
      if (cleaned.length === 0 && !q.isGlobal && q.name.kind === NodeKind.Identifier) {
        const name = q.name as Identifier;
        return updateNode(name, {
          leadingTrivia: [...(q.leadingTrivia ?? []), ...(name.leadingTrivia ?? [])],
          trailingTrivia: [...(name.trailingTrivia ?? []), ...(q.trailingTrivia ?? [])],
        } as Partial<Identifier>);
      }

      return updateNode(q, { qualifier: cleaned } as Partial<QualifiedId>);
    },
  });
}

import { createPlugin } from '../registry.js';

export const qualifiedNameCleanupPlugin: TransformPlugin = createPlugin(
  'qualified-name-cleanup',
  'Qualified Name Cleanup',
  'Collapses repeated namespace segments, drops CRT/compiler qualifiers and strips the _exref import-thunk suffix',
  (options?: PluginOptions) =>
    createQualifiedNameCleanupTransformer(options as QualifiedNameCleanupOptions),
  {
    priority: 46,
    defaultEnabled: true,
    tags: ['cleanup', 'cpp'],
    version: '1.0.0',
  }
);
