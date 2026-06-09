/**
 * Caching for decompiled function results
 *
 * Caches transformed pseudocode based on a hash of the raw decompiled output.
 * If the decompiled code hasn't changed, we can skip re-running the transform pipeline.
 */

import { createHash } from 'crypto';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';

// =============================================================================
// Types
// =============================================================================

export interface CacheEntry {
  /** Hash of the raw pseudocode */
  pseudocodeHash: string;

  /** Transformed pseudocode */
  transformedCode: string;

  /** Original raw pseudocode (for debugging) */
  rawPseudocode: string;

  /** Transform pipeline version/config hash */
  pipelineVersion: string;

  /** When this was cached */
  cachedAt: number;

  /** Any warnings from transformation */
  warnings?: string[];
}

export interface AddressCacheEntry {
  /** Raw decompiled pseudocode */
  code: string;

  /** When this was cached */
  cachedAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  entries: number;
  hitRate: number;
}

export interface CacheOptions {
  /** Enable caching (default: true) */
  enabled?: boolean;

  /** Directory for disk cache (default: in-memory only) */
  cacheDir?: string;

  /** Max entries in memory cache (default: 1000) */
  maxMemoryEntries?: number;

  /** TTL for cache entries in ms (default: 24 hours) */
  ttlMs?: number;

  /** Pipeline version string for cache invalidation */
  pipelineVersion?: string;
}

// =============================================================================
// Cache Implementation
// =============================================================================

/**
 * Function result cache with memory and optional disk backing
 */
export class FunctionCache {
  private memoryCache: Map<string, CacheEntry> = new Map();
  private addressCache: Map<string, AddressCacheEntry> = new Map();
  private stats = { hits: 0, misses: 0 };
  private options: Required<CacheOptions>;

  constructor(options: CacheOptions = {}) {
    this.options = {
      enabled: options.enabled ?? true,
      cacheDir: options.cacheDir ?? '',
      maxMemoryEntries: options.maxMemoryEntries ?? 1000,
      ttlMs: options.ttlMs ?? 24 * 60 * 60 * 1000, // 24 hours
      pipelineVersion: options.pipelineVersion ?? '1.0.0',
    };
  }

  /**
   * Get cached result for a function's pseudocode
   */
  async get(pseudocode: string): Promise<CacheEntry | null> {
    if (!this.options.enabled) return null;

    const hash = this.hashPseudocode(pseudocode);
    const cacheKey = this.makeCacheKey(hash);

    // Check memory cache first
    const memEntry = this.memoryCache.get(cacheKey);
    if (memEntry && this.isValid(memEntry)) {
      this.stats.hits++;
      return memEntry;
    }

    // Check disk cache if configured
    if (this.options.cacheDir) {
      const diskEntry = await this.loadFromDisk(cacheKey);
      if (diskEntry && this.isValid(diskEntry)) {
        // Promote to memory cache
        this.setMemory(cacheKey, diskEntry);
        this.stats.hits++;
        return diskEntry;
      }
    }

    this.stats.misses++;
    return null;
  }

  /**
   * Store result in cache
   */
  async set(
    pseudocode: string,
    transformedCode: string,
    warnings?: string[]
  ): Promise<void> {
    if (!this.options.enabled) return;

    const hash = this.hashPseudocode(pseudocode);
    const cacheKey = this.makeCacheKey(hash);

    const entry: CacheEntry = {
      pseudocodeHash: hash,
      transformedCode,
      rawPseudocode: pseudocode,
      pipelineVersion: this.options.pipelineVersion,
      cachedAt: Date.now(),
      warnings,
    };

    // Store in memory
    this.setMemory(cacheKey, entry);

    // Store on disk if configured
    if (this.options.cacheDir) {
      await this.saveToDisk(cacheKey, entry);
    }
  }

  /**
   * Check if pseudocode is cached
   */
  async has(pseudocode: string): Promise<boolean> {
    const result = await this.get(pseudocode);
    return result !== null;
  }

