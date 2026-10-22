/**
 * Partial patch engine
 *
 * Applies sequential find/replace patches to decompiled code,
 * with optional fuzzy whitespace matching.
 */

import type { PatchEntry } from '../config/schema.js';

/**
 * Apply a sequence of patches to code.
 *
 * Patches are applied in order, each to the result of the one before. Each find
 * string must match exactly once in the text it is applied to; anything else is an
 * error, not a warning. A find that matches nothing is a fix that silently stopped
 * applying (the decompiler renamed a local, Ghidra changed the body), and a find
 * that matches twice rewrites whichever occurrence happens to come first - both emit
 * a body that compiles and is not the one the entry was written for.
 *
 * `warnings` is kept for callers; it is always empty now.
 */
export function applyPatches(
  code: string,
  patches: PatchEntry[]
): { code: string; warnings: string[] } {
  let result = code;

  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i];
    const applied = applySinglePatch(result, patch);

    if (applied.matches !== 1) {
      throw new Error(
        `Patch ${i}: find string matched ${applied.matches} times${patch.fuzzy ? ' (fuzzy)' : ''}, must match exactly once: "${truncate(patch.find, 60)}"`
      );
    }

    result = applied.code;
  }

  return { code: result, warnings: [] };
}

/**
 * Apply a single find/replace patch where it matches, counting the matches.
 */
function applySinglePatch(
  code: string,
  patch: PatchEntry
): { code: string; matches: number } {
  if (patch.fuzzy) {
    return applyFuzzyPatch(code, patch.find, patch.replace);
  }

  if (patch.find.length === 0) return { code, matches: 0 };

  // Exact match
  const idx = code.indexOf(patch.find);
  if (idx === -1) {
    return { code, matches: 0 };
  }
  let matches = 0;
  for (let at = idx; at !== -1; at = code.indexOf(patch.find, at + patch.find.length)) matches++;

  const patched =
    code.substring(0, idx) + patch.replace + code.substring(idx + patch.find.length);

  return { code: patched, matches };
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
): { code: string; matches: number } {
  // Build a regex from the find string where any whitespace sequence
  // matches any whitespace sequence (including newlines)
  const escapedParts = find
    .split(/\s+/)
    .filter(Boolean)
    .map(part => escapeRegex(part));

  if (escapedParts.length === 0) {
    return { code, matches: 0 };
  }

  const pattern = escapedParts.join('\\s+');
  const all = code.match(new RegExp(pattern, 'g'));
  const match = new RegExp(pattern).exec(code);

  if (!match) {
    return { code, matches: 0 };
  }

  const patched =
    code.substring(0, match.index) + replace + code.substring(match.index + match[0].length);

  return { code: patched, matches: all?.length ?? 1 };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncate(str: string, len: number): string {
  if (str.length <= len) return str;
  return str.substring(0, len - 3) + '...';
}
