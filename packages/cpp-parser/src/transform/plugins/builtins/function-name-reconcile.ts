/**
 * Function-Name-Reconcile Plugin
 *
 * A function has TWO independent spellings in an extraction, and they can
 * disagree:
 *
 *  - the DECLARATION spelling — `name` + `namespace` from the symbol table,
 *    which decides the emitted prototype, the header it lands in, the module it
 *    belongs to and every include that resolves through it;
 *  - the REFERENCE spelling — the identifier the DECOMPILER printed, which is
 *    what every call site in every other body is written with.
 *
 * The two come from different round-trips, so any rename or namespace move
 * landing between them (or served from either side's cache) splits the pair: the
 * tree then REFERENCES a name it never DECLARES, and every call site is
 * "'X' was not declared in this scope".
 *
 * The reconciliation is one-directional and keyed on nothing but identity: the
 * decompiler's spelling for an address is respelled as the declaration's
 * spelling for that same address. Nothing is keyed on a name list or a module,
 * so a later renaming campaign needs no change here.
 *
 * Both halves of the spelling are reconciled — a bare rename respells the tail,
 * a namespace move respells the qualifier too — because a reference whose
 * qualifier still names the old namespace is just as undeclared as one whose
 * tail names the old function.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, Identifier, QualifiedId, TemplateType } from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface FunctionNameReconcileOptions extends PluginOptions {
  /**
   * Reference spelling (exactly as the decompiler printed it, qualified or
   * bare) → the spelling the emitted declaration uses. Never contains an entry
   * whose key is also some function's declared spelling, so applying it is
   * idempotent.
   */
  aliases?: Record<string, string>;
}

/** The spelled name of an Identifier / QualifiedId node, or undefined. */
function spelledName(n: ASTNode): string | undefined {
  if (n.kind === NodeKind.Identifier) return (n as Identifier).name;
  if (n.kind !== NodeKind.QualifiedId) return undefined;
  const q = n as QualifiedId;
  if (q.isGlobal) return undefined; // `::f` is already an explicit root reference
  if (q.name.kind !== NodeKind.Identifier) return undefined;
  const parts: string[] = [];
  for (const part of q.qualifier) {
    if (part.kind !== NodeKind.Identifier) return undefined;
    parts.push((part as Identifier).name);
  }
  parts.push((q.name as Identifier).name);
  return parts.join('::');
}

function createFunctionNameReconcileTransformer(
  options: FunctionNameReconcileOptions = {}
): Transformer {
  const aliases = options.aliases ?? {};
  if (Object.keys(aliases).length === 0) {
    return (ast: ASTNode) => ast;
  }

  return createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      if (n.kind !== NodeKind.Identifier && n.kind !== NodeKind.QualifiedId) return undefined;
      const spelled = spelledName(n);
      if (spelled === undefined) return undefined;
      const canonical = aliases[spelled];
      if (canonical === undefined || canonical === spelled) return undefined;

      const segments = canonical.split('::');
      const tail = segments.pop()!;

      // A bare canonical name replaces the whole reference with one Identifier.
      if (segments.length === 0) {
        const base = n.kind === NodeKind.Identifier
          ? (n as Identifier)
          : ((n as QualifiedId).name as Identifier);
        return updateNode(base, {
          name: tail,
          leadingTrivia: [...(n.leadingTrivia ?? []), ...(base.leadingTrivia ?? [])],
          trailingTrivia: [...(base.trailingTrivia ?? []), ...(n.trailingTrivia ?? [])],
        } as Partial<Identifier>);
      }

      // Reuse the existing name node for the tail so its trivia survives, and
      // build the qualifier from the declaration's namespace.
      const nameNode = (n.kind === NodeKind.Identifier
        ? (n as Identifier)
        : ((n as QualifiedId).name as Identifier));
      const newName = updateNode(nameNode, { name: tail } as Partial<Identifier>) as Identifier;
      const qualifier: (Identifier | TemplateType)[] = segments.map(seg => ({
        kind: NodeKind.Identifier,
        name: seg,
        location: n.location,
        leadingTrivia: [],
        trailingTrivia: [],
      } as unknown as Identifier));

      if (n.kind === NodeKind.QualifiedId) {
        return updateNode(n as QualifiedId, {
          qualifier,
          name: newName,
        } as Partial<QualifiedId>);
      }
      return {
        kind: NodeKind.QualifiedId,
        qualifier,
        name: newName,
        isGlobal: false,
        location: n.location,
        leadingTrivia: n.leadingTrivia ?? [],
        trailingTrivia: n.trailingTrivia ?? [],
      } as unknown as QualifiedId;
    },
  });
}

import { createPlugin } from '../registry.js';

export const functionNameReconcilePlugin: TransformPlugin = createPlugin(
  'function-name-reconcile',
  'Function Name Reconcile',
  "Respells a body's references with the name and namespace the emitted declaration uses",
  (options?: PluginOptions) =>
    createFunctionNameReconcileTransformer(options as FunctionNameReconcileOptions),
  {
    priority: 20,
    defaultEnabled: true,
    tags: ['cleanup', 'cpp'],
    version: '1.0.0',
  }
);
