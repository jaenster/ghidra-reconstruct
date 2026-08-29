/**
 * Label-Macro-Collision Plugin
 *
 * Ghidra can name a goto label after an identifier that the Win32/CRT headers
 * `#define` as a macro — most commonly `ERROR` (`#define ERROR 0`). The
 * preprocessor then expands `goto ERROR;` → `goto 0;` and `ERROR:` → `0:`,
 * yielding "expected ; before numeric constant" / "before ':' token".
 *
 * Rename any label (and its matching gotos) whose name collides with a known
 * platform macro, appending `_lbl` so the goto/label pair stays consistent.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, LabelStmt, GotoStmt, Identifier } from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface LabelMacroCollisionOptions extends PluginOptions {}

// Identifiers the Win32 SDK / CRT define as object-like macros, which a bare
// label of the same name would be wrongly expanded into.
const RESERVED_MACROS = new Set<string>([
  'ERROR', 'DELETE', 'OPTIONAL', 'IN', 'OUT', 'CONST', 'NULL', 'TRUE', 'FALSE',
  'NAN', 'EOF', 'DIFFERENCE', 'INPUT', 'OUTPUT',
]);

function renamed(name: string): string | null {
  return RESERVED_MACROS.has(name) ? `${name}_lbl` : null;
}

/**
 * A name this pass produced. The rename happens at priority 41, long before the
 * passes that reason about labels, so by the time one of them asks "is this a
 * decompiler-authored label?" the decompiler's `ERROR` is spelled `ERROR_lbl`
 * and answers no. This is the record that it still is one.
 */
export function isMacroRenamedLabel(name: string): boolean {
  const stem = /^(\w+)_lbl$/.exec(name);
  return stem !== null && RESERVED_MACROS.has(stem[1]);
}

function rename(id: Identifier): Identifier {
  const nn = renamed(id.name);
  return nn ? updateNode(id, { name: nn } as Partial<Identifier>) as Identifier : id;
}

function createLabelMacroCollisionTransformer(_options: LabelMacroCollisionOptions = {}): Transformer {
  return createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      if (n.kind === NodeKind.LabelStmt) {
        const l = n as LabelStmt;
        if (renamed(l.label.name)) return updateNode(l, { label: rename(l.label) } as Partial<LabelStmt>);
      } else if (n.kind === NodeKind.GotoStmt) {
        const g = n as GotoStmt;
        if (renamed(g.label.name)) return updateNode(g, { label: rename(g.label) } as Partial<GotoStmt>);
      }
      return undefined;
    },
  });
}

export const labelMacroCollisionPlugin: TransformPlugin = {
  id: 'label-macro-collision',
  name: 'Label Macro Collision',
  description: 'Renames goto labels that collide with Win32/CRT macros (ERROR, DELETE, …) so they do not preprocessor-expand',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 41,
  tags: ['cleanup', 'cpp'],
  createTransformer: createLabelMacroCollisionTransformer,
};
