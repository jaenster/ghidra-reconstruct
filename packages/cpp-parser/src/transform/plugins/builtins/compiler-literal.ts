/**
 * Compiler Literal Plugin
 *
 * A pooled string literal is not a variable of the program: VC8 made it from a `"..."`
 * at the use, and pooled it (/GF). The data model knows which Ghidra labels are such
 * literals (reconstruct's compiler-data.ts) and the tree declares none of them. A pass
 * that resolves an address to a label (`global-address-literal`) can still spell one,
 * so a reference to it is respelled here as the literal itself:
 *
 *   s_Font8_006dc978            ->  (char*)"Font8"
 *   (void*)&s_Font8_006dc978    ->  (void*)(char*)"Font8"
 *
 * `(char*)` is the type the array decays to, so the value and the type of the
 * expression are unchanged. `&label` outside a cast is `char(*)[N]`, which the literal
 * cannot spell without inventing a type; it is left, and reported.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, CStyleCastExpr, Identifier, QualifiedId, UnaryExpr, Expression } from '../../../ast/nodes.js';
import { Expr, Type } from '../../../ast/factory.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createPlugin } from '../registry.js';

export interface CompilerLiteralOptions extends PluginOptions {
  /** Label -> its exact C++ string literal (`"Font8"`, octal escapes for other bytes). */
  literals?: Record<string, string>;
  /** Label -> the symbol the linker defines in its place (`IMAGE_DOS_HEADER__00400000` -> `__ImageBase`). */
  renames?: Record<string, string>;
  onRewrite?: (info: { name: string; form: string }) => void;
  onRefusal?: (reason: string) => void;
}

function labelOf(node: ASTNode): string | undefined {
  if (node.kind === NodeKind.Identifier) return (node as Identifier).name;
  if (node.kind === NodeKind.QualifiedId) {
    const q = node as QualifiedId;
    return q.name.kind === NodeKind.Identifier ? (q.name as Identifier).name : undefined;
  }
  return undefined;
}

export function createCompilerLiteralTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as CompilerLiteralOptions;
  const literals = o.literals ?? {};
  const renames = o.renames ?? {};
  if (Object.keys(literals).length === 0 && Object.keys(renames).length === 0) return (n: ASTNode) => n;
  const literalOf = (node: ASTNode): string | undefined => {
    const name = labelOf(node);
    return name !== undefined && Object.prototype.hasOwnProperty.call(literals, name) ? literals[name] : undefined;
  };
  // The literal each respelled node stands for, and the label it replaced.
  const spelledFrom = new WeakMap<ASTNode, { raw: string; label: ASTNode }>();
  const addressOf = new WeakMap<ASTNode, string>();
  const spelled = (raw: string, label: ASTNode): Expression => {
    const lit = { ...Expr.stringLiteral(''), raw, location: label.location } as Expression;
    const cast = Expr.cast(Type.pointer(Type.builtin('char')), lit);
    spelledFrom.set(cast, { raw, label });
    return cast;
  };
  // Children first: a label is respelled before its parent is seen, and a parent that
  // cannot take the literal (`&label` outside a cast) puts the label back.
  return createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      if (n.kind === NodeKind.UnaryExpr) {
        const u = n as UnaryExpr;
        const from = spelledFrom.get(u.operand);
        if (!from) return undefined;
        if (u.operator !== '&') {
          o.onRefusal?.(`${labelOf(from.label)}: operand of unary ${u.operator}`);
          return updateNode(u, { operand: from.label as Expression } as Partial<UnaryExpr>);
        }
        const restored = updateNode(u, { operand: from.label as Expression } as Partial<UnaryExpr>);
        addressOf.set(restored, from.raw);
        return restored;
      }
      if (n.kind === NodeKind.CStyleCastExpr) {
        const c = n as CStyleCastExpr;
        const raw = addressOf.get(c.expression);
        if (raw === undefined) return undefined;
        o.onRewrite?.({ name: labelOf((c.expression as UnaryExpr).operand) ?? '?', form: '(T)&label' });
        return updateNode(c, { expression: spelled(raw, (c.expression as UnaryExpr).operand) } as Partial<CStyleCastExpr>);
      }
      if (n.kind === NodeKind.QualifiedId) {
        // Its leaf was met first: the qualified label is the same literal.
        const leaf = spelledFrom.get((n as QualifiedId).name as ASTNode);
        if (leaf) return spelled(leaf.raw, n);
      }
      if (n.kind === NodeKind.Identifier || n.kind === NodeKind.QualifiedId) {
        const name = labelOf(n);
        if (name !== undefined && Object.prototype.hasOwnProperty.call(renames, name)) {
          o.onRewrite?.({ name, form: 'linker symbol' });
          return { ...Expr.identifier(renames[name]), location: n.location } as ASTNode;
        }
        const raw = literalOf(n);
        if (raw === undefined) return undefined;
        o.onRewrite?.({ name: labelOf(n)!, form: 'label' });
        return spelled(raw, n);
      }
      return undefined;
    },
  });
}

export const compilerLiteralPlugin: TransformPlugin = createPlugin(
  'compiler-literal',
  'Compiler Literal',
  'A reference to a pooled string literal Ghidra labelled, respelled as the literal itself',
  (options?: PluginOptions) => createCompilerLiteralTransformer(options),
  {
    priority: 70, // after global-address-literal (68) has resolved addresses to labels
    defaultEnabled: true,
    tags: ['correctness'],
    version: '1.0.0',
  },
);
