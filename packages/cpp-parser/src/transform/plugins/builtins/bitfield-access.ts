/**
 * Bitfield Access Transform Plugin
 *
 * Reverses compiler bitfield-to-mask transformations, restoring named bitfield
 * member accesses from Ghidra's byte-level mask operations.
 *
 * Transforms:
 * - expr->field_0xD & 2        →  expr->interact        (read test)
 * - expr->field_0xD |= 2       →  expr->interact = 1    (set bit)
 * - expr->field_0xD &= ~2      →  expr->interact = 0    (clear bit / complement assign)
 * - expr->field_0xD & ~2       →  (unchanged, multi-bit mask)
 *
 * Requires a bitfield catalog passed via plugin options mapping
 * (fieldName, mask) → bitfieldName.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  AssignExpr,
  BinaryExpr,
  Expression,
  Identifier,
  IntegerLiteralExpr,
  MemberExpr,
  UnaryExpr,
} from '../../../ast/nodes.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

// ============================================
// TYPES
// ============================================

export interface BitfieldEntry {
  fieldName: string;
  mask: number;
  bitfieldName: string;
}

/** Map key: "field_0xNN:mask" → bitfield name */
export type BitfieldCatalog = Map<string, string>;

export interface BitfieldAccessOptions extends PluginOptions {
  /** Catalog mapping "field_0xNN:mask" → bitfield member name */
  bitfieldCatalog?: BitfieldCatalog;
}

// ============================================
// HELPERS
// ============================================

/** Check if a number is a power of 2 (single-bit mask) */
function isPowerOf2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/** Unwrap parenthesized expressions */
function unwrapParens(node: Expression): Expression {
  while (node.kind === NodeKind.ParenExpr) {
    node = (node as any).expression;
  }
  return node;
}

/** Unwrap C-style casts to get the inner expression */
function unwrapCasts(node: Expression): Expression {
  let expr = unwrapParens(node);
  while (expr.kind === NodeKind.CStyleCastExpr) {
    expr = unwrapParens((expr as any).expression);
  }
  return expr;
}

/** Extract integer value from a literal node, unwrapping casts like (byte)2 */
function getIntValue(node: ASTNode): number | null {
  const unwrapped = unwrapCasts(node as Expression);
  if (unwrapped.kind !== NodeKind.IntegerLiteral) return null;
  const lit = unwrapped as IntegerLiteralExpr;
  if (typeof lit.value === 'bigint') {
    if (lit.value > 0xFFFFFFFFn || lit.value < 0n) return null;
    return Number(lit.value);
  }
  return typeof lit.value === 'number' ? lit.value : null;
}

/** Check if node is a MemberExpr accessing field_0xNN */
function getFieldMember(node: Expression): MemberExpr | null {
  const expr = unwrapParens(node);
  if (expr.kind !== NodeKind.MemberExpr) return null;
  const member = expr as MemberExpr;
  const memberName = (member.member as Identifier).name;
  if (!memberName || !memberName.startsWith('field_0x')) return null;
  return member;
}

/** Build a catalog lookup key */
function catalogKey(fieldName: string, mask: number): string {
  return `${fieldName}:${mask}`;
}

/** Create a MemberExpr with a different member name, preserving trivia and location */
function replaceMember(original: MemberExpr, newName: string): MemberExpr {
  return {
    ...original,
    member: {
      ...(original.member as Identifier),
      name: newName,
    },
  };
}

/** Create an integer literal node */
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

// ============================================
// TRANSFORMER
// ============================================

