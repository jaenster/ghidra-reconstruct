/**
 * String literal extraction from Ghidra
 */

import type { GhidraConnection, ExtractedString } from '../types.js';

/**
 * Options for string extraction
 */
export interface StringExtractionOptions {
  /** Filter by pattern */
  filter?: string;

  /** Minimum string length */
  minLength?: number;

  /** Maximum number to extract */
  limit?: number;

  /** Offset for pagination */
  offset?: number;
}

interface GhidraStringInfo {
  address: string;
  value: string;
  length: number;
  encoding: string;
  inFunction?: string;
  xrefCount: number;
}

/**
 * Extract strings from Ghidra with pagination
 */
export async function extractStrings(
  connection: GhidraConnection,
  options: StringExtractionOptions = {}
): Promise<{
  strings: ExtractedString[];
  total: number;
}> {
  const { filter, minLength = 4, limit = 100, offset = 0 } = options;

  const params: Record<string, unknown> = {
    offset,
    limit,
    minLength,
  };

  if (filter) params.filter = filter;
  params._commandTimeout = 300000; // 5 minutes — large binaries have thousands of strings

  const result = await connection.sendCommand<{
    strings: GhidraStringInfo[];
    total: number;
  }>('list_strings', params);

  return {
    strings: result.strings.map(mapStringInfo),
    total: result.total,
  };
}

/**
 * Extract all strings from Ghidra (handles pagination)
 */
export async function extractAllStrings(
  connection: GhidraConnection,
  options: Omit<StringExtractionOptions, 'limit' | 'offset'> = {}
): Promise<ExtractedString[]> {
  const allStrings: ExtractedString[] = [];
  const pageSize = 500;
  let offset = 0;
  let total = 0;

  do {
    const result = await extractStrings(connection, {
      ...options,
      limit: pageSize,
      offset,
    });

    allStrings.push(...result.strings);
    total = result.total;
    offset += pageSize;
  } while (offset < total);

  return allStrings;
}

/**
 * Find strings used by a specific function
 */
export async function extractStringsInFunction(
  connection: GhidraConnection,
  functionName: string,
  options: Omit<StringExtractionOptions, 'limit' | 'offset'> = {}
): Promise<ExtractedString[]> {
  // Get all strings and filter by function
  const strings = await extractAllStrings(connection, options);
  return strings.filter(s => s.inFunction === functionName);
}

/**
 * Group strings by the functions that reference them
 */
export function groupStringsByFunction(
  strings: ExtractedString[]
): Map<string, ExtractedString[]> {
  const groups = new Map<string, ExtractedString[]>();

  for (const str of strings) {
    const func = str.inFunction || '__global__';
    if (!groups.has(func)) {
      groups.set(func, []);
    }
    groups.get(func)!.push(str);
  }

  return groups;
}

function mapStringInfo(info: GhidraStringInfo): ExtractedString {
  return {
    address: info.address,
    value: info.value,
    length: info.length,
    encoding: info.encoding,
    inFunction: info.inFunction,
    xrefCount: info.xrefCount,
  };
}
