/**
 * Rename Transformer
 *
 * Renames identifiers throughout an AST based on a mapping of
 * old names to new names. Particularly useful for renaming
 * Ghidra-generated function names like 'FUN_00401000' to
 * meaningful names like 'processData'.
 */

import { NodeKind } from '../../ast/kinds.js';
import type {
  ASTNode,
  Identifier,
  QualifiedId,
  FunctionDecl,
  VariableDecl,
  ParameterDecl,
  ClassDecl,
  StructDecl,
  EnumDecl,
  NamespaceDecl,
  FieldDecl,
  MethodDecl,
  TypedefDecl,
  TypeAliasDecl,
  GotoStmt,
  LabelStmt,
  EnumeratorDecl,
} from '../../ast/nodes.js';
import {
  type Transformer,
  createTransformer,
  updateNode,
} from '../transformer.js';

// ============================================
// TYPES
// ============================================

/**
 * Map of old names to new names
 */
export type RenameMap = Map<string, string> | Record<string, string>;

/**
 * Options for the rename transformer
 */
export interface RenameOptions {
  /** Only rename identifiers in specific contexts */
  contexts?: RenameContext[];

  /** Preserve the original name in ghidraInfo metadata */
  preserveOriginal?: boolean;

  /** Case-sensitive matching. Default: true */
  caseSensitive?: boolean;

  /** Match patterns (glob-style or regex) instead of exact names */
  patterns?: boolean;
}

/**
 * Contexts where identifiers can be renamed
 */
export type RenameContext =
  | 'function'        // Function declarations
  | 'variable'        // Variable declarations
  | 'parameter'       // Function parameters
  | 'field'           // Struct/class fields
  | 'method'          // Class methods
  | 'class'           // Class/struct names
  | 'enum'            // Enum names
  | 'namespace'       // Namespace names
  | 'typedef'         // Typedef names
  | 'label'           // goto labels
  | 'reference';      // All identifier references

// ============================================
// RENAME TRANSFORMER
// ============================================

/**
 * Create a transformer that renames identifiers based on a mapping.
 *
 * @example
 * ```ts
 * const rename = createRenameTransformer({
 *   'FUN_00401000': 'processData',
 *   'DAT_00402000': 'globalConfig',
 *   'param_1': 'inputBuffer',
 * });
 *
 * const transformedAst = rename(ast);
 * ```
 */
