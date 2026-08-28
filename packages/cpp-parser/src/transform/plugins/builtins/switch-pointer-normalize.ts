/**
 * Switch-Pointer-Normalize Plugin
 *
 * Ghidra sometimes models a small integer switch through a pointer type, emitting
 * `switch ((int*)(uint32_t)x)` with `case (int*)0x1:` / `case nullptr:`. C++ requires
 * an INTEGER switch condition and integer case labels, so all of these fail
 * ("switch quantity not an integer" / "'reinterpret_cast' from integer to pointer").
 *
 * A case label is the load-bearing evidence, not the condition. C++ case labels are
 * integral constant expressions by definition, so `case (D2UnitStrc*)0x2:` is proof
 * that this switch is an integer switch Ghidra typed as a pointer — whether or not
 * the condition happens to be spelled as a cast. When the condition is itself a
 * pointer cast we strip it; when it is a plain pointer-typed expression (a parameter
 * Ghidra gave a struct-pointer type) there is nothing to strip, so it is converted
 * with `(int32_t)(uintptr_t)` instead.
 *
 * `case nullptr:` alone is NOT taken as evidence — an integer switch can legitimately
 * carry one after nullptr-cleanup — but it is rewritten to `case 0:` whenever the
 * switch is being normalized anyway.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, Expression, SwitchStmt, CaseStmt, CStyleCastExpr, ParenExpr, Identifier } from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { Expr, Type } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface SwitchPointerNormalizeOptions extends PluginOptions {}

function unwrapParens(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/**
 * `nullptr` reaches here two ways: as a NullptrLiteral the parser produced, and as
 * a plain Identifier named `nullptr` — which is what nullptr-cleanup substitutes
 * for `(T*)0x0`. Both are the integer 0 in a case label, and neither is legal as
 * one, so both have to be recognised.
 */
function isNullptr(e: Expression): boolean {
  return e.kind === NodeKind.NullptrLiteral
    || (e.kind === NodeKind.Identifier && (e as Identifier).name === 'nullptr');
}

function isPointerCast(e: Expression): boolean {
  return e.kind === NodeKind.CStyleCastExpr
    && (e as CStyleCastExpr).type.kind === NodeKind.PointerType;
}

/** Strip leading pointer casts (and turn nullptr into 0) → an integer expression. */
function normalize(expr: Expression): Expression {
  let e = unwrapParens(expr);
  if (isNullptr(e)) return Expr.intLiteral(0);
  while (isPointerCast(e)) {
    e = unwrapParens((e as CStyleCastExpr).expression);
    if (isNullptr(e)) return Expr.intLiteral(0);
  }
  return e;
}

function createSwitchPointerNormalizeTransformer(_options: SwitchPointerNormalizeOptions = {}): Transformer {
  return createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      if (n.kind !== NodeKind.SwitchStmt) return undefined;
      const sw = n as SwitchStmt;

      // A pointer-cast case label proves the switch is a mis-typed integer switch.
      const labels = findNodesByKind(sw.body, NodeKind.CaseStmt)
        .map(c => unwrapParens((c as CaseStmt).value));
      const pointerLabel = labels.some(isPointerCast);
      const nullptrLabel = labels.some(isNullptr);
      const condIsPointerCast = isPointerCast(unwrapParens(sw.condition));
      if (!pointerLabel && !nullptrLabel && !condIsPointerCast) return undefined;

      // Condition: strip the cast when there is one, otherwise convert the
      // pointer-typed expression the labels have just proven it to be.
      // `case nullptr:` on its own is not evidence about the CONDITION — an
      // integer switch can carry one — so it rewrites the label without touching
      // the condition. A pointer-cast label is evidence, and gets the conversion.
      const newCond = condIsPointerCast
        ? normalize(sw.condition)
        : pointerLabel
          ? Expr.cast(Type.builtin('int32_t'), Expr.cast(Type.builtin('uintptr_t'), sw.condition))
          : sw.condition;

      const sub = createTransformer({
        visitNode(m: ASTNode): ASTNode | undefined {
          if (m.kind !== NodeKind.CaseStmt) return undefined;
          const c = m as CaseStmt;
          const nv = normalize(c.value);
          return nv === c.value ? undefined : updateNode(c, { value: nv } as Partial<CaseStmt>);
        },
      });
      return updateNode(sw, { condition: newCond, body: sub(sw.body) } as Partial<SwitchStmt>);
    },
  });
}

export const switchPointerNormalizePlugin: TransformPlugin = {
  id: 'switch-pointer-normalize',
  name: 'Switch Pointer Normalize',
  description: 'Strips pointer casts from a pointer-typed switch condition and its case labels (→ integer switch)',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 40,
  tags: ['cleanup', 'cpp'],
  createTransformer: createSwitchPointerNormalizeTransformer,
};
