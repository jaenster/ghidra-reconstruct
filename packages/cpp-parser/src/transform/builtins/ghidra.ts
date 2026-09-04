/**
 * Ghidra-Specific Transforms
 *
 * Transformations designed to clean up Ghidra decompiler output.
 */

import { NodeKind } from '../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  Identifier,
  FunctionDecl,
  VariableDecl,
  CallExpr,
  BinaryExpr,
  UnaryExpr,
  CStyleCastExpr,
  MemberExpr,
  SubscriptExpr,
  IntegerLiteralExpr,
} from '../../ast/nodes.js';
import {
  createTransformer,
  createKindTransformer,
  sequence,
  updateNode,
  type Transformer,
} from '../transformer.js';
import type { RenameMap } from './rename.js';

// ============================================
// GHIDRA NAMING PATTERNS
// ============================================

/**
 * Detect Ghidra-style auto-generated names
 */
export function isGhidraGeneratedName(name: string): boolean {
  // FUN_XXXXXXXX - auto-generated function name
  if (/^FUN_[0-9a-fA-F]{8,}$/.test(name)) return true;

  // DAT_XXXXXXXX - auto-generated data label
  if (/^DAT_[0-9a-fA-F]{8,}$/.test(name)) return true;

  // LAB_XXXXXXXX - auto-generated label
  if (/^LAB_[0-9a-fA-F]{8,}$/.test(name)) return true;

  // param_N or param_N_NN - auto-generated parameter name
  // Ghidra appends _00/_01 for duplicate names in mixed calling conventions
  if (/^param_\d+(_\d+)?$/.test(name)) return true;

  // local_N or local_Xh - auto-generated local variable
  if (/^local_[0-9a-fA-F]+h?$/.test(name)) return true;

  // uVar, iVar, etc. - decompiler temporaries
  if (/^[a-z]Var\d*$/.test(name)) return true;

  // puVar, piVar - pointer variants
  if (/^p[a-z]Var\d*$/.test(name)) return true;

  // bVar, cVar, sVar - byte/char/short vars
  if (/^[bcs]Var\d*$/.test(name)) return true;

  // __return_storage_ptr__ etc.
  if (name.startsWith('__') && name.endsWith('__')) return true;

  // in_stack_XXXXXXXX - register/stack parameter artifacts
  if (/^in_stack_[0-9a-fA-F]+$/.test(name)) return true;

  // in_EAX, in_ECX, in_EDX - register parameter artifacts
  if (/^in_E[A-Z]{1,2}$/.test(name)) return true;

  // unaff_ESI, unaff_EDI, unaff_EBX, unaff_EBP - callee-saved register artifacts
  if (/^unaff_E[A-Z]{1,2}$/.test(name)) return true;

  // extraout_EAX, extraout_ECX_00 etc. - extra output artifacts
  if (/^extraout_E[A-Z]{1,2}(?:_\d+)?$/.test(name)) return true;

  return false;
}

/**
 * Extract address from Ghidra-generated name
 */
export function extractAddressFromName(name: string): string | null {
  const match = name.match(/^(?:FUN|DAT|LAB)_([0-9a-fA-F]{8,})$/);
  if (match) {
    return '0x' + match[1];
  }
  return null;
}

/**
 * Generate a shorter name from Ghidra patterns, or null if no rename needed.
 *
 * All Ghidra names are kept as-is to preserve 1:1 correspondence with the
 * decompiler output. This makes cross-referencing with Ghidra trivial.
 */
export function suggestBetterName(_name: string, _context?: NameContext): string | null {
  return null;
}

export interface NameContext {
  parameterTypes?: string[];
  returnType?: string;
  calledFunctions?: string[];
}

// ============================================
// TRANSFORMS
// ============================================

/**
 * Rename Ghidra auto-generated names to more readable ones
 */
export function cleanGhidraNames(_context?: NameContext): Transformer {
  return createTransformer({
    visitIdentifier(node) {
      if (isGhidraGeneratedName(node.name)) {
        const better = suggestBetterName(node.name);
        if (better !== null) {
          return updateNode(node, { name: better });
        }
      }
      return undefined;
    },
  });
}

