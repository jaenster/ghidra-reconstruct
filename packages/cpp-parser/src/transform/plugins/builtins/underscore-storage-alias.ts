/**
 * Underscore Storage-Alias Plugin
 *
 * Ghidra writes one leading underscore over a name to mean "the same storage,
 * second occupant". Three different things wear that spelling and only one of
 * them is a local:
 *
 *  1. A reused STACK SLOT (`_nSuffixId` over a local `nSuffixId`) — declared by
 *     `underscore-slot-local`, which owns that case and is the only pass allowed
 *     to, because a wrong answer there is a silent aliasing bug.
 *  2. A GLOBAL's reused slot (`_gnLastLevelId` over the global `gnLastLevelId`).
 *     The underscore form is the same storage, so it binds correctly once it is
 *     spelled as the global — which is also the only spelling anything declares.
 *  3. An MSVC-DECORATED CRT CALL. Ghidra emits `_memmove(...)`, `_isspace(...)`
 *     for the standard functions; the leading underscore is MS decoration. The
 *     include resolver already strips it to pick the header, but the call site
 *     keeps it and then names nothing the header declares.
 *
 * Cases 2 and 3 used to be a pair of `body.replace()` calls over the finished
 * text, which could not tell an identifier from the same characters inside a
 * string literal or a comment, and read "is this name declared?" off a regex for
 * a declaration. Here the declared set is the parameters and the `VariableDecl`s
 * themselves, a call is a `CallExpr`, and `p->_field` keeps its field name
 * because a member is not a value-position identifier.
 *
 * An alias whose base is neither a global nor a CRT function is left exactly as
 * it is — that is case 1's, or a genuinely undeclared name that must stay loud.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, FunctionDecl, CompoundStmt, VariableDecl, ParameterDecl, Identifier,
  CallExpr, MemberExpr,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Expr } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface UnderscoreStorageAliasOptions extends PluginOptions {
  /** Names of program globals visible to this unit. */
  globalNames?: string[];
  /** CRT function names whose MSVC-decorated `_name` form binds to a header. */
  crtFunctionNames?: string[];
  /** Params/locals the wrapped body's AST cannot show — same map the slot pass gets. */
  varTypes?: Record<string, string>;
}

function createUnderscoreStorageAliasTransformer(options: UnderscoreStorageAliasOptions = {}): Transformer {
  const globals = new Set(options.globalNames ?? []);
  const crt = new Set(options.crtFunctionNames ?? []);
  if (globals.size === 0 && crt.size === 0) return (n: ASTNode) => n;

  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;

      const declared = new Set<string>(Object.keys(options.varTypes ?? {}));
      for (const p of node.parameters) {
        const pd = p as ParameterDecl;
        if (pd.name) declared.add(pd.name.name);
      }
      for (const d of findNodesByKind(node.body, NodeKind.VariableDecl)) {
        declared.add((d as VariableDecl).name.name);
      }

      /** `_base` → `base` when `base` is a global and `_base` is not declared. */
      const globalTarget = (name: string): string | null => {
        if (name.length < 2 || name[0] !== '_') return null;
        if (declared.has(name)) return null;
        const base = name.slice(1);
        return globals.has(base) ? base : null;
      };

      // Identifiers this pass rewrote, so a member access can put its field name
      // back: the transformer visits a MemberExpr's `member` like any other
      // identifier, and `p->_flags` is a FIELD, not a storage alias.
      const rewritten = new Map<ASTNode, string>();
      let changed = false;

      const inner = createTransformer({
        visitIdentifier(id: Identifier): ASTNode | undefined {
          const target = globalTarget(id.name);
          if (!target) return undefined;
          const out = Expr.identifier(target);
          rewritten.set(out, id.name);
          changed = true;
          return out;
        },
        visitMemberExpr(m: MemberExpr): ASTNode | undefined {
          const original = rewritten.get(m.member as ASTNode);
          if (original === undefined) return undefined;
          return updateNode(m, { member: Expr.identifier(original) } as Partial<MemberExpr>);
        },
        visitCallExpr(call: CallExpr): ASTNode | undefined {
          const callee = call.callee;
          if (callee.kind !== NodeKind.Identifier) return undefined;
          const name = (callee as Identifier).name;
          if (name.length < 2 || name[0] !== '_') return undefined;
          if (declared.has(name)) return undefined;
          const base = name.slice(1);
          if (!crt.has(base)) return undefined;
          changed = true;
          return updateNode(call, { callee: Expr.identifier(base) } as Partial<CallExpr>);
        },
      });

      const newBody = inner(node.body) as CompoundStmt;
      if (!changed) return undefined;
      return updateNode(node, { body: newBody } as Partial<FunctionDecl>);
    },
  });
}

export const underscoreStorageAliasPlugin: TransformPlugin = {
  id: 'underscore-storage-alias',
  name: 'Underscore Storage Alias',
  description: "Binds Ghidra's `_<global>` slot alias to the global, and a decorated `_<crt>(` call to the CRT name",
  version: '1.0.0',
  defaultEnabled: true,
  // Alongside underscore-slot-local (600), whose case is disjoint from these two:
  // it claims `_<base>` only where `<base>` is a declared param or local.
  priority: 599,
  tags: ['cleanup', 'declaration'],
  createTransformer: createUnderscoreStorageAliasTransformer,
};
