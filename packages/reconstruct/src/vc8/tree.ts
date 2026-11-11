/**
 * The tree the VC8 oracle compiles: which files of the reconstruction are mirrored, the
 * whole-tree pre-pass over them, and the mirror itself.
 *
 * The vendored libraries (3rdparty/libbacktrace, 3rdparty/implibs) and the build and tooling
 * directories are not part of the reconstruction and are not mirrored; 3rdparty/Storm and
 * 3rdparty/crashy are game code and are. Of the hand-written Redivivus/ tree only the headers
 * are, because some game sources include them, and ghidra_version.cpp, the generated version
 * stamp.
 *
 * Files are read and written as latin1, byte for byte: what the translator does not rewrite
 * comes out exactly as it went in.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileFacts, mergeFacts, type FileFacts, type TreeState } from './facts.js';
import { translate } from './translate.js';

const SKIP_DIRS = new Set(['.git', '.github', '.idea', 'asm_matching', 'build', 'cmake', 'tools', 'metrics']);
const VENDORED = new Set(['3rdparty/libbacktrace', '3rdparty/implibs']);
const HEADERS_ONLY = new Set(['Redivivus']);
const HEADERS_ONLY_BUT = new Set(['Redivivus/ghidra_version.cpp']);
export const EXTS = ['.h', '.hpp', '.inl', '.cpp', '.c'];

/** Every mirrored source, relative and forward-slashed, in walk order (each directory's files sorted). */
export function sources(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const dirs: string[] = [];
    const files: string[] = [];
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          if (statSync(join(root, rel, e.name)).isDirectory()) continue;    // listed, never walked into
        } catch {
          continue;
        }
        isDir = false;
      }
      (isDir ? dirs : files).push(e.name);
    }
    const top = rel ? rel.split('/')[0] : '.';
    for (const name of files.sort(byCodePoint)) {
      const path = rel ? `${rel}/${name}` : name;
      if (EXTS.some(x => name.endsWith(x)) && (!HEADERS_ONLY.has(top) || name.endsWith('.h') || HEADERS_ONLY_BUT.has(path))) {
        out.push(path);
      }
    }
    for (const d of dirs) {
      const path = rel ? `${rel}/${d}` : d;
      if (!rel ? SKIP_DIRS.has(d) || d.startsWith('build') : VENDORED.has(path)) continue;
      walk(path);
    }
  };
  walk('');
  return out;
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function readSource(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'latin1');
}

/** quarantine.tsv -> file -> the 1-based lines inside functions to blank. */
export function loadQuarantine(path: string | undefined): Map<string, Set<number>> {
  const q = new Map<string, Set<number>>();
  if (!path || !existsSync(path)) return q;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const parts = line.split('\t');
    if (parts.length >= 2 && parts[0] !== 'file') {
      let s = q.get(parts[0]);
      if (!s) q.set(parts[0], s = new Set());
      s.add(parseInt(parts[1], 10));
    }
  }
  return q;
}

export interface Tree {
  root: string;
  files: string[];
  texts: Map<string, string>;
  state: TreeState;
}

/** Read every source of `root` and run the pre-pass. */
export function loadTree(root: string): Tree {
  const files = sources(root);
  const texts = new Map<string, string>();
  const facts: FileFacts[] = [];
  for (const rel of files) {
    const text = readSource(root, rel);
    texts.set(rel, text);
    facts.push(fileFacts(text, rel.endsWith('.h'), rel));
  }
  return { root, files, texts, state: mergeFacts(facts) };
}

/** Translate every source of the tree into `out`; a file whose translation is already there is left alone. */
export function mirror(tree: Tree, out: string, quarantine: Map<string, Set<number>>): { written: number; kept: number } {
  let written = 0;
  let kept = 0;
  for (const rel of tree.files) {
    let data: Buffer;
    try {
      data = Buffer.from(translate(tree.texts.get(rel)!, rel, tree.state, quarantine.get(rel)), 'latin1');
    } catch (e) {
      throw new Error(`${join(tree.root, rel)}: ${(e as Error).message}`);
    }
    const dst = join(out, rel);
    if (existsSync(dst) && readFileSync(dst).equals(data)) {
      kept++;
      continue;
    }
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, data);
    written++;
  }
  return { written, kept };
}
