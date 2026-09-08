/**
 * Extraout Splice Plugin
 *
 * A callee that returns a byte defines only AL. Ghidra models the rest of EAX
 * as a synthetic `extraout_var` (or `extraout_EAX`, ...) and rebuilds the full
 * register by splicing it back on:
 *
 *   (uint32_t)extraout_var << 8 | (uint32_t)bGemApplyType & 0xffu
 *
 * Those symbols are never assigned - the corpus declares `undefined3
 * extraout_var` 148 times and assigns it 0 times - so every one of the 482 uses
 * reads an uninitialised stack word. The consequences are not subtle:
 *
 *   - as a value, the result carries garbage above the one real byte.
 *     `ITEM_GetItemsTxt_bGemApplyType` returned it as a gem-apply-type, which
 *     `ITEMMOD_GetPropertyFromAffix` then range-checked with `nIndex < 3`. The
 *     garbage failed the check and the original assert fired, killing the client
 *     while it applied socket stats on load.
 *   - as a CONDITION it is worse: `if (extraout_var << 8 | b & 0xff)` is true
 *     whenever the garbage is non-zero, whatever `b` is. The branch stops
 *     depending on the value the program actually computed.
 *
 * The splice is undone rather than repaired, because there is nothing to repair
 * with: the upper bytes are undefined in the machine too. A correct program can
 * only be reading the byte, so the byte is what the expression becomes:
 *
 *   (uint32_t)extraout_var << 8 | (uint32_t)b & 0xffu   →   (uint32_t)b & 0xffu
 *
 * That is exact wherever the original is meaningful, and it turns a silent wrong
 * value into the right one instead of into a build error.
 *
 * What this pass deliberately does NOT do is widen the callee. When the machine
 * ends in `MOVZX EAX, byte ptr [...]` the whole register IS defined and the
 * `bool`/byte return type is the real defect - `TXT_Items_GetGemApplyType`
 * @0x00629a00 is one, squashing 0/1/2 to 0/1. That is a Ghidra retype, and this
 * pass only stops the uninitialised read that sits on top of it.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  BinaryExpr,
  Identifier,
  ParenExpr,
  CStyleCastExpr,
  IntegerLiteralExpr,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

/**
 * Ghidra's usual name for register bytes a callee left undefined. The name is
 * only a hint: these get renamed in the database (`dwTmp`, `extraout_boolHigh`,
 * ...), so the real test is the SHAPE - a local the function declares, never
 * assigns, and shifts into the top of a word. `D2Net/SRC/Client.cpp` carried a
 * hand fix for a renamed one whose splice decided whether the single-player
 * handshake ran at all.
 */
const EXTRAOUT_RE = /^extraout_/;

function unwrap(expr: Expression): Expression {
  let e = expr;
  for (;;) {
    if (e.kind === NodeKind.ParenExpr) { e = (e as ParenExpr).expression; continue; }
    if (e.kind === NodeKind.CStyleCastExpr) { e = (e as CStyleCastExpr).expression; continue; }
    return e;
  }
}

/** The identifier this expression is, ignoring casts and parens. */
function identName(expr: Expression): string | null {
  const e = unwrap(expr);
  return e.kind === NodeKind.Identifier ? (e as Identifier).name : null;
}

function intValue(expr: Expression): bigint | null {
  const e = unwrap(expr);
  return e.kind === NodeKind.IntegerLiteral ? (e as IntegerLiteralExpr).value : null;
}

/**
 * `<extraout> << <n>`, the half of the splice that carries nothing.
 *
 * The shift is required: a bare `extraout_var` that is not shifted into the top
 * of a word is some other shape this pass has no evidence about, and is left
 * alone to keep failing loudly.
 */
function isExtraoutShift(expr: Expression): boolean {
  const e = unwrap(expr);
  if (e.kind !== NodeKind.BinaryExpr) return false;
  const b = e as BinaryExpr;
  if (b.operator !== '<<') return false;
  if (identName(b.left) === null) return false;
  const n = intValue(b.right);
  return n !== null && n > 0n && n < 32n;
}

function createExtraoutSpliceTransformer(): Transformer {
  return (root: ASTNode) => {
    // Locals the function declares. Only those can be judged - a parameter or a
    // global may be set anywhere, so their upper bytes are not known garbage.
    const declared = new Set<string>();
    for (const n of traverseAST(root)) {
      if (n.kind !== NodeKind.VariableDecl) continue;
      const nm = (n as unknown as { name?: { name?: string } }).name?.name;
      if (nm) declared.add(nm);
    }

    // Anything the body writes, or whose address it takes, may hold a real
    // value. Conservative on purpose: a name that escapes is left alone.
    const assigned = new Set<string>();
    for (const n of traverseAST(root)) {
      if (n.kind === NodeKind.AssignExpr) {
        const nm = identName((n as unknown as { left: Expression }).left);
        if (nm) assigned.add(nm);
      } else if (n.kind === NodeKind.UnaryExpr) {
        const u = n as unknown as { operator: string; operand: Expression };
        if (u.operator === '&' || u.operator === '++' || u.operator === '--') {
          const nm = identName(u.operand);
          if (nm) assigned.add(nm);
        }
      }
    }

    /** Never written, so its bytes are whatever the frame happened to hold. */
    const isGarbage = (name: string): boolean =>
      (declared.has(name) || EXTRAOUT_RE.test(name)) && !assigned.has(name);

    return createTransformer({
      visitNode(node: ASTNode): ASTNode | undefined {
        if (node.kind !== NodeKind.BinaryExpr) return undefined;
        const bin = node as BinaryExpr;
        if (bin.operator !== '|') return undefined;

        const spliceName = (side: Expression): string | null =>
          isExtraoutShift(side) ? identName((unwrap(side) as BinaryExpr).left) : null;
        const leftName = spliceName(bin.left);
        const rightName = spliceName(bin.right);

        if (leftName !== null && isGarbage(leftName)) return bin.right as unknown as ASTNode;
        if (rightName !== null && isGarbage(rightName)) return bin.left as unknown as ASTNode;
        return undefined;
      },
    })(root);
  };
}

export const extraoutSplicePlugin: TransformPlugin = {
    id: 'extraout-splice',
    name: 'Extraout Splice',
    description:
      'Drops Ghidra\'s undefined upper register bytes from a narrow return, which are read uninitialised',
    version: '1.0.0',
    defaultEnabled: true,
    // Before the branchless folds (42/43) and ternary-simplify (55), so a
    // condition is simplified from the byte rather than from the splice.
    priority: 41,
    tags: ['core', 'correctness', 'ghidra'],
  createTransformer(_options?: PluginOptions) {
    return createExtraoutSpliceTransformer();
  },
};
