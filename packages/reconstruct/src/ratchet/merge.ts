/**
 * Merge a regen into source/modified with the ratchet as the merge for pinned functions.
 *
 * A pinned function's body is hand-written, so a textual three-way merge of its file pits
 * the hand body against every regen's fresh output: a conflict each time the generator
 * touches it, or worse, a silent interleaving when the hunks happen not to overlap. Here the
 * pin is printed again under the regen's names (the same re-spelling as a kept match body)
 * and that text replaces the function's body in all three versions - base, ours and theirs -
 * before `git merge-file` runs. The three agree on every pinned region, so the textual merge
 * only ever sees the rest of the file, and the pin comes out re-spelled.
 *
 * Then the hand-written files follow the regen's renames (follow.ts). A pin that cannot be
 * re-spelled is reported and its old body kept under `#if 0` beside the generated one; it
 * never fails the merge.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { followHandFile } from './follow.js';
import { applyRecords, type ApplyRow } from './ratchet.js';
import { scanCpp } from './scan.js';
import { RatchetStore } from './store.js';
import { previousTree } from './previous.js';
import { SymbolIndex, diskTree } from './symbol-index.js';

export interface RatchetMergeOptions {
  /** Default `<tree>/ratchet`. */
  storeDir?: string;
  /** Hand-written directories whose references follow the regen (default Redivivus, support). */
  followDirs?: string[];
  /** Commit when nothing is left unmerged (default true). */
  commit?: boolean;
  /** Extra arguments for `git commit`, e.g. `--no-gpg-sign`. */
  commitArgs?: string[];
  /** Extra `-c` settings for every git call. */
  gitConfig?: string[];
  /** Merge over untracked files (a store not yet committed, in a replay). */
  allowUntracked?: boolean;
}

export interface RatchetMergeResult {
  state: 'clean' | 'conflict' | 'uptodate' | 'error' | 'dirty';
  conflictFiles: string[];
  pins: ApplyRow[];
  followed: Array<{ file: string; renames: string[]; includes: string[]; errors: string[] }>;
  message?: string;
}

const GENERATED = (rel: string) => !rel.startsWith('Redivivus/') && !rel.startsWith('asm_matching/') && !rel.startsWith('ratchet/') && !rel.startsWith('support/');

