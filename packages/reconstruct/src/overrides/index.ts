/**
 * Function override resolution
 *
 * Looks up overrides by function address and applies them
 * (full replacement from source file, or partial patches).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { OverrideEntry, ProjectConfig } from '../config/schema.js';
import { normalizeAddress } from '../config/loader.js';
import { applyPatches } from './patches.js';

export { applyPatches } from './patches.js';

/**
 * Index of overrides keyed by normalized address for O(1) lookup
 */
export class OverrideRegistry {
  private byAddress = new Map<string, OverrideEntry>();

  constructor(
    private config: ProjectConfig,
    private projectDir: string
  ) {
    for (const entry of config.overrides ?? []) {
      this.byAddress.set(normalizeAddress(entry.address), entry);
    }
  }

  /**
   * Check if a function at the given address has an override
   */
  has(address: string): boolean {
    return this.byAddress.has(normalizeAddress(address));
  }

  /**
   * Get the override entry for an address (or undefined)
   */
  get(address: string): OverrideEntry | undefined {
    return this.byAddress.get(normalizeAddress(address));
  }

  get size(): number {
    return this.byAddress.size;
  }

  getProjectDir(): string {
    return this.projectDir;
  }

  /**
   * Apply the override for a function, returning the new body.
   *
   * - "replace": reads the sourceFile and returns its content
   * - "patch": applies patches to the original decompiled body
   *
   * Returns null if no override exists for this address.
   */
  async applyOverride(
    address: string,
    originalBody: string
  ): Promise<{ body: string; warnings: string[] } | null> {
    const entry = this.get(address);
    if (!entry) return null;

    if (entry.action === 'replace') {
      return this.applyReplace(entry);
    } else if (entry.action === 'patch') {
      return this.applyPatch(entry, originalBody);
    }

    return null;
  }

  private async applyReplace(
    entry: OverrideEntry
  ): Promise<{ body: string; warnings: string[] }> {
    if (!entry.sourceFile) {
      return {
        body: '    // ERROR: override has action "replace" but no sourceFile',
        warnings: [`Override at ${entry.address}: missing sourceFile`],
      };
    }

    const filePath = path.resolve(this.projectDir, entry.sourceFile);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return {
        body: indentBody(content.trim()),
        warnings: [],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        body: `    // ERROR: could not read override file: ${entry.sourceFile}`,
        warnings: [`Override at ${entry.address}: ${msg}`],
      };
    }
  }

  private applyPatch(
    entry: OverrideEntry,
    originalBody: string
  ): { body: string; warnings: string[] } {
    if (!entry.patches || entry.patches.length === 0) {
      return { body: originalBody, warnings: [] };
    }

    const result = applyPatches(originalBody, entry.patches);
    const warnings = result.warnings.map(
      w => `Override at ${entry.address}: ${w}`
    );

    return { body: result.code, warnings };
  }
}

/**
 * Create an override registry from a project config.
 * Returns null if no config or no overrides.
 */
export function createOverrideRegistry(
  config: ProjectConfig | undefined,
  projectDir: string
): OverrideRegistry | null {
  if (!config || !config.overrides || config.overrides.length === 0) {
    return null;
  }
  return new OverrideRegistry(config, projectDir);
}

/**
 * Indent a body block consistently (4 spaces)
 */
function indentBody(code: string): string {
  return code
    .split('\n')
    .map(line => (line.trim() ? '    ' + line : ''))
    .join('\n');
}
