/**
 * Call graph analysis
 *
 * Builds and analyzes the call graph for proper function ordering
 * and dependency analysis.
 */

import type { ExtractedFunction, CallGraph, CallGraphNode, CallPath } from '../types.js';

export interface CallGraphResult {
  graph: CallGraph;
  stats: {
    totalNodes: number;
    totalEdges: number;
    maxDepth: number;
    rootFunctions: number;
    leafFunctions: number;
  };
}

/**
 * Build call graph from extracted functions
 */
export function buildCallGraph(functions: ExtractedFunction[]): CallGraph {
  const nodes = new Map<string, CallGraphNode>();
  const edges = new Map<string, Set<string>>();

  // Create nodes for all functions
  for (const func of functions) {
    nodes.set(func.address, {
      address: func.address,
      name: func.name,
      namespace: func.namespace,
    });
    edges.set(func.address, new Set());
  }

  // Parse decompiled code to find call edges
  for (const func of functions) {
    if (!func.decompiled) continue;

    const callees = extractCallees(func.decompiled, functions);
    for (const callee of callees) {
      edges.get(func.address)?.add(callee);
    }
  }

  // A thunk has no body to scan, but it calls exactly one function. Without this
  // edge nothing knows the target is referenced, so its header is not included
  // where the forwarder is emitted and its declaration is not made public.
  const byAddressKey = new Map<string, string>();
  for (const func of functions) byAddressKey.set(addressKey(func.address), func.address);
  for (const func of functions) {
    const target = func.thunkTarget;
    if (!target || target.isExternal) continue;
    const targetAddress = byAddressKey.get(addressKey(target.address));
    if (targetAddress && targetAddress !== func.address) {
      edges.get(func.address)?.add(targetAddress);
    }
  }

  return { nodes, edges };
}

/** The hex tail of a Ghidra address ("Game.exe.ram:005011f0" -> "005011f0"). */
function addressKey(address: string): string {
  return address.includes(':') ? address.slice(address.lastIndexOf(':') + 1) : address;
}

/**
 * Extract called function addresses from decompiled code
 */
function extractCallees(
  decompiled: string,
  functions: ExtractedFunction[]
): string[] {
  const callees: string[] = [];

  // Build a map of function names to addresses
  const nameToAddress = new Map<string, string>();
  for (const func of functions) {
    nameToAddress.set(func.name, func.address);
  }

  // Look for function calls in the decompiled code
  // Pattern: functionName(...)
  const callPattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let match;

  while ((match = callPattern.exec(decompiled)) !== null) {
    const funcName = match[1];
    const address = nameToAddress.get(funcName);
    if (address) {
      callees.push(address);
    }
  }

  return [...new Set(callees)]; // Deduplicate
}

/**
 * Get topological order of functions (for proper declaration order)
 */
export function getTopologicalOrder(graph: CallGraph): string[] {
  const visited = new Set<string>();
  const result: string[] = [];

  function visit(address: string): void {
    if (visited.has(address)) return;
    visited.add(address);

    const callees = graph.edges.get(address) || new Set();
    for (const callee of callees) {
      visit(callee);
    }

    result.push(address);
  }

  for (const address of graph.nodes.keys()) {
    visit(address);
  }

  return result.reverse();
}

/**
 * Find strongly connected components (recursive function groups)
 */
export function getStronglyConnectedComponents(graph: CallGraph): string[][] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let currentIndex = 0;

  function strongConnect(address: string): void {
    index.set(address, currentIndex);
    lowlink.set(address, currentIndex);
    currentIndex++;
    stack.push(address);
    onStack.add(address);

    const callees = graph.edges.get(address) || new Set();
    for (const callee of callees) {
      if (!index.has(callee)) {
        strongConnect(callee);
        lowlink.set(address, Math.min(lowlink.get(address)!, lowlink.get(callee)!));
      } else if (onStack.has(callee)) {
        lowlink.set(address, Math.min(lowlink.get(address)!, index.get(callee)!));
      }
    }

    // If this is a root node, pop the SCC
    if (lowlink.get(address) === index.get(address)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== address);
      components.push(component);
    }
  }

  for (const address of graph.nodes.keys()) {
    if (!index.has(address)) {
      strongConnect(address);
    }
  }

  return components;
}

/**
 * Get all dependencies for a function (transitive closure)
 */
