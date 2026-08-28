/**
 * Shadowed-Type-Qualify Plugin
 *
 * Ghidra hangs a class's vtable data and its member functions under a namespace
 * named after the class (`D2Client::ButtonWrapper`, `D2Client::Draw`), and the
 * generator emits that namespace. The struct/typedef of the same name is emitted
 * at ROOT scope, so inside the enclosing namespace block unqualified lookup for
 * the type finds the NAMESPACE first and stops there:
 *
 *     namespace D2Client {
 *       pwszCursor = (Draw**)...;      // error: expected primary-expression before '*'
 *     }
 *
 * Every such type name is respelled root-qualified (`::Draw`). Decided per
 * TypedefType/ElaboratedType node from the caller's table of names that really
 * are BOTH a namespace component and a root-scope type — nothing else is
 * touched, and an already-qualified name is left alone.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, Identifier, QualifiedId, TypedefType, ElaboratedType } from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface ShadowedTypeQualifyOptions extends PluginOptions {
  /** Type names that a same-named emitted namespace shadows */
  shadowedTypeNames?: string[];
}

function createShadowedTypeQualifyTransformer(
  options: ShadowedTypeQualifyOptions = {},
): Transformer {
  const shadowed = new Set(options.shadowedTypeNames ?? []);
  if (shadowed.size === 0) return (node: ASTNode) => node;

  return createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      if (n.kind !== NodeKind.TypedefType && n.kind !== NodeKind.ElaboratedType) return undefined;
      const t = n as TypedefType | ElaboratedType;
      if (t.name.kind !== NodeKind.Identifier) return undefined;
      const id = t.name as Identifier;
      if (!shadowed.has(id.name)) return undefined;

      const qualified: QualifiedId = {
        kind: NodeKind.QualifiedId,
        qualifier: [],
        name: { ...id, leadingTrivia: [], trailingTrivia: [] },
        isGlobal: true,
        location: id.location,
        leadingTrivia: id.leadingTrivia ?? [],
        trailingTrivia: id.trailingTrivia ?? [],
      };
      return updateNode(t, { name: qualified } as Partial<TypedefType>);
    },
  });
}

import { createPlugin } from '../registry.js';

export const shadowedTypeQualifyPlugin: TransformPlugin = createPlugin(
  'shadowed-type-qualify',
  'Shadowed Type Qualify',
  'Root-qualifies a type name that a same-named emitted namespace shadows',
  (options?: PluginOptions) =>
    createShadowedTypeQualifyTransformer(options as ShadowedTypeQualifyOptions),
  {
    priority: 47,
    defaultEnabled: true,
    tags: ['cleanup', 'cpp'],
    version: '1.0.0',
  }
);
