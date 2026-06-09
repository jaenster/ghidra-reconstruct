/**
 * Declaration Order Fix Plugin
 *
 * After decl-init-merge combines declarations with their first assignments,
 * the original C89-style declaration order may create forward references:
 *
 *   int* pData = pGrid->field;   // uses pGrid before it's defined!
 *   GridStrc* pGrid = pRoom->pGrid;
 *
 * This plugin topologically sorts the contiguous declaration block at the
 * top of each compound statement so that dependencies are satisfied.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, CompoundStmt, DeclStmt, VariableDecl, Identifier,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface DeclOrderFixOptions extends PluginOptions {}

/**
 * Topological sort of declaration indices based on initializer dependencies.
 * Returns a reordered list of indices, or the original order if there are cycles.
 */
function topoSort(
  declIndices: number[],
  nameToIndex: Map<string, number>,
  deps: Map<number, Set<number>>,
): number[] {
  // Kahn's algorithm
  const inDegree = new Map<number, number>();
  for (const idx of declIndices) inDegree.set(idx, 0);

  for (const [idx, depSet] of deps) {
    for (const dep of depSet) {
      if (inDegree.has(dep)) {
        // dep doesn't create in-degree — idx depends on dep, so idx has in-degree
      }
    }
  }
  // Count in-degree: for each edge (idx depends on dep), idx gets +1
  for (const [idx, depSet] of deps) {
    let count = 0;
    for (const dep of depSet) {
      if (inDegree.has(dep)) count++;
    }
    inDegree.set(idx, count);
  }

  const queue: number[] = [];
  for (const idx of declIndices) {
    if ((inDegree.get(idx) ?? 0) === 0) queue.push(idx);
  }

  const result: number[] = [];
  while (queue.length > 0) {
    // Pick the node with lowest original index for stability
    queue.sort((a, b) => a - b);
    const current = queue.shift()!;
    result.push(current);

    // For each node that depends on current, decrement in-degree
    for (const [idx, depSet] of deps) {
      if (depSet.has(current)) {
        const newDeg = (inDegree.get(idx) ?? 1) - 1;
        inDegree.set(idx, newDeg);
        if (newDeg === 0) queue.push(idx);
      }
    }
  }

  // If cycle detected, return original order
  if (result.length !== declIndices.length) return declIndices;
  return result;
}

function createDeclOrderFixTransformer(_options: DeclOrderFixOptions = {}): Transformer {
  return createTransformer({
    visitCompoundStmt(node: CompoundStmt): ASTNode | undefined {
      const stmts = node.statements;

      // Find the contiguous block of DeclStmt at the top
      let declEnd = 0;
      while (declEnd < stmts.length && stmts[declEnd].kind === NodeKind.DeclStmt) {
        declEnd++;
      }
      if (declEnd < 2) return undefined; // Nothing to reorder

      // Collect variable names and their declaration indices
      const nameToIndex = new Map<string, number>();
      const declNames: string[] = []; // indexed by position in block
      const hasInitializer: boolean[] = [];

      for (let i = 0; i < declEnd; i++) {
        const declStmt = stmts[i] as DeclStmt;
        if (declStmt.declarations.length !== 1) continue;
        const decl = declStmt.declarations[0];
        if (decl.kind !== NodeKind.VariableDecl) continue;
        const varDecl = decl as VariableDecl;
        nameToIndex.set(varDecl.name.name, i);
        declNames[i] = varDecl.name.name;
        hasInitializer[i] = varDecl.initializer !== null;
      }

      // Build dependency graph: if decl[i]'s initializer references decl[j]'s name, i depends on j
      const deps = new Map<number, Set<number>>();
      let hasDeps = false;

      for (let i = 0; i < declEnd; i++) {
        const declStmt = stmts[i] as DeclStmt;
        if (declStmt.declarations.length !== 1) continue;
        const decl = declStmt.declarations[0];
        if (decl.kind !== NodeKind.VariableDecl) continue;
        const varDecl = decl as VariableDecl;
        if (!varDecl.initializer) continue;

        const depSet = new Set<number>();
        // Find all identifiers in the initializer
        const idNodes = findNodesByKind(varDecl.initializer as ASTNode, NodeKind.Identifier);
        for (const idNode of idNodes) {
          const idName = (idNode as Identifier).name;
          const depIdx = nameToIndex.get(idName);
          if (depIdx !== undefined && depIdx !== i) {
            depSet.add(depIdx);
            hasDeps = true;
          }
        }
        if (depSet.size > 0) deps.set(i, depSet);
      }

      if (!hasDeps) return undefined;

      // Check if current order already satisfies deps
      let needsReorder = false;
      for (const [idx, depSet] of deps) {
        for (const dep of depSet) {
          if (dep > idx) { // dependency is declared AFTER this variable
            needsReorder = true;
            break;
          }
        }
        if (needsReorder) break;
      }

      if (!needsReorder) return undefined;

      // Topological sort the declaration block
      const declIndices = Array.from({ length: declEnd }, (_, i) => i);
      const sorted = topoSort(declIndices, nameToIndex, deps);

      // Check if sort actually changed anything
      if (sorted.every((v, i) => v === i)) return undefined;

      // Build reordered statement list
      const newStmts: ASTNode[] = [];
      for (const idx of sorted) {
        newStmts.push(stmts[idx]);
      }
      // Append the rest of the statements unchanged
      for (let i = declEnd; i < stmts.length; i++) {
        newStmts.push(stmts[i]);
      }

      return updateNode(node, { statements: newStmts } as Partial<CompoundStmt>);
    },
  });
}

export const declOrderFixPlugin: TransformPlugin = {
  id: 'decl-order-fix',
  name: 'Declaration Order Fix',
  description: 'Reorders merged declarations to respect initializer dependencies',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 61, // Right after decl-init-merge (60), before decl-scope-sink (62)
  tags: ['cleanup', 'declaration'],
  createTransformer: createDeclOrderFixTransformer,
};
