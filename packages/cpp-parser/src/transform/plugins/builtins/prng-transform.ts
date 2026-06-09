/**
 * PRNG Pattern Transform Plugin
 *
 * Detects Diablo 2 Linear Congruential Generator (LCG) patterns and replaces
 * them with D2_SEED_NEXT(seed) / D2_SEED_NEXT_VAL(val) macro calls.
 *
 * Matches pattern:
 *   (D2SeedStrc)(... * 0x6ac690c5 + ...)
 *
 * Replacement forms:
 *   D2_SEED_NEXT(obj->sSeed)     — when nSeedLow/nSeedHigh member accesses found
 *   D2_SEED_NEXT(*this)          — when this->nSeedLow accessed
 *   D2_SEED_NEXT(*pSeed)         — when pSeed->nSeedLow (direct pointer to seed)
 *   D2_SEED_NEXT_VAL(DVar1)      — when operand is (val & -1) * mult + (val >> 32)
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  BinaryExpr,
  CallExpr,
  CStyleCastExpr,
  Expression,
  Identifier,
  IntegerLiteralExpr,
  MemberExpr,
  UnaryExpr,
} from '../../../ast/nodes.js';
import { TriviaKind } from '../../../lexer/trivia.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

// ============================================
// CONSTANTS
// ============================================

const D2_LCG_MULTIPLIER = 0x6ac690c5n;

// ============================================
// AST HELPERS
// ============================================

/** Unwrap parenthesized expressions */
function unwrapParens(node: Expression): Expression {
  while (node.kind === NodeKind.ParenExpr) {
    node = (node as any).expression;
  }
  return node;
}

/** Unwrap C-style casts (e.g. (uint64_t)(uint32_t)expr → expr) */
function unwrapCasts(node: Expression): Expression {
  let expr = unwrapParens(node);
  while (expr.kind === NodeKind.CStyleCastExpr) {
    expr = unwrapParens((expr as CStyleCastExpr).expression);
  }
  return expr;
}

/** Check if a node is an integer literal with a specific value */
function isLiteral(node: ASTNode, value: bigint): boolean {
  if (node.kind !== NodeKind.IntegerLiteral) return false;
  return (node as IntegerLiteralExpr).value === value;
}

/** Check if a BinaryExpr(*) has 0x6ac690c5 on either side */
function isLcgMultiplication(node: Expression): boolean {
  const expr = unwrapParens(node);
  if (expr.kind !== NodeKind.BinaryExpr) return false;
  const bin = expr as BinaryExpr;
  if (bin.operator !== '*') return false;
  return isLiteral(unwrapCasts(bin.left), D2_LCG_MULTIPLIER) ||
    isLiteral(unwrapCasts(bin.right), D2_LCG_MULTIPLIER);
}

/**
 * Check if a BinaryExpr(+) contains an LCG multiplication on either side.
 * Returns the addition node if matched.
 */
function findLcgAddition(node: Expression): BinaryExpr | null {
  const expr = unwrapParens(node);
  if (expr.kind !== NodeKind.BinaryExpr) return null;
  const bin = expr as BinaryExpr;
  if (bin.operator !== '+') return null;
  if (isLcgMultiplication(bin.left) || isLcgMultiplication(bin.right)) {
    return bin;
  }
  return null;
}

/**
 * Recursively find all MemberExpr nodes with a given member name.
 */
function findMemberAccess(node: ASTNode, memberName: string): MemberExpr | null {
  if (node.kind === NodeKind.MemberExpr) {
    const m = node as MemberExpr;
    if (m.member.kind === NodeKind.Identifier && (m.member as Identifier).name === memberName) {
      return m;
    }
  }
  // Recurse into children
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === 'object' && 'kind' in item) {
            const result = findMemberAccess(item as ASTNode, memberName);
            if (result) return result;
          }
        }
      } else if ('kind' in value) {
        const result = findMemberAccess(value as ASTNode, memberName);
        if (result) return result;
      }
    }
  }
  return null;
}

/**
 * Check if expression is the "value form": (val & -1) * mult + (val >> 32)
 * Returns the identifier if matched.
 */
function matchValueForm(addition: BinaryExpr): Identifier | null {
  // Look for (X & -1) pattern on the multiplication side
  const mulSide = isLcgMultiplication(addition.left) ? addition.left : addition.right;
  const mulExpr = unwrapParens(mulSide);
  if (mulExpr.kind !== NodeKind.BinaryExpr) return null;
  const mul = mulExpr as BinaryExpr;

  // One side is the multiplier, the other should be (X & -1) or a cast of it
  const otherSide = isLiteral(unwrapCasts(mul.left), D2_LCG_MULTIPLIER)
    ? unwrapCasts(mul.right) : unwrapCasts(mul.left);

  // Check for (X & -1) pattern
  if (otherSide.kind === NodeKind.BinaryExpr) {
    const band = otherSide as BinaryExpr;
    if (band.operator === '&') {
      const rhs = unwrapCasts(band.right);
      // -1 appears as UnaryExpr('-', 1)
      if (rhs.kind === NodeKind.UnaryExpr) {
        const unary = rhs as UnaryExpr;
        if (unary.operator === '-' && isLiteral(unary.operand, 1n)) {
          const ident = unwrapCasts(band.left);
          if (ident.kind === NodeKind.Identifier) return ident as Identifier;
        }
      }
    }
  }
  return null;
}

