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
 * Clean up Ghidra's boolean expressions
 * e.g., (x != 0) -> x (in boolean context)
 *       (x == 0) -> !x
 */
export function simplifyBooleanExpressions(): Transformer {
  return createKindTransformer(NodeKind.BinaryExpr, (node) => {
    const binary = node as BinaryExpr;

    // Check for comparison with zero
    const isLeftZero = binary.left.kind === NodeKind.IntegerLiteral &&
                       (binary.left as IntegerLiteralExpr).value === 0n;
    const isRightZero = binary.right.kind === NodeKind.IntegerLiteral &&
                        (binary.right as IntegerLiteralExpr).value === 0n;

    if (!isLeftZero && !isRightZero) return undefined;

    const nonZero = isLeftZero ? binary.right : binary.left;

    // x != 0 -> x (in boolean context)
    if (binary.operator === '!=') {
      return nonZero;
    }

    // x == 0 -> !x
    if (binary.operator === '==') {
      return {
        kind: NodeKind.UnaryExpr,
        operator: '!',
        operand: nonZero,
        location: binary.location,
        leadingTrivia: binary.leadingTrivia,
        trailingTrivia: binary.trailingTrivia,
      } as UnaryExpr;
    }

    return undefined;
  });
}

/**
 * Remove Ghidra's explicit NULL checks where unnecessary
 * e.g., if (ptr != (void *)0x0) -> if (ptr)
 */
export function simplifyNullChecks(): Transformer {
  return createKindTransformer(NodeKind.BinaryExpr, (node) => {
    const binary = node as BinaryExpr;

    if (binary.operator !== '!=' && binary.operator !== '==') {
      return undefined;
    }

    // Check for cast to void* of 0
    const isNullLiteral = (expr: Expression): boolean => {
      if (expr.kind === NodeKind.CStyleCastExpr) {
        const cast = expr as CStyleCastExpr;
        if (cast.expression.kind === NodeKind.IntegerLiteral) {
          return (cast.expression as IntegerLiteralExpr).value === 0n;
        }
      }
      if (expr.kind === NodeKind.IntegerLiteral) {
        return (expr as IntegerLiteralExpr).value === 0n;
      }
      if (expr.kind === NodeKind.NullptrLiteral) {
        return true;
      }
      return false;
    };

    const leftIsNull = isNullLiteral(binary.left);
    const rightIsNull = isNullLiteral(binary.right);

    if (!leftIsNull && !rightIsNull) return undefined;

    const nonNull = leftIsNull ? binary.right : binary.left;

    if (binary.operator === '!=') {
      // ptr != NULL -> ptr
      return nonNull;
    } else {
      // ptr == NULL -> !ptr
      return {
        kind: NodeKind.UnaryExpr,
        operator: '!',
        operand: nonNull,
        location: binary.location,
        leadingTrivia: binary.leadingTrivia,
        trailingTrivia: binary.trailingTrivia,
      } as UnaryExpr;
    }
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
