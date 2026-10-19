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
 * M === 3 has no C type and must touch exactly three bytes. A 4-byte access was
 * used here once, and as a STORE it wrote the byte after the field: the D2GS packet
 * senders build `aPacketFrame._0_3_ = ...` and `uStack_14._1_3_ = ...`, where that
 * fourth byte is the next packet byte or the neighbouring local. So:
 *
 *   x._1_3_ = v      →  d2_store24((char *)&x + 1, v)
 *   x._1_3_ |= v     →  d2_store24((char *)&x + 1, d2_load24((char *)&x + 1) | v)
 *   ... x._1_3_ ...  →  d2_load24((char *)&x + 1)
 *
 * (helpers in artifact-support.ts). A cast of `v` to a 3-byte Ghidra type is dropped
 * on a store: the store keeps the low three bytes, which is all the cast meant, and
 * `undefined3` is a 1-byte typedef that would otherwise lose two of them. A 3-byte
 * member in any other position (an increment, an address-of) keeps the old 4-byte
 * lvalue. For any other M we leave the node unchanged rather than guess.
 *
 * The XMM/register subfield form (e.g. `in_XMM0._0_8_`) also matches this pattern
 * and the same rewrite is valid for it, so it is intentionally not special-cased.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  AssignExpr,
  CallExpr,
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
import { createKindTransformer, createTransformer, sequence, type Transformer } from '../../transformer.js';
import { Expr } from '../../../ast/factory.js';
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
    // 3-byte SUBPIECE: the 4-byte lvalue is the fallback for positions that are
    // neither a load nor a store (see the header); loads and stores use the helpers.
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

/** `_<offset>_<size>_` of a member access, or null. */
function subpieceOf(node: ASTNode): { offset: number; size: number; member: MemberExpr } | null {
  if (node.kind !== NodeKind.MemberExpr) return null;
  const member = node as MemberExpr;
  if (member.member.kind !== NodeKind.Identifier) return null;
  const m = SUBPIECE_RE.exec((member.member as Identifier).name);
  return m ? { offset: Number(m[1]), size: Number(m[2]), member } : null;
}

/** `(char *)base + offset`, the address of the piece, with base = p or &v. */
function pieceAddress(member: MemberExpr, offset: number): Expression {
  const objParen = makeParen(member.object, member);
  const base: Expression = member.isArrow ? objParen : makeUnary('&', objParen, member);
  const charCast = makeCast('char', base, member);
  return offset === 0 ? charCast : makeBinary('+', charCast, makeIntLiteral(offset, member), member);
}

/** Ghidra's 3-byte integer types. A cast to one is a truncation to 24 bits. */
const THREE_BYTE_TYPES = new Set(['undefined3', 'int3', 'uint3']);

function stripThreeByteCast(e: Expression): Expression {
  let x: Expression = e;
  while (x.kind === NodeKind.ParenExpr) x = (x as ParenExpr).expression;
  if (x.kind !== NodeKind.CStyleCastExpr) return e;
  const t = (x as CStyleCastExpr).type as { kind: NodeKind; name?: { name?: string } | string };
  const name = typeof t.name === 'string' ? t.name : t.name?.name;
  return (t.kind === NodeKind.TypedefType || t.kind === NodeKind.BuiltinType) && name && THREE_BYTE_TYPES.has(name)
    ? (x as CStyleCastExpr).expression
    : e;
}

/** An expression that can be evaluated twice with the same result and no effect. */
function isPure(e: ASTNode): boolean {
  switch (e.kind) {
    case NodeKind.Identifier:
    case NodeKind.QualifiedId:
    case NodeKind.IntegerLiteral:
    case NodeKind.ThisExpr:
      return true;
    case NodeKind.ParenExpr:
      return isPure((e as ParenExpr).expression);
    case NodeKind.CStyleCastExpr:
      return isPure((e as CStyleCastExpr).expression);
    case NodeKind.MemberExpr:
      return isPure((e as MemberExpr).object);
    case NodeKind.UnaryExpr: {
      const u = e as UnaryExpr;
      return (u.operator === '*' || u.operator === '&') && isPure(u.operand);
    }
    default:
      return false;
  }
}

const call = (name: string, args: Expression[], template: ASTNode): CallExpr =>
  ({ ...Expr.call(name, args), location: template.location, leadingTrivia: [], trailingTrivia: [] }) as CallExpr;

/** A store to a 3-byte piece, written as exactly three bytes. */
function createThreeByteStoreTransformer(): Transformer {
  return createKindTransformer(NodeKind.AssignExpr, (node) => {
    const assign = node as AssignExpr;
    const piece = subpieceOf(assign.left);
    if (!piece || piece.size !== 3) return undefined;
    const addr = pieceAddress(piece.member, piece.offset);
    let value: Expression;
    if (assign.operator === '=') {
      value = stripThreeByteCast(assign.right);
    } else {
      // Read-modify-write names the piece twice, so its object must be pure.
      if (!isPure(piece.member.object)) return undefined;
      const op = assign.operator.slice(0, -1);
      value = makeBinary(op, call('d2_load24', [pieceAddress(piece.member, piece.offset)], assign),
        makeParen(assign.right, assign), assign);
    }
    return {
      ...call('d2_store24', [addr, value], assign),
      leadingTrivia: assign.leadingTrivia,
      trailingTrivia: assign.trailingTrivia,
    } as CallExpr;
  });
}

function createSubpieceReadTransformer(): Transformer {
  // A read of a 3-byte piece is any position that is not the target of a store, and the
  // store pass has already removed those. Increments and address-of need an lvalue, which
  // only the parent can tell: the traversal is bottom-up, so the parent swaps the load it
  // finds as its operand back for the 4-byte lvalue it was made from.
  const lvalueOf = new WeakMap<ASTNode, Expression>();
  return createTransformer({
    visitNode(node: ASTNode): ASTNode | undefined {
      if (node.kind === NodeKind.UnaryExpr || node.kind === NodeKind.PostfixExpr) {
        const u = node as UnaryExpr;
        const lv = lvalueOf.get(u.operand);
        if (lv && (node.kind === NodeKind.PostfixExpr || ['&', '++', '--'].includes(u.operator))) {
          return { ...u, operand: lv } as UnaryExpr;
        }
        return undefined;
      }
      const piece = subpieceOf(node);
      if (!piece) return undefined;
      const { offset, size, member } = piece;
      const typeName = accessTypeName(size);
      if (typeName === null) return undefined; // unsupported M — leave unchanged

      // *(<T> *)(<addr>), with the original node's trivia.
      const deref = {
        ...makeUnary('*', makeCast(typeName, pieceAddress(member, offset), member), member),
        leadingTrivia: member.leadingTrivia,
        trailingTrivia: member.trailingTrivia,
      } as UnaryExpr;
      if (size !== 3) return deref;

      const load = {
        ...call('d2_load24', [pieceAddress(member, offset)], member),
        leadingTrivia: member.leadingTrivia,
        trailingTrivia: member.trailingTrivia,
      } as CallExpr;
      lvalueOf.set(load, deref);
      return load;
    },
  });
}

function createSubpieceAccessTransformer(): Transformer {
  return sequence(createThreeByteStoreTransformer(), createSubpieceReadTransformer());
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
