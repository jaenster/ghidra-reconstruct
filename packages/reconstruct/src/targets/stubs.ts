/**
 * Stub generation for cross-target dependencies
 *
 * When a target calls functions from another target,
 * we generate forward declarations (stubs) so the target
 * can compile independently.
 */

import type { ExtractedFunction } from '../types.js';
import type { ResolvedTarget } from './index.js';

/**
 * Generate a stubs.h file for a target
 *
 * Contains forward declarations for all functions this target calls
 * that live in other targets.
 */
export function generateStubsHeader(
  target: ResolvedTarget,
  allTargets: Map<string, ResolvedTarget>
): string | null {
  // Collect all external functions we need stubs for
  const stubs: { targetName: string; functions: ExtractedFunction[] }[] = [];

  for (const [depTargetName, funcNames] of target.externalDeps) {
    const depTarget = allTargets.get(depTargetName);
    if (!depTarget) continue;

    const depFunctions = funcNames
      .map(name => depTarget.functions.find(f => f.name === name || f.address === name))
      .filter((f): f is ExtractedFunction => f !== undefined);

    if (depFunctions.length > 0) {
      stubs.push({ targetName: depTargetName, functions: depFunctions });
    }
  }

  if (stubs.length === 0) return null;

  const lines: string[] = [];

  lines.push('#pragma once');
  lines.push('');
  lines.push('/**');
  lines.push(` * External function declarations for ${target.name} target`);
  lines.push(' *');
  lines.push(' * Forward declarations for functions called from other targets.');
  lines.push(' * These are resolved at link time.');
  lines.push(' */');
  lines.push('');
  lines.push('#include <cstdint>');
  lines.push('#include <cstddef>');
  lines.push('');

  for (const { targetName, functions } of stubs) {
    lines.push(`// From target: ${targetName}`);

    // Group by namespace
    const byNamespace = new Map<string | undefined, ExtractedFunction[]>();
    for (const func of functions) {
      const ns = func.namespace;
      if (!byNamespace.has(ns)) {
        byNamespace.set(ns, []);
      }
      byNamespace.get(ns)!.push(func);
    }

    for (const [ns, nsFunctions] of byNamespace) {
      if (ns) {
        lines.push(`namespace ${ns} {`);
      }

      for (const func of nsFunctions) {
        const params = func.parameters
          .map(p => `${p.dataType} ${p.name}`)
          .join(', ');
        lines.push(`${func.returnType} ${func.name}(${params});`);
      }

      if (ns) {
        lines.push(`} // namespace ${ns}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
