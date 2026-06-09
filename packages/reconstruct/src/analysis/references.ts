/**
 * Symbol reference tracking for header/module generation
 *
 * Builds a dependency graph showing what symbols reference what other symbols,
 * and whether a forward declaration is sufficient or a full definition is required.
 */

import type {
  ExtractedFunction,
  ExtractedDataType,
  ExtractedGlobal,
  ExtractedStruct,
  StructField,
} from '../types.js';
import { isPlatformOrBuiltinType } from '../codegen/platform-types.js';

/**
 * How a symbol is referenced
 */
export type ReferenceUsage =
  | 'field'       // Struct field type
  | 'base_class'  // Inheritance
  | 'param'       // Function parameter
  | 'return'      // Function return type
  | 'local'       // Local variable in function body
  | 'call'        // Function call
  | 'typedef'     // Typedef target
  | 'global';     // Global variable reference

/**
 * A reference from one symbol to another
 */
export interface SymbolReference {
  /** Name of the referenced symbol */
  name: string;

  /** Is this a pointer/reference (forward decl OK) or value (full def required) */
  isPointer: boolean;

  /** How the symbol is used */
  usage: ReferenceUsage;

  /** Source location (file:line or address) */
  location?: string;
}

/**
 * A symbol with its dependencies
 */
export interface SymbolNode {
  /** Unique identifier (address for functions, name for types) */
  id: string;

  /** Symbol kind */
  kind: 'function' | 'struct' | 'class' | 'enum' | 'typedef' | 'union' | 'global';

  /** Display name */
  name: string;

  /** Namespace/category */
  namespace?: string;

  /** Compilation unit (source file) this symbol belongs to */
  unitName?: string;

  /** What this symbol depends on (outgoing edges) */
  dependsOn: SymbolReference[];

  /** What depends on this symbol (incoming edges) */
  dependedBy: string[];
}

/**
 * Complete dependency graph
 */
export class DependencyGraph {
  private nodes: Map<string, SymbolNode> = new Map();
  private nameIndex: Map<string, string> = new Map(); // name → id

  /**
   * Add a symbol to the graph
   */
  addSymbol(node: SymbolNode): void {
    this.nodes.set(node.id, node);
    // First symbol with a given name wins the index slot
    if (!this.nameIndex.has(node.name)) {
      this.nameIndex.set(node.name, node.id);
    }
  }

  /**
   * Get a symbol by ID
   */
  getSymbol(id: string): SymbolNode | undefined {
    return this.nodes.get(id);
  }

  /**
   * Get all symbols
   */
  getAllSymbols(): SymbolNode[] {
    return Array.from(this.nodes.values());
  }

  /**
   * Get symbols that this symbol requires (for include/import generation)
   */
  getRequiredSymbols(id: string): { forwardDecl: string[]; fullDef: string[] } {
    const node = this.nodes.get(id);
    if (!node) return { forwardDecl: [], fullDef: [] };

    const forwardDecl = new Set<string>();
    const fullDef = new Set<string>();

    for (const ref of node.dependsOn) {
      // Skip built-in types
      if (isBuiltinType(ref.name)) continue;

      if (ref.isPointer && ref.usage !== 'base_class') {
        forwardDecl.add(ref.name);
      } else {
        fullDef.add(ref.name);
      }
    }

    // If something needs full def, remove from forward decl
    for (const name of fullDef) {
      forwardDecl.delete(name);
    }

    return {
      forwardDecl: Array.from(forwardDecl),
      fullDef: Array.from(fullDef),
    };
  }

  /**
   * Get topological order for header/module generation
   * Returns null if there's a cycle (need forward declarations)
   */
  getTopologicalOrder(): string[] | null {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const order: string[] = [];

    const visit = (id: string): boolean => {
      if (visiting.has(id)) return false; // Cycle detected
      if (visited.has(id)) return true;

      visiting.add(id);
      const node = this.nodes.get(id);
      if (node) {
        for (const ref of node.dependsOn) {
          const depId = this.findSymbolId(ref.name);
          if (depId && !ref.isPointer) {
            if (!visit(depId)) return false;
          }
        }
      }
      visiting.delete(id);
      visited.add(id);
      order.push(id);
      return true;
    };

    for (const id of this.nodes.keys()) {
      if (!visit(id)) return null;
    }

    return order;
  }

