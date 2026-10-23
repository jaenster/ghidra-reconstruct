/**
 * One spelling per path, on every filesystem.
 *
 * The emitted tree names a directory twice: once as the place a file is written, once in
 * every `#include` of a header in it. Both come from the same project path, and
 * canonicalizeProjectPathCase gives every directory one spelling even where Ghidra has two
 * namespaces differing only in case, so they agree in the generator. They stop agreeing on
 * disk when the output directory already holds an older spelling of the same name on a
 * case-insensitive filesystem (macOS): writing
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
    // Through a temporary name: a rename that changes only case is a no-op on some
    // case-insensitive filesystems (it was on the container's mount of the macOS disk).
    const tmp = path.join(root, `${from}.case-rename-${process.pid}`);
    await fs.rename(path.join(root, from), tmp);
    await fs.rename(tmp, path.join(root, rel));
    entries[entries.indexOf(stale[0])] = name;
    renames.push(`${from} -> ${rel}`);
  }
  return renames;
}

/**
 * The quoted path of one `#include "..."` directive line, with its offsets in `line`; null
 * for any other line, a `<system>` include or an empty path. Reads the directive's own
 * grammar (`#`, optional blanks, `include`, blanks, a quoted path), never code around it.
 */
export function quotedIncludePath(line: string): { path: string; start: number; end: number } | null {
  let i = 0;
  const blank = (c: string | undefined) => c === ' ' || c === '\t';
  while (blank(line[i])) i++;
  if (line[i] !== '#') return null;
  i++;
  while (blank(line[i])) i++;
  if (!line.startsWith('include', i)) return null;
  i += 'include'.length;
  while (blank(line[i])) i++;
  if (line[i] !== '"') return null;
  const start = i + 1;
  const end = line.indexOf('"', start);
  if (end <= start) return null;
  return { path: line.slice(start, end), start, end };
}

/**
 * One spelling for every directory of `relPaths`, keyed by the case-folded directory path.
 *
 * Two namespaces that differ only in case (`D2Client::GAME` and `D2Client::Game`) are two
 * C++ namespaces but must be ONE directory: a case-insensitive disk merges them under
 * whichever spelling mkdir saw first, git on that disk records that spelling, and on a
 * case-sensitive checkout every include written with the other spelling fails.
 *
 * The rule, applied level by level from the root so a child sits under its parent's
 * spelling: the spelling of the directory that holds the most emitted files (counting every
 * file below it) wins; on a tie, the spelling that sorts first by UTF-16 code unit, so
 * upper case before lower case. Neither depends on emission order or on what is on disk.
 */
export function canonicalDirectoryCase(relPaths: Iterable<string>): Map<string, string> {
  const weights = new Map<string, Map<string, number>>();
  for (const p of relPaths) {
    const parts = p.split(/[\\/]/).filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const key = parts.slice(0, i).join('/').toLowerCase();
      let w = weights.get(key);
      if (!w) weights.set(key, (w = new Map()));
      w.set(parts[i - 1], (w.get(parts[i - 1]) ?? 0) + 1);
    }
  }
  const out = new Map<string, string>();
  const keys = [...weights.keys()].sort((a, b) => a.split('/').length - b.split('/').length);
  for (const key of keys) {
    const [winner] = [...weights.get(key)!].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const slash = key.lastIndexOf('/');
    const parent = slash < 0 ? '' : out.get(key.slice(0, slash))!;
    out.set(key, parent ? `${parent}/${winner[0]}` : winner[0]);
  }
  return out;
}

/** `p` with every directory spelled as `dirs` (from canonicalDirectoryCase) spells it. */
export function withCanonicalDirectories(p: string, dirs: Map<string, string>): string {
  const slash = p.lastIndexOf('/');
  if (slash < 0) return p;
  const dir = dirs.get(p.slice(0, slash).toLowerCase());
  return dir === undefined ? p : `${dir}/${p.slice(slash + 1)}`;
}

/** Collapse `a/./b` and `a/b/../c` in a forward-slash path. */
export function normalizeRelativePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}

/**
 * The emitted file an include names, resolved the way the compiler resolves it: beside the
 * including file first, then from the tree root (every directory is on the include path).
 */
export function resolveQuotedInclude(
  includer: string, included: string, exists: (p: string) => boolean,
): { target: string; beside: boolean } | null {
  const slash = includer.lastIndexOf('/');
  if (slash >= 0) {
    const beside = normalizeRelativePath(`${includer.slice(0, slash)}/${included}`);
    if (exists(beside)) return { target: beside, beside: true };
  }
  if (exists(included)) return { target: included, beside: false };
  return null;
}

/**
 * Give every directory of the project its one spelling (canonicalDirectoryCase): rename the
 * file and source-map keys, and rewrite each quoted include that names a renamed file to the
 * path that file is now written to. Returns the file renames as `old -> new`.
 */
export function canonicalizeProjectPathCase<F extends { path: string; content: string }, M extends { file?: string }>(
  project: { files: Map<string, F>; sourceMaps: Map<string, M> },
): string[] {
  // Weighed by the files alone: a source map shadows its .cpp and would count it twice.
  const dirs = canonicalDirectoryCase(project.files.keys());
  const moved = new Map<string, string>();
  for (const p of [...project.files.keys(), ...project.sourceMaps.keys()]) {
    const q = withCanonicalDirectories(p, dirs);
    if (q !== p) moved.set(p, q);
  }
  if (moved.size === 0) return [];

  const oldKeys = new Set(project.files.keys());
  const renamed = new Map<string, F>();
  for (const [from, file] of project.files) {
    const to = moved.get(from) ?? from;
    const toDir = to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : '';
    let changed = false;
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const inc = quotedIncludePath(lines[i]);
      if (!inc) continue;
      const hit = resolveQuotedInclude(from, inc.path, p => oldKeys.has(p));
      const target = hit && moved.get(hit.target);
      if (!hit || !target) continue;
      const spelled = hit.beside && toDir && target.startsWith(`${toDir}/`) ? target.slice(toDir.length + 1) : target;
      lines[i] = lines[i].slice(0, inc.start) + spelled + lines[i].slice(inc.end);
      changed = true;
    }
    const content = changed ? lines.join('\n') : file.content;
    renamed.set(to, to === from && !changed ? file : { ...file, path: file.path === from ? to : file.path, content });
  }
  project.files.clear();
  for (const [k, v] of renamed) project.files.set(k, v);

  const maps = [...project.sourceMaps];
  project.sourceMaps.clear();
  for (const [from, map] of maps) {
    const fileTo = map.file !== undefined ? moved.get(map.file) : undefined;
    project.sourceMaps.set(moved.get(from) ?? from, fileTo ? { ...map, file: fileTo } : map);
  }
  return [...moved].map(([a, b]) => `${a} -> ${b}`);
}
