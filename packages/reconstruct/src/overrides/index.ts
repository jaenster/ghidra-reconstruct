/**
 * Function override resolution
 *
 * Looks up overrides by function address and applies them
 * (full replacement from source file, or partial patches).
 */

import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { OverrideEntry, ProjectConfig } from '../config/schema.js';
import { normalizeAddress } from '../config/loader.js';
import { applyPatches } from './patches.js';

export { applyPatches } from './patches.js';

/**
 * The tracked overrides directory: `<repo>/overrides`, the same three levels up from
 * `src/overrides/` and from `dist/overrides/`.
 */
export const BUILTIN_OVERRIDES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../../../../overrides'
);

/**
 * The overrides the repository itself ships, from `overrides/registry.json`, with each
 * `sourceFile` made absolute.
 *
 * They used to be registered only in `project/project.json`, which is gitignored: a run
 * without that file (a fresh checkout, a worktree, the container) emitted the decompiler's
 * body for the functions the bodies exist for, frame artifacts and all, and said nothing.
 * The bodies are part of the generator's output contract, so their registration is too.
 */
export function loadBuiltinOverrides(dir: string = BUILTIN_OVERRIDES_DIR): OverrideEntry[] {
  const file = path.join(dir, 'registry.json');
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const parsed = JSON.parse(raw) as { overrides?: OverrideEntry[] };
  if (!Array.isArray(parsed.overrides)) throw new Error(`${file}: "overrides" must be an array`);
  return parsed.overrides.map((e, i) => {
    if (!e.address) throw new Error(`${file}: overrides[${i}] missing "address"`);
    if (e.action !== 'replace' && e.action !== 'patch') {
      throw new Error(`${file}: overrides[${i}] invalid action "${e.action}"`);
    }
    if (e.action === 'replace' && !e.sourceFile) {
      throw new Error(`${file}: overrides[${i}] action "replace" requires "sourceFile"`);
    }
    return e.sourceFile ? { ...e, sourceFile: path.resolve(dir, e.sourceFile) } : e;
  });
}

/**
 * Index of overrides keyed by normalized address for O(1) lookup.
 *
 * The repository's own overrides are registered first; a project entry for the same
 * address replaces one of them.
 */
export class OverrideRegistry {
  private byAddress = new Map<string, OverrideEntry>();

  constructor(
    private config: ProjectConfig,
    private projectDir: string,
    builtins: OverrideEntry[] = loadBuiltinOverrides()
  ) {
    for (const entry of [...builtins, ...(config.overrides ?? [])]) {
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
    // A replacement with no body would emit an empty function that compiles: fatal.
    if (!entry.sourceFile) {
      throw new Error(`Override at ${entry.address}: action "replace" but no sourceFile`);
    }
    const content = await fs.readFile(this.resolveSource(entry.sourceFile), 'utf-8');
    return { body: indentBody(content.trim()), warnings: [] };
  }

  /** A `sourceFile` as a path: absolute as given, else relative to the project dir. */
  resolveSource(sourceFile: string): string {
    return path.resolve(this.projectDir, sourceFile);
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
 * Create an override registry from the repository's overrides and a project config.
 * Returns null when neither has any.
 */
export function createOverrideRegistry(
  config: ProjectConfig | undefined,
  projectDir: string
): OverrideRegistry | null {
  const builtins = loadBuiltinOverrides();
  if (builtins.length === 0 && !config?.overrides?.length) return null;
  return new OverrideRegistry(config ?? ({} as ProjectConfig), projectDir, builtins);
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