  /**
   * Clear all cached entries
   */
  async clear(): Promise<void> {
    this.memoryCache.clear();
    this.addressCache.clear();
    this.stats = { hits: 0, misses: 0 };
  }

  /**
   * Get last known decompiled output for a function address
   */
  async getByAddress(address: string): Promise<string | null> {
    if (!this.options.enabled) return null;

    const key = this.makeAddressKey(address);
    const memEntry = this.addressCache.get(key);
    if (memEntry && this.isAddressEntryValid(memEntry)) {
      return memEntry.code;
    }

    if (this.options.cacheDir) {
      const diskEntry = await this.loadAddressFromDisk(key);
      if (diskEntry && this.isAddressEntryValid(diskEntry)) {
        this.addressCache.set(key, diskEntry);
        return diskEntry.code;
      }
    }

    return null;
  }

  /**
   * Store last known decompiled output for a function address
   */
  async setByAddress(address: string, code: string): Promise<void> {
    if (!this.options.enabled) return;

    const key = this.makeAddressKey(address);
    const entry: AddressCacheEntry = {
      code,
      cachedAt: Date.now(),
    };

    this.addressCache.set(key, entry);
    if (this.options.cacheDir) {
      await this.saveAddressToDisk(key, entry);
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const total = this.stats.hits + this.stats.misses;
    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      entries: this.memoryCache.size,
      hitRate: total > 0 ? this.stats.hits / total : 0,
    };
  }

