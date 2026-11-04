/**
 * Rotate Intrinsic Plugin
 *
 * Ghidra's p-code has no rotate, so `rol ecx, 0x1e` is decompiled as the shift pair
 * `x << 0x1e | x >> 2`. VC8 compiles that pair as a rotate again, but always the one with
 * the smaller count (`ror ecx, 2`): a rotate the original wrote with a count above 16 only
 * comes back from `_rotl(x, 0x1e)`, which VC8 keeps as written (Storm SHA1_Round1..4
 * 00425730.., SSignature.cpp `*pnB = *pnB << 0x1e | *pnB >> 2;` against `rol ecx, 0x1e`).
 *
 * The text cannot say which rotate the original performed, nor whether the pair was a rotate
 * at all (two shifts of a signed value, XSHA1_Transform 005206b0); the instruction can. The
 * rotate-sites facts (reconstruct extract/rotate-sites.ts) list, per line, each ROL/ROR of a
 * 32-bit register by an immediate. A pair on a line is rewritten when that line's facts hold
 * the rotate the pair spells with a count above 16:
 *
 *     x << n | x >> (32 - n)    ROL n, n > 16          ->  _rotl(x, n)
 *     x << n | x >> (32 - n)    ROR (32 - n) > 16      ->  _rotr(x, 32 - n)
 *
 * either operand order, both shifts by integer literals summing to 32, the same x on both
 * sides (structurally, with no call, assignment or increment in it), no cast on either x. A
 * count of 16 or less is left alone: VC8 compiles the pair to that instruction already.
 *
 * Value-preserving for a 32-bit unsigned x, which is the only operand a 32-bit rotate the
 * original performed can have: `x << n | x >> (32 - n)` is the rotate by n, and `_rotl` is
 * declared `unsigned int _rotl(unsigned int, int)` by <stdlib.h> in both builds (an intrinsic
 * under VC8's /O2). The facts tie the rewrite to the line, so a line without the rotate keeps
 * its shifts.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, BinaryExpr, Expression, IntegerLiteralExpr, ParenExpr,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, cloneNode, type Transformer } from '../../transformer.js';
import { Expr } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { placed } from './access-order-evidence.js';

/** One rotate the original's instruction performs: ROL (left) or ROR by `count`. */
export interface RotateFact {
  left: boolean;
  count: number;
}

export interface RotateIntrinsicOptions extends PluginOptions {
  /** Parsed-text line -> the rotates its instructions perform. Absent: nothing changes. */
  rotates?: ReadonlyMap<number, readonly RotateFact[]>;
  onSite?: (e: { line: number; spelling: string }) => void;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function literal(e: Expression): IntegerLiteralExpr | null {
  const x = unwrap(e);
  return x.kind === NodeKind.IntegerLiteral ? x as IntegerLiteralExpr : null;
}

/** x reads only: no call, assignment, increment, cast or comma anywhere in it. */
function pureOperand(e: Expression): boolean {
  for (const n of traverseAST(e)) {
    switch (n.kind) {
      case NodeKind.CallExpr: case NodeKind.AssignExpr: case NodeKind.PostfixExpr:
      case NodeKind.CStyleCastExpr: case NodeKind.CommaExpr:
        return false;
      case NodeKind.UnaryExpr: {
        const op = (n as unknown as { operator: string }).operator;
        if (op === '++' || op === '--') return false;
        break;
      }
      default:
        break;
    }
  }
  return true;
}

interface Pair { x: Expression; left: IntegerLiteralExpr; right: IntegerLiteralExpr }

/** `x << n | x >> m` with n + m == 32, either order; the operand and both counts. */
function shiftPair(b: BinaryExpr): Pair | null {
  if (b.operator !== '|') return null;
  const l = unwrap(b.left), r = unwrap(b.right);
  if (l.kind !== NodeKind.BinaryExpr || r.kind !== NodeKind.BinaryExpr) return null;
  let shl = l as BinaryExpr, shr = r as BinaryExpr;
  if (shl.operator === '>>' && shr.operator === '<<') [shl, shr] = [shr, shl];
  if (shl.operator !== '<<' || shr.operator !== '>>') return null;
  const n = literal(shl.right), m = literal(shr.right);
  if (!n || !m || n.value <= 0n || m.value <= 0n || n.value + m.value !== 32n) return null;
  if (!pureOperand(shl.left) || !pureOperand(shr.left)) return null;
  if (emit(unwrap(shl.left)) !== emit(unwrap(shr.left))) return null;
  return { x: unwrap(shl.left), left: n, right: m };
}

export const rotateIntrinsicPlugin: TransformPlugin = {
  id: 'rotate-intrinsic',
  name: 'Rotate Intrinsic',
  description: 'A shift pair the original performs as a rotate by more than 16 is written as _rotl/_rotr',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 59.65,
  tags: ['matching'],
  createTransformer: (options: RotateIntrinsicOptions = {}): Transformer => {
    const rotates = options.rotates;
    return createTransformer({
      visitNode(node: ASTNode): ASTNode | undefined {
        if (!rotates || node.kind !== NodeKind.BinaryExpr || !placed(node)) return undefined;
        const facts = rotates.get(node.location.start.line);
        if (!facts || facts.length === 0) return undefined;
        const pair = shiftPair(node as BinaryExpr);
        if (!pair) return undefined;
        const n = Number(pair.left.value);
        let name: string, count: IntegerLiteralExpr;
        if (n > 16 && facts.some(f => f.left && f.count === n)) { name = '_rotl'; count = pair.left; }
        else if (32 - n > 16 && facts.some(f => !f.left && f.count === 32 - n)) { name = '_rotr'; count = pair.right; }
        else return undefined;
        const call = Expr.call(name, [cloneNode(pair.x), cloneNode(count)]);
        call.location = node.location;
        options.onSite?.({ line: node.location.start.line, spelling: name });
        return call;
      },
    });
  },
};
