/**
 * SUBPIECE Access Transform Plugin
 *
 * Ghidra's decompiler emits SUBPIECE member accesses of the form `expr._N_M_`
 * meaning "read M bytes starting at byte-offset N of expr". The member name
 * pattern is `_<N>_<M>_` where N (offset) and M (size) are DECIMAL.
 *
 * These names are not real struct members, so the emitted C++ fails to compile
 * ("X has no member named '_16_4_'"). This rewrites them into a valid C++
 * byte-range read that is an lvalue (works for both reads and assignments):
 *
 *   p->_16_4_   →  *(uint32_t *)((char *)(p) + 16)     (arrow: object is a pointer)
 *   v._4_2_     →  *(uint16_t *)((char *)&(v) + 4)     (dot: object is a value)
 *
 * The byte-size M selects the access type:
 *   1 → uint8_t, 2 → uint16_t, 4 → uint32_t, 8 → uint64_t.
 * For M === 3 we use uint32_t (a 4-byte access). The extra 1-byte over-read is
 * acceptable here: these are decompiler-emitted scalar reads, and a 3-byte field
 * is invariably padded to 4 in the surrounding struct, so reading the 4th byte is
 * harmless. For any other M we leave the node unchanged rather than guess.
 *
 * The XMM/register subfield form (e.g. `in_XMM0._0_8_`) also matches this pattern
 * and the same rewrite is valid for it, so it is intentionally not special-cased.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  Identifier,
  UnaryExpr,
  BinaryExpr,
  MemberExpr,
  ParenExpr,
  CStyleCastExpr,
  IntegerLiteralExpr,
  PointerType,
  BuiltinType,
} from '../../../ast/nodes.js';
import { createKindTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createPlugin } from '../registry.js';

// ============================================
// HELPERS
// ============================================

/** Matches a SUBPIECE member name `_<offset>_<size>_` (both decimal). */
const SUBPIECE_RE = /^_(\d+)_(\d+)_$/;

/** Map a SUBPIECE byte-size M to the C scalar type used for the access. */
function accessTypeName(size: number): string | null {
  switch (size) {
    case 1:
      return 'uint8_t';
    case 2:
      return 'uint16_t';
    // 3-byte SUBPIECE: access 4 bytes (1-byte over-read is acceptable, see header).
    case 3:
      return 'uint32_t';
    case 4:
      return 'uint32_t';
    case 8:
      return 'uint64_t';
    default:
      return null;
  }
}

function makeBuiltinType(name: string, template: ASTNode): BuiltinType {
  return {
    kind: NodeKind.BuiltinType,
    name,
    modifiers: [],
    location: template.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as BuiltinType;
}

function makePointerType(pointee: BuiltinType, template: ASTNode): PointerType {
  return {
    kind: NodeKind.PointerType,
    pointee,
    qualifiers: [],
    location: template.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as PointerType;
}

function makeCast(typeName: string, expr: Expression, template: ASTNode): CStyleCastExpr {
  return {
    kind: NodeKind.CStyleCastExpr,
    type: makePointerType(makeBuiltinType(typeName, template), template),
    expression: expr,
    location: template.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as CStyleCastExpr;
}

function makeParen(expr: Expression, template: ASTNode): ParenExpr {
  return {
    kind: NodeKind.ParenExpr,
    expression: expr,
    location: template.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as ParenExpr;
}

function makeUnary(operator: string, operand: Expression, template: ASTNode): UnaryExpr {
  return {
    kind: NodeKind.UnaryExpr,
    operator,
    operand,
    location: template.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as UnaryExpr;
}

function makeIntLiteral(value: number, template: ASTNode): IntegerLiteralExpr {
  return {
    kind: NodeKind.IntegerLiteral,
    value: BigInt(value),
    raw: String(value),
    location: template.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as IntegerLiteralExpr;
}

function makeBinary(
  operator: string,
  left: Expression,
  right: Expression,
  template: ASTNode,
): BinaryExpr {
  return {
    kind: NodeKind.BinaryExpr,
    operator,
    left,
    right,
    location: template.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as BinaryExpr;
}

// ============================================
// TRANSFORMER
// ============================================

function createSubpieceAccessTransformer(): Transformer {
  return createKindTransformer(NodeKind.MemberExpr, (node) => {
    const member = node as MemberExpr;

    // Member name must be a plain identifier matching `_N_M_`.
    if (member.member.kind !== NodeKind.Identifier) return undefined;
    const name = (member.member as Identifier).name;
    const m = SUBPIECE_RE.exec(name);
    if (!m) return undefined;

    const offset = Number(m[1]);
    const size = Number(m[2]);
    const typeName = accessTypeName(size);
    if (typeName === null) return undefined; // unsupported M — leave unchanged

    // base = object for arrow (pointer), &(object) for dot (value).
    const objParen = makeParen(member.object, member);
    const base: Expression = member.isArrow
      ? objParen
      : makeUnary('&', objParen, member);

    // (char *)base
    const charCast = makeCast('char', base, member);

    // (char *)base + offset   (omit "+ 0" when offset === 0)
    const addr: Expression =
      offset === 0 ? charCast : makeBinary('+', charCast, makeIntLiteral(offset, member), member);

    // *(<T> *)(<addr>)
    const typedCast = makeCast(typeName, addr, member);
    const deref = makeUnary('*', typedCast, member);

    // Preserve the original node's trivia on the produced expression.
    return {
      ...deref,
      leadingTrivia: member.leadingTrivia,
      trailingTrivia: member.trailingTrivia,
    } as UnaryExpr;
  });
}

// ============================================
// PLUGIN
// ============================================

export const subpieceAccessPlugin: TransformPlugin = createPlugin(
  'subpiece-access',
  'SUBPIECE Access',
  "Rewrites Ghidra SUBPIECE member accesses (expr._N_M_) into valid C++ byte-range reads *(T *)((char *)expr + N)",
  () => createSubpieceAccessTransformer(),
  {
    priority: 46, // just after bitfield-access (45); both rewrite MemberExpr accesses
    defaultEnabled: true,
    tags: ['cleanup', 'ghidra'],
    version: '1.0.0',
  },
);
