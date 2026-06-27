/**
 * Switch-Pointer-Normalize Plugin
 *
 * Ghidra sometimes models a small integer switch through a pointer type, emitting
 * `switch ((int*)(uint32_t)x)` with `case (int*)0x1:` / `case nullptr:`. C++ requires
 * an INTEGER switch condition and integer case labels, so all of these fail
 * ("'reinterpret_cast' from integer to pointer" / "expected ; before …").
 *
 * When a switch condition is a cast to a pointer type, strip the pointer cast from
 * the condition and from every case label (recursively, leaving the inner integer),
 * and turn `case nullptr:` into `case 0:`. Only acts on pointer-typed switches, so
 * ordinary integer switches are untouched.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, Expression, SwitchStmt, CaseStmt, CStyleCastExpr, ParenExpr } from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Expr } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface SwitchPointerNormalizeOptions extends PluginOptions {}

function unwrapParens(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** Strip leading pointer casts (and turn nullptr into 0) → an integer expression. */
function normalize(expr: Expression): Expression {
  let e = unwrapParens(expr);
  if (e.kind === NodeKind.NullptrLiteral) return Expr.intLiteral(0);
  while (e.kind === NodeKind.CStyleCastExpr && (e as CStyleCastExpr).type.kind === NodeKind.PointerType) {
    e = unwrapParens((e as CStyleCastExpr).expression);
    if (e.kind === NodeKind.NullptrLiteral) return Expr.intLiteral(0);
  }
  return e;
}

function createSwitchPointerNormalizeTransformer(_options: SwitchPointerNormalizeOptions = {}): Transformer {
  return createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      if (n.kind !== NodeKind.SwitchStmt) return undefined;
      const sw = n as SwitchStmt;
      const newCond = normalize(sw.condition);
      if (newCond === sw.condition) return undefined; // not a pointer-typed switch
      // Normalize every case label in the body.
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