  /**
   * Find cycles in the dependency graph
   * Returns arrays of symbol IDs that form cycles
   */
  findCycles(): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const path: string[] = [];
    const pathSet = new Set<string>();

    const dfs = (id: string): void => {
      if (pathSet.has(id)) {
        // Found a cycle - extract it
        const cycleStart = path.indexOf(id);
        cycles.push(path.slice(cycleStart));
        return;
      }
      if (visited.has(id)) return;

      path.push(id);
      pathSet.add(id);

      const node = this.nodes.get(id);
      if (node) {
        for (const ref of node.dependsOn) {
          if (!ref.isPointer) {
            const depId = this.findSymbolId(ref.name);
            if (depId) dfs(depId);
          }
        }
      }

      path.pop();
      pathSet.delete(id);
      visited.add(id);
    };

    for (const id of this.nodes.keys()) {
      dfs(id);
    }

    return cycles;
  }

  /**
   * Find symbol ID by name (O(1) via name index)
   */
  findSymbolId(name: string): string | undefined {
    return this.nameIndex.get(name);
  }
}

/**
 * Parse a type string to extract the base type name and whether it's a pointer
 *
 * Examples:
 * - "Player *" → { name: "Player", isPointer: true }
 * - "const Player *" → { name: "Player", isPointer: true }
 * - "Player" → { name: "Player", isPointer: false }
 * - "struct Player" → { name: "Player", isPointer: false }
 * - "Player **" → { name: "Player", isPointer: true }
 * - "Player[10]" → { name: "Player", isPointer: false } (array = value type)
 * - "Player &" → { name: "Player", isPointer: true } (reference = like pointer)
 */
export function parseTypeString(typeStr: string): { name: string; isPointer: boolean } {
  let str = typeStr.trim();

  // Check if it's a pointer or reference
  const isPointer = str.includes('*') || str.includes('&');

  // Remove pointer/reference indicators
  str = str.replace(/\s*\*+\s*/g, ' ').replace(/\s*&+\s*/g, ' ');

  // Remove array brackets
  str = str.replace(/\[[^\]]*\]/g, '');

  // Remove const/volatile qualifiers
  str = str.replace(/\b(const|volatile|restrict)\b/g, '');

  // Remove struct/class/union/enum keywords
  str = str.replace(/\b(struct|class|union|enum)\b/g, '');

  // Clean up whitespace
  str = str.trim().replace(/\s+/g, ' ');

  return { name: str, isPointer };
}

/**
 * Check if a type name is a built-in type that doesn't need a declaration
 */
export function isBuiltinType(name: string): boolean {
  return isPlatformOrBuiltinType(name);
}

/**
 * Build a dependency graph from extracted data
 */
