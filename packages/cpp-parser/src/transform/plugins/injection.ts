/**
 * Code Injection System
 *
 * Allows transform plugins to inject code (includes, inline functions, macros)
 * into the generated output.
 */

import type { CodeInjection, InjectionContext } from './types.js';

/**
 * Default implementation of InjectionContext
 */
export class InjectionCollector implements InjectionContext {
  private injections: Map<string, CodeInjection> = new Map();

  /**
   * Add an injection. If ID already exists, it's deduplicated.
   */
  inject(injection: CodeInjection): void {
    if (!this.injections.has(injection.id)) {
      this.injections.set(injection.id, injection);
    }
  }

  /**
   * Check if an injection with this ID already exists
   */
  has(id: string): boolean {
    return this.injections.has(id);
  }

  /**
   * Get all injections, sorted by priority and dependencies
   */
  getAll(): CodeInjection[] {
    const all = Array.from(this.injections.values());

    // Sort by priority first
    all.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

    // TODO: Topological sort by dependencies if needed
    return all;
  }

  /**
   * Generate the preamble code (includes + definitions)
   */
  generatePreamble(): string {
    const all = this.getAll();
    const lines: string[] = [];

    // Group by type
    const includes = all.filter(i => i.type === 'include');
    const macros = all.filter(i => i.type === 'macro');
    const typedefs = all.filter(i => i.type === 'typedef');
    const functions = all.filter(i => i.type === 'function');
    const preambles = all.filter(i => i.type === 'preamble');

    // Emit includes first
    if (includes.length > 0) {
      // System includes first
      const sysIncludes = includes.filter(i => i.isSystemInclude);
      const localIncludes = includes.filter(i => !i.isSystemInclude);

      for (const inc of sysIncludes) {
        lines.push(inc.code);
      }
      for (const inc of localIncludes) {
        lines.push(inc.code);
      }
      lines.push('');
    }

    // Emit macros
    if (macros.length > 0) {
      for (const macro of macros) {
        lines.push(macro.code);
      }
      lines.push('');
    }

    // Emit typedefs
    if (typedefs.length > 0) {
      for (const td of typedefs) {
        lines.push(td.code);
      }
      lines.push('');
    }

    // Emit general preamble code
    if (preambles.length > 0) {
      for (const p of preambles) {
        lines.push(p.code);
      }
      lines.push('');
    }

    // Emit inline functions last
    if (functions.length > 0) {
      for (const fn of functions) {
        // Add attributes if specified
        if (fn.attributes && fn.attributes.length > 0) {
          const attrs = fn.attributes.map(a => `__attribute__((${a}))`).join(' ');
          lines.push(`${attrs}`);
        }
        lines.push(fn.code);
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  /**
   * Clear all injections
   */
  clear(): void {
    this.injections.clear();
  }

  /**
   * Get count of injections
   */
  get size(): number {
    return this.injections.size;
  }
}

// ============================================
// HELPER FUNCTIONS FOR CREATING INJECTIONS
// ============================================

/**
 * Create an include injection
 */
export function createInclude(
  header: string,
  isSystem: boolean = false
): CodeInjection {
  const brackets = isSystem ? `<${header}>` : `"${header}"`;
  return {
    id: `include:${header}`,
    type: 'include',
    code: `#include ${brackets}`,
    isSystemInclude: isSystem,
    priority: 0,
  };
}

/**
 * Create an inline function injection
 */
export function createInlineFunction(
  name: string,
  code: string,
  attributes: string[] = ['always_inline', 'inline']
): CodeInjection {
  return {
    id: `function:${name}`,
    type: 'function',
    code,
    attributes,
    priority: 50,
  };
}

/**
 * Create a macro injection
 */
export function createMacro(
  name: string,
  code: string
): CodeInjection {
  return {
    id: `macro:${name}`,
    type: 'macro',
    code,
    priority: 10,
  };
}

/**
 * Create a typedef injection
 */
export function createTypedef(
  name: string,
  code: string
): CodeInjection {
  return {
    id: `typedef:${name}`,
    type: 'typedef',
    code,
    priority: 20,
  };
}
