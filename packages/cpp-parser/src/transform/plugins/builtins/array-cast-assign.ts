/**
 * Array-Cast Assignment Transform Plugin
 *
 * When a stack slot is modelled as an array but the machine code stores a whole
 * register into it, Ghidra emits a cast to an ARRAY type on the right of an
 * assignment:
 *
 *   aPacketFrame = (byte[4])dwLadderReq;
 *
 * meaning "reinterpret the 4 bytes of dwLadderReq as byte[4] and store them into
 * aPacketFrame". That is not valid C++ — an array is not assignable and an array
 * type is not a valid cast target — so the emitted translation unit fails to
 * compile. It is rewritten into the scalar store the machine code actually does:
 *
 *   aPacketFrame = (byte[4])dwLadderReq;   →  *(uint32_t *)(aPacketFrame) = dwLadderReq;
 *
 * The rewrite is exact on little-endian x86, which is the only target here.
 *
 * The shape appears whenever a narrow store shares a slot with a register spill,
 * because modelling that slot as an array is what stops the decompiler from
 * eliminating the store as a partial overwrite of a dead wider value. So this
 * plugin is the other half of that correction: without it, fixing the dropped
 * store in Ghidra trades a silent wrong value for a broken build.
 *
 * Only total widths of 1, 2, 4 and 8 bytes are rewritten. Anything else is left
 * unchanged rather than guessed at — a wrong width here would be a silent
 * corruption, which is strictly worse than a compile error that names the line.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  Identifier,
  AssignExpr,
  UnaryExpr,
  ParenExpr,
  CStyleCastExpr,
  ArrayType,
  BuiltinType,
  PointerType,
} from '../../../ast/nodes.js';
import { createKindTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin } from '../types.js';
import { createPlugin } from '../registry.js';

// ============================================
// HELPERS
// ============================================

/**
 * Byte width of an element type, by name. Only the spellings Ghidra actually
 * produces for a byte-granular stack slot are listed; an unknown name returns
 * null and the node is left alone.
 */
const ELEMENT_WIDTH: Readonly<Record<string, number>> = {
  byte: 1,
  char: 1,
  uchar: 1,
  int8_t: 1,
  uint8_t: 1,
  undefined1: 1,
  short: 2,
  ushort: 2,
  int16_t: 2,
  uint16_t: 2,
  undefined2: 2,
  int: 4,
  uint: 4,
  int32_t: 4,
  uint32_t: 4,
  undefined4: 4,
};

/** The C scalar used to perform a store of `size` bytes. */
function storeTypeName(size: number): string | null {
  switch (size) {
    case 1:
      return 'uint8_t';
    case 2:
      return 'uint16_t';
    case 4:
      return 'uint32_t';
    case 8:
      return 'uint64_t';
    default:
      return null;
  }
}

/** Resolve a type node to a simple name, if it has one. */
function typeName(t: ASTNode | null | undefined): string | null {
  if (!t) return null;
  const anyT = t as { kind: NodeKind; name?: Identifier | string };
  if (anyT.kind !== NodeKind.BuiltinType && anyT.kind !== NodeKind.TypedefType) return null;
  const n = anyT.name;
  if (!n) return null;
  return typeof n === 'string' ? n : n.name;
}

/** Constant array length, or null when it is not a plain integer literal. */
function arrayLength(t: ArrayType): number | null {
  const size = t.size as unknown as { kind?: NodeKind; value?: unknown } | null;
  if (!size || size.kind !== NodeKind.IntegerLiteral) return null;
  const n = Number(size.value as string | number | bigint);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function makeBuiltinType(name: string, template: ASTNode): BuiltinType {
  return {
    kind: NodeKind.BuiltinType,
    name,
    modifiers: [],
    location: template.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as unknown as BuiltinType;
}

function makePointerTo(name: string, template: ASTNode): PointerType {
  return {
    kind: NodeKind.PointerType,
    pointee: makeBuiltinType(name, template),
    qualifiers: [],
    location: template.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as unknown as PointerType;
}

function makeParen(inner: Expression, template: ASTNode): ParenExpr {
  return {
    kind: NodeKind.ParenExpr,
    expression: inner,
    location: template.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as unknown as ParenExpr;
}

function makeCastTo(name: string, inner: Expression, template: ASTNode): CStyleCastExpr {
  return {
    kind: NodeKind.CStyleCastExpr,
    type: makePointerTo(name, template),
    expression: inner,
    location: template.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as unknown as CStyleCastExpr;
}

function makeDeref(inner: Expression, template: ASTNode): UnaryExpr {
  return {
    kind: NodeKind.UnaryExpr,
    operator: '*',
    operand: inner,
    isPrefix: true,
    location: template.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as unknown as UnaryExpr;
}

// ============================================
// TRANSFORMER
// ============================================

function createArrayCastAssignTransformer(): Transformer {
  return createKindTransformer(NodeKind.AssignExpr, (node) => {
    const assign = node as AssignExpr;
    if (assign.operator !== '=') return undefined;

    const rhs = assign.right as ASTNode;
    if (rhs.kind !== NodeKind.CStyleCastExpr) return undefined;

    const cast = rhs as CStyleCastExpr;
    const castType = cast.type as unknown as ASTNode;
    if (castType.kind !== NodeKind.ArrayType) return undefined;

    const arr = castType as ArrayType;
    const len = arrayLength(arr);
    if (len === null) return undefined;

    const elemName = typeName(arr.elementType as unknown as ASTNode);
    if (elemName === null) return undefined;
    const elemWidth = ELEMENT_WIDTH[elemName];
    if (elemWidth === undefined) return undefined;

    const storeType = storeTypeName(len * elemWidth);
    if (storeType === null) return undefined; // unsupported width — leave unchanged

    // *(<T> *)(<lhs>) = <rhs-without-the-array-cast>
    const dest = makeDeref(makeCastTo(storeType, makeParen(assign.left, assign), assign), assign);

    return {
      ...assign,
      left: dest,
      right: cast.expression,
    } as AssignExpr;
  });
}

// ============================================
// PLUGIN
// ============================================

export const arrayCastAssignPlugin: TransformPlugin = createPlugin(
  'array-cast-assign',
  'Array-Cast Assignment',
  'Rewrites Ghidra whole-array stores (a = (byte[4])x) into the scalar store they represent',
  () => createArrayCastAssignTransformer(),
  {
    // MUST run before array-cast-strip (17). That pass drops an array-type cast
    // outright, which is exact for the scalar contexts it was written for
    // (comparison, bitwise-or) but not for this one: dropping it here leaves
    // `a = x` with `a` an array, which is still ill-formed, and the width the
    // store needs is gone with the cast.
    priority: 16,
    defaultEnabled: true,
    tags: ['cleanup', 'ghidra'],
    version: '1.0.0',
  },
);
