/**
 * The tree a record's spellings belong to, read from the history of the repo that holds the
 * store (`source/modified`, docs/ratchet.md).
 *
 * A record's text is what the tree at its `evidence` commit emitted. The current merge target
 * is no witness for it: once a regen with renames is merged there, it spells the new names and
 * the old ones in a stored body resolve to nothing (deploy 1167: the second daemon rebuild kept
 * renamed globals again). So each record is read against its evidence commit - or, where that
 * tree did not yet carry what the ratchet reads, the first commit after it on the first-parent
 * line that does: `Source/globals/globals.addr.tsv` for names (globals, enum constants, types),
 * source maps with `"paramStorage"` for parameter storage. Nothing outside those commits is
 * consulted, so the answer does not change as the merge target moves on.
 */
import { spawnSync } from 'node:child_process';

import { previousTree, type PreviousTree } from './previous.js';
import { GLOBALS_INDEX_FILE, SymbolIndex, type TreeSource } from './symbol-index.js';

function git(repo: string, args: string[], input?: string): { code: number; out: string } {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf-8', maxBuffer: 1 << 30, input, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { code: r.status ?? 1, out: r.stdout ?? '' };
}

/** The top of the git work tree holding `dir`, if any. */
export function repoOf(dir: string): string | undefined {
  const r = git(dir, ['rev-parse', '--show-toplevel']);
  return r.code === 0 && r.out.trim() ? r.out.trim() : undefined;
}

function commitOf(repo: string, rev: string): string | undefined {
  const r = git(repo, ['rev-parse', '--verify', '-q', `${rev}^{commit}`]);
  return r.code === 0 && r.out.trim() ? r.out.trim() : undefined;
}

const hasNames = (repo: string, c: string) => git(repo, ['cat-file', '-e', `${c}:${GLOBALS_INDEX_FILE}`]).code === 0;
const hasStorage = (repo: string, c: string) => git(repo, ['grep', '-q', '-F', '"paramStorage"', c, '--', '*.map']).code === 0;

export interface EvidenceAnchors {
  /** The commit whose tree resolves the record's names. */
  names?: string;
  /** The commit whose source maps give its parameters' storage. */
  storage?: string;
}

/**
 * The commits a record captured at `evidence` is read against: the evidence itself where it
 * carries the facet, else the first commit after it on HEAD's first-parent line that does.
 * Empty when the evidence is not in the repo.
 */
export function evidenceAnchors(repo: string, evidence: string): EvidenceAnchors {
  const e = commitOf(repo, evidence);
  if (!e) return {};
  let line: string[] | undefined;
  const after = (): string[] => {
    if (!line) {
      const r = git(repo, ['rev-list', '--first-parent', '--reverse', `${e}..HEAD`]);
      line = r.code === 0 ? r.out.split('\n').filter(Boolean) : [];
    }
    return line;
  };
  const first = (has: (repo: string, c: string) => boolean): string | undefined => {
    if (has(repo, e)) return e;
    for (const c of after()) if (has(repo, c)) return c;
    return undefined;
  };
  return { names: first(hasNames), storage: first(hasStorage) };
}

/** The files of a commit `filter` admits, read in one `git cat-file --batch`. */
export function gitTree(repo: string, commit: string, filter: (rel: string) => boolean): TreeSource {
  const ls = git(repo, ['ls-tree', '-r', '-z', '--full-tree', commit]);
  const entries: Array<{ sha: string; path: string }> = [];
  for (const rec of ls.out.split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [, type, sha] = rec.slice(0, tab).split(' ');
    const p = rec.slice(tab + 1);
    if (type === 'blob' && filter(p)) entries.push({ sha, path: p });
  }
  const files = new Map<string, string>();
  if (entries.length > 0) {
    const r = spawnSync('git', ['-C', repo, 'cat-file', '--batch'], { input: entries.map(x => x.sha).join('\n') + '\n', maxBuffer: 2 ** 32 });
    const buf = r.stdout as Buffer;
    let pos = 0;
    for (const x of entries) {
      const nl = buf.indexOf(0x0a, pos);
      if (nl < 0) break;
      const header = buf.subarray(pos, nl).toString('utf-8').split(' ');
      if (header[1] === 'missing') { pos = nl + 1; continue; }
      const size = Number(header[2]);
      files.set(x.path, buf.subarray(nl + 1, nl + 1 + size).toString('utf-8'));
      pos = nl + 1 + size + 1;
    }
  }
  return { list: () => [...files.keys()], read: rel => files.get(rel) };
}

const INDEXED = /\.(?:h|hpp|inl|cpp|c|map)$/u;

/** The symbol index of a commit's generated tree, without the texts it was built from. */
export function commitIndex(repo: string, commit: string, generated: (rel: string) => boolean): SymbolIndex {
  const ix = SymbolIndex.build(gitTree(repo, commit, rel => generated(rel) && (INDEXED.test(rel) || rel === GLOBALS_INDEX_FILE)));
  // Only names, signatures, layouts and storage are read from it.
  ix.texts.clear();
  ix.scans.clear();
  ix.extents.clear();
  return ix;
}

/** Indices of commits already read, by repo and commit: the live daemon reads them once. */
const INDEX_CACHE = new Map<string, SymbolIndex>();
const INDEX_CACHE_SIZE = 8;

function cachedIndex(repo: string, commit: string, generated: (rel: string) => boolean): SymbolIndex {
  const key = `${repo}\0${commit}`;
  let ix = INDEX_CACHE.get(key);
  if (ix) {
    INDEX_CACHE.delete(key);
  } else {
    ix = commitIndex(repo, commit, generated);
    while (INDEX_CACHE.size >= INDEX_CACHE_SIZE) INDEX_CACHE.delete(INDEX_CACHE.keys().next().value!);
  }
  INDEX_CACHE.set(key, ix);
  return ix;
}

/**
 * The previous tree of each record by its evidence commit, for one apply over `current`.
 * Undefined for a record whose evidence the repo does not have, or whose history never
 * carried a globals index: the caller falls back to whatever it would use otherwise.
 */
export function evidencePrevious(repo: string, current: SymbolIndex, generated: (rel: string) => boolean): (evidence: string) => PreviousTree | undefined {
  const anchors = new Map<string, EvidenceAnchors>();
  const trees = new Map<string, PreviousTree | undefined>();
  return evidence => {
    let a = anchors.get(evidence);
    if (!a) { a = evidenceAnchors(repo, evidence); anchors.set(evidence, a); }
    if (!a.names) return undefined;
    const key = `${a.names}\0${a.storage ?? ''}`;
    if (!trees.has(key)) {
      try {
        const names = cachedIndex(repo, a.names, generated);
        const storage = a.storage && a.storage !== a.names ? cachedIndex(repo, a.storage, generated) : undefined;
        trees.set(key, previousTree(names, current, storage));
      } catch (e) {
        console.warn(`ratchet: the tree at ${a.names.slice(0, 9)} (evidence ${evidence}) could not be read: ${(e as Error).message}`);
        trees.set(key, undefined);
      }
    }
    return trees.get(key);
  };
}