function gitRun(tree: string, cfg: string[], args: string[], input?: string): { code: number; out: string; err: string } {
  const r = spawnSync('git', [...cfg.flatMap(c => ['-c', c]), '-C', tree, ...args], { encoding: 'utf-8', maxBuffer: 1 << 30, input, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function showFile(tree: string, rev: string, file: string): string | undefined {
  const r = spawnSync('git', ['-C', tree, 'show', `${rev}:${file}`], { encoding: 'utf-8', maxBuffer: 1 << 30 });
  return r.status === 0 ? r.stdout : undefined;
}

/** The generated part of a commit's tree, unpacked to a temp dir. */
export function checkoutTree(repo: string, rev: string, dirs: string[] = ['Source', '3rdparty']): { root: string; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-tree-'));
  const present = dirs.filter(d => spawnSync('git', ['-C', repo, 'cat-file', '-e', `${rev}:${d}`]).status === 0);
  if (present.length > 0) {
    const tar = execFileSync('git', ['-C', repo, 'archive', rev, ...present], { maxBuffer: 1 << 30 });
    execFileSync('tar', ['-x', '-C', dir], { input: tar, maxBuffer: 1 << 30 });
  }
  return { root: dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Replace the bodies of `addresses` in `text` with the bodies `pinned` has for them. */
function normalize(text: string | undefined, pinned: Map<string, string>): string | undefined {
  if (text === undefined) return undefined;
  const scan = scanCpp(text);
  if (!scan) return text;
  const edits = scan.functions.filter(f => pinned.has(f.address)).sort((a, b) => b.bodyStart - a.bodyStart);
  let out = text;
  for (const f of edits) out = out.slice(0, f.bodyStart) + pinned.get(f.address)! + out.slice(f.end);
  return out;
}

export function ratchetMerge(tree: string, branch: string, opts: RatchetMergeOptions = {}): RatchetMergeResult {
  const cfg = opts.gitConfig ?? [];
  const result: RatchetMergeResult = { state: 'clean', conflictFiles: [], pins: [], followed: [] };
  if (gitRun(tree, cfg, ['status', '--porcelain', ...(opts.allowUntracked ? ['--untracked-files=no'] : [])]).out.trim()) {
    return { ...result, state: 'dirty', message: `${tree} has uncommitted changes; refusing to merge ${branch} over them.` };
  }
  const head = gitRun(tree, cfg, ['rev-parse', 'HEAD']).out.trim();
  const theirs = gitRun(tree, cfg, ['rev-parse', branch]).out.trim();
  if (!theirs) return { ...result, state: 'error', message: `no such ref ${branch}` };
  const base = gitRun(tree, cfg, ['merge-base', head, theirs]).out.trim();
  if (base === theirs) return { ...result, state: 'uptodate', message: 'Already up to date.' };

  const merge = gitRun(tree, cfg, ['merge', '--no-commit', '--no-ff', theirs]);
  // A failed merge that left no MERGE_HEAD never started (a bad ref, untracked files in the way).
  if (merge.code !== 0 && !gitRun(tree, cfg, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).out.trim()) {
    return { ...result, state: 'error', message: (merge.err || merge.out).trim() };
  }

  const store = RatchetStore.open(opts.storeDir ?? path.join(tree, 'ratchet'));
  const pins = store?.list().filter(r => r.kind === 'pin') ?? [];
  const after = checkoutTree(tree, theirs);
  const before = checkoutTree(tree, head);
  try {
    const theirsIndex = SymbolIndex.build(diskTree(after.root), GENERATED);
    const beforeIndex = SymbolIndex.build(diskTree(before.root), GENERATED);
    if (pins.length > 0) {
      // Every pin printed under the regen's names, in the regen's own files.
      const applied = applyRecords(theirsIndex, pins, { previous: previousTree(beforeIndex, theirsIndex) });
      result.pins = applied.rows;
      const pinnedFiles = new Map<string, Map<string, string>>();
      for (const row of applied.rows) {
        const e = theirsIndex.extents.get(row.address);
        if (!e) continue;
        const text = applied.changed.get(e.file) ?? theirsIndex.texts.get(e.file)!;
        const scan = scanCpp(text);
        const f = scan?.functions.find(x => x.address === row.address);
        if (!f) continue;
        const m = pinnedFiles.get(e.file) ?? new Map<string, string>();
        m.set(row.address, text.slice(f.bodyStart, f.end));
        pinnedFiles.set(e.file, m);
      }
      // A pinned function may have moved file: its old file needs the same normalization.
      const allPinned = new Map<string, string>();
      for (const m of pinnedFiles.values()) for (const [a, b] of m) allPinned.set(a, b);
      const files = new Set<string>(pinnedFiles.keys());
      for (const a of allPinned.keys()) {
        const e = beforeIndex.extents.get(a);
        if (e) files.add(e.file);
      }
      for (const file of files) {
        const b = normalize(showFile(tree, base, file), allPinned);
        const o = normalize(showFile(tree, head, file), allPinned);
        const t = applied.changed.get(file) ?? showFile(tree, theirs, file);
        if (o === undefined && t === undefined) continue;
        if (t === undefined) continue; // theirs deleted it: git's merge stands
        if (o === undefined) { fs.writeFileSync(path.join(tree, file), t, 'utf-8'); gitRun(tree, cfg, ['add', '--', file]); continue; }
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-merge-'));
        try {
          const [pb, po, pt] = ['base', 'ours', 'theirs'].map(n => path.join(tmp, n));
          fs.writeFileSync(pb, b ?? '', 'utf-8');
          fs.writeFileSync(po, o, 'utf-8');
          fs.writeFileSync(pt, t, 'utf-8');
          const mf = spawnSync('git', ['merge-file', '-p', '-L', 'ours', '-L', 'base', '-L', 'regen', po, pb, pt], { encoding: 'utf-8', maxBuffer: 1 << 30 });
          fs.mkdirSync(path.dirname(path.join(tree, file)), { recursive: true });
          fs.writeFileSync(path.join(tree, file), mf.stdout, 'utf-8');
          if (mf.status === 0) gitRun(tree, cfg, ['add', '--', file]);
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      }
    }

    // Hand-written files follow the regen's renames.
    for (const d of opts.followDirs ?? ['Redivivus', 'support']) {
      const base0 = path.join(tree, d);
      if (!fs.existsSync(base0)) continue;
      for (const e of fs.readdirSync(base0, { recursive: true, withFileTypes: true })) {
        if (!e.isFile() || !['.cpp', '.c', '.h', '.hpp', '.inl'].includes(path.extname(e.name))) continue;
        const f = path.join((e as unknown as { parentPath?: string; path?: string }).parentPath ?? (e as unknown as { path: string }).path, e.name);
        const rel = path.relative(tree, f);
        const r = followHandFile(fs.readFileSync(f, 'utf-8'), beforeIndex, theirsIndex);
        if (r.changed || r.errors.length) result.followed.push({ file: rel, renames: r.renames, includes: r.includes, errors: r.errors });
        if (!r.changed) continue;
        fs.writeFileSync(f, r.text, 'utf-8');
        gitRun(tree, cfg, ['add', '--', rel]);
      }
    }
  } finally {
    after.done();
    before.done();
  }

  result.conflictFiles = gitRun(tree, cfg, ['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean);
  if (result.conflictFiles.length > 0) return { ...result, state: 'conflict', message: 'conflicts outside pinned functions: markers left, nothing resolved' };
  if (opts.commit !== false) {
    const c = gitRun(tree, cfg, ['commit', '--no-edit', ...(opts.commitArgs ?? [])]);
    if (c.code !== 0) return { ...result, state: 'error', message: (c.err || c.out).trim() };
  }
  return result;
}

