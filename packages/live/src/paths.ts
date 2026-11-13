/**
 * Output-tree paths the live writer must never create, overwrite or delete.
 *
 * The first six mirror the rsync exclusions in
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
  'cmake/',
  'metrics/',
  '.gitignore',
  'compile-errors.txt',
  // Hand-written support code; ghidra_version.cpp in it is written by the regen and
  // the daemon after the sync, not by the generator.
  'Redivivus/',
  // Vendored code and the licensed DLLs' import-library definitions.
  '3rdparty/libbacktrace/',
  '3rdparty/implibs/',
  'sites2.tsv',
];

/** The Ghidra version file the regen and the daemon write (it is not generator output). */
export const VERSION_FILE = 'Redivivus/ghidra_version.cpp';

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

/**
 * Entries in a tree that belong to the checkout, not to the output: the regen repo's
 * `.git`, an IDE's `.idea`, Finder's `.DS_Store`. The sync leaves them alone, and the
 * `full_regen` diff skips them at any depth: a scratch generation never has them, so
 * they are always "only in" the live tree and say nothing about the generator.
 */
export const TREE_METADATA: readonly string[] = ['.git', '.idea', '.DS_Store'];

/** Does this output-relative path lie in (or name) a checkout metadata entry? */
export function isTreeMetadata(relPath: string): boolean {
  return relPath.split('/').some(segment => TREE_METADATA.includes(segment));
}