export function buildDependencyGraph(
  functions: ExtractedFunction[],
  dataTypes: ExtractedDataType[],
  globals?: ExtractedGlobal[],
): DependencyGraph {
  const graph = new DependencyGraph();

  // Add all data types first
  for (const type of dataTypes) {
    const node: SymbolNode = {
      id: `type:${type.category}/${type.name}`,
      kind: mapKindToSymbolKind(type.kind),
      name: type.name,
      namespace: type.category,
      dependsOn: [],
      dependedBy: [],
    };

    // Extract dependencies from struct fields
    if (type.kind === 'STRUCTURE' || type.kind === 'UNION') {
      const structType = type as ExtractedStruct;
      if (structType.fields) {
        for (const field of structType.fields) {
          const parsed = parseTypeString(field.dataType);
          if (!isBuiltinType(parsed.name) && parsed.name !== type.name) {
            node.dependsOn.push({
              name: parsed.name,
              isPointer: parsed.isPointer,
              usage: 'field',
              location: `offset:${field.offset}`,
            });
          }
        }
      }
    }

    // Extract dependencies from typedef
    if (type.kind === 'TYPEDEF') {
      const typedefType = type as { underlyingType?: string };
      if (typedefType.underlyingType) {
        const parsed = parseTypeString(typedefType.underlyingType);
        if (!isBuiltinType(parsed.name)) {
          node.dependsOn.push({
            name: parsed.name,
            isPointer: parsed.isPointer,
            usage: 'typedef',
          });
        }
      }
    }

    graph.addSymbol(node);
  }

  // Add functions
  for (const func of functions) {
    const node: SymbolNode = {
      id: `func:${func.address}`,
      kind: 'function',
      name: func.name,
      namespace: func.namespace,
      dependsOn: [],
      dependedBy: [],
    };

    // Add return type dependency
    if (func.returnType) {
      const parsed = parseTypeString(func.returnType);
      if (!isBuiltinType(parsed.name)) {
        node.dependsOn.push({
          name: parsed.name,
          isPointer: parsed.isPointer,
          usage: 'return',
        });
      }
    }

    // Add parameter type dependencies
    if (func.parameters) {
      for (const param of func.parameters) {
        if (param.dataType) {
          const parsed = parseTypeString(param.dataType);
          if (!isBuiltinType(parsed.name)) {
            node.dependsOn.push({
              name: parsed.name,
              isPointer: parsed.isPointer,
              usage: 'param',
              location: param.name,
            });
          }
        }
      }
    }

    // Add call dependencies
    if (func.calledFunctions) {
      for (const callee of func.calledFunctions) {
        node.dependsOn.push({
          name: callee,
          isPointer: false,
          usage: 'call',
        });
      }
    }

    graph.addSymbol(node);
  }

  // Add globals
  if (globals) {
    for (const g of globals) {
      const parsed = parseTypeString(g.dataType);
      const gNode: SymbolNode = {
        id: `global:${g.address}`,
        kind: 'global',
        name: g.name,
        namespace: g.namespace,
        dependsOn: [],
        dependedBy: [],
      };

      if (!isBuiltinType(parsed.name)) {
        gNode.dependsOn.push({
          name: parsed.name,
          isPointer: parsed.isPointer,
          usage: 'global',
        });
      }

      graph.addSymbol(gNode);
    }
  }

  // Build reverse dependencies (dependedBy) using nameIndex for O(1) lookup
  for (const node of graph.getAllSymbols()) {
    for (const ref of node.dependsOn) {
      const targetId = graph.findSymbolId(ref.name);
      if (targetId) {
        const target = graph.getSymbol(targetId);
        if (target) {
          target.dependedBy.push(node.id);
        }
      }
    }
  }

  return graph;
}

function mapKindToSymbolKind(kind: string): SymbolNode['kind'] {
  switch (kind) {
    case 'STRUCTURE': return 'struct';
    case 'UNION': return 'union';
    case 'ENUM': return 'enum';
    case 'TYPEDEF': return 'typedef';
    default: return 'struct';
  }
}

/**
 * Generate include statements for a header file
 */
export function generateIncludes(
  graph: DependencyGraph,
  symbolId: string,
  options: {
    style: 'c++' | 'c++20-modules';
    headerExtension?: string;
  } = { style: 'c++' }
): { forwardDeclarations: string[]; includes: string[] } {
  const { forwardDecl, fullDef } = graph.getRequiredSymbols(symbolId);
  const { style, headerExtension = '.h' } = options;

  if (style === 'c++20-modules') {
    return {
      forwardDeclarations: forwardDecl.map(name => `class ${name};`),
      includes: fullDef.map(name => `import ${name};`),
    };
  }

  return {
    forwardDeclarations: forwardDecl.map(name => `class ${name};`),
    includes: fullDef.map(name => `#include "${name}${headerExtension}"`),
  };
}
