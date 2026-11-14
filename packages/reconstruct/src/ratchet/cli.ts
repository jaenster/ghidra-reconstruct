#!/usr/bin/env node
/**
 * ratchet: the per-function body store (docs/ratchet.md).
 *
 *   advance --tree T --audit A --evidence REV --store S [--regen R]   after a VC8 measurement
 *   apply   --tree T --store S [--in-place | --out O]      a generated tree, offline
 *   pin     --tree T --store S <addr...> [--note N]        capture hand-edited bodies
 *   unpin   --store S <addr...>
 *   release --store S <addr> --reason R                    let the generated body through
 *   follow  --tree T --from REV [--to REV] [--dir D...]    carry hand files through renames
 *   merge   --tree T <regen-ref> [--no-commit] [--no-sign]  git merge with pins as the merge
 *   show    --store S <addr>
 *
 * Every command prints a TSV report (or writes it with --report) and a one-line summary on
 * stderr. Nothing here touches Ghidra or git history; `follow` and `apply --in-place` edit
 * the working tree only.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { advance, formatAdvanceReport, readAudit } from './advance.js';
import { followHandFile } from './follow.js';
import { ratchetMerge } from './merge.js';
import { applyRecords, capture, formatApplyReport, summarize } from './ratchet.js';
import { RatchetStore, normalizeAddress } from './store.js';
import { SymbolIndex, diskTree } from './symbol-index.js';

type Opts = Record<string, string | string[] | boolean>;

function parseArgs(argv: string[]): { cmd: string; opts: Opts; rest: string[] } {
  const [cmd, ...args] = argv;
  const opts: Opts = {};
  const rest: string[] = [];
  const multi = new Set(['dir']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) { opts[key] = true; continue; }
      i++;
      if (multi.has(key)) opts[key] = [...((opts[key] as string[] | undefined) ?? []), next];
      else opts[key] = next;
    } else rest.push(a);
  }
  return { cmd: cmd ?? 'help', opts, rest };
}

function need(opts: Opts, key: string): string {
  const v = opts[key];
  if (typeof v !== 'string') throw new Error(`--${key} is required`);
  return v;
}

/** Generated paths only: hand-written directories are not part of the index. */
const GENERATED = (rel: string) => !rel.startsWith('Redivivus/') && !rel.startsWith('asm_matching/') && !rel.startsWith('3rdparty/libbacktrace/') && !rel.startsWith('ratchet/');

function treeIndex(root: string): SymbolIndex {
  return SymbolIndex.build(diskTree(root), GENERATED);
}

/** A tree at a commit, checked out under a temp dir (only the files the index reads). */
function treeAt(repo: string, rev: string): { root: string; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-tree-'));
  const tar = execFileSync('git', ['-C', repo, 'archive', rev, 'Source', '3rdparty'], { maxBuffer: 1 << 30 });
  execFileSync('tar', ['-x', '-C', dir], { input: tar, maxBuffer: 1 << 30 });
  return { root: dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function dhByAddress(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.cpp.map')) {
        try {
          const m = JSON.parse(fs.readFileSync(p, 'utf-8')) as { functions?: Array<{ address: string; dh?: string }> };
          for (const f of m.functions ?? []) if (f.dh) out.set(normalizeAddress(f.address), f.dh);
        } catch { /* a map that does not parse carries no dh */ }
      }
    }
  };
  if (fs.existsSync(path.join(root, 'Source'))) walk(path.join(root, 'Source'));
  return out;
}

function emit(opts: Opts, text: string): void {
  if (typeof opts.report === 'string') fs.writeFileSync(opts.report, text, 'utf-8');
  else process.stdout.write(text);
}

function revOf(tree: string): string {
  try { return execFileSync('git', ['-C', tree, 'rev-parse', '--short=9', 'HEAD']).toString().trim(); } catch { return 'unknown'; }
}