/**
 * Extract seed expression from a MemberExpr chain.
 * Given expr.nSeedLow or expr->nSeedLow, return the seed object expression.
 *
 * Cases:
 * - pUnit->sSeed.nSeedLow → pUnit->sSeed (the object is sSeed member)
 * - this->nSeedLow → *this (this IS the seed)
 * - pSeed->nSeedLow → *pSeed (pointer to seed)
 */
function extractSeedFromMember(memberAccess: MemberExpr): Expression {
  const obj = memberAccess.object;

  if (obj.kind === NodeKind.MemberExpr) {
    // e.g. pUnit->sSeed.nSeedLow — the object of the outer member is "pUnit->sSeed"
    return obj;
  }

  // Direct access like this->nSeedLow or pSeed->nSeedLow
  // Need to dereference since D2_SEED_NEXT takes a reference, not a pointer
  if (memberAccess.isArrow) {
    // pSeed->nSeedLow → *pSeed
    return {
      kind: NodeKind.UnaryExpr,
      operator: '*',
      operand: obj,
      location: obj.location,
      leadingTrivia: [],
      trailingTrivia: [],
    } as UnaryExpr;
  }

  // Dot access: someVal.nSeedLow → someVal
  return obj;
}

/**
 * Create a D2_SEED_NEXT(seedExpr) or D2_SEED_NEXT_VAL(val) call expression.
 */
function createMacroCall(
  macroName: string,
  arg: Expression,
  original: ASTNode,
): CallExpr {
  return {
    kind: NodeKind.CallExpr,
    callee: {
      kind: NodeKind.Identifier,
      name: macroName,
      location: original.location,
      leadingTrivia: [],
      trailingTrivia: [],
    } as Identifier,
    arguments: [arg],
    location: original.location,
    leadingTrivia: original.leadingTrivia || [],
    trailingTrivia: original.trailingTrivia || [],
  };
}

// ============================================
// TRANSFORMER
// ============================================

export interface PrngTransformOptions extends PluginOptions {
  /** Replace with macro call (default: true). When false, only adds comment. */
  replaceMacro?: boolean;
  /** Additional multipliers to detect (map of value -> name) */
  additionalMultipliers?: Map<bigint, string>;
}

function createPrngTransformer(options: PrngTransformOptions = {}): Transformer {
  const { replaceMacro = true } = options;

  return createTransformer({
    visitNode(node: ASTNode): ASTNode | undefined {
      // Match: (D2SeedStrc)(... * 0x6ac690c5 + ...)
      if (node.kind !== NodeKind.CStyleCastExpr) return undefined;

      const cast = node as CStyleCastExpr;

      // Check cast target is D2SeedStrc
      if (cast.type.kind !== NodeKind.TypedefType) return undefined;
      const typeName = (cast.type as any).name;
      const name = typeName?.name ?? typeName;
      if (name !== 'D2SeedStrc') return undefined;

      // Find the LCG addition pattern inside
      const addition = findLcgAddition(cast.expression);
      if (!addition) return undefined;

      if (!replaceMacro) {
        // Legacy mode: just add comment
        const existingComments = node.leadingTrivia || [];
        const hasAnnotation = existingComments.some(
          t => t.kind === TriviaKind.BlockComment && t.text?.includes('PRNG'),
        );
        if (hasAnnotation) return undefined;

        return {
          ...cast,
          leadingTrivia: [{
            kind: TriviaKind.BlockComment,
            text: '/* PRNG: Diablo 2 PRNG (LCG multiplier) */',
            location: { file: '<generated>', start: { line: 0, column: 0, offset: 0 }, end: { line: 0, column: 0, offset: 0 } },
          }, ...existingComments],
        };
      }

      // Try value form first: ((uint64_t)DVar1 & -1) * 0x6ac690c5 + ((uint64_t)DVar1 >> 0x20)
      const valIdent = matchValueForm(addition);
      if (valIdent) {
        return createMacroCall('D2_SEED_NEXT_VAL', valIdent, node);
      }

      // Try member access form: find nSeedLow access
      const seedLowAccess = findMemberAccess(addition, 'nSeedLow');
      if (seedLowAccess) {
        const seedExpr = extractSeedFromMember(seedLowAccess);
        return createMacroCall('D2_SEED_NEXT', seedExpr, node);
      }

      // Fallback: try nSeedHigh (when low was extracted to a local variable)
      const seedHighAccess = findMemberAccess(addition, 'nSeedHigh');
      if (seedHighAccess) {
        const seedExpr = extractSeedFromMember(seedHighAccess);
        return createMacroCall('D2_SEED_NEXT', seedExpr, node);
      }

      // Unrecognized variant — leave as-is
      return undefined;
    },
  });
}

// ============================================
// PLUGIN EXPORT
// ============================================

export const prngTransformPlugin: TransformPlugin = {
  id: 'prng-transform',
  name: 'PRNG Pattern Transform',
  description: 'Replaces D2 PRNG LCG expressions with D2_SEED_NEXT macro calls',
  version: '2.0.0',
  defaultEnabled: true,
  priority: 80,
  tags: ['game', 'patterns', 'diablo'],

  createTransformer: createPrngTransformer,
};