  /**
   * Preload cache from disk
   */
  async preload(): Promise<number> {
    if (!this.options.cacheDir) return 0;

    // This would scan the cache directory and load entries
    // For now, we just do lazy loading
    return 0;
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  private hashPseudocode(pseudocode: string): string {
    return createHash('sha256').update(pseudocode).digest('hex').slice(0, 16);
  }

  private makeCacheKey(hash: string): string {
    // Include pipeline version in key for invalidation
    return `${this.options.pipelineVersion}:${hash}`;
  }

  private makeAddressKey(address: string): string {
    const sanitized = address.replace(/[^a-zA-Z0-9_-]/g, '_');
    // Address cache is raw decompile output, independent of transform pipeline.
    return `addr:${sanitized}`;
  }

  private isValid(entry: CacheEntry): boolean {
    // Check TTL
    const age = Date.now() - entry.cachedAt;
    if (age > this.options.ttlMs) return false;

    // Check pipeline version
    if (entry.pipelineVersion !== this.options.pipelineVersion) return false;

    return true;
  }

  private isAddressEntryValid(entry: AddressCacheEntry): boolean {
    const age = Date.now() - entry.cachedAt;
    return age <= this.options.ttlMs;
  }

  private setMemory(key: string, entry: CacheEntry): void {
    // Evict oldest entries if at capacity
    if (this.memoryCache.size >= this.options.maxMemoryEntries) {
      const oldestKey = this.memoryCache.keys().next().value;
      if (oldestKey) {
        this.memoryCache.delete(oldestKey);
      }
    }

    this.memoryCache.set(key, entry);
  }

  private getDiskPath(key: string): string {
    // Use first 2 chars of hash for directory sharding
    const safeKey = key.replace(/[^a-zA-Z0-9]/g, '_');
    const shard = safeKey.slice(0, 2);
    return join(this.options.cacheDir, shard, `${safeKey}.json`);
  }

  private async loadFromDisk(key: string): Promise<CacheEntry | null> {
    try {
      const path = this.getDiskPath(key);
      if (!existsSync(path)) return null;

      const data = await readFile(path, 'utf-8');
      return JSON.parse(data) as CacheEntry;
    } catch {
      return null;
    }
  }

  private async loadAddressFromDisk(key: string): Promise<AddressCacheEntry | null> {
    try {
      const path = this.getDiskPath(key);
      if (!existsSync(path)) return null;

      const data = await readFile(path, 'utf-8');
      return JSON.parse(data) as AddressCacheEntry;
    } catch {
      return null;
    }
  }

  private async saveToDisk(key: string, entry: CacheEntry): Promise<void> {
    try {
      const path = this.getDiskPath(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(entry, null, 2));
    } catch {
      // Disk cache is best-effort
    }
  }

  private async saveAddressToDisk(key: string, entry: AddressCacheEntry): Promise<void> {
    try {
      const path = this.getDiskPath(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(entry, null, 2));
    } catch {
      // Disk cache is best-effort
    }
  }
}

// =============================================================================
// Singleton / Default Cache
// =============================================================================

let defaultCache: FunctionCache | null = null;

/**
 * Get or create the default function cache
 */
export function getDefaultCache(options?: CacheOptions): FunctionCache {
  if (!defaultCache) {
    defaultCache = new FunctionCache(options);
  }
  return defaultCache;
}

/**
 * Reset the default cache (useful for testing)
 */
export function resetDefaultCache(): void {
  defaultCache = null;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Compute a version hash for the transform pipeline configuration
 * This is used to invalidate cache when transforms change
 */
export function computePipelineVersion(
  pluginIds: string[],
  pluginVersions: Record<string, string>
): string {
  const versionString = pluginIds
    .sort()
    .map(id => `${id}:${pluginVersions[id] || '1.0.0'}`)
    .join(',');

  return createHash('sha256').update(versionString).digest('hex').slice(0, 8);
}

// =============================================================================
// Export All C Cache
// =============================================================================

export interface ExportedFunction {
  name: string;
  address: string;
  signature: string;
  namespace?: string;
  code: string;
  success: boolean;
  error?: string;
}

export interface ExportAllCResult {
  cacheVersion: number;
  functionCount: number;
  typeCount: number;
  headerCode?: string;
  implementationCode: string;
  functions: ExportedFunction[];
}

export interface ExportAllCCacheEntry {
  /** Cache version from Ghidra worker */
  cacheVersion: number;

  /** The cached export result */
  result: ExportAllCResult;

  /** When this was cached */
  cachedAt: number;
}

/**
 * Cache for the full C code export from Ghidra
 * Uses the worker's cacheVersion to detect when modifications have been made
 */
export class ExportAllCCache {
  private cached: ExportAllCCacheEntry | null = null;

  /**
   * Get the cached export if it's still valid
   * @param currentVersion The current cache version from the worker
   */
  get(currentVersion: number): ExportAllCResult | null {
    if (!this.cached) return null;

    // Cache is valid only if versions match
    if (this.cached.cacheVersion !== currentVersion) {
      this.cached = null;
      return null;
    }

    return this.cached.result;
  }

  /**
   * Store the export result in cache
   */
  set(result: ExportAllCResult): void {
    this.cached = {
      cacheVersion: result.cacheVersion,
      result,
      cachedAt: Date.now(),
    };
  }

  /**
   * Clear the cache
   */
  clear(): void {
    this.cached = null;
  }

  /**
   * Check if cache is valid for the given version
   */
  isValid(currentVersion: number): boolean {
    return this.cached !== null && this.cached.cacheVersion === currentVersion;
  }

  /**
   * Get cache info (for debugging)
   */
  getInfo(): { version: number | null; cachedAt: number | null; functionCount: number } {
    return {
      version: this.cached?.cacheVersion ?? null,
      cachedAt: this.cached?.cachedAt ?? null,
      functionCount: this.cached?.result.functionCount ?? 0,
    };
  }
}

// Singleton instance
let exportAllCCache: ExportAllCCache | null = null;

/**
 * Get or create the export all C cache
 */
export function getExportAllCCache(): ExportAllCCache {
  if (!exportAllCCache) {
    exportAllCCache = new ExportAllCCache();
  }
  return exportAllCCache;
}

/**
 * Reset the export all C cache
 */
export function resetExportAllCCache(): void {
  exportAllCCache = null;
}
