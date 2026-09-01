/**
 * Reserved-Field-Rename Plugin
 *
 * Ghidra names data-table struct fields after the .txt column headers, and some
 * of those columns are spelled exactly like a C++ keyword — CharTemplate.txt has
 * an `int` column, so `D2CharTemplateTxt` really carries a field named `int`.
 * The header generator therefore declares such a field with a trailing `_`
 * (`int_`). Every REFERENCE to the field must use the same spelling.
 *
 * The rename map is the one produced when the struct was declared, so this pass
 * only rewrites member names that were actually renamed — and, because it
 * matches on the MemberExpr node, it cannot touch the same characters inside a
 * string literal or a comment.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, Identifier, MemberExpr } from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface ReservedFieldRenameOptions extends PluginOptions {
  /** Declaration-time field renames: Ghidra field name → emitted C++ member name */
  fieldRenames?: Record<string, string>;
}

function createReservedFieldRenameTransformer(
  options: ReservedFieldRenameOptions = {}
): Transformer {
  const renames = options.fieldRenames ?? {};
  if (Object.keys(renames).length === 0) {
    return (node: ASTNode) => node;
  }

  return createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      if (n.kind !== NodeKind.MemberExpr) return undefined;
      const m = n as MemberExpr;
      if (m.member.kind !== NodeKind.Identifier) return undefined;
      const member = m.member as Identifier;
      const renamed = renames[member.name];
      if (!renamed || renamed === member.name) return undefined;
      return updateNode(m, {
        member: updateNode(member, { name: renamed } as Partial<Identifier>) as Identifier,
      } as Partial<MemberExpr>);
    },
  });
}

import { createPlugin } from '../registry.js';

export const reservedFieldRenamePlugin: TransformPlugin = createPlugin(
  'reserved-field-rename',
  'Reserved Field Rename',
  'Rewrites member accesses to struct fields the header renamed because their name is a C++ keyword (->int → ->int_)',
  (options?: PluginOptions) =>
    createReservedFieldRenameTransformer(options as ReservedFieldRenameOptions),
  {
    priority: 47,
    defaultEnabled: true,
    tags: ['cleanup', 'cpp'],
    version: '1.0.0',
  }
);
