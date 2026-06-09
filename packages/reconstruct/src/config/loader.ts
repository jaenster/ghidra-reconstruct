/**
 * Project config loader
 *
 * Loads and validates project.json files
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ProjectConfig } from './schema.js';

const CURRENT_VERSION = 1;

/**
 * Load a project config from a directory
 *
 * Looks for project.json in the given directory.
 * Returns null if no config file exists.
 */
export async function loadProjectConfig(
  dir: string
): Promise<ProjectConfig | null> {
  const configPath = path.join(dir, 'project.json');

  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as ProjectConfig;
    validate(parsed, configPath);
    const config = applyDefaults(parsed);
    await loadMethodConversionsFile(config, dir);
    return config;
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${configPath}: ${err.message}`);
    }
    if (isNodeError(err) && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * Load a project config from a specific file path
 */
export async function loadProjectConfigFromFile(
  filePath: string
): Promise<ProjectConfig> {
  const raw = await fs.readFile(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as ProjectConfig;
  validate(parsed, filePath);
  const config = applyDefaults(parsed);
  await loadMethodConversionsFile(config, path.dirname(filePath));
  return config;
}

/**
 * Load and merge an external methodConversions file if configured
 */
async function loadMethodConversionsFile(config: ProjectConfig, configDir: string): Promise<void> {
  if (!config.methodConversionsFile) return;

  const filePath = path.resolve(configDir, config.methodConversionsFile);
  const raw = await fs.readFile(filePath, 'utf-8');
  const entries = JSON.parse(raw);

  if (!Array.isArray(entries)) {
    throw new Error(`${filePath}: methodConversionsFile must contain a JSON array`);
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry.address) {
      throw new Error(`${filePath}: entry[${i}] missing "address"`);
    }
    if (!entry.className) {
      throw new Error(`${filePath}: entry[${i}] missing "className"`);
    }
  }

  // Merge: file entries are appended after any inline entries
  config.methodConversions = [...(config.methodConversions ?? []), ...entries];
}

/**
 * Validate a project config, throwing on errors
 */
function validate(config: ProjectConfig, source: string): void {
  if (typeof config.version !== 'number') {
    throw new Error(`${source}: missing or invalid "version" field`);
  }
  if (config.version > CURRENT_VERSION) {
    throw new Error(
      `${source}: config version ${config.version} is newer than supported (${CURRENT_VERSION})`
    );
  }
  if (typeof config.project !== 'string' || config.project.length === 0) {
    throw new Error(`${source}: missing or empty "project" field`);
  }

  // Validate overrides
  if (config.overrides) {
    if (!Array.isArray(config.overrides)) {
      throw new Error(`${source}: "overrides" must be an array`);
    }
    for (let i = 0; i < config.overrides.length; i++) {
      const o = config.overrides[i];
      if (!o.address) {
        throw new Error(`${source}: overrides[${i}] missing "address"`);
      }
      if (o.action !== 'replace' && o.action !== 'patch') {
        throw new Error(
          `${source}: overrides[${i}] invalid action "${o.action}" (must be "replace" or "patch")`
        );
      }
      if (o.action === 'replace' && !o.sourceFile) {
        throw new Error(
          `${source}: overrides[${i}] action "replace" requires "sourceFile"`
        );
      }
      if (o.action === 'patch' && (!o.patches || o.patches.length === 0)) {
        throw new Error(
          `${source}: overrides[${i}] action "patch" requires non-empty "patches" array`
        );
      }
    }
  }

  // Validate libraries
  if (config.libraries) {
    if (!Array.isArray(config.libraries)) {
      throw new Error(`${source}: "libraries" must be an array`);
    }
    for (let i = 0; i < config.libraries.length; i++) {
      const lib = config.libraries[i];
      if (!lib.address) {
        throw new Error(`${source}: libraries[${i}] missing "address"`);
      }
      if (!lib.symbol) {
        throw new Error(`${source}: libraries[${i}] missing "symbol"`);
      }
      if (!lib.header) {
        throw new Error(`${source}: libraries[${i}] missing "header"`);
      }
    }
  }

  // Validate method conversions
  if (config.methodConversions) {
    if (!Array.isArray(config.methodConversions)) {
      throw new Error(`${source}: "methodConversions" must be an array`);
    }
    for (let i = 0; i < config.methodConversions.length; i++) {
      const mc = config.methodConversions[i];
      if (!mc.address) {
        throw new Error(`${source}: methodConversions[${i}] missing "address"`);
      }
      if (!mc.className) {
        throw new Error(`${source}: methodConversions[${i}] missing "className"`);
      }
      if (mc.thisParam !== undefined && (typeof mc.thisParam !== 'number' || mc.thisParam < 0)) {
        throw new Error(
          `${source}: methodConversions[${i}] "thisParam" must be a non-negative number`
        );
      }
    }
  }

  // Validate type ownership
  if (config.typeOwnership) {
    if (!Array.isArray(config.typeOwnership)) {
      throw new Error(`${source}: "typeOwnership" must be an array`);
    }
    for (let i = 0; i < config.typeOwnership.length; i++) {
      const entry = config.typeOwnership[i];
      if (!entry.type) {
        throw new Error(`${source}: typeOwnership[${i}] missing "type"`);
      }
      if (!entry.header) {
        throw new Error(`${source}: typeOwnership[${i}] missing "header"`);
      }
    }
  }

  // Validate modules
  if (config.modules) {
    if (typeof config.modules !== 'object' || Array.isArray(config.modules)) {
      throw new Error(`${source}: "modules" must be an object`);
    }
    for (const [name, mod] of Object.entries(config.modules)) {
      if (!Array.isArray(mod.namespaces) || mod.namespaces.length === 0) {
        throw new Error(
          `${source}: modules.${name} must have a non-empty "namespaces" array`
        );
      }
      if (mod.dependencies !== undefined && !Array.isArray(mod.dependencies)) {
        throw new Error(
          `${source}: modules.${name} "dependencies" must be an array`
        );
      }
    }
  }

  // Validate autoMethodConversion
  if (config.autoMethodConversion) {
    const amc = config.autoMethodConversion;
    if (typeof amc.enabled !== 'boolean') {
      throw new Error(`${source}: autoMethodConversion.enabled must be a boolean`);
    }
    if (amc.maxFunctionSize !== undefined && (typeof amc.maxFunctionSize !== 'number' || amc.maxFunctionSize <= 0)) {
      throw new Error(`${source}: autoMethodConversion.maxFunctionSize must be a positive number`);
    }
  }

  // Validate targets
  if (config.targets) {
    if (typeof config.targets !== 'object' || Array.isArray(config.targets)) {
      throw new Error(`${source}: "targets" must be an object`);
    }
    for (const [name, target] of Object.entries(config.targets)) {
      const validTypes = ['interface', 'static_library', 'shared_library', 'executable'];
      if (!validTypes.includes(target.type)) {
        throw new Error(
          `${source}: targets.${name} invalid type "${target.type}"`
        );
      }
      if (target.dependencies) {
        for (const dep of target.dependencies) {
          if (!(dep in config.targets)) {
            throw new Error(
              `${source}: targets.${name} depends on unknown target "${dep}"`
            );
          }
        }
      }
    }
  }
}

/**
 * Apply default values to a loaded config
 */
function applyDefaults(config: ProjectConfig): ProjectConfig {
  return {
    ...config,
    overrides: config.overrides ?? [],
    libraries: config.libraries ?? [],
    libraryDetection: config.libraryDetection ?? { enabled: false },
    targets: config.targets ?? {},
    methodConversions: config.methodConversions ?? [],
    typeOwnership: config.typeOwnership ?? [],
  };
}

/**
 * Normalize an address to lowercase with 0x prefix for consistent lookups
 */
export function normalizeAddress(address: string): string {
  const cleaned = address.toLowerCase().replace(/^0x/, '');
  return '0x' + cleaned;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
