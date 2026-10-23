/**
 * Where the central globals files sit in the emitted tree.
 *
 * All of them share one directory, `globals/`, instead of the tree root:
 *
 *   globals/globals.h        every extern declaration
 *   globals/globals.cpp      the definitions no single module owns
 *   globals/<Module>.cpp     one definition unit per module (see globals-partition.ts)
 *
 * Every translation unit includes the header by its tree-relative path,
 * `#include "globals/globals.h"`, like every other header in the tree.
 */

/** The directory the globals files are written to, relative to the tree (or target) root. */
export const GLOBALS_DIR = 'globals';

/** The basename of the declarations header and of the shared definitions unit. */
const GLOBALS_BASE = 'globals';

/** The tree-relative path of the globals header in a flat (single-root) project. */
export const GLOBALS_HEADER = `${GLOBALS_DIR}/${GLOBALS_BASE}.h`;

/** The globals header under `baseDir` (a target directory), or under the tree root when empty. */
export function globalsHeaderPathUnder(baseDir: string): string {
  return baseDir ? `${baseDir}/${GLOBALS_HEADER}` : GLOBALS_HEADER;
}

/**
 * The definitions unit beside `headerPath`: the shared one for `module === undefined`,
 * otherwise that module's. A module whose name is the shared unit's own basename (in any
 * case) has no path of its own - it would be the shared unit - and gets `undefined`.
 */
export function globalsUnitPath(headerPath: string, module: string | undefined, implExt: string): string | undefined {
  const slash = headerPath.lastIndexOf('/');
  const dir = slash >= 0 ? headerPath.slice(0, slash + 1) : '';
  const base = headerPath.slice(slash + 1).replace(/\.h$/, '');
  if (module === undefined) return `${dir}${base}${implExt}`;
  if (module.toLowerCase() === base.toLowerCase()) return undefined;
  return `${dir}${module}${implExt}`;
}

/**
 * Whether a tree-relative path is the globals header. The root `globals.h` is the layout
 * trees generated before `globals/` existed still have; the lint reads both.
 */
export function isGlobalsHeaderPath(p: string): boolean {
  return p === GLOBALS_HEADER || p === `${GLOBALS_BASE}.h`;
}

/**
 * Whether a tree-relative path is one of the central globals definition units:
 * `globals/<name>.cpp`, or the older root `globals.cpp` / `globals.<Module>.cpp`.
 */
export function isGlobalsUnitPath(p: string): boolean {
  if (!p.endsWith('.cpp')) return false;
  if (p.startsWith(`${GLOBALS_DIR}/`)) return !p.slice(GLOBALS_DIR.length + 1).includes('/');
  return !p.includes('/') && (p === `${GLOBALS_BASE}.cpp` || p.startsWith(`${GLOBALS_BASE}.`));
}