/**
 * Remove unnecessary casts that Ghidra adds
 * e.g., (int)x when x is already int
 */
export function removeRedundantCasts(): Transformer {
  return createKindTransformer(NodeKind.CStyleCastExpr, (node) => {
    const cast = node as CStyleCastExpr;

    // If casting an integer literal to int type, just return the literal
    if (cast.expression.kind === NodeKind.IntegerLiteral) {
      const type = cast.type;
      if (type.kind === NodeKind.BuiltinType) {
        const builtin = type as { name: string; modifiers?: readonly string[] };
        // A multi-word builtin arrives as a head plus modifiers, so `(short)`
        // and `(unsigned)` both present as head `int`. Dropping the cast then
        // drops a truncation or a signedness the machine really performed, so
        // only a cast with NO width/sign modifier is redundant here.
        const mods = (builtin.modifiers ?? []).filter(m => m !== 'const' && m !== 'volatile');
        if (mods.length === 0 && (builtin.name === 'int' || builtin.name === 'long')) {
          return cast.expression;
        }
      }
    }

    // If casting a pointer to the same pointer type, remove cast
    // (This is common in Ghidra output)

    return undefined;
  });
}

/**
 * Simplify Ghidra's pointer arithmetic patterns
 * e.g., *(int *)(ptr + 4) -> ptr[1] (if ptr is int*)
 */
export function simplifyPointerArithmetic(): Transformer {
  return createKindTransformer(NodeKind.UnaryExpr, (node) => {
    const unary = node as UnaryExpr;

    // Looking for *(cast)(ptr + offset)
    if (unary.operator !== '*') return undefined;

    // Check if operand is a cast
    if (unary.operand.kind !== NodeKind.CStyleCastExpr) return undefined;

    const cast = unary.operand as CStyleCastExpr;

    // Check if inside cast is binary add
    if (cast.expression.kind !== NodeKind.BinaryExpr) return undefined;

    const binary = cast.expression as BinaryExpr;
    if (binary.operator !== '+') return undefined;

    // Could transform to array access, but need type info
    // For now, just annotate that this is pointer math

    return undefined;
  });
}

/**
 * The expression positions where a value is read for its TRUTH and nothing else.
 *
 * These are the only places `x != 0` may be spelled `x`. Everywhere else the
 * comparison is a VALUE — an `int` that is 0 or 1 — and dropping it substitutes
 * `x` itself, which is a different number for every `x` outside {0, 1}.
 *
 * `truthyContext` walks down through the shapes that keep a position truthy:
 * parentheses carry it, `!` and the short-circuit operators read their operands
 * for truth too, so `!(a != 0)` and `(a != 0) && (b != 0)` are all inside one
 * condition. Anything else stops the descent.
 */
function truthyContext(expr: Expression, isNil: (e: Expression) => boolean): Expression {
  if (expr.kind === NodeKind.ParenExpr) {
    const paren = expr as unknown as { expression: Expression };
    const inner = truthyContext(paren.expression, isNil);
    return inner === paren.expression ? expr : { ...expr, expression: inner } as Expression;
  }

  if (expr.kind === NodeKind.UnaryExpr) {
    const unary = expr as UnaryExpr;
    if (unary.operator !== '!') return expr;
    const operand = truthyContext(unary.operand, isNil);
    return operand === unary.operand ? expr : { ...unary, operand };
  }

  if (expr.kind === NodeKind.BinaryExpr) {
    const binary = expr as BinaryExpr;
    if (binary.operator === '&&' || binary.operator === '||') {
      const left = truthyContext(binary.left, isNil);
      const right = truthyContext(binary.right, isNil);
      return left === binary.left && right === binary.right
        ? expr
        : { ...binary, left, right };
    }
    if (binary.operator !== '!=') return expr;
    const nilLeft = isNil(binary.left);
    const nilRight = isNil(binary.right);
    if (!nilLeft && !nilRight) return expr;
    const nonNil = nilLeft ? binary.right : binary.left;
    return {
      ...nonNil,
      leadingTrivia: binary.leadingTrivia,
      trailingTrivia: binary.trailingTrivia,
    } as Expression;
  }

  return expr;
}

