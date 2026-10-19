/**
 * One spelling per path, on every filesystem.
 *
 * The emitted tree names a directory twice: once as the place a file is written, once in
 * every `#include` of a header in it. Both come from the same project path, so they agree
 * in the generator. They stop agreeing on disk when the output directory already holds an
 * older spelling of the same name on a case-insensitive filesystem (macOS): writing
 * `D2Client/GAME/RosterPets.h` into an existing `D2Client/Game/` keeps the old directory
 * name, the tree is committed as `D2Client/Game/`, and on a case-sensitive checkout every
 * `#include "D2Client/GAME/RosterPets.h"` fails.
 *
 * So the writer makes the disk spell each path the way the project does, and refuses a
 * project in which two FILES differ only in case: on a case-insensitive disk one would
 * overwrite the other.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Throw when two emitted files differ only in case. */
export function assertNoCaseCollidingFiles(paths: Iterable<string>): void {
  const byFolded = new Map<string, string>();
  const collisions: string[] = [];
  for (const p of paths) {
    const norm = p.split(path.sep).join('/');
    const folded = norm.toLowerCase();
    const prior = byFolded.get(folded);
    if (prior !== undefined && prior !== norm) collisions.push(`${prior} <-> ${norm}`);
    else byFolded.set(folded, norm);
  }
  if (collisions.length > 0) {
    throw new Error(
      `${collisions.length} emitted file(s) differ from another only in case; on a case-insensitive ` +
      `filesystem one overwrites the other:\n  ${collisions.slice(0, 20).join('\n  ')}`
    );
  }
}

/**
 * The spelling each directory and file of `relPaths` must have on disk, keyed by the
 * case-folded path. A directory the project spells two ways (two namespaces differing only
 * in case) has no single spelling and is left out: both spellings are valid on a
 * case-sensitive disk, and a case-insensitive one merges them whatever the writer does.
 */
export function canonicalSpellings(relPaths: Iterable<string>): Map<string, string> {
  const spellings = new Map<string, Set<string>>();
  for (const p of relPaths) {
    const parts = p.split(/[\\/]/).filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join('/');
      const key = sub.toLowerCase();
      let set = spellings.get(key);
      if (!set) spellings.set(key, (set = new Set()));
      set.add(sub);
    }
  }
  const out = new Map<string, string>();
  for (const [key, set] of spellings) if (set.size === 1) out.set(key, [...set][0]);
  return out;
}

/**
 * Rename every existing directory or file under `root` whose name differs only in case
 * from the spelling `relPaths` gives it. Shallow paths first, so a renamed directory is
 * the parent its children are then looked up in. Returns the renames done, as
 * `old -> new` relative paths.
 */
export async function alignPathCase(root: string, relPaths: Iterable<string>): Promise<string[]> {
  const canonical = canonicalSpellings(relPaths);
  const wanted = [...canonical.values()].sort((a, b) => a.split('/').length - b.split('/').length);
  const listings = new Map<string, string[] | null>();
  const list = async (dir: string): Promise<string[] | null> => {
    if (!listings.has(dir)) {
      listings.set(dir, await fs.readdir(path.join(root, dir)).catch(() => null));
    }
    return listings.get(dir)!;
  };
  const renames: string[] = [];
  for (const rel of wanted) {
    const parent = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
    const name = path.posix.basename(rel);
    const entries = await list(parent);
    if (!entries || entries.includes(name)) continue;
    const lower = name.toLowerCase();
    const stale = entries.filter(e => e.toLowerCase() === lower);
    // Two entries folding to one name exist only on a case-sensitive disk, where both
    // are real and neither is this path's stale spelling.
    if (stale.length !== 1) continue;
    const from = parent ? `${parent}/${stale[0]}` : stale[0];
    await fs.rename(path.join(root, from), path.join(root, rel));
    entries[entries.indexOf(stale[0])] = name;
    renames.push(`${from} -> ${rel}`);
  }
  return renames;
}