function createBitfieldAccessTransformer(options: BitfieldAccessOptions = {}): Transformer {
  const catalog = options.bitfieldCatalog;
  if (!catalog || catalog.size === 0) {
    return createTransformer({});
  }

  return createTransformer({
    visitNode(node: ASTNode): ASTNode | undefined {
      // Pattern 1: Read test — `expr->field_0xNN & MASK`
      if (node.kind === NodeKind.BinaryExpr) {
        const bin = node as BinaryExpr;
        if (bin.operator === '&') {
          return tryReadTest(bin, catalog);
        }
      }

      // Pattern 2: Set bit — `expr->field_0xNN |= MASK`
      // Pattern 3: Clear bit — `expr->field_0xNN &= ~MASK`
      if (node.kind === NodeKind.AssignExpr) {
        const assign = node as AssignExpr;
        if (assign.operator === '|=') {
          return trySetBit(assign, catalog);
        }
        if (assign.operator === '&=') {
          return tryClearBit(assign, catalog);
        }
      }

      return undefined;
    },
  });
}

/** Pattern: expr->field_0xNN & MASK  →  expr->bitfieldName */
function tryReadTest(bin: BinaryExpr, catalog: BitfieldCatalog): ASTNode | undefined {
  // Try field on left, mask on right
  const member = getFieldMember(bin.left) ?? getFieldMember(bin.right);
  const maskNode = getFieldMember(bin.left) ? bin.right : bin.left;

  if (!member) return undefined;

  const mask = getIntValue(unwrapParens(maskNode));
  if (mask === null || !isPowerOf2(mask)) return undefined;

  const fieldName = ((member.member) as Identifier).name;
  const bitfieldName = catalog.get(catalogKey(fieldName, mask));
  if (!bitfieldName) return undefined;

  return replaceMember(member, bitfieldName);
}

/** Pattern: expr->field_0xNN |= MASK  →  expr->bitfieldName = 1 */
function trySetBit(assign: AssignExpr, catalog: BitfieldCatalog): ASTNode | undefined {
  const member = getFieldMember(assign.left);
  if (!member) return undefined;

  const mask = getIntValue(unwrapParens(assign.right));
  if (mask === null || !isPowerOf2(mask)) return undefined;

  const fieldName = ((member.member) as Identifier).name;
  const bitfieldName = catalog.get(catalogKey(fieldName, mask));
  if (!bitfieldName) return undefined;

  // Replace with: expr->bitfieldName = 1
  const newAssign: AssignExpr = {
    ...assign,
    operator: '=',
    left: replaceMember(member, bitfieldName),
    right: makeIntLiteral(1, assign.right),
  };
  return newAssign;
}

/** Pattern: expr->field_0xNN &= ~MASK  →  expr->bitfieldName = 0 */
function tryClearBit(assign: AssignExpr, catalog: BitfieldCatalog): ASTNode | undefined {
  const member = getFieldMember(assign.left);
  if (!member) return undefined;

  // RHS should be ~MASK (UnaryExpr with '~' operator)
  const rhs = unwrapParens(assign.right);
  if (rhs.kind !== NodeKind.UnaryExpr) return undefined;
  const unary = rhs as UnaryExpr;
  if (unary.operator !== '~') return undefined;

  const mask = getIntValue(unwrapParens(unary.operand));
  if (mask === null || !isPowerOf2(mask)) return undefined;

  const fieldName = ((member.member) as Identifier).name;
  const bitfieldName = catalog.get(catalogKey(fieldName, mask));
  if (!bitfieldName) return undefined;

  // Replace with: expr->bitfieldName = 0
  const newAssign: AssignExpr = {
    ...assign,
    operator: '=',
    left: replaceMember(member, bitfieldName),
    right: makeIntLiteral(0, assign.right),
  };
  return newAssign;
}

// ============================================
// PLUGIN
// ============================================

import { createPlugin } from '../registry.js';

export const bitfieldAccessPlugin: TransformPlugin = createPlugin(
  'bitfield-access',
  'Bitfield Access',
  'Restores named bitfield member accesses from compiler mask operations (field_0xNN & MASK → bitfieldName)',
  (options?: PluginOptions) => createBitfieldAccessTransformer(options as BitfieldAccessOptions),
  {
    priority: 45,
    defaultEnabled: true,
    tags: ['cleanup', 'ghidra'],
    version: '1.0.0',
  }
);