/**
 * Rewrite the truthy positions a node owns, or `undefined` when nothing moved.
 *
 * The truthy positions are the conditions of the control-flow statements and
 * the ternary, and the operands of `!`, `&&` and `||`. A node kind not in that
 * set has none and is left alone; the caller handles the value-preserving
 * `== nil` direction separately, which needs no context at all.
 */
function rewriteTruthyPositions(
  node: ASTNode,
  isNil: (e: Expression) => boolean,
): ASTNode | undefined {
  switch (node.kind) {
    case NodeKind.IfStmt:
    case NodeKind.WhileStmt:
    case NodeKind.DoWhileStmt:
    case NodeKind.ForStmt:
    case NodeKind.ConditionalExpr: {
      const owner = node as unknown as { condition: Expression | null };
      if (!owner.condition) return undefined;
      const condition = truthyContext(owner.condition, isNil);
      return condition === owner.condition
        ? undefined
        : ({ ...node, condition } as unknown as ASTNode);
    }
    case NodeKind.UnaryExpr: {
      const unary = node as UnaryExpr;
      if (unary.operator !== '!') return undefined;
      const operand = truthyContext(unary.operand, isNil);
      return operand === unary.operand
        ? undefined
        : ({ ...unary, operand } as unknown as ASTNode);
    }
    case NodeKind.BinaryExpr: {
      const binary = node as BinaryExpr;
      if (binary.operator !== '&&' && binary.operator !== '||') return undefined;
      const left = truthyContext(binary.left, isNil);
      const right = truthyContext(binary.right, isNil);
      return left === binary.left && right === binary.right
        ? undefined
        : ({ ...binary, left, right } as unknown as ASTNode);
    }
    default:
      return undefined;
  }
}

/** `x == nil` → `!x`. Value-preserving in every context: `!x` is already 0 or 1. */
function negatedNilCompare(
  node: ASTNode,
  isNil: (e: Expression) => boolean,
): ASTNode | undefined {
  const binary = node as BinaryExpr;
  if (binary.operator !== '==') return undefined;

  const nilLeft = isNil(binary.left);
  const nilRight = isNil(binary.right);
  if (!nilLeft && !nilRight) return undefined;

  return {
    kind: NodeKind.UnaryExpr,
    operator: '!',
    operand: nilLeft ? binary.right : binary.left,
    location: binary.location,
    leadingTrivia: binary.leadingTrivia,
    trailingTrivia: binary.trailingTrivia,
  } as UnaryExpr;
}

/** A bare integer `0`. */
function isZeroLiteral(expr: Expression): boolean {
  return expr.kind === NodeKind.IntegerLiteral
    && (expr as IntegerLiteralExpr).value === 0n;
}

/** `nullptr`, a bare `0`, or a cast of `0` — the spellings Ghidra writes NULL as. */
function isNullLiteral(expr: Expression): boolean {
  if (expr.kind === NodeKind.NullptrLiteral) return true;
  if (expr.kind === NodeKind.CStyleCastExpr) {
    const cast = expr as CStyleCastExpr;
    return cast.expression.kind === NodeKind.IntegerLiteral
      && (cast.expression as IntegerLiteralExpr).value === 0n;
  }
  return isZeroLiteral(expr);
}