export function createRenameTransformer(
  renames: RenameMap,
  options: RenameOptions = {}
): Transformer {
  const renameMap = normalizeRenameMap(renames);
  const {
    contexts,
    preserveOriginal = false,
    caseSensitive = true,
  } = options;

  // If contexts specified, determine which node kinds to transform
  const contextSet = contexts ? new Set(contexts) : null;

  function shouldRenameInContext(context: RenameContext): boolean {
    return !contextSet || contextSet.has(context) || contextSet.has('reference');
  }

  function getRenamedName(name: string): string | null {
    if (caseSensitive) {
      return renameMap.get(name) ?? null;
    }
    // Case-insensitive: check all keys
    const lowerName = name.toLowerCase();
    for (const [key, value] of renameMap) {
      if (key.toLowerCase() === lowerName) {
        return value;
      }
    }
    return null;
  }

  function renameIdentifier(node: Identifier, context: RenameContext): Identifier | undefined {
    if (!shouldRenameInContext(context)) {
      return undefined;
    }

    const newName = getRenamedName(node.name);
    if (newName === null) {
      return undefined;
    }

    const renamed = updateNode(node, { name: newName });

    if (preserveOriginal) {
      renamed.ghidraInfo = {
        ...renamed.ghidraInfo,
        originalName: node.name,
      };
    }

    return renamed;
  }

  return createTransformer({
    visitIdentifier(node) {
      // General identifier reference
      return renameIdentifier(node, 'reference');
    },

    visitFunctionDecl(node) {
      if (!shouldRenameInContext('function')) {
        return undefined;
      }

      if (node.name.kind === NodeKind.Identifier) {
        const renamed = renameIdentifier(node.name as Identifier, 'function');
        if (renamed) {
          return updateNode(node, { name: renamed } as Partial<FunctionDecl>);
        }
      }
      return undefined;
    },

    visitVariableDecl(node) {
      if (!shouldRenameInContext('variable')) {
        return undefined;
      }

      const renamed = renameIdentifier(node.name, 'variable');
      if (renamed) {
        return updateNode(node, { name: renamed } as Partial<VariableDecl>);
      }
      return undefined;
    },

    visitParameterDecl(node) {
      if (!shouldRenameInContext('parameter') || !node.name) {
        return undefined;
      }

      const renamed = renameIdentifier(node.name, 'parameter');
      if (renamed) {
        return updateNode(node, { name: renamed } as Partial<ParameterDecl>);
      }
      return undefined;
    },

    visitFieldDecl(node) {
      if (!shouldRenameInContext('field')) {
        return undefined;
      }

      const renamed = renameIdentifier(node.name, 'field');
      if (renamed) {
        return updateNode(node, { name: renamed } as Partial<FieldDecl>);
      }
      return undefined;
    },

    visitMethodDecl(node) {
      if (!shouldRenameInContext('method')) {
        return undefined;
      }

      if (node.name.kind === NodeKind.Identifier) {
        const renamed = renameIdentifier(node.name as Identifier, 'method');
        if (renamed) {
          return updateNode(node, { name: renamed } as Partial<MethodDecl>);
        }
      }
      return undefined;
    },

    visitClassDecl(node) {
      if (!shouldRenameInContext('class') || !node.name) {
        return undefined;
      }

      const renamed = renameIdentifier(node.name, 'class');
      if (renamed) {
        return updateNode(node, { name: renamed } as Partial<ClassDecl>);
      }
      return undefined;
    },

    visitStructDecl(node) {
      if (!shouldRenameInContext('class') || !node.name) {
        return undefined;
      }

      const renamed = renameIdentifier(node.name, 'class');
      if (renamed) {
        return updateNode(node, { name: renamed } as Partial<StructDecl>);
      }
      return undefined;
    },

    visitEnumDecl(node) {
      if (!shouldRenameInContext('enum') || !node.name) {
        return undefined;
      }

      const renamed = renameIdentifier(node.name, 'enum');
      if (renamed) {
        return updateNode(node, { name: renamed } as Partial<EnumDecl>);
      }
      return undefined;
    },

    visitNamespaceDecl(node) {
      if (!shouldRenameInContext('namespace') || !node.name) {
        return undefined;
      }

      const renamed = renameIdentifier(node.name, 'namespace');
      if (renamed) {
        return updateNode(node, { name: renamed } as Partial<NamespaceDecl>);
      }
      return undefined;
    },
  });
}

// ============================================
// CONVENIENCE FUNCTIONS
// ============================================

/**
 * Create a simple rename transformer from an object mapping
 */
export function rename(renames: Record<string, string>, options?: RenameOptions): Transformer {
  return createRenameTransformer(renames, options);
}

/**
 * Rename a single identifier throughout the AST
 */
export function renameSingle(
  oldName: string,
  newName: string,
  options?: RenameOptions
): Transformer {
  return createRenameTransformer({ [oldName]: newName }, options);
}

/**
 * Rename using a function to determine new names
 */
export function renameWith(
  renamer: (name: string, context: RenameContext) => string | null,
  options?: RenameOptions
): Transformer {
  const {
    contexts,
    preserveOriginal = false,
  } = options ?? {};

  const contextSet = contexts ? new Set(contexts) : null;

  function shouldRenameInContext(context: RenameContext): boolean {
    return !contextSet || contextSet.has(context) || contextSet.has('reference');
  }

  function renameIdentifier(node: Identifier, context: RenameContext): Identifier | undefined {
    if (!shouldRenameInContext(context)) {
      return undefined;
    }

    const newName = renamer(node.name, context);
    if (newName === null || newName === node.name) {
      return undefined;
    }

    const renamed = updateNode(node, { name: newName });

    if (preserveOriginal) {
      renamed.ghidraInfo = {
        ...renamed.ghidraInfo,
        originalName: node.name,
      };
    }

    return renamed;
  }

  return createTransformer({
    visitIdentifier(node) {
      return renameIdentifier(node, 'reference');
    },
  });
}