export async function main(argv: string[]): Promise<number> {
  const { cmd, opts, rest } = parseArgs(argv);
  switch (cmd) {
    case 'advance': {
      const tree = need(opts, 'tree');
      const store = new RatchetStore(need(opts, 'store'));
      const audit = readAudit(fs.readFileSync(need(opts, 'audit'), 'utf-8'));
      const evidence = typeof opts.evidence === 'string' ? opts.evidence : revOf(tree);
      // The regen side of the measured merge: a tree path, or a ref checked out from the tree's repo.
      let regenTree: { root: string; done: () => void } | undefined;
      if (typeof opts.regen === 'string') regenTree = fs.existsSync(opts.regen) ? { root: opts.regen, done: () => {} } : treeAt(tree, opts.regen);
      const rows = advance(treeIndex(tree), store, audit, evidence, {
        dh: dhByAddress(tree), dryRun: opts['dry-run'] === true, regen: regenTree ? treeIndex(regenTree.root) : undefined,
      });
      regenTree?.done();
      emit(opts, formatAdvanceReport(rows));
      const n = (s: string) => rows.filter(r => r.status === s).length;
      console.error(`ratchet advance @${evidence}: new ${n('new')}, refreshed ${n('refreshed')}, unchanged ${n('unchanged')}, phase-noise ${n('phase-noise')}, lost ${n('lost')}, retired ${n('retired')}, hand ${n('hand')}, uncapturable ${n('uncapturable')}`);
      return 0;
    }
    case 'apply': {
      const tree = need(opts, 'tree');
      const store = new RatchetStore(need(opts, 'store'));
      const index = treeIndex(tree);
      const releases = new Set(store.releases().map(r => r.address));
      const out = applyRecords(index, store.list(), { releases, forceKeep: opts['force-keep'] === true });
      const target = opts['in-place'] === true ? tree : typeof opts.out === 'string' ? opts.out : undefined;
      if (target) {
        for (const [file, text] of out.changed) {
          fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
          fs.writeFileSync(path.join(target, file), text, 'utf-8');
        }
      }
      emit(opts, formatApplyReport(out.rows));
      console.error(`ratchet apply: ${JSON.stringify(summarize(out.rows))}, ${out.changed.size} files${target ? ` written to ${target}` : ' (dry run)'}`);
      return summarize(out.rows).unresolved > 0 ? 3 : 0;
    }
    case 'pin': {
      const tree = need(opts, 'tree');
      const store = new RatchetStore(need(opts, 'store'));
      const index = treeIndex(tree);
      const rev = revOf(tree);
      let bad = 0;
      for (const a of rest.map(normalizeAddress)) {
        const c = capture(index, a, 'pin', rev, { note: typeof opts.note === 'string' ? opts.note : undefined, closure: false });
        if (!c.record) { console.error(`pin ${a}: ${c.error}`); bad++; continue; }
        store.put(c.record);
        console.log(`pinned\t${a}\t${c.record.members[0].name}`);
      }
      return bad ? 1 : 0;
    }
    case 'unpin': {
      const store = new RatchetStore(need(opts, 'store'));
      for (const a of rest.map(normalizeAddress)) {
        const r = store.get(a);
        if (r?.kind !== 'pin') { console.error(`unpin ${a}: no pin`); continue; }
        store.remove(a);
        console.log(`unpinned\t${a}`);
      }
      return 0;
    }
    case 'release': {
      const store = new RatchetStore(need(opts, 'store'));
      const reason = need(opts, 'reason');
      const rows = store.releases();
      for (const a of rest.map(normalizeAddress)) if (!rows.some(r => r.address === a)) rows.push({ address: a, reason });
      store.writeReleases(rows);
      return 0;
    }
    case 'show': {
      const store = new RatchetStore(need(opts, 'store'));
      for (const a of rest.map(normalizeAddress)) process.stdout.write(`${JSON.stringify(store.get(a), null, 1)}\n`);
      return 0;
    }
    case 'follow': {
      const tree = need(opts, 'tree');
      const from = need(opts, 'from');
      const dirs = (opts.dir as string[] | undefined) ?? ['Redivivus'];
      const before = treeAt(tree, from);
      let after: { root: string; done: () => void } | undefined;
      try {
        const bi = treeIndex(before.root);
        after = typeof opts.to === 'string' ? treeAt(tree, opts.to) : undefined;
        const ai = treeIndex(after ? after.root : tree);
        const lines: string[] = ['file\tstatus\tdetail'];
        let errs = 0;
        for (const d of dirs) {
          const base = path.join(tree, d);
          if (!fs.existsSync(base)) continue;
          const files = fs.readdirSync(base, { recursive: true, withFileTypes: true })
            .filter(e => e.isFile() && /\.(cpp|c|h|hpp|inl)$/u.test(e.name))
            .map(e => path.join(e.parentPath ?? (e as unknown as { path: string }).path, e.name));
          for (const f of files.sort()) {
            const rel = path.relative(tree, f);
            const r = followHandFile(fs.readFileSync(f, 'utf-8'), bi, ai);
            for (const e of r.errors) { lines.push(`${rel}\tunresolved\t${e}`); errs++; }
            if (!r.changed) continue;
            if (opts['dry-run'] !== true) fs.writeFileSync(f, r.text, 'utf-8');
            for (const x of r.renames) lines.push(`${rel}\trenamed\t${x}`);
            for (const x of r.includes) lines.push(`${rel}\tinclude\t${x}`);
          }
        }
        emit(opts, `${lines.join('\n')}\n`);
        console.error(`ratchet follow ${from} -> ${typeof opts.to === 'string' ? opts.to : 'worktree'}: ${lines.length - 1 - errs} edits, ${errs} unresolved`);
        return errs ? 3 : 0;
      } finally {
        before.done();
        after?.done();
      }
    }
    case 'merge': {
      const tree = need(opts, 'tree');
      const branch = rest[0];
      if (!branch) throw new Error('merge: which regen ref?');
      const r = ratchetMerge(tree, branch, {
        storeDir: typeof opts.store === 'string' ? opts.store : undefined,
        commit: opts['no-commit'] !== true,
        commitArgs: opts['no-sign'] === true ? ['--no-gpg-sign'] : [],
        followDirs: (opts.dir as string[] | undefined),
        allowUntracked: opts['allow-untracked'] === true,
      });
      const lines = ['what\taddress-or-file\tstatus\tdetail'];
      for (const p of r.pins) lines.push(`pin\t${p.address}\t${p.status}\t${p.detail}`);
      for (const f of r.followed) {
        for (const x of f.renames) lines.push(`follow\t${f.file}\trenamed\t${x}`);
        for (const x of f.includes) lines.push(`follow\t${f.file}\tinclude\t${x}`);
        for (const x of f.errors) lines.push(`follow\t${f.file}\tunresolved\t${x}`);
      }
      for (const c of r.conflictFiles) lines.push(`conflict\t${c}\t\t`);
      emit(opts, `${lines.join('\n')}\n`);
      console.error(`ratchet merge ${branch}: ${r.state}${r.message ? ` - ${r.message}` : ''}; pins ${r.pins.length}, hand files followed ${r.followed.length}, conflicts ${r.conflictFiles.length}`);
      return r.state === 'conflict' ? 3 : r.state === 'dirty' ? 5 : r.state === 'error' ? 1 : 0;
    }
    default:
      console.error('usage: ratchet advance|apply|pin|unpin|release|follow|show (see the header of ratchet/cli.ts)');
      return cmd === 'help' ? 0 : 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => process.exit(code), err => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
}
