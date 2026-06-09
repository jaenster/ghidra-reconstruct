/**
 * Partial patch engine
 *
 * Applies sequential find/replace patches to decompiled code,
 * with optional fuzzy whitespace matching.
 */

import type { PatchEntry } from '../config/schema.js';

/**
 * Apply a sequence of patches to code
 *
 * Patches are applied in order. Each patch's find string must
 * match exactly once (or with fuzzy whitespace if enabled).
 *
 * Returns the patched code and a list of any warnings.
 */
export function applyPatches(
  code: string,
  patches: PatchEntry[]
): { code: string; warnings: string[] } {
  const warnings: string[] = [];
  let result = code;

  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i];
    const applied = applySinglePatch(result, patch);

    if (!applied.matched) {
      warnings.push(
        `Patch ${i}: find string not matched${patch.fuzzy ? ' (fuzzy)' : ''}: "${truncate(patch.find, 60)}"`
      );
      continue;
    }

    result = applied.code;
  }

  return { code: result, warnings };
}

/**
 * Apply a single find/replace patch
 */
function applySinglePatch(
  code: string,
  patch: PatchEntry
): { code: string; matched: boolean } {
  if (patch.fuzzy) {
    return applyFuzzyPatch(code, patch.find, patch.replace);
  }

  // Exact match
  const idx = code.indexOf(patch.find);
  if (idx === -1) {
    return { code, matched: false };
  }

  const patched =
    code.substring(0, idx) + patch.replace + code.substring(idx + patch.find.length);

  return { code: patched, matched: true };
}

/**
 * Apply a patch with fuzzy whitespace matching
 *
 * Normalizes whitespace in both the find pattern and the code
 * to tolerate differences in spacing, indentation, and line breaks.
 */
function applyFuzzyPatch(
  code: string,
  find: string,
  replace: string
): { code: string; matched: boolean } {
  // Build a regex from the find string where any whitespace sequence
  // matches any whitespace sequence (including newlines)
  const escapedParts = find
    .split(/\s+/)
    .filter(Boolean)
    .map(part => escapeRegex(part));

  if (escapedParts.length === 0) {
    return { code, matched: false };
  }

  const pattern = escapedParts.join('\\s+');
  const regex = new RegExp(pattern);
  const match = regex.exec(code);

  if (!match) {
    return { code, matched: false };
  }

  const patched =
    code.substring(0, match.index) + replace + code.substring(match.index + match[0].length);

  return { code: patched, matched: true };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncate(str: string, len: number): string {
  if (str.length <= len) return str;
  return str.substring(0, len - 3) + '...';
}
