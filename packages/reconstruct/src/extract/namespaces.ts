/**
 * Namespace extraction from Ghidra
 */

import type { GhidraConnection, ExtractedNamespace } from '../types.js';

/**
 * Options for namespace extraction
 */
export interface NamespaceExtractionOptions {
  /** Filter by name pattern */
  filter?: string;

  /** Maximum number to extract */
  limit?: number;

  /** Offset for pagination */
  offset?: number;
}

interface GhidraNamespaceInfo {
  name: string;
  fullPath: string;
  address?: string;
  parentNamespace?: string;
  isClass: boolean;
  functionCount: number;
}

/**
 * Extract namespaces from Ghidra with pagination
 */
export async function extractNamespaces(
  connection: GhidraConnection,
  options: NamespaceExtractionOptions = {}
): Promise<{
  namespaces: ExtractedNamespace[];
  total: number;
}> {
  const { filter, limit = 100, offset = 0 } = options;

  const params: Record<string, unknown> = {
    offset,
    limit,
  };

  if (filter) params.filter = filter;
  params._commandTimeout = 300000; // 5 minutes

  const result = await connection.sendCommand<{
    namespaces: GhidraNamespaceInfo[];
    total: number;
  }>('list_namespaces', params);

  return {
    namespaces: result.namespaces.map(mapNamespaceInfo),
    total: result.total,
  };
}

/**
 * Extract all namespaces from Ghidra (handles pagination)
 */
export async function extractAllNamespaces(
  connection: GhidraConnection,
  options: Omit<NamespaceExtractionOptions, 'limit' | 'offset'> = {}
): Promise<ExtractedNamespace[]> {
  const allNamespaces: ExtractedNamespace[] = [];
  const pageSize = 100;
  let offset = 0;
  let total = 0;

  do {
    const result = await extractNamespaces(connection, {
      ...options,
      limit: pageSize,
      offset,
    });

    allNamespaces.push(...result.namespaces);
    total = result.total;
    offset += pageSize;
  } while (offset < total);

  return allNamespaces;
}

/**
 * Build a namespace tree from flat namespace list
 */
export function buildNamespaceTree(
  namespaces: ExtractedNamespace[]
): NamespaceNode {
  const root: NamespaceNode = {
    name: '',
    fullPath: '',
    isClass: false,
    functionCount: 0,
    children: new Map(),
  };

  for (const ns of namespaces) {
    const parts = ns.fullPath.split('::').filter(p => p);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          fullPath: parts.slice(0, i + 1).join('::'),
          isClass: false,
          functionCount: 0,
          children: new Map(),
        });
      }
      current = current.children.get(part)!;
    }

    // Update the final node with actual data
    current.isClass = ns.isClass;
    current.functionCount = ns.functionCount;
  }

  return root;
}

export interface NamespaceNode {
  name: string;
  fullPath: string;
  isClass: boolean;
  functionCount: number;
  children: Map<string, NamespaceNode>;
}

/**
 * Get classes (namespaces marked as class) from namespace list
 */
export function getClasses(namespaces: ExtractedNamespace[]): ExtractedNamespace[] {
  return namespaces.filter(ns => ns.isClass);
}

/**
 * Get top-level namespaces
 */
export function getTopLevelNamespaces(
  namespaces: ExtractedNamespace[]
): ExtractedNamespace[] {
  return namespaces.filter(ns => !ns.parentNamespace);
}

function mapNamespaceInfo(info: GhidraNamespaceInfo): ExtractedNamespace {
  return {
    name: info.name,
    fullPath: info.fullPath,
    isClass: info.isClass,
    parentNamespace: info.parentNamespace,
    functionCount: info.functionCount,
  };
}
