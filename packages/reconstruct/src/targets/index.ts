/**
 * Build target resolution
 *
 * Partitions functions into targets based on project config.
 * Functions not matching any target go into "unsorted".
 */

import type { ExtractedFunction, ExtractedNamespace } from '../types.js';
import type { TargetConfig } from '../config/schema.js';

/**
 * A resolved target with its assigned functions
 */
export interface ResolvedTarget {
  name: string;
  config: TargetConfig;
  functions: ExtractedFunction[];
  /** Functions from other targets that this target calls */
  externalDeps: Map<string, string[]>; // targetName -> [functionName]
}

/**
 * Result of target resolution
 */
export interface TargetResolution {
  targets: Map<string, ResolvedTarget>;
  unsorted: ExtractedFunction[];
}

/**
 * Resolve functions into targets based on config
 */
export function resolveTargets(
  functions: ExtractedFunction[],
  namespaces: ExtractedNamespace[],
  targetConfigs: Record<string, TargetConfig>
): TargetResolution {
  const targets = new Map<string, ResolvedTarget>();
  const assigned = new Set<string>(); // function addresses that have been assigned

  // Build namespace hierarchy for recursive matching
  const nsChildren = buildNamespaceHierarchy(namespaces);

  // Initialize targets
  for (const [name, config] of Object.entries(targetConfigs)) {
    targets.set(name, {
      name,
      config,
      functions: [],
      externalDeps: new Map(),
    });
  }

  // Assign functions to targets
  for (const func of functions) {
    if (func.isLibrary) continue; // Library functions don't go in any target

    const targetName = findTargetForFunction(func, targetConfigs, nsChildren);
    if (targetName) {
      targets.get(targetName)!.functions.push(func);
      assigned.add(func.address);
    }
  }

  // Collect unsorted functions
  const unsorted = functions.filter(
    f => !assigned.has(f.address) && !f.isLibrary
  );

  // Resolve cross-target dependencies
  const funcToTarget = new Map<string, string>();
  for (const [targetName, target] of targets) {
    for (const func of target.functions) {
      funcToTarget.set(func.name, targetName);
      funcToTarget.set(func.address, targetName);
    }
  }

  for (const [targetName, target] of targets) {
    for (const func of target.functions) {
      for (const called of func.calledFunctions ?? []) {
        const calledTarget = funcToTarget.get(called);
        if (calledTarget && calledTarget !== targetName) {
          if (!target.externalDeps.has(calledTarget)) {
            target.externalDeps.set(calledTarget, []);
          }
          const deps = target.externalDeps.get(calledTarget)!;
          if (!deps.includes(called)) {
            deps.push(called);
          }
        }
      }
    }
  }

  return { targets, unsorted };
}

/**
 * Find which target a function belongs to
 */
function findTargetForFunction(
  func: ExtractedFunction,
  targetConfigs: Record<string, TargetConfig>,
  nsChildren: Map<string, string[]>
): string | null {
  for (const [name, config] of Object.entries(targetConfigs)) {
    // Interface targets don't contain functions
    if (config.type === 'interface') continue;

    // Check namespace match (recursive)
    if (config.namespaces && func.namespace) {
      for (const ns of config.namespaces) {
        if (matchesNamespace(func.namespace, ns, nsChildren)) {
          return name;
        }
      }
    }

    // Check explicit function list
    if (config.functions) {
      if (config.functions.includes(func.name) || config.functions.includes(func.address)) {
        return name;
      }
    }

    // Check address ranges
    if (config.addressRanges) {
      const addr = parseInt(func.address, 16);
      for (const range of config.addressRanges) {
        const start = parseInt(range.start, 16);
        const end = parseInt(range.end, 16);
        if (addr >= start && addr <= end) {
          return name;
        }
      }
    }
  }

  return null;
}

/**
 * Check if a function's namespace matches a target namespace (recursively)
 */
function matchesNamespace(
  funcNs: string,
  targetNs: string,
  nsChildren: Map<string, string[]>
): boolean {
  // Direct match
  if (funcNs === targetNs) return true;

  // Check if funcNs starts with targetNs:: (child namespace)
  if (funcNs.startsWith(targetNs + '::')) return true;

  return false;
}

/**
 * Build a map of namespace -> child namespaces
 */
function buildNamespaceHierarchy(
  namespaces: ExtractedNamespace[]
): Map<string, string[]> {
  const children = new Map<string, string[]>();

  for (const ns of namespaces) {
    if (ns.parentNamespace) {
      if (!children.has(ns.parentNamespace)) {
        children.set(ns.parentNamespace, []);
      }
      children.get(ns.parentNamespace)!.push(ns.fullPath);
    }
  }

  return children;
}

/**
 * Get the target directory name for file organization
 */
export function getTargetDirectory(targetName: string): string {
  return targetName.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}