/**
 * Rename Ghidra-style function names (FUN_XXXXXXXX) using a pattern
 */
export function renameGhidraFunctions(
  renames: Record<string, string>
): Transformer {
  return createRenameTransformer(renames, {
    contexts: ['function', 'reference'],
    preserveOriginal: true,
  });
}

/**
 * Rename Ghidra-style variable names (DAT_XXXXXXXX, param_N, local_N)
 */
export function renameGhidraVariables(
  renames: Record<string, string>
): Transformer {
  return createRenameTransformer(renames, {
    contexts: ['variable', 'parameter', 'reference'],
    preserveOriginal: true,
  });
}

/**
 * Automatically rename Ghidra identifiers using a naming convention function
 */
export function autoRenameGhidra(
  namer: (name: string, address?: string) => string | null
): Transformer {
  return renameWith((name, _context) => {
    // Extract address from Ghidra naming patterns
    const funMatch = name.match(/^FUN_([0-9a-fA-F]+)$/);
    if (funMatch) {
      return namer(name, funMatch[1]);
    }

    const datMatch = name.match(/^DAT_([0-9a-fA-F]+)$/);
    if (datMatch) {
      return namer(name, datMatch[1]);
    }

    // Handle param_N, local_N patterns
    if (/^(param|local)_\d+$/.test(name)) {
      return namer(name, undefined);
    }

    return null;
  }, { preserveOriginal: true });
}

// ============================================
// HELPERS
// ============================================

function normalizeRenameMap(renames: RenameMap): Map<string, string> {
  if (renames instanceof Map) {
    return renames;
  }
  return new Map(Object.entries(renames));
}

/**
 * Extract all identifiers that could be renamed from an AST
 */
export function extractRenameableIdentifiers(
  ast: ASTNode
): Map<string, { count: number; contexts: Set<RenameContext> }> {
  const result = new Map<string, { count: number; contexts: Set<RenameContext> }>();

  function record(name: string, context: RenameContext): void {
    const existing = result.get(name);
    if (existing) {
      existing.count++;
      existing.contexts.add(context);
    } else {
      result.set(name, { count: 1, contexts: new Set([context]) });
    }
  }

  // Use a simple traversal to find all identifiers
  const traverse = (node: ASTNode): void => {
    if (!node || typeof node !== 'object') return;

    if (node.kind === NodeKind.Identifier) {
      record((node as Identifier).name, 'reference');
    } else if (node.kind === NodeKind.FunctionDecl) {
      const fn = node as FunctionDecl;
      if (fn.name?.kind === NodeKind.Identifier) {
        record((fn.name as Identifier).name, 'function');
      }
    } else if (node.kind === NodeKind.VariableDecl) {
      record((node as VariableDecl).name.name, 'variable');
    } else if (node.kind === NodeKind.ParameterDecl) {
      const param = node as ParameterDecl;
      if (param.name) {
        record(param.name.name, 'parameter');
      }
    } else if (node.kind === NodeKind.FieldDecl) {
      record((node as FieldDecl).name.name, 'field');
    } else if (node.kind === NodeKind.MethodDecl) {
      const method = node as MethodDecl;
      if (method.name.kind === NodeKind.Identifier) {
        record((method.name as Identifier).name, 'method');
      }
    } else if (node.kind === NodeKind.ClassDecl || node.kind === NodeKind.StructDecl) {
      const cls = node as ClassDecl | StructDecl;
      if (cls.name) {
        record(cls.name.name, 'class');
      }
    } else if (node.kind === NodeKind.EnumDecl) {
      const en = node as EnumDecl;
      if (en.name) {
        record(en.name.name, 'enum');
      }
    } else if (node.kind === NodeKind.NamespaceDecl) {
      const ns = node as NamespaceDecl;
      if (ns.name) {
        record(ns.name.name, 'namespace');
      }
    }

    // Recurse into children
    for (const key of Object.keys(node)) {
      const value = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === 'object' && 'kind' in item) {
            traverse(item as ASTNode);
          }
        }
      } else if (value && typeof value === 'object' && 'kind' in value) {
        traverse(value as ASTNode);
      }
    }
  };

  traverse(ast);
  return result;
}
