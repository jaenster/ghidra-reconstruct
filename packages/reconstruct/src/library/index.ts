/**
 * Library function registry
 *
 * Maps known library functions (CRT, stdlib) by address.
 * Used to exclude them from generated code and rewrite calls
 * to use standard library symbols.
 */

import type { ProjectConfig, LibraryEntry } from '../config/schema.js';
import { normalizeAddress } from '../config/loader.js';

/**
 * Registry for library function lookups
 */
export class LibraryRegistry {
  private byAddress = new Map<string, LibraryEntry>();
  private byName = new Map<string, LibraryEntry>();
  private bySymbol = new Map<string, LibraryEntry>();

  constructor(entries: LibraryEntry[]) {
    for (const entry of entries) {
      this.byAddress.set(normalizeAddress(entry.address), entry);
      if (entry.name) {
        this.byName.set(entry.name, entry);
      }
      this.bySymbol.set(entry.symbol, entry);
    }
  }

  /**
   * Look up a library function by its address
   */
  get(address: string): LibraryEntry | undefined {
    return this.byAddress.get(normalizeAddress(address));
  }

  /**
   * Look up a library function by its Ghidra name
   */
  getByName(name: string): LibraryEntry | undefined {
    return this.byName.get(name);
  }

  /**
   * Look up a library function by its standard symbol
   */
  getBySymbol(symbol: string): LibraryEntry | undefined {
    return this.bySymbol.get(symbol);
  }

  /**
   * Check if an address is a known library function
   */
  has(address: string): boolean {
    return this.byAddress.has(normalizeAddress(address));
  }

  /**
   * Get all unique headers needed
   */
  getHeaders(): string[] {
    const headers = new Set<string>();
    for (const entry of this.byAddress.values()) {
      headers.add(entry.header);
    }
    return [...headers].sort();
  }

  /**
   * Get all entries of a given category
   */
  getByCategory(category: string): LibraryEntry[] {
    const results: LibraryEntry[] = [];
    for (const entry of this.byAddress.values()) {
      if (entry.category === category) {
        results.push(entry);
      }
    }
    return results;
  }

  get size(): number {
    return this.byAddress.size;
  }

  /**
   * Get all entries
   */
  entries(): IterableIterator<LibraryEntry> {
    return this.byAddress.values();
  }
}

/**
 * Create a library registry from project config.
 * Returns null if no config or no library entries.
 */
export function createLibraryRegistry(
  config: ProjectConfig | undefined
): LibraryRegistry | null {
  if (!config || !config.libraries || config.libraries.length === 0) {
    return null;
  }
  return new LibraryRegistry(config.libraries);
}
