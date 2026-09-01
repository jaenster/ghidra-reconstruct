/**
 * Function-Shadowed-Global Plugin
 *
 * A data symbol and a function can carry the same name: `D2GFX_EndCutScene` is
 * both a function at 0x4f5fa0 and a flag at 0x7c9340, `fpInsertPlayCd` is both a
 * callback at 0x434220 and a file-local flag at 0x7798d4, `DenOfEvilLight` is
 * both a lighting routine and the BOOL that switches it on. The generator emits
 * the function inside its namespace and the flag at ROOT scope, and then every
 * unqualified read or write of the flag from inside that namespace binds to the
 * FUNCTION instead:
 *
 *     namespace D2gfx::D2GFX {
 *       D2GFX_EndCutScene = D2GFX_EndCutSceneCurrentState;   // assignment of function
 *     }
 *
 * Ghidra keeps the two apart and this pass keeps them apart: the decompiler
 * spells a reference to the FUNCTION with its whole namespace path
 * (`D2gfx::D2GFX::D2GFX_EndCutScene()`) and a reference to the DATA bare. So a
 * BARE occurrence of one of these names is the global, and it is respelled
 * `::name`, which reaches the global from any scope. The qualified spelling is
 * left exactly as it is — it is the one that means the function.
 *
 * This has to run before `enclosing-namespace-strip`, which shortens the
 * qualified spelling to the bare one and erases the distinction.
 *
 * A name is only an identifier in an EXPRESSION when it is not naming something
 * else, so the rewrite is put back wherever the identifier turns out to be a
 * member name, the tail of a qualified name, or a declaration's own name.
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

export interface FunctionShadowedGlobalOptions extends PluginOptions {
  /**
   * Names that are BOTH a root-scope data symbol and a function somewhere in the
   * project. Only these are respelled; everything else is untouched.
   */
  functionShadowedGlobals?: string[];
}

/** Names this body declares itself — a parameter or a local of its own. */
function declaredInBody(root: ASTNode): Set<string> {
  const names = new Set<string>();
  const add = (n: ASTNode | undefined) => {
    if (n && n.kind === NodeKind.Identifier) names.add((n as Identifier).name);
  };
  for (const d of findNodesByKind(root, NodeKind.ParameterDecl)) add((d as ParameterDecl).name);
  for (const d of findNodesByKind(root, NodeKind.VariableDecl)) add((d as VariableDecl).name);
  return names;
}

function createFunctionShadowedGlobalTransformer(
  options: FunctionShadowedGlobalOptions = {},
): Transformer {
  const configured = new Set(options.functionShadowedGlobals ?? []);
  if (configured.size === 0) return (node: ASTNode) => node;

  return (root: ASTNode) => {
    // A parameter or local of the same name is what a bare occurrence means, and
    // it is nearer than either the global or the function.
    // `MPQ_LoadAllMediaMpqFiles(fpRequiredUserAction fpInsertPlayCd, …)` takes the
    // callback as a PARAMETER named after the flag, and every use of it in that
    // body is the parameter. The name is dropped for the whole body rather than
    // scope-tracked: a body that declares it never needs the rewrite anyway.
    const declared = declaredInBody(root);
    const shadowed = new Set([...configured].filter(n => !declared.has(n)));
    if (shadowed.size === 0) return root;
    return rewrite(shadowed)(root);
  };
}

function rewrite(shadowed: Set<string>): Transformer {
  /** Each `::name` this pass built, against the Identifier it replaced. */
  const builtFrom = new WeakMap<ASTNode, Identifier>();

  /** Put back the plain Identifier at a position that names, not references. */
  const restore = (child: ASTNode | undefined): Identifier | undefined =>
    child ? builtFrom.get(child) : undefined;

  return createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      if (n.kind === NodeKind.QualifiedId) {
        const q = n as QualifiedId;
        const back = restore(q.name);
        if (!back) return undefined;
        return updateNode(q, { name: back } as Partial<QualifiedId>);
      }

      if (n.kind !== NodeKind.Identifier) return undefined;
      const id = n as Identifier;
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
      builtFrom.set(qualified, id);
      return qualified;
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

import { createPlugin } from '../registry.js';

export const functionShadowedGlobalPlugin: TransformPlugin = createPlugin(
  'function-shadowed-global',
  'Function Shadowed Global',
  'Root-qualifies a bare reference to a root-scope global that a same-named function hides',
  (options?: PluginOptions) =>
    createFunctionShadowedGlobalTransformer(options as FunctionShadowedGlobalOptions),
  {
    priority: 49,
    defaultEnabled: true,
    tags: ['cleanup', 'cpp'],
    version: '1.0.0',
  }
);
