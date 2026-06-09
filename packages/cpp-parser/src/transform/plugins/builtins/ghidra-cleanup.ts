/**
 * Ghidra Cleanup Plugins
 *
 * Wraps existing Ghidra transforms as plugins for the plugin system.
 */

import type { TransformPlugin, PluginOptions } from '../types.js';
import {
  cleanGhidraNames,
  removeRedundantCasts,
  simplifyBooleanExpressions,
  simplifyNullChecks,
  addAddressComments,
  simplifyPointerArithmetic,
  type NameContext,
} from '../../builtins/ghidra.js';

// ============================================
// CLEAN GHIDRA NAMES PLUGIN
// ============================================

export interface CleanNamesOptions extends PluginOptions {
  /** Context for smarter name generation */
  nameContext?: NameContext;
}

/**
 * Plugin that renames Ghidra auto-generated names to more readable ones
 *
 * Transforms:
 * - FUN_00401000 → func_00401000
 * - param_1 → arg1
 * - local_8 → kept as-is (stack offset is useful)
 * - uVar1 → u1
 */
export const cleanGhidraNamesPlugin: TransformPlugin = {
  id: 'ghidra-clean-names',
  name: 'Clean Ghidra Names',
  description:
    'Rename Ghidra auto-generated names (FUN_, DAT_, param_, local_, etc.) to more readable versions',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 10, // Run early to rename before other transforms
  tags: ['core', 'cleanup', 'naming'],

  createTransformer(options?: CleanNamesOptions) {
    return cleanGhidraNames(options?.nameContext);
  },
};

// ============================================
// REMOVE REDUNDANT CASTS PLUGIN
// ============================================

/**
 * Plugin that removes unnecessary casts that Ghidra adds
 *
 * Transforms:
 * - (int)5 → 5 (when casting literal to same type)
 */
export const removeRedundantCastsPlugin: TransformPlugin = {
  id: 'ghidra-remove-casts',
  name: 'Remove Redundant Casts',
  description: 'Remove unnecessary casts that Ghidra adds to literals and expressions',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 50,
  tags: ['core', 'cleanup', 'simplify'],

  createTransformer() {
    return removeRedundantCasts();
  },
};

// ============================================
// SIMPLIFY BOOLEAN EXPRESSIONS PLUGIN
// ============================================

/**
 * Plugin that simplifies Ghidra's verbose boolean expressions
 *
 * Transforms:
 * - (x != 0) → x (in boolean context)
 * - (x == 0) → !x
 */
export const simplifyBooleanExpressionsPlugin: TransformPlugin = {
  id: 'ghidra-simplify-booleans',
  name: 'Simplify Boolean Expressions',
  description: 'Simplify verbose boolean comparisons like (x != 0) to just x',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 60,
  tags: ['core', 'cleanup', 'simplify'],

  createTransformer() {
    return simplifyBooleanExpressions();
  },
};

// ============================================
// SIMPLIFY NULL CHECKS PLUGIN
// ============================================

/**
 * Plugin that simplifies Ghidra's explicit NULL checks
 *
 * Transforms:
 * - if (ptr != (void *)0x0) → if (ptr)
 * - if (ptr == (void *)0x0) → if (!ptr)
 */
export const simplifyNullChecksPlugin: TransformPlugin = {
  id: 'ghidra-simplify-null-checks',
  name: 'Simplify NULL Checks',
  description: 'Simplify verbose NULL checks like (ptr != (void*)0x0) to just ptr',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 61, // Right after boolean simplification
  tags: ['core', 'cleanup', 'simplify'],

  createTransformer() {
    return simplifyNullChecks();
  },
};

// ============================================
// SIMPLIFY POINTER ARITHMETIC PLUGIN
// ============================================

/**
 * Plugin that simplifies Ghidra's pointer arithmetic patterns
 *
 * Note: This plugin is experimental and may not produce results
 * for all patterns without type information.
 */
export const simplifyPointerArithmeticPlugin: TransformPlugin = {
  id: 'ghidra-simplify-pointer-arithmetic',
  name: 'Simplify Pointer Arithmetic',
  description:
    'Simplify pointer arithmetic patterns like *(int*)(ptr + 4) to array notation',
  version: '1.0.0',
  defaultEnabled: false, // Experimental
  priority: 70,
  tags: ['experimental', 'simplify'],

  createTransformer() {
    return simplifyPointerArithmetic();
  },
};

// ============================================
// ADD ADDRESS COMMENTS PLUGIN
// ============================================

/**
 * Plugin that adds address metadata from Ghidra names
 *
 * Adds ghidraInfo to functions with their original addresses
 */
export const addAddressCommentsPlugin: TransformPlugin = {
  id: 'ghidra-address-comments',
  name: 'Add Address Comments',
  description:
    'Extract and preserve address information from Ghidra-generated function names',
  version: '1.0.0',
  defaultEnabled: false, // Not needed for most use cases
  priority: 90, // Run late, after renames
  tags: ['metadata'],

  createTransformer() {
    return addAddressComments();
  },
};

// ============================================
// ALL GHIDRA CLEANUP PLUGINS
// ============================================

/**
 * All Ghidra cleanup plugins in recommended order
 */
export const ghidraCleanupPlugins: TransformPlugin[] = [
  cleanGhidraNamesPlugin,
  removeRedundantCastsPlugin,
  simplifyBooleanExpressionsPlugin,
  simplifyNullChecksPlugin,
  simplifyPointerArithmeticPlugin,
  addAddressCommentsPlugin,
];