export function getFunctionDependencies(
  graph: CallGraph,
  address: string
): Set<string> {
  const deps = new Set<string>();
  const queue = [address];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const callees = graph.edges.get(current) || new Set();

    for (const callee of callees) {
      if (!deps.has(callee)) {
        deps.add(callee);
        queue.push(callee);
      }
    }
  }

  return deps;
}

/**
 * Find a call path between two functions using BFS
 */
export function findCallPath(
  graph: CallGraph,
  from: string,
  to: string,
  maxDepth: number = 10
): CallPath | null {
  if (from === to) {
    return { from, to, path: [from], depth: 0 };
  }

  const visited = new Set<string>();
  const queue: Array<{ address: string; path: string[]; depth: number }> = [
    { address: from, path: [from], depth: 0 },
  ];

  while (queue.length > 0) {
    const { address, path, depth } = queue.shift()!;

    if (depth >= maxDepth) continue;
    if (visited.has(address)) continue;
    visited.add(address);

    const callees = graph.edges.get(address) || new Set();
    for (const callee of callees) {
      const newPath = [...path, callee];

      if (callee === to) {
        return { from, to, path: newPath, depth: depth + 1 };
      }

      if (!visited.has(callee)) {
        queue.push({ address: callee, path: newPath, depth: depth + 1 });
      }
    }
  }

  return null;
}

/**
 * Get callers of a function
 */
export function getCallers(graph: CallGraph, address: string): string[] {
  const callers: string[] = [];

  for (const [caller, callees] of graph.edges) {
    if (callees.has(address)) {
      callers.push(caller);
    }
  }

  return callers;
}

/**
 * Get callees of a function
 */
export function getCallees(graph: CallGraph, address: string): string[] {
  return Array.from(graph.edges.get(address) || []);
}

/**
 * Get root functions (not called by anyone)
 */
export function getRootFunctions(graph: CallGraph): string[] {
  const calledFunctions = new Set<string>();

  for (const callees of graph.edges.values()) {
    for (const callee of callees) {
      calledFunctions.add(callee);
    }
  }

  return Array.from(graph.nodes.keys()).filter(addr => !calledFunctions.has(addr));
}

/**
 * Get leaf functions (don't call anyone)
 */
export function getLeafFunctions(graph: CallGraph): string[] {
  return Array.from(graph.nodes.keys()).filter(addr => {
    const callees = graph.edges.get(addr);
    return !callees || callees.size === 0;
  });
}

/**
 * Populate calledFunctions (by name) on each ExtractedFunction from the call graph edges.
 * Must be called after buildCallGraph() so edges are populated.
 */
export function populateCalledFunctions(
  functions: ExtractedFunction[],
  graph: CallGraph
): void {
  // Build address→name lookup
  const addressToName = new Map<string, string>();
  for (const func of functions) {
    addressToName.set(func.address, func.name);
  }

  for (const func of functions) {
    const calleeAddresses = graph.edges.get(func.address);
    if (!calleeAddresses || calleeAddresses.size === 0) {
      func.calledFunctions = [];
      continue;
    }

    const calleeNames: string[] = [];
    for (const addr of calleeAddresses) {
      const name = addressToName.get(addr);
      if (name) calleeNames.push(name);
    }
    func.calledFunctions = calleeNames;
  }
}

/**
 * Get call graph statistics
 */
export function getCallGraphStats(graph: CallGraph): CallGraphResult['stats'] {
  let totalEdges = 0;
  for (const callees of graph.edges.values()) {
    totalEdges += callees.size;
  }

  const roots = getRootFunctions(graph);
  const leaves = getLeafFunctions(graph);

  // Calculate max depth by finding longest path from any root
  let maxDepth = 0;
  for (const root of roots) {
    const depth = getMaxDepthFrom(graph, root, new Set());
    maxDepth = Math.max(maxDepth, depth);
  }

  return {
    totalNodes: graph.nodes.size,
    totalEdges,
    maxDepth,
    rootFunctions: roots.length,
    leafFunctions: leaves.length,
  };
}

/**
 * Get maximum depth from a node
 */
function getMaxDepthFrom(
  graph: CallGraph,
  address: string,
  visited: Set<string>
): number {
  if (visited.has(address)) return 0;
  visited.add(address);

  const callees = graph.edges.get(address);
  if (!callees || callees.size === 0) return 0;

  let maxChildDepth = 0;
  for (const callee of callees) {
    const childDepth = getMaxDepthFrom(graph, callee, visited);
    maxChildDepth = Math.max(maxChildDepth, childDepth);
  }

  visited.delete(address);
  return maxChildDepth + 1;
}
