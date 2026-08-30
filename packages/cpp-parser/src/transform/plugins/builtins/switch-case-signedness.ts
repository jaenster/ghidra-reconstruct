/**
 * Switch-Case-Signedness Plugin
 *
 * Reconciles a negative case label with an unsigned switch control.
 *
 * Ghidra's own C is consistent here — it writes an `undefined4` control and an
 * `0xffffffff` label, and those agree. Two earlier passes then make independent
 * decisions that do not:
 *
 *   - `type-normalize` (15) resolves `undefined4` to `uint32_t`;
 *   - `signed-literal` (30) reads `0xffffffff` as `-1`.
 *
 * The result is `switch ((uint32_t)x) { case -1: }`, and from C++11 a case label
 * is a converted constant expression, so a negative label under an unsigned
 * control is a narrowing conversion and a hard error.
 *
 * Neither half is wrong on its own. `-1` is the value the original source wrote
 * (`nMenuItemType` is documented `-1 = disabled`), and the 132 other negative
 * labels in the tree sit on signed controls where `0xfffffffd` would be the
 * narrowing error instead. So the reconciliation is done at the switch: give
 * the CONTROL the signed sibling of its own width. That is bit-exact — the
 * machine compares a 32-bit word and both spellings denote the same bits — and
 * it fires only where the emitter had already contradicted itself.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, Expression, SwitchStmt, CaseStmt, CStyleCastExpr, ParenExpr,
  UnaryExpr, IntegerLiteralExpr, TypeNode, TypedefType, BuiltinType,
  PointerType, Identifier, Statement,
} from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Expr, Type } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface SwitchCaseSignednessOptions extends PluginOptions {}

/** Unsigned fixed-width spellings and the signed sibling of the same width. */
const SIGNED_SIBLING: Record<string, string> = {
  uint8_t: 'int8_t',
  uint16_t: 'int16_t',
  uint32_t: 'int32_t',
  uint64_t: 'int64_t',
};

function unwrapParens(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** The name a type node spells, for the fixed-width spellings we key on. */
function typeName(t: TypeNode | undefined): string | null {
  if (!t) return null;
  if (t.kind === NodeKind.TypedefType) {
    const n = (t as TypedefType).name;
    return n.kind === NodeKind.Identifier ? (n as Identifier).name : null;
  }
  if (t.kind === NodeKind.BuiltinType) return (t as BuiltinType).name;
  return null;
}

/**
 * The unsigned fixed-width type the control is SPELLED as, or null.
 *
 * Only the two shapes the spelling itself settles are accepted:
 *   `(uint32_t)e`         — a direct cast, and
 *   `*(uint32_t *)e`      — the anonymous read Ghidra emits for a `void *` base.
 * Anything else (a bare identifier, a field access) needs a type environment
 * this pass does not have, and is left alone rather than guessed at.
 */
function unsignedControlType(cond: Expression): string | null {
  const e = unwrapParens(cond);
  if (e.kind === NodeKind.CStyleCastExpr) {
    const n = typeName((e as CStyleCastExpr).type);
    return n && n in SIGNED_SIBLING ? n : null;
  }
  if (e.kind === NodeKind.UnaryExpr && (e as UnaryExpr).operator === '*') {
    const inner = unwrapParens((e as UnaryExpr).operand);
    if (inner.kind !== NodeKind.CStyleCastExpr) return null;
    const ptr = (inner as CStyleCastExpr).type;
    if (ptr.kind !== NodeKind.PointerType) return null;
    const n = typeName((ptr as PointerType).pointee);
    return n && n in SIGNED_SIBLING ? n : null;
  }
  return null;
}

/** Is this label a negative integer constant? */
function isNegativeLabel(value: Expression): boolean {
  const e = unwrapParens(value);
  if (e.kind === NodeKind.IntegerLiteral) return (e as IntegerLiteralExpr).value < 0n;
  if (e.kind === NodeKind.UnaryExpr && (e as UnaryExpr).operator === '-') {
    const operand = unwrapParens((e as UnaryExpr).operand);
    return operand.kind === NodeKind.IntegerLiteral
      && (operand as IntegerLiteralExpr).value > 0n;
  }
  return false;
}

/**
 * The case labels belonging to THIS switch. A nested switch owns its own
 * labels and its own control; descending into one would let an inner negative
 * label rewrite an outer control that never saw it.
 */
function ownCaseLabels(stmt: Statement | ASTNode, out: CaseStmt[]): void {
  if (stmt.kind === NodeKind.SwitchStmt) return;
  if (stmt.kind === NodeKind.CaseStmt) {
    out.push(stmt as CaseStmt);
    ownCaseLabels((stmt as CaseStmt).statement, out);
    return;
  }
  for (const key of Object.keys(stmt as object)) {
    const child = (stmt as any)[key];
    if (Array.isArray(child)) {
      for (const c of child) {
        if (c && typeof c === 'object' && typeof c.kind === 'string') ownCaseLabels(c, out);
      }
    } else if (child && typeof child === 'object' && typeof child.kind === 'string') {
      ownCaseLabels(child, out);
    }
  }
}

function createSwitchCaseSignednessTransformer(
  _options: SwitchCaseSignednessOptions = {},
): Transformer {
  return createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      if (n.kind !== NodeKind.SwitchStmt) return undefined;
      const sw = n as SwitchStmt;

      const unsignedType = unsignedControlType(sw.condition);
      if (!unsignedType) return undefined;

      const labels: CaseStmt[] = [];
      ownCaseLabels(sw.body, labels);
      if (!labels.some(l => isNegativeLabel(l.value))) return undefined;

      return updateNode(sw, {
        condition: Expr.cast(Type.typedef(SIGNED_SIBLING[unsignedType]), sw.condition),
      } as Partial<SwitchStmt>);
    },
  });
}

export const switchCaseSignednessPlugin: TransformPlugin = {
  id: 'switch-case-signedness',
  name: 'Switch Case Signedness Reconciliation',
  description:
    'Casts an unsigned switch control to its signed sibling when the switch carries a negative case label',
  version: '1.0.0',
  defaultEnabled: true,
  // After type-normalize (15) and signed-literal (30) have both had their say,
  // and beside the other late type-repair passes.
  priority: 605,
  tags: ['cleanup', 'type', 'switch'],
  createTransformer: createSwitchCaseSignednessTransformer,
};