/**
 * Clean up Ghidra's boolean expressions
 * e.g., (x != 0) -> x  — ONLY where the value is read for truth
 *       (x == 0) -> !x — anywhere
 *
 * ## Why the two directions are not symmetric
 *
 * `!x` is already 0 or 1, so `x == 0` → `!x` preserves the value in every
 * context and needs no guard. `x != 0` → `x` does not: the comparison yields 0
 * or 1 and `x` yields whatever `x` is.
 *
 * The unguarded version of this cost a crash. A `SETNZ` at `0040ee0e` decompiles
 * as `nSlot = (uint)(*szFileName != 0)` — slot 0 is reserved for the empty log
 * name, so the log manager's slot index is 0 or 1. Rewritten to
 * `nSlot = (uint32_t)*szFileName` it became the first CHARACTER of the file
 * name, and Ghidra's own `(*szFileName != 0) < 0x14` guard, given the same
 * treatment, went false for every name starting at or above 'T' — so the scan
 * that fills the slot never ran and every log open fell into LRU eviction.
 *
 * A comparison is therefore only dropped at a position that reads it for truth:
 * a condition, an operand of `!`, `&&` or `||`. In an assignment, a cast, an
 * argument, a `return`, or under a relational operator it stands, and stands as
 * the normalised 0/1 the instruction produced.
 */
export function simplifyBooleanExpressions(): Transformer {
  return createTransformer({
    visitNode(node) {
      return rewriteTruthyPositions(node, isZeroLiteral)
        ?? (node.kind === NodeKind.BinaryExpr
          ? negatedNilCompare(node, isZeroLiteral)
          : undefined);
    },
  });
}

/**
 * Remove Ghidra's explicit NULL checks where unnecessary
 * e.g., if (ptr != (void *)0x0) -> if (ptr)
 */
export function simplifyNullChecks(): Transformer {
  return createTransformer({
    visitNode(node) {
      return rewriteTruthyPositions(node, isNullLiteral)
        ?? (node.kind === NodeKind.BinaryExpr
          ? negatedNilCompare(node, isNullLiteral)
          : undefined);
    },
  });
}

/**
 * Add metadata comments from Ghidra addresses
 */
export function addAddressComments(): Transformer {
  return createTransformer({
    visitFunctionDecl(node) {
      const funcName = typeof node.name === 'string' ? node.name : (node.name as Identifier)?.name;
      if (typeof funcName !== 'string') return node;
      const addr = extractAddressFromName(funcName);
      if (addr) {
        return updateNode(node, {
          ghidraInfo: {
            ...node.ghidraInfo,
            originalAddress: addr,
            originalName: funcName,
          },
        });
      }
      return undefined;
    },
  });
}

// ============================================
// COMBINED TRANSFORMS
// ============================================

/**
 * Apply all Ghidra-specific cleanups
 */
export function ghidraCleanup(options: GhidraCleanupOptions = {}): Transformer {
  const transforms: Transformer[] = [];

  if (options.cleanNames !== false) {
    transforms.push(cleanGhidraNames(options.nameContext));
  }

  if (options.removeRedundantCasts !== false) {
    transforms.push(removeRedundantCasts());
  }

  if (options.simplifyBooleans !== false) {
    transforms.push(simplifyBooleanExpressions());
    transforms.push(simplifyNullChecks());
  }

  if (options.addAddressComments) {
    transforms.push(addAddressComments());
  }

  return sequence(...transforms);
}

export interface GhidraCleanupOptions {
  /** Clean up auto-generated names. Default: true */
  cleanNames?: boolean;

  /** Context for smarter name generation */
  nameContext?: NameContext;

  /** Remove redundant casts. Default: true */
  removeRedundantCasts?: boolean;

  /** Simplify boolean expressions. Default: true */
  simplifyBooleans?: boolean;

  /** Add address comments from Ghidra names. Default: false */
  addAddressComments?: boolean;

  /** Custom rename map to apply */
  customRenames?: RenameMap;
}

/**
 * Quick cleanup preset - minimal changes, safe transforms only
 */
export const ghidraQuickClean = ghidraCleanup({
  cleanNames: true,
  removeRedundantCasts: false,
  simplifyBooleans: false,
});

/**
 * Full cleanup preset - all transforms
 */
export const ghidraFullClean = ghidraCleanup({
  cleanNames: true,
  removeRedundantCasts: true,
  simplifyBooleans: true,
  addAddressComments: true,
});
