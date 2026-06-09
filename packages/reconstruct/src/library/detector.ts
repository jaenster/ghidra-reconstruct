/**
 * Library function auto-detection
 *
 * Matches decompiled functions against known CRT/stdlib patterns
 * to suggest library function mappings.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ExtractedFunction } from '../types.js';
import type {
  LibraryEntry,
  LibrarySignatureDatabase,
  LibrarySignature,
} from '../config/schema.js';

/**
 * Detection result for a single function
 */
export interface DetectionResult {
  function: ExtractedFunction;
  symbol: string;
  header: string;
  category?: string;
  confidence: number;
  matchedHeuristics: string[];
}

/**
 * Detect library functions by matching against a signature database
 */
export async function detectLibraryFunctions(
  functions: ExtractedFunction[],
  signaturePath: string
): Promise<DetectionResult[]> {
  const db = await loadSignatureDatabase(signaturePath);
  const results: DetectionResult[] = [];

  for (const func of functions) {
    if (!func.decompiled || func.isExternal || func.isThunk) continue;

    const best = matchFunction(func, db);
    if (best && best.confidence >= 0.6) {
      results.push(best);
    }
  }

  return results;
}

/**
 * Match a single function against all signatures in the database
 */
function matchFunction(
  func: ExtractedFunction,
  db: LibrarySignatureDatabase
): DetectionResult | null {
  let bestResult: DetectionResult | null = null;

  for (const [symbol, sig] of Object.entries(db.functions)) {
    const result = matchSignature(func, symbol, sig);
    if (result && (!bestResult || result.confidence > bestResult.confidence)) {
      bestResult = result;
    }
  }

  return bestResult;
}

/**
 * Match a function against a single signature
 */
function matchSignature(
  func: ExtractedFunction,
  symbol: string,
  sig: LibrarySignature
): DetectionResult | null {
  const matchedHeuristics: string[] = [];
  let totalChecks = 0;
  let passedChecks = 0;

  const h = sig.heuristics;

  // Check parameter count
  if (h.paramCount !== undefined) {
    totalChecks++;
    if (func.parameters.length === h.paramCount) {
      passedChecks++;
      matchedHeuristics.push('paramCount');
    }
  }

  // Check parameter types
  if (h.paramTypes && h.paramTypes.length > 0) {
    totalChecks++;
    const typeMatch = h.paramTypes.every((expected, i) => {
      if (i >= func.parameters.length) return false;
      const actual = func.parameters[i].dataType;
      return normalizeType(actual) === normalizeType(expected);
    });
    if (typeMatch) {
      passedChecks++;
      matchedHeuristics.push('paramTypes');
    }
  }

  // Check return type
  if (h.returnType) {
    totalChecks++;
    if (normalizeType(func.returnType) === normalizeType(h.returnType)) {
      passedChecks++;
      matchedHeuristics.push('returnType');
    }
  }

  // Check function size range
  if (h.sizeRange) {
    totalChecks++;
    if (func.size >= h.sizeRange[0] && func.size <= h.sizeRange[1]) {
      passedChecks++;
      matchedHeuristics.push('sizeRange');
    }
  }

  // Check body patterns (require decompiled code)
  if (h.bodyPatterns && h.bodyPatterns.length > 0 && func.decompiled) {
    totalChecks++;
    const body = func.decompiled.toLowerCase();
    const matchCount = h.bodyPatterns.filter(p =>
      body.includes(p.toLowerCase())
    ).length;
    if (matchCount > 0) {
      passedChecks += matchCount / h.bodyPatterns.length;
      matchedHeuristics.push(`bodyPatterns(${matchCount}/${h.bodyPatterns.length})`);
    }
  }

  if (totalChecks === 0) return null;

  const confidence = passedChecks / totalChecks;
  if (confidence < 0.5) return null;

  return {
    function: func,
    symbol,
    header: sig.header,
    category: sig.category,
    confidence,
    matchedHeuristics,
  };
}

/**
 * Normalize a C type for comparison (strip qualifiers, whitespace)
 */
function normalizeType(type: string): string {
  return type
    .replace(/\bconst\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Load and parse a signature database JSON file
 */
async function loadSignatureDatabase(
  filePath: string
): Promise<LibrarySignatureDatabase> {
  const raw = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(raw) as LibrarySignatureDatabase;
}

/**
 * Convert detection results to library entries for project.json
 */
export function detectionResultsToLibraryEntries(
  results: DetectionResult[]
): LibraryEntry[] {
  return results.map(r => ({
    address: r.function.address,
    name: r.function.name,
    symbol: r.symbol,
    header: r.header,
    category: r.category,
  }));
}
