/**
 * Output-tree paths the live writer must never create, overwrite or delete.
 *
 * The first five mirror the rsync exclusions in
 * `~/code/re/diablo2/recon/runs/run-regen.sh`: the regen rsync deletes anything
 * in the target it did not produce, and these are the entries it is told to
 * leave alone. The last three exist only on `source/modified` — hand-written
 * support code and the build's own scratch output — and a writer that drops
 * them into `source/regen` would make the two branches conflict on every merge.
 *
 * This is data, not a filter buried in the writer, because the set is the
 * contract between two tools: change it here and in run-regen.sh together.
 */
export const NEVER_TOUCH: string[] = [
  'README.md',
  'CMakeLists.txt',
  'metrics/',
  '.gitignore',
  'compile-errors.txt',
  'support/',
  'thirdparty/',
  'sites2.tsv',
];

/**
 * Is this output-relative path off limits?
 *
 * A trailing slash means a directory and matches everything beneath it;
 * anything else is an exact file. Prefix matching WITHOUT the slash would let
 * `supported/foo.cpp` masquerade as being inside `support/`, so the slash is
 * load-bearing rather than cosmetic.
 */
export function isNeverTouch(relPath: string): boolean {
  const normalized = relPath.replace(/^\.\//, '').replace(/^\/+/, '');
  for (const entry of NEVER_TOUCH) {
    if (entry.endsWith('/')) {
      if (normalized === entry.slice(0, -1) || normalized.startsWith(entry)) return true;
    } else if (normalized === entry) {
      return true;
    }
  }
  return false;
}
