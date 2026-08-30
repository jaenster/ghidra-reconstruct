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
 *
 *  - A qualifier segment that names a struct/union/enum and sits DIRECTLY before
 *    the name: `Forms::D2WinImage::Draw` → `Forms::Draw`, because Ghidra hangs a
 *    class's members under a namespace named after the class while the emitter
 *    puts them in the parent. Only the last qualifier segment, and only when
 *    something else qualifies it: an INTERMEDIATE type-named segment
 *    (`D2Common::Item::ItemMods::Fn`, where `Item` is also a struct) is a real
 *    enclosing namespace, and dropping it points the reference at a sibling
 *    scope that does not exist.
 *
 *    This was a `String.replace` over the whole emitted file. It could not tell
 *    a reference from anything else that looks like one, and it rewrote the
 *    file's own `namespace D2Common::Item::ItemMods {` header — the guard looks
 *    for a following `::`, and a namespace declaration is followed by ` {` — so
 *    every definition in the unit moved to a namespace its header never
 *    declared. Deciding it on the QualifiedId node cannot reach a declaration,
 *    a comment or a string literal.
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
  /**
   * Struct/union/enum names. A qualifier segment naming one of these is dropped
   * when it is the LAST segment of the qualifier and is itself qualified.
   */
  typeQualifierNames?: string[];
}

const DEFAULT_DROPPED_QUALIFIERS = ['VisualStudio', 'compiler'];

const EXREF_SUFFIX = '_exref';

function segmentName(part: Identifier | TemplateType): string | undefined {
  return part.kind === NodeKind.Identifier ? (part as Identifier).name : undefined;
}

/** `A::B::f` for a reference built only from plain identifiers; undefined otherwise. */
function modelName(q: QualifiedId): string | undefined {
  if (q.name.kind !== NodeKind.Identifier) return undefined;
  const parts: string[] = [];
  for (const part of q.qualifier) {
    const name = segmentName(part);
    if (name === undefined) return undefined;
    parts.push(name);
  }
  parts.push((q.name as Identifier).name);
  return parts.join('::');
}

function cleanQualifier(
  qualifier: (Identifier | TemplateType)[],
  dropped: Set<string>,
  collapseDuplicates: boolean,
  typeNames: Set<string>
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

  // Penultimate-only: the segment immediately before the name, never an
  // intermediate one, and never the sole qualifier (`D2WinImage::Draw` is a
  // member reference, not a namespace path).
  if (typeNames.size > 0 && out.length >= 2) {
    const last = segmentName(out[out.length - 1]);
    if (last !== undefined && typeNames.has(last)) {
      out.pop();
      changed = true;
    }
  }

  return changed ? out : undefined;
}

function createQualifiedNameCleanupTransformer(
  options: QualifiedNameCleanupOptions = {}
): Transformer {
  const dropped = new Set(options.dropQualifiers ?? DEFAULT_DROPPED_QUALIFIERS);
  const collapseDuplicates = options.collapseDuplicateQualifiers ?? true;
  const stripExref = options.stripExrefSuffix ?? true;
  const typeNames = new Set(options.typeQualifierNames ?? []);

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

      const cleaned = cleanQualifier(q.qualifier, dropped, collapseDuplicates, typeNames);
      if (!cleaned) return undefined;

      // What the model spelled here, kept for the passes that resolve a
      // signature by name. Dropping the form's own segment maps eight distinct
      // functions onto one spelling; the signature tables still hold the
      // spelling that told them apart. Recorded only when a name is actually
      // spellable from the node, and never overwritten: the FIRST pass to
      // shorten a reference is the one that held the model's answer.
      const info = modelName(q) === undefined || q.ghidraInfo?.modelQualifiedName !== undefined
        ? q.ghidraInfo
        : { ...q.ghidraInfo, modelQualifiedName: modelName(q)! };

      // Nothing qualifies the name any more — emit it bare, unless the
      // reference was explicitly root-qualified (`::name`), which must stay.
      if (cleaned.length === 0 && !q.isGlobal && q.name.kind === NodeKind.Identifier) {
        const name = q.name as Identifier;
        return updateNode(name, {
          ghidraInfo: info ?? name.ghidraInfo,
          leadingTrivia: [...(q.leadingTrivia ?? []), ...(name.leadingTrivia ?? [])],
          trailingTrivia: [...(name.trailingTrivia ?? []), ...(q.trailingTrivia ?? [])],
        } as Partial<Identifier>);
      }

      return updateNode(q, { qualifier: cleaned, ghidraInfo: info } as Partial<QualifiedId>);
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
