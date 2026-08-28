/**
 * AST Transformer - Base transformer interface and utilities
 *
 * Provides the foundation for immutable AST transformations with
 * visitor pattern support and trivia preservation.
 */

import { NodeKind } from '../ast/kinds.js';
import type { ASTNode, AnyNode, Identifier, TranslationUnit } from '../ast/nodes.js';
import {
  transformAST as baseTransformAST,
  traverseAST,
  getChildren,
  type ASTVisitor,
} from '../ast/visitor.js';

// ============================================
// TRANSFORMER TYPES
// ============================================

/**
 * A transformer is a function that takes an AST node and returns
 * a transformed node (or the same node if unchanged).
 *
 * Transformers must be immutable - they should return new nodes
 * rather than mutating the input.
 */
export type Transformer<N extends ASTNode = ASTNode> = (node: N) => N;

/**
 * Configuration options for transformers
 */
export interface TransformOptions {
  /** Whether to preserve trivia (comments, whitespace). Default: true */
  preserveTrivia?: boolean;

  /** Whether to deep clone nodes before transformation. Default: false */
  deepClone?: boolean;

  /** Optional filter to only transform certain node kinds */
  filterKinds?: NodeKind[];

  /**
   * Compute `changesCount` by walking the tree before and after. Default: true.
   *
   * This costs TWO extra full traversals plus an identity Set of every node,
   * per step. `transformChildren` shallow-copies every node unconditionally, so
   * the number it produces is the node count of the result, not a count of
   * anything that actually changed — it is only ever useful as a "did the
   * transformer run" signal. Callers that never read `changesCount` should turn
   * it off; the transformed AST is bit-for-bit the same either way.
   */
  trackChanges?: boolean;
}

/**
 * Result of a transformation with metadata
 */
export interface TransformResult<N extends ASTNode = ASTNode> {
  /** The transformed AST */
  ast: N;

  /** Number of nodes that were changed */
  changesCount: number;

  /** Map of original nodes to their replacements */
  changeMap: Map<ASTNode, ASTNode>;
}

// ============================================
// CORE TRANSFORMATION FUNCTIONS
// ============================================

/**
 * Create a transformer from a visitor.
 * The visitor's methods return either a new node (to replace) or undefined (to keep).
 */
export function createTransformer(
  visitor: ASTVisitor<ASTNode | undefined>
): Transformer {
  return (node: ASTNode) => baseTransformAST(node, visitor);
}

/**
 * Create a transformer that only transforms nodes of specific kinds.
 * The transform function receives a node and returns either a new node or undefined.
 */
export function createKindTransformer<K extends NodeKind>(
  kinds: K | K[],
  transform: (node: ASTNode) => ASTNode | undefined
): Transformer {
  const kindSet = new Set(Array.isArray(kinds) ? kinds : [kinds]);

  return createTransformer({
    visitNode(node) {
      if (kindSet.has(node.kind as K)) {
        return transform(node);
      }
      return undefined;
    },
  });
}

/**
 * Transform an AST with detailed result information
 */
export function transformWithTracking<N extends ASTNode>(
  node: N,
  transformer: Transformer<N>,
  options: TransformOptions = {}
): TransformResult<N> {
  const changeMap = new Map<ASTNode, ASTNode>();
  let changesCount = 0;

  // The two traversals below are pure bookkeeping — skip them when the caller
  // does not read the count.
  if (options.trackChanges === false) {
    return { ast: transformer(node), changesCount: 0, changeMap };
  }

  // Collect original nodes for comparison
  const originalNodes = new Set<ASTNode>();
  for (const n of traverseAST(node)) {
    originalNodes.add(n);
  }

  // Apply transformation
  const result = transformer(node);

  // Track changes
  for (const n of traverseAST(result)) {
    if (!originalNodes.has(n)) {
      changesCount++;
    }
  }

  return {
    ast: result,
    changesCount,
    changeMap,
  };
}

/**
 * Apply a transformer to an AST, returning the transformed AST
 */
export function transform<N extends ASTNode>(
  node: N,
  transformer: Transformer<N>,
  options: TransformOptions = {}
): N {
  const { preserveTrivia = true, filterKinds } = options;

  if (filterKinds && filterKinds.length > 0) {
    const kindSet = new Set(filterKinds);
    const wrappedTransformer: Transformer<N> = (n) => {
      if (kindSet.has(n.kind)) {
        return transformer(n);
      }
      return n;
    };
    return wrappedTransformer(node);
  }

  return transformer(node);
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Deep clone an AST node, preserving all properties including trivia
 */
export function cloneNode<N extends ASTNode>(node: N): N {
  if (node === null || typeof node !== 'object') {
    return node;
  }

  if (Array.isArray(node)) {
    return node.map(item => cloneNode(item)) as unknown as N;
  }

  const clone: Record<string, unknown> = {};
  for (const key in node) {
    if (Object.prototype.hasOwnProperty.call(node, key)) {
      const value = (node as Record<string, unknown>)[key];
      if (value && typeof value === 'object') {
        clone[key] = cloneNode(value as ASTNode);
      } else {
        clone[key] = value;
      }
    }
  }

  return clone as N;
}

/**
 * Create a new node with updated properties while preserving trivia
 */
export function updateNode<N extends ASTNode>(
  node: N,
  updates: Partial<N>
): N {
  return {
    ...node,
    ...updates,
    // Always preserve trivia unless explicitly overwritten
    leadingTrivia: updates.leadingTrivia ?? node.leadingTrivia,
    trailingTrivia: updates.trailingTrivia ?? node.trailingTrivia,
    location: updates.location ?? node.location,
    ghidraInfo: updates.ghidraInfo ?? node.ghidraInfo,
  };
}

/**
 * Check if two nodes are structurally equal (ignoring location and trivia)
 */
export function nodesEqual(a: ASTNode, b: ASTNode): boolean {
  if (a.kind !== b.kind) return false;

  // Compare specific node values first (before children for efficiency)
  switch (a.kind) {
    case NodeKind.Identifier:
      return (a as Identifier).name === (b as Identifier).name;

    case NodeKind.IntegerLiteral:
      return (a as any).value === (b as any).value;

    case NodeKind.FloatingLiteral:
      return (a as any).value === (b as any).value;

    case NodeKind.StringLiteral:
      return (a as any).value === (b as any).value;

    case NodeKind.CharLiteral:
      return (a as any).value === (b as any).value;

    case NodeKind.BoolLiteral:
      return (a as any).value === (b as any).value;

    case NodeKind.BinaryExpr:
    case NodeKind.AssignExpr:
      if ((a as any).operator !== (b as any).operator) return false;
      break;

    case NodeKind.UnaryExpr:
    case NodeKind.PostfixExpr:
      if ((a as any).operator !== (b as any).operator) return false;
      break;
  }

  // Compare all children
  const childrenA = getChildren(a);
  const childrenB = getChildren(b);

  if (childrenA.length !== childrenB.length) return false;

  for (let i = 0; i < childrenA.length; i++) {
    if (!nodesEqual(childrenA[i], childrenB[i])) return false;
  }

  return true;
}

/**
 * Replace all occurrences of a specific node in the AST
 */
export function replaceNode<N extends ASTNode>(
  root: N,
  target: ASTNode,
  replacement: ASTNode
): N {
  return createTransformer({
    visitNode(node) {
      if (nodesEqual(node, target)) {
        return replacement;
      }
      return undefined;
    },
  })(root) as N;
}

/**
 * Remove nodes matching a predicate from the AST
 * Note: This only works for nodes in arrays (like statements, declarations)
 */
export function filterNodes<N extends ASTNode>(
  root: N,
  predicate: (node: ASTNode) => boolean
): N {
  return createTransformer({
    visitTranslationUnit(node) {
      const filtered = node.declarations.filter(predicate);
      if (filtered.length !== node.declarations.length) {
        return updateNode(node, { declarations: filtered } as Partial<TranslationUnit>);
      }
      return undefined;
    },
    // Add more array-containing node types as needed
  })(root) as N;
}

// ============================================
// IDENTITY TRANSFORMER
// ============================================

/**
 * Identity transformer - returns the input unchanged.
 * Useful as a base or for testing.
 */
export const identity: Transformer = (node) => node;

// ============================================
// COMBINATOR FUNCTIONS
// ============================================

/**
 * Combine multiple transformers into one that applies them in sequence
 */
export function sequence<N extends ASTNode>(
  ...transformers: Transformer<N>[]
): Transformer<N> {
  return (node: N) => {
    let result = node;
    for (const t of transformers) {
      result = t(result);
    }
    return result;
  };
}

/**
 * Apply a transformer only if a condition is met
 */
export function when<N extends ASTNode>(
  condition: (node: N) => boolean,
  transformer: Transformer<N>
): Transformer<N> {
  return (node: N) => {
    if (condition(node)) {
      return transformer(node);
    }
    return node;
  };
}

/**
 * Apply transformers until one returns a different node
 */
export function firstMatch<N extends ASTNode>(
  ...transformers: Transformer<N>[]
): Transformer<N> {
  return (node: N) => {
    for (const t of transformers) {
      const result = t(node);
      if (result !== node) {
        return result;
      }
    }
    return node;
  };
}

/**
 * Repeat a transformer until the AST no longer changes
 * (useful for iterative simplification)
 */
export function fixpoint<N extends ASTNode>(
  transformer: Transformer<N>,
  maxIterations: number = 100
): Transformer<N> {
  return (node: N) => {
    let current = node;
    for (let i = 0; i < maxIterations; i++) {
      const next = transformer(current);
      if (nodesEqual(next, current)) {
        return next;
      }
      current = next;
    }
    return current;
  };
}
