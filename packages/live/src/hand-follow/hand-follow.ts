/**
 * Carry the hand-written delta of source/modified through file and TU moves.
 *
 * source/modified is the generator output (source/regen) plus a small hand delta. Every
 * generated function carries a `// 1.14d: <addr>` line, so a hand hunk can be keyed by the
 * function it sits in instead of by path and line number. That key survives a TU move or a
 * layout rename; a path does not. A plain merge of a regen that moves functions turns every
 * hand hunk inside a moved function into a modify/delete conflict, and `--theirs` then drops
 * it without a trace.
 *
 * Subcommands (see cli.ts for the options): inventory, plan, reapply, audit, simulate. Every
 * file they write is byte-identical to what the Python tools/hand-follow.py wrote, so plans
 * and inventories from either can be mixed.
 *
 * Matching is on whitespace-stripped lines. Context is up to 3 unchanged base lines either
 * side, clipped to the function, so it travels with the function.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { unifiedDiff } from './difflib.js';
import {
  PY_W,
  PY_WS,
  cmp,
  decodeSE,
  encodeSE,
  head as headCp,
  ljust,
  lstrip,
  pyJson,
  rstripChars,
  sorted,
  splitWS,
  splitlines,
  strip,
  tail,
  universalNewlines,
  zfill,
} from './pystr.js';

const W = `[${PY_W}]`;
const MARK = new RegExp(`^// 1\\.14d: (?:0x)?([0-9a-fA-F]{6,8})(?!${W})`, 'u');
const MARKS = new RegExp(`(?:^|(?<=\\n))// 1\\.14d: (?:0x)?([0-9a-fA-F]{6,8})(?!${W})`, 'gu');
/** Hand-owned by rsync exclude, not generated; their delta is not a hand patch over code. */
export const DEFAULT_EXCLUDES = ['asm_matching', 'Redivivus', '3rdparty/libbacktrace', '3rdparty/implibs', 'cmake',
  'tools', 'CMakeLists.txt', 'README.md', '.gitignore', '*.map'];
const SRC_EXT = ['.cpp', '.h', '.c', '.hpp', '.inc', '.CPP', '.H', '.C'];
const CTX = 3;
const TRIVIAL = new Set(['', '{', '}', '};', 'return;', 'break;', 'continue;', '} else {', 'else', '#endif']);
const COMPANIONS = ['.h', '.data.h', '.cpp.map'];
const IDENT_G = new RegExp(`[A-Za-z_]${W}*`, 'gu');
const IDENT_AT = new RegExp(`^[A-Za-z_]${W}*`, 'u');

export class ExitError extends Error {
  constructor(message: string, readonly code = 1) {
    super(message);
  }
}

// ---------------------------------------------------------------- git and files

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], surrogate = true): Run {
  const r = spawnSync(cmd, args, { maxBuffer: 1 << 30 });
  if (r.error) throw r.error;
  const dec = (b: Buffer) => universalNewlines(surrogate ? decodeSE(b) : b.toString('utf8'));
  return { code: r.status ?? 1, stdout: dec(r.stdout), stderr: dec(r.stderr) };
}

function git(repo: string, args: string[], check = true): string {
  const r = run('git', ['-C', repo, ...args]);
  if (check && r.code !== 0) throw new ExitError(`git ${args.slice(0, 6).join(' ')}: ${strip(r.stderr)}`);
  return r.stdout;
}

function show(repo: string, rev: string, p: string): string | null {
  const r = run('git', ['-C', repo, 'show', `${rev}:${p}`]);
  return r.code === 0 ? r.stdout : null;
}

function read(p: string): string | null {
  try {
    return decodeSE(fs.readFileSync(p));
  } catch (e) {
    const c = (e as NodeJS.ErrnoException).code;
    if (c === 'ENOENT' || c === 'EISDIR' || c === 'ENOTDIR') return null;
    throw e;
  }
}

function write(p: string, text: string): void {
  fs.mkdirSync(path.dirname(p) || '.', { recursive: true });
  fs.writeFileSync(p, encodeSE(text));
}

/** open(p, 'w').write(text): the locale codec, strict. */
function writeText(p: string, text: string): void {
  fs.writeFileSync(p, encodeSE(text, 'strict'));
}

/** Iterating a text-mode file: universal newlines, lines keep their '\n'. */
function textLines(p: string): string[] {
  const t = universalNewlines(decodeStrict(fs.readFileSync(p)));
  return t.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function decodeStrict(b: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(b);
}

const linesOf = (text: string | null): string[] => (text ? splitlines(text, true) : []);
const norm = (lines: string[]): string[] => lines.map(strip);

function h12(...parts: string[][]): string {
  const m = createHash('sha1');
  for (const p of parts) {
    m.update(encodeSE(norm(p).join('\n')));
    m.update(Buffer.from([0x1f]));
  }
  return m.digest('hex').slice(0, 12);
}

function weak(block: string[]): boolean {
  let n = 0;
  for (const l of norm(block)) if (!TRIVIAL.has(l)) n += [...l].length;
  return n < 8;
}

const endsWithAny = (p: string, exts: string[]) => exts.some((e) => p.endsWith(e));
const exists = (p: string) => fs.existsSync(p);

/** a[i] with Python's negative index. */
const at = <T>(a: T[], i: number): T => a[i < 0 ? a.length + i : i];

class DefaultMap<K, V> extends Map<K, V> {
  constructor(private make: () => V) {
    super();
  }
  need(k: K): V {
    let v = this.get(k);
    if (v === undefined) this.set(k, (v = this.make()));
    return v;
  }
}

function counterLine(xs: Iterable<string>): string {
  const c = new Map<string, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return sorted(c, (e) => e[0]).map(([k, v]) => `${k} ${v}`).join(', ');
}

// ---------------------------------------------------------------- the scanner

export class Fn {
  start: number;
  constructor(
    readonly addr: string,
    readonly marker: number,
    readonly body: number | null,
    readonly end: number,
    readonly ns: string,
    readonly name: string,
  ) {
    this.start = marker;
  }
  contains(li: number): boolean {
    return this.start <= li && li <= this.end;
  }
}

function identsOf(s: string): string[] {
  return s.match(IDENT_G) ?? [];
}

function sigName(pre: string): string {
  const ids = identsOf(pre.split('(')[0]);
  return ids.length ? ids[ids.length - 1] : '';
}

type Ev = [li: number, kind: string, pre: string | null];

/**
 * Function spans of one file, 0-based inclusive line indices.
 *
 * A marker counts only at namespace level. The body is the first `{` after it at that
 * level; a `;` first means a declaration, whose span ends there. Braces in strings,
 * character literals, comments and preprocessor lines do not count; at #else/#elif the
 * brace state of the #if is restored and the first branch's result kept at #endif.
 */
export function scan(lines: string[]): Fn[] {
  const events: Ev[] = [];
  let inBlock = false;
  let cont = false;
  let pending = '';
  lines.forEach((line, li) => {
    if (!inBlock && (cont || lstrip(line).startsWith('#'))) {
      if (!cont) {
        const m = IDENT_AT.exec(lstrip(lstrip(line).slice(1)));
        const d = m ? m[0] : '';
        if (d === 'if' || d === 'ifdef' || d === 'ifndef') events.push([li, '#if', null]);
        else if (d === 'else' || d === 'elif') events.push([li, '#else', null]);
        else if (d === 'endif') events.push([li, '#endif', null]);
      }
      cont = rstripChars(line, '\r\n').endsWith('\\');
      return;
    }
    let i = 0;
    const n = line.length;
    while (i < n) {
      const c = line[i];
      if (inBlock) {
        const j = line.indexOf('*/', i);
        if (j < 0) break;
        inBlock = false;
        i = j + 2;
        continue;
      }
      if (c === '/' && line.startsWith('//', i)) break;
      if (c === '/' && line.startsWith('/*', i)) {
        inBlock = true;
        i += 2;
        continue;
      }
      if (c === '"' && i > 0 && line[i - 1] === 'R' && line.indexOf('(', i) >= 0) {
        const p = line.indexOf('(', i);
        const delim = ')' + line.slice(i + 1, p) + '"';
        const j = line.indexOf(delim, p);
        i = j >= 0 ? j + delim.length : n;
        pending += ' ';
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n) {
          if (line[j] === '\\') {
            j += 2;
            continue;
          }
          if (line[j] === c) break;
          j += 1;
        }
        pending += ' ';
        i = j + 1;
        continue;
      }
      if (c === '{') {
        events.push([li, '{', tail(pending, 400)]);
        pending = '';
      } else if (c === '}' || c === ';') {
        events.push([li, c, null]);
        pending = '';
      } else pending += c;
      i += 1;
    }
    pending += '\n';
  });

  const markers: [number, string][] = [];
  lines.forEach((l, li) => {
    const m = MARK.exec(l);
    if (m) markers.push([li, zfill(m[1].toLowerCase(), 8)]);
  });
  const fns: Fn[] = [];
  let stack: [string, string][] = [];
  const pp: [[string, string][], [string, string][] | null][] = [];
  let mi = 0;
  // [addr, marker line, depth, body line, name, ns]
  let cur: [string, number, number, number | null, string, string] | null = null;
  for (const [li, kind, pre] of events) {
    while (mi < markers.length && markers[mi][0] < li) {
      const [mli, addr] = markers[mi];
      mi += 1;
      if (cur === null && stack.every(([k]) => k === 'ns')) {
        cur = [addr, mli, stack.length, null, '', stack.filter(([, nm]) => nm).map(([, nm]) => nm).join('::')];
      }
    }
    if (kind === '#if') {
      pp.push([[...stack], null]);
      continue;
    }
    if (kind === '#else') {
      if (pp.length) {
        const top = pp[pp.length - 1];
        if (top[1] === null) top[1] = [...stack];
        stack = [...top[0]];
      }
      continue;
    }
    if (kind === '#endif') {
      if (pp.length) {
        const top = pp.pop()!;
        if (top[1] !== null) stack = top[1];
      }
      continue;
    }
    if (kind === '{') {
      const t = strip(pre!);
      if (NS_RE.test(t)) stack.push(['ns', strip(t.slice(t.indexOf('namespace') + 'namespace'.length))]);
      else if (t === 'extern') stack.push(['ns', '']);
      else {
        stack.push(['blk', '']);
        if (cur !== null && cur[3] === null && stack.length === cur[2] + 1) {
          cur[3] = li;
          cur[4] = sigName(pre!);
        }
      }
    } else if (kind === '}') {
      if (stack.length) stack.pop();
      if (cur !== null && cur[3] !== null && stack.length === cur[2]) {
        fns.push(new Fn(cur[0], cur[1], cur[3], li, cur[5], cur[4]));
        cur = null;
      }
    } else if (kind === ';') {
      if (cur !== null && cur[3] === null && stack.length === cur[2]) {
        fns.push(new Fn(cur[0], cur[1], null, li, cur[5], ''));
        cur = null;
      }
    }
  }
  // The plate comment is the `//` block directly above the marker.
  let prevEnd = -1;
  for (const f of fns) {
    let s = f.marker;
    while (s - 1 > prevEnd && lstrip(at(lines, s - 1)).startsWith('//') && !MARK.test(at(lines, s - 1))) s -= 1;
    f.start = s;
    prevEnd = f.end;
  }
  return fns;
}
const NS_RE = new RegExp(`^(?:inline[${PY_WS}]+)?namespace(?!${W})`, 'u');

function fnAt(fns: Fn[], li: number): Fn | null {
  for (const f of fns) if (f.contains(li)) return f;
  return null;
}

const addrAt = (fns: Fn[], li: number) => fnAt(fns, li)?.addr ?? null;

/** The function a gap between lines i and j sits in, or null between functions. */
function point(fns: Fn[], i: number, j: number): string | null {
  const a = fnAt(fns, i), b = fnAt(fns, j);
  return a !== null && a === b ? a.addr : null;
}

/** Names of namespace-level `static` objects and functions outside any marked span. */
function fileStatics(lines: string[], fns: Fn[]): Set<string> {
  const inside = new Set<number>();
  for (const f of fns) for (let i = f.start; i <= f.end; i++) inside.add(i);
  const out = new Set<string>();
  lines.forEach((l, li) => {
    const s = strip(l);
    if (inside.has(li) || !s.startsWith('static ')) return;
    const cuts = ['=', ';', '[', '('].map((c) => s.indexOf(c)).filter((p) => p >= 0);
    const cut = cuts.length ? Math.min(...cuts) : s.length;
    const ids = identsOf(s.slice(0, cut));
    if (ids.length) out.add(ids[ids.length - 1]);
  });
  return out;
}

function tokens(lines: string[]): Set<string> {
  const out = new Set<string>();
  for (const l of lines) for (const t of identsOf(l.split('//')[0])) out.add(t);
  return out;
}

const QUAL = new RegExp(`(?<![${PY_W}:])([A-Za-z_]${W}*)::`, 'gu');

/** `A::B` spellings whose first component is neither `::` nor a top-level namespace. */
function relQualifiers(lines: string[], tops: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const l of lines) {
    for (const m of l.split('//')[0].matchAll(QUAL)) if (!tops.has(m[1]) && m[1] !== 'std') out.add(m[1]);
  }
  return out;
}

function trackedSources(root: string): string[] {
  if (exists(path.join(root, '.git'))) {
    const out = git(root, ['ls-files', '-z', '--', ...SRC_EXT.map((e) => `*${e}`)]);
    return out.split('\0').filter((p) => p);
  }
  const res: string[] = [];
  const walk = (dir: string) => {
    const ents = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of ents) if (!e.isDirectory() && endsWithAny(e.name, SRC_EXT)) res.push(path.relative(root, path.join(dir, e.name)));
    for (const e of ents) if (e.isDirectory() && e.name !== '.git') walk(path.join(dir, e.name));
  };
  walk(root);
  return res;
}

/** rel path -> [Fn] for source files under root; with `want`, only files naming one. */
function indexTree(root: string, want: Set<string> | null = null): Map<string, Fn[]> {
  const out = new Map<string, Fn[]>();
  for (const rel of trackedSources(root)) {
    const t = read(path.join(root, rel));
    if (t === null || !t.includes('// 1.14d: ')) continue;
    if (want !== null) {
      let hit = false;
      for (const m of t.matchAll(MARKS)) if (want.has(zfill(m[1].toLowerCase(), 8))) hit = true;
      if (!hit) continue;
    }
    out.set(rel, scan(linesOf(t)));
  }
  return out;
}

// ---------------------------------------------------------------- inventory

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface RawHunk {
  old_start: number;
  old_len: number;
  new_start: number;
  new_len: number;
  removed: string[];
  added: string[];
}

export interface Hunk extends RawHunk {
  file: string;
  scope: string;
  kind: string;
  addrs: string[];
  addr: string | null;
  fn: string;
  ns: string;
  off_old: number | null;
  off_new: number | null;
  ctx_before: string[];
  ctx_after: string[];
  hash: string;
  weak: boolean;
  id: string;
}

export interface Inventory {
  base: string;
  head: string;
  base_ref: string;
  head_ref: string;
  tree: string;
  top_namespaces: string[];
  hand_files: string[];
  hunks: Hunk[];
}

function parseDiff(text: string): Map<string, RawHunk[]> {
  const files = new Map<string, RawHunk[]>();
  let cur: string | null = null;
  for (const line of splitlines(text, true)) {
    if (line.startsWith('diff --git ')) cur = null;
    else if (cur === null && line.startsWith('+++ ')) {
      const p = rstripChars(line.slice(4), '\n');
      cur = p.startsWith('b/') ? p.slice(2) : null;
      if (cur !== null) files.set(cur, []);
    } else if (line.startsWith('@@') && cur !== null) {
      const m = HUNK.exec(line)!;
      files.get(cur)!.push({
        old_start: +m[1], old_len: m[2] === undefined ? 1 : +m[2],
        new_start: +m[3], new_len: m[4] === undefined ? 1 : +m[4],
        removed: [], added: [],
      });
    } else if (cur !== null && files.get(cur)!.length) {
      const hs = files.get(cur)!;
      if (line.startsWith('-')) hs[hs.length - 1].removed.push(line.slice(1));
      else if (line.startsWith('+')) hs[hs.length - 1].added.push(line.slice(1));
    }
  }
  return files;
}

function hunkKind(h: RawHunk): string {
  const body = norm([...h.removed, ...h.added]).filter((l) => l);
  if (body.length && body.every((l) => l.startsWith('#include'))) return 'include';
  if (body.length && body.every((l) => l.startsWith('#'))) return 'preprocessor';
  return 'code';
}

export interface InventoryArgs {
  tree: string;
  base: string;
  head: string;
  exclude?: string[];
  out: string;
}

export function cmdInventory(a: InventoryArgs, log: (s: string) => void): number {
  const repo = path.resolve(a.tree);
  const base = strip(git(repo, ['rev-parse', a.base]));
  const head = strip(git(repo, ['rev-parse', a.head]));
  const spec = ['--', '.', ...[...DEFAULT_EXCLUDES, ...(a.exclude ?? [])].map((x) => `:!${x}`)];
  const addedFiles = splitWS(git(repo, ['diff', '--name-only', '--diff-filter=A', base, head, ...spec]));
  const diff = git(repo, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames',
    '--diff-algorithm=histogram', '--diff-filter=M', base, head, ...spec]);
  const files = parseDiff(diff);
  const hunks: Hunk[] = [];
  const tops = new Set<string>();
  for (const [p, hs] of files) {
    const bl = linesOf(show(repo, base, p)), hl = linesOf(show(repo, head, p));
    const bf = scan(bl), hf = scan(hl);
    // Base lines another hunk replaces, and base lines another hunk inserts in front
    // of: context may not cross either, or it would not be contiguous in the result.
    const changedOld = new Set<number>(), gaps = new Set<number>();
    for (const h of hs) {
      for (let i = h.old_start - 1; i < h.old_start - 1 + h.old_len; i++) changedOld.add(i);
      if (!h.old_len) gaps.add(h.old_start);
    }
    for (const f of hf) if (f.ns) tops.add(f.ns.split('::')[0]);
    for (const h of hs) {
      const ol = h.old_len, nl = h.new_len;
      // -U0: a zero-length side is a gap after line N (1-based) of that side
      const first = ol ? h.old_start - 1 : h.old_start;
      const fo = new Set<string | null>();
      if (ol) for (let i = first; i < first + ol; i++) fo.add(addrAt(bf, i));
      else fo.add(point(bf, first - 1, first));
      const n0 = nl ? h.new_start - 1 : h.new_start;
      const fw = new Set<string | null>();
      if (nl) for (let i = n0; i < n0 + nl; i++) fw.add(addrAt(hf, i));
      else fw.add(point(hf, n0 - 1, n0));
      const addrs = new Set([...fo, ...fw]);
      const named = sorted([...addrs].filter((x): x is string => !!x));
      let scope: string;
      if (addrs.size === 1 && named.length) scope = 'function';
      else if (!named.length) scope = 'file';
      else scope = 'multi';
      const rec = {
        file: p, ...h, scope, kind: hunkKind(h), addrs: named, addr: null as string | null, fn: '', ns: '',
        off_old: null as number | null, off_new: null as number | null,
      } as Hunk;
      let anchor: Fn | null = null;
      if (scope === 'function') {
        const addr = named[0];
        anchor = bf.find((f) => f.addr === addr) ?? null;
        const nf = hf.find((f) => f.addr === addr) ?? null;
        const src = nf ?? anchor;
        rec.addr = addr;
        rec.fn = src ? src.name : '';
        rec.ns = src ? src.ns : '';
        if (anchor === null) rec.scope = 'hand-function';
        else rec.off_old = first - anchor.start;
        if (nf !== null) rec.off_new = n0 - nf.start;
      }
      // Context: unchanged base lines next to the hunk, clipped to the function.
      const [lo, hi] = anchor ? [anchor.start, anchor.end] : [0, bl.length - 1];
      const cb: string[] = [];
      let i = first - 1;
      while (i >= lo && cb.length < CTX && !changedOld.has(i) && (i + 1 === first || !gaps.has(i + 1))) {
        cb.unshift(at(bl, i));
        i -= 1;
      }
      const ca: string[] = [];
      i = first + ol;
      while (i <= hi && ca.length < CTX && !changedOld.has(i) && (i === first + ol || !gaps.has(i))) {
        ca.push(at(bl, i));
        i += 1;
      }
      rec.ctx_before = cb;
      rec.ctx_after = ca;
      rec.hash = h12(rec.removed, rec.added);
      rec.weak = weak(rec.added) && weak(rec.removed);
      hunks.push(rec);
    }
  }
  hunks.forEach((r, i) => (r.id = `h${String(i + 1).padStart(3, '0')}`));
  const inv: Inventory = {
    base, head, base_ref: a.base, head_ref: a.head, tree: repo,
    top_namespaces: sorted(tops), hand_files: addedFiles, hunks,
  };
  fs.mkdirSync(a.out, { recursive: true });
  writeText(path.join(a.out, 'hand-inventory.json'), pyJson(inv));
  const cols = ['id', 'hash', 'file', 'scope', 'kind', 'addr', 'fn', 'ns', 'old_start', 'old_len',
    'new_start', 'new_len', 'off_in_fn', 'n_added', 'n_removed', 'weak', 'first_line'];
  const rows = [cols.join('\t') + '\n'];
  for (const r of hunks) {
    const first = [...r.added, ...r.removed].map(strip).find((l) => l) ?? '';
    rows.push([
      r.id, r.hash, r.file, r.scope, r.kind, r.addr || r.addrs.join(','), r.fn, r.ns, r.old_start,
      r.old_len, r.new_start, r.new_len, r.off_new === null ? '' : r.off_new, r.added.length,
      r.removed.length, r.weak ? 1 : 0, headCp(first, 100).split('\t').join(' '),
    ].map(String).join('\t') + '\n');
  }
  for (const p of addedFiles) {
    rows.push(['-', '-', p, 'hand-file', '-', ...Array(10).fill(''), '0', 'whole file absent from base'].join('\t') + '\n');
  }
  writeText(path.join(a.out, 'hand-inventory.tsv'), rows.join(''));
  log(`${hunks.length} hunks in ${files.size} files (+${addedFiles.length} hand-owned files): ` +
    counterLine(hunks.map((r) => r.scope)));
  log(`base ${base.slice(0, 10)} (${a.base})  head ${head.slice(0, 10)} (${a.head})`);
  return 0;
}

// ---------------------------------------------------------------- maps

type Row = Record<string, string>;

function readTsv(p: string): Row[] {
  const rows = textLines(p).filter((l) => strip(l)).map((l) => rstripChars(l, '\n').split('\t'));
  return rows.slice(1).map((r) => {
    const o: Row = {};
    const n = Math.min(rows[0].length, r.length);
    for (let i = 0; i < n; i++) o[rows[0][i]] = r[i];
    return o;
  });
}

function need(r: Row, k: string): string {
  if (!(k in r)) throw new Error(`KeyError: '${k}'`);
  return r[k];
}

export interface MapArgs {
  inventory: string;
  clusters?: string;
  fn_map?: string;
  fn_map_tree?: string;
  layout?: string;
  path_map?: string;
  out: string;
}

/** addr -> [new file, where the claim came from, the file the claim says it leaves] */
type FnMap = Map<string, [string, string, string]>;

function loadFnMap(a: MapArgs, inv: Inventory): FnMap {
  const m: FnMap = new Map();
  if (a.clusters) {
    for (const r of readTsv(a.clusters)) {
      for (const item of (r.functions || '').split(';')) {
        if (item.includes(':')) {
          const addr = zfill(item.split(':')[0].toLowerCase(), 8);
          m.set(addr, [need(r, 'to_tu'), r.cluster ?? '', r.from_tu ?? '']);
        }
      }
    }
  }
  if (a.fn_map) {
    for (const l of textLines(a.fn_map)) {
      const p = rstripChars(l, '\n').split('\t');
      if (p.length >= 2 && /^(0x)?[0-9a-fA-F]{6,8}$/.test(p[0])) {
        m.set(zfill(p[0].toLowerCase().split('0x').join(''), 8), [p[1], 'fn-map', '']);
      }
    }
  }
  if (a.fn_map_tree) {
    // every function of a file with hunks, so file-level hunks see what leaves
    const want = new Set<string>();
    for (const p of new Set(inv.hunks.map((r) => r.file))) {
      for (const f of scan(linesOf(show(inv.tree, inv.head, p)))) want.add(f.addr);
    }
    for (const [rel, fns] of indexTree(a.fn_map_tree, want)) for (const f of fns) m.set(f.addr, [rel, 'tree', '']);
  }
  return m;
}

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dirname = (p: string) => (p.includes('/') ? rstripChars(p.slice(0, p.lastIndexOf('/') + 1), '/') || '/' : '');

/** [renames old -> new, merged files old -> the file that absorbs them]. */
function loadPathMap(a: MapArgs, tracked: Set<string>): [Map<string, string>, Map<string, string>] {
  const pairs: [string, string][] = [];
  if (a.layout) {
    for (const r of readTsv(a.layout)) {
      const parts = splitWS(r.proposed_path || '');
      const nw = parts.length ? parts[0] : ''; // the column may carry a trailing [note]
      if (nw && nw !== need(r, 'current_path')) pairs.push([r.current_path, nw]);
    }
  }
  if (a.path_map) {
    for (const l of textLines(a.path_map)) {
      const p = rstripChars(l, '\n').split('\t');
      if (p.length >= 2 && p[0] && p[1] && p[0] !== 'old') pairs.push([p[0], p[1]]);
    }
  }
  const byNew = new DefaultMap<string, string[]>(() => []);
  for (const [o, n] of pairs) byNew.need(n).push(o);
  const mv = new Map<string, string>(), merge = new Map<string, string>();
  for (const [n, olds] of byNew) {
    if (olds.length === 1) {
      mv.set(olds[0], n);
      continue;
    }
    // Several files become one: the one with the target's name is renamed, the
    // others' functions move into it.
    const same = olds.filter((o) => basename(o).toLowerCase() === basename(n).toLowerCase());
    const keep = same.length === 1 ? same[0] : sorted(olds)[0];
    mv.set(keep, n);
    for (const o of olds) if (o !== keep) merge.set(o, n);
  }
  for (const [o, n] of [...mv]) {
    if (o.endsWith('.cpp') && n.toLowerCase().endsWith('.cpp')) {
      const ob = o.slice(0, -4), nb = n.slice(0, -4);
      for (const ext of COMPANIONS) if (tracked.has(ob + ext) && !mv.has(ob + ext)) mv.set(ob + ext, nb + ext);
    }
  }
  return [mv, merge];
}

/**
 * Spell a path the way the tree does. Plans written on a case-insensitive file system
 * name `Source/D2Game/Player/PlayerMsg.cpp` for the tracked `Source/D2Game/PLAYER/PlayerMsg.cpp`;
 * git treats those as two files, so every path from a map goes through here first.
 */
class Canon {
  files = new Map<string, string>();
  dirs = new Map<string, string>();
  fixed = new Map<string, string>();
  constructor(tracked: Iterable<string>) {
    for (const p of tracked) this.files.set(p.toLowerCase(), p);
    for (const p of tracked) {
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) {
        const d = parts.slice(0, i).join('/');
        if (!this.dirs.has(d.toLowerCase())) this.dirs.set(d.toLowerCase(), d);
      }
    }
  }
  call = (p: string): string => {
    if (!p) return p;
    let q = this.files.get(p.toLowerCase());
    if (q === undefined) {
      const d = dirname(p), b = basename(p);
      q = d ? (this.dirs.get(d.toLowerCase()) ?? d) + '/' + b : b;
    }
    if (q !== p) this.fixed.set(p, q);
    return q;
  };
}

/**
 * One spelling per directory across the tree after the moves.
 *
 * Two spellings of a directory are one directory on macOS and Windows, so `git mv` into
 * the second fails or lands in the first. The spelling the tree already has wins, else
 * the one most targets use. Returns the respell map; the caller reports it.
 */
function foldCase(tracked: Iterable<string>, mv: Map<string, string>, merge: Map<string, string>): Map<string, string> {
  const final = [...[...tracked].filter((p) => !merge.has(p)).map((p) => mv.get(p) ?? p), ...merge.values()];
  const count = new Map<string, number>();
  const inc = (k: string) => count.set(k, (count.get(k) ?? 0) + 1);
  for (const p of final) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) inc(parts.slice(0, i).join('/'));
  }
  const have = new Map<string, string>();
  for (const p of tracked) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (!have.has(d.toLowerCase())) have.set(d.toLowerCase(), d);
    }
  }
  for (const p of final) inc(p);
  const groups = new DefaultMap<string, string[]>(() => []);
  for (const d of count.keys()) groups.need(d.toLowerCase()).push(d);
  const pick = new Map<string, string>();
  for (const [k, v] of groups) {
    if (v.length > 1) {
      const h = have.get(k);
      const win = h !== undefined && v.includes(h) ? h : sorted(v, (d) => [count.get(d)!, d]).pop()!;
      for (const d of v) if (d !== win) pick.set(d, win);
    }
  }
  if (!pick.size) return new Map();
  const fix = (p: string): string => {
    if (pick.has(p)) return pick.get(p)!;
    const parts = p.split('/');
    for (let i = parts.length - 1; i > 0; i--) {
      const d = parts.slice(0, i).join('/');
      if (pick.has(d)) return fix(pick.get(d)! + '/' + parts.slice(i).join('/'));
    }
    return p;
  };
  const out = new Map<string, string>();
  for (const p of new Set([...mv.values(), ...merge.values()])) if (fix(p) !== p) out.set(p, fix(p));
  return out;
}

function canonMaps(c: Canon, fnmap: FnMap, mv: Map<string, string>, merge: Map<string, string>,
  tracked: Set<string> | null): [FnMap, Map<string, string>, Map<string, string>, Map<string, string>] {
  fnmap = new Map([...fnmap].map(([k, [t, s, f]]) => [k, [c.call(t), s, c.call(f)]]));
  mv = mapPairs(mv, c.call);
  merge = mapPairs(merge, c.call);
  const folded = tracked !== null ? foldCase(tracked, mv, merge) : new Map<string, string>();
  if (folded.size) {
    mv = new Map([...mv].map(([o, n]) => [o, folded.get(n) ?? n]));
    merge = new Map([...merge].map(([o, n]) => [o, folded.get(n) ?? n]));
    fnmap = new Map([...fnmap].map(([k, [t, s, f]]) => [k, [folded.get(t) ?? t, s, f]]));
    // two files folded onto one name: the second is merged into the first
    const seen = new Map<string, string>();
    for (const o of sorted(mv.keys())) {
      const n = mv.get(o)!;
      if (seen.has(n)) {
        merge.set(o, n);
        mv.delete(o);
      } else seen.set(n, o);
    }
  }
  return [fnmap, mv, merge, folded];
}

function mapPairs(m: Map<string, string>, f: (s: string) => string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [o, n] of m) out.set(f(o), f(n));
  return out;
}

// ---------------------------------------------------------------- plan

const INCLUDE = new RegExp(`^[${PY_WS}]*#[${PY_WS}]*include[${PY_WS}]+"([^"]+)"`, 'u');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function loadInventory(p: string): Inventory {
  return JSON.parse(decodeStrict(fs.readFileSync(p))) as Inventory;
}

interface PlanRow {
  id: string;
  hash: string;
  file: string;
  scope: string;
  kind: string;
  addr: string;
  fn: string;
  action: string;
  new_file: string;
  notes: string[];
}

export function cmdPlan(a: MapArgs, log: (s: string) => void): number {
  const inv = loadInventory(a.inventory);
  const repo = inv.tree, headRev = inv.head;
  const tracked = new Set(splitlines(git(repo, ['ls-tree', '-r', '--name-only', headRev])));
  let fnmap = loadFnMap(a, inv);
  let [mv, merge] = loadPathMap(a, tracked);
  const canon = new Canon(tracked);
  let folded: Map<string, string>;
  [fnmap, mv, merge, folded] = canonMaps(canon, fnmap, mv, merge, tracked);
  const tops = new Set(inv.top_namespaces);
  const hunks = inv.hunks;
  const byid = new Map(hunks.map((r) => [r.id, r]));
  const hcache = new Map<string, string[]>(), bcache = new Map<string, string[]>(), bscache = new Map<string, Fn[]>();
  const hfile = (p: string) => {
    if (!hcache.has(p)) hcache.set(p, linesOf(show(repo, headRev, p)));
    return hcache.get(p)!;
  };
  const bfile = (p: string) => {
    if (!bcache.has(p)) {
      const ls = linesOf(show(repo, inv.base, p));
      bcache.set(p, ls);
      bscache.set(p, scan(ls));
    }
    return bcache.get(p)!;
  };
  const bscan = (p: string) => {
    bfile(p);
    return bscache.get(p)!;
  };

  const headFns = new Map<string, Fn[]>();
  for (const p of new Set(hunks.map((r) => r.file))) headFns.set(p, scan(hfile(p)));
  for (const [o, n] of merge) {
    if (tracked.has(o)) for (const f of scan(hfile(o))) if (!fnmap.has(f.addr)) fnmap.set(f.addr, [n, 'layout-merge', o]);
  }
  const pmap = (p: string) => mv.get(p) ?? merge.get(p) ?? p;
  const ren = (p: string) => mv.get(p) ?? p; // where the file itself goes; a merged file is not renamed

  const movedFrom = new DefaultMap<string, Set<string>>(() => new Set()); // file -> addrs that leave it
  for (const [p, fns] of headFns) {
    for (const f of fns) {
      const t = fnmap.get(f.addr);
      if (t && pmap(t[0]) !== ren(p)) movedFrom.need(p).add(f.addr);
    }
  }

  // Identifiers a file-level hunk adds that the base file never had.
  const introduced = new Map<string, Set<string>>();
  for (const r of hunks) {
    if (r.scope === 'file' || r.scope === 'multi' || r.scope === 'hand-function') {
      const base = tokens(bfile(r.file));
      introduced.set(r.id, new Set([...tokens(r.added)].filter((t) => !base.has(t))));
    }
  }
  const statics = new Map<string, Set<string>>();
  const invMv = new Map<string, string>();
  for (const [o, n] of mv) invMv.set(n, o);

  const plan: PlanRow[] = [], review: PlanRow[] = [];
  const lift = new DefaultMap<string, Hunk[]>(() => []);
  for (const r of hunks) {
    const p = r.file;
    const np = ren(p);
    const row: PlanRow = {
      id: r.id, hash: r.hash, file: p, scope: r.scope, kind: r.kind, addr: r.addr || r.addrs.join(','),
      fn: r.fn, action: 'stay', new_file: np, notes: [],
    };
    if (r.scope === 'function') {
      const t = fnmap.get(r.addr!);
      const target = t ? pmap(t[0]) : np;
      row.new_file = target;
      if (t && t[2] && t[2] !== p && t[1] !== 'tree') row.notes.push(`map says it leaves ${t[2]}, head has it in ${p}`);
      if (target !== np) {
        row.action = 'move-fn';
        lift.need(p).push(r);
        if (!statics.has(p)) statics.set(p, fileStatics(bfile(p), bscan(p)));
        const bfn = bscan(p).find((f) => f.addr === r.addr) ?? null;
        const body = bfn ? tokens(bfile(p).slice(bfn.start, bfn.end + 1)) : new Set<string>();
        const nw = tokens(r.added);
        const st = statics.get(p)!;
        const dep = sorted([...nw].filter((x) => st.has(x) && !body.has(x)));
        if (dep.length) row.notes.push('uses file statics of the old TU the generated body does not: ' + dep.join(','));
        for (const [oid, names] of introduced) {
          if (byid.get(oid)!.file === p) {
            const both = [...nw].filter((x) => names.has(x));
            if (both.length) row.notes.push(`uses ${sorted(both).slice(0, 6).join(',')} introduced by file-level ${oid}`);
          }
        }
        // Includes the old TU's hand code added that the target does not have.
        const cur = invMv.get(target) ?? target;
        const have = tracked.has(cur) ? new Set(norm(hfile(cur))) : new Set<string>();
        for (const x of hunks) {
          if (x.file === p && x.scope === 'file' && x.kind === 'include') {
            const needs = x.added.map(strip).filter((l) => l && !have.has(l));
            if (needs.length) row.notes.push(`target lacks ${needs.join('; ')} (file-level ${x.id} of the old TU)`);
          }
        }
        const q = sorted(relQualifiers(r.added, tops));
        if (q.length) row.notes.push('namespace-relative qualifiers, re-check in the new namespace: ' + q.join(','));
      } else if (np !== p) row.action = 'follow-file';
    } else {
      if (merge.has(p)) {
        row.new_file = merge.get(p)!;
        row.action = 'review';
        row.notes.push(`file is merged into ${merge.get(p)}; its file-level hand code has no home`);
      } else if (movedFrom.has(p)) {
        row.action = 'review';
        const mf = movedFrom.get(p)!;
        row.notes.push(`${mf.size} function(s) leave this TU`);
        const intro = introduced.get(r.id) ?? new Set<string>();
        const users = hunks
          .filter((x) => x.file === p && x.scope === 'function' && mf.has(x.addr!) && [...tokens(x.added)].some((t) => intro.has(t)))
          .map((x) => x.id);
        if (users.length) row.notes.push('needed by moving hunk(s) ' + users.join(','));
      } else if (np !== p) row.action = 'follow-file';
      if (r.scope === 'multi' && (merge.has(p) || r.addrs.some((x) => fnmap.has(x) && pmap(fnmap.get(x)![0]) !== np))) {
        row.action = 'review';
        row.notes.push('hunk spans functions ' + r.addrs.join(',') + ' and one of them changes TU');
      }
    }
    for (const l of r.added) {
      const m = INCLUDE.exec(l);
      if (m && mv.has(m[1])) {
        row.notes.push(`#include "${m[1]}" moves to ${mv.get(m[1])}`);
        if (row.action === 'stay' || row.action === 'follow-file') row.action = 'review';
      }
    }
    if (row.action === 'review' || (row.action === 'move-fn' && row.notes.length)) review.push(row);
    plan.push(row);
  }

  fs.mkdirSync(a.out, { recursive: true });
  const cols: (keyof PlanRow)[] = ['id', 'hash', 'file', 'scope', 'kind', 'addr', 'fn', 'action', 'new_file', 'notes'];
  for (const [name, rows] of [['move-plan.tsv', plan], ['review.tsv', review]] as const) {
    const out = [cols.join('\t') + '\n'];
    for (const r of rows) out.push(cols.map((c) => (c === 'notes' ? r.notes.join('; ') : String(r[c]))).join('\t') + '\n');
    writeText(path.join(a.out, name), out.join(''));
  }

  const conflicts: string[] = [];
  if (folded.size) {
    const seen = new Set<string>();
    const dirs: [string, string][] = [];
    for (const [k, v] of folded) {
      const pair: [string, string] = [dirname(k), dirname(v)];
      const key = pair.join('\0');
      if (pair[0] !== pair[1] && !seen.has(key)) seen.add(key), dirs.push(pair);
    }
    const sd = sorted(dirs);
    conflicts.push(`case collision: ${folded.size} target(s) respelled so each directory has one spelling (fix the map): ` +
      sd.slice(0, 8).map(([x, y]) => `${x} -> ${y}`).join(', '));
  }
  if (canon.fixed.size) {
    conflicts.push(`${canon.fixed.size} map path(s) differ from the tree only in case, respelled: ` +
      sorted(canon.fixed, (e) => e).slice(0, 8).map(([k, v]) => `${k} -> ${v}`).join(', '));
  }
  for (const o of sorted(mv.keys())) if (!tracked.has(o)) conflicts.push(`path map names ${o}, which is not tracked at head`);
  // Renames ordered so that every target is free when it is used.
  const todo = new Map([...mv].filter(([o]) => tracked.has(o)));
  const existing = new Set(tracked);
  const order: [string, string][] = [];
  while (todo.size) {
    const ready = sorted([...todo].filter(([, n]) => !existing.has(n)).map(([o]) => o));
    if (!ready.length) {
      conflicts.push('occupied targets or a rename cycle: ' +
        sorted(todo, (e) => e).slice(0, 5).map(([o, n]) => `${o}->${n}`).join(', '));
      break;
    }
    for (const o of ready) {
      const n = todo.get(o)!;
      todo.delete(o);
      order.push([o, n]);
      existing.delete(o);
      existing.add(n);
    }
  }
  const final = new Set([...tracked].filter((p) => !merge.has(p)).map(pmap));
  const spell = new DefaultMap<string, Set<string>>(() => new Set());
  for (const p of final) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) spell.need(parts.slice(0, i).join('/').toLowerCase()).add(parts.slice(0, i).join('/'));
    spell.need(p.toLowerCase()).add(p);
  }
  for (const [, v] of sorted(spell, (e) => e[0])) {
    if (v.size > 1) conflicts.push('case collision, one path on macOS and Windows: ' + sorted(v).join(' / '));
  }
  const handFiles = new Set(inv.hand_files);
  const owned = [...tracked].filter((p) => p === 'CMakeLists.txt' ||
    ['Redivivus/', 'cmake/', '3rdparty/libbacktrace/', '3rdparty/implibs/'].some((x) => p.startsWith(x)) || handFiles.has(p));
  const moving = new Set([...mv.keys(), ...merge.keys()]);
  for (const p of sorted(owned)) {
    if (!endsWithAny(p, [...SRC_EXT, '.txt', '.cmake'])) continue;
    const t = show(repo, headRev, p) || '';
    let c = 0;
    for (const o of moving) if (new RegExp(`(?<![${PY_W}./-])${escapeRe(o)}(?![${PY_W}.-])`, 'u').test(t)) c++;
    if (c) conflicts.push(`hand-owned ${p} names ${c} moving path(s)`);
  }

  const sh = ['#!/bin/sh\n# Pure renames, no content change. Run on the deploy tree before merging the regen.\nset -eu\nT="${1:?usage: git-mv.sh <tree>}"\n'];
  for (const d of sorted(new Set(order.map(([, n]) => dirname(n)).filter((d) => d)))) sh.push(`mkdir -p "$T/${d}"\n`);
  for (const [o, n] of order) sh.push(`git -C "$T" mv -- "${o}" "${n}"\n`);
  if (order.length) sh.push('git -C "$T" commit -q -m "chore(layout): move files to the new layout"\n');
  writeText(path.join(a.out, 'git-mv.sh'), sh.join(''));
  fs.chmodSync(path.join(a.out, 'git-mv.sh'), 0o755);

  // The lift patch takes the hand hunks of TU-changing functions out of their old file,
  // on the path the file has after git-mv.sh.
  const out: string[] = [];
  for (const [p, rs] of sorted(lift, (e) => e[0])) {
    const old = hfile(p);
    const nw = [...old];
    for (const r of sorted(rs, (r) => -r.new_start)) {
      const n0 = r.new_len ? r.new_start - 1 : r.new_start;
      nw.splice(n0, r.new_len, ...r.removed);
    }
    out.push(udiff(old, nw, ren(p)));
  }
  write(path.join(a.out, 'lift.patch'), out.join(''));

  const liftHunks = [...lift.values()].reduce((s, v) => s + v.length, 0);
  const summary = [
    `inventory ${inv.head.slice(0, 10)} over ${inv.base.slice(0, 10)}: ${hunks.length} hunks\n`,
    `maps: ${fnmap.size} function placements, ${mv.size} renames (${order.length} tracked), ${merge.size} merged files\n`,
    'actions: ' + counterLine(plan.map((r) => r.action)) + '\n',
    `git-mv.sh: ${order.length} renames\n`,
    `lift.patch: ${liftHunks} hunks in ${lift.size} files\n`,
    `review.tsv: ${review.length} rows\n`,
    `conflicts: ${conflicts.length}\n`,
    ...conflicts.map((x) => `  ${x}\n`),
  ].join('');
  writeText(path.join(a.out, 'summary.txt'), summary);
  log(summary.replace(/\n$/, ''));
  return 0;
}

function udiff(old: string[], nw: string[], p: string): string {
  if (old.length === nw.length && old.every((l, i) => l === nw[i])) return '';
  const fix = (ls: string[]) => ls.map((l) => (l.endsWith('\n') ? l : l + '\n'));
  const body = unifiedDiff(fix(old), fix(nw), `a/${p}`, `b/${p}`, 3);
  return `diff --git a/${p} b/${p}\n` + body;
}

// ---------------------------------------------------------------- locate, audit, reapply

function findAll(hay: string[], needle: string[]): number[] {
  if (!needle.length) return [];
  const n = needle.length, first = needle[0];
  const out: number[] = [];
  for (let i = 0; i < hay.length - n + 1; i++) {
    if (hay[i] !== first) continue;
    let ok = true;
    for (let k = 1; k < n; k++) if (hay[i + k] !== needle[k]) (ok = false), (k = n);
    if (ok) out.push(i);
  }
  return out;
}

class Tree {
  text = new Map<string, string[]>();
  byaddr: DefaultMap<string, string[]> | null = null;
  files = new Map<string, Fn[]>();
  constructor(readonly root: string) {}

  lines(rel: string): string[] {
    if (!this.text.has(rel)) this.text.set(rel, linesOf(read(path.join(this.root, rel)) || ''));
    return this.text.get(rel)!;
  }

  index(want: Set<string> | null): DefaultMap<string, string[]> {
    if (this.byaddr === null) {
      this.byaddr = new DefaultMap(() => []);
      for (const [rel, fns] of indexTree(this.root, want)) {
        this.files.set(rel, fns);
        for (const f of fns) this.byaddr.need(f.addr).push(rel);
      }
    }
    return this.byaddr;
  }

  put(rel: string, ls: string[]): void {
    this.text.set(rel, ls);
    this.files.set(rel, scan(ls));
    const b = this.byaddr!;
    for (const k of [...b.keys()]) b.set(k, b.get(k)!.filter((r) => r !== rel));
    for (const f of this.files.get(rel)!) b.need(f.addr).push(rel);
  }

  fn(rel: string, addr: string): Fn | null {
    let fns = this.files.get(rel);
    if (fns === undefined) this.files.set(rel, (fns = scan(this.lines(rel))));
    return fns.find((f) => f.addr === addr) ?? null;
  }
}

type Status = [status: string, hits: number[], how: string];

/** [status, hit offsets, 'ctx' or 'bare'] of one hunk inside the normalised lines hay. */
function statusIn(hay: string[], r: Hunk): Status {
  const cb = norm(r.ctx_before), ca = norm(r.ctx_after);
  const add = norm(r.added), rem = norm(r.removed);
  const newHits = findAll(hay, [...cb, ...add, ...ca]);
  const oldHits = findAll(hay, [...cb, ...rem, ...ca]);
  if (!add.length) { // a pure deletion
    if (rem.length && oldHits.length) return ['reverted', oldHits, 'ctx'];
    if (newHits.length) return ['present', newHits, 'ctx'];
    if (rem.length && !weak(rem)) {
      const h = findAll(hay, rem);
      return h.length ? ['reverted', h, 'bare'] : ['present', [], 'bare'];
    }
    return ['missing', [], ''];
  }
  if (newHits.length) return [newHits.length > 1 ? 'duplicated' : 'present', newHits, 'ctx'];
  if (oldHits.length) return ['reverted', oldHits, 'ctx'];
  if (!weak(add)) {
    const h = findAll(hay, add);
    if (h.length) return [h.length > 1 ? 'duplicated' : 'present', h, 'bare'];
  }
  if (rem.length && !weak(rem)) {
    const h = findAll(hay, rem);
    if (h.length) return ['reverted', h, 'bare'];
  }
  return ['missing', [], ''];
}

export interface TreeArgs {
  inventory: string;
  tree: string;
  plan?: string;
  out: string;
}

function expectedFiles(a: { plan?: string }): Map<string, string> {
  if (!a.plan) return new Map();
  return new Map(readTsv(path.join(a.plan, 'move-plan.tsv')).map((row) => [need(row, 'id'), need(row, 'new_file')]));
}

interface Report {
  id: string;
  hash: string;
  scope: string;
  addr: string;
  fn: string;
  expected: string;
  found_in: string;
  status: string;
  how: string;
  note: string;
}

function check(inv: Inventory, tree: Tree, exp: Map<string, string>): [Hunk, Report, string | null][] {
  const byaddr = tree.index(new Set(inv.hunks.filter((r) => r.addr).map((r) => r.addr!)));
  const res: [Hunk, Report, string | null][] = [];
  for (const r of inv.hunks) {
    const e = exp.get(r.id) ?? r.file;
    const out: Report = {
      id: r.id, hash: r.hash, scope: r.scope, addr: r.addr || '', fn: r.fn, expected: e, found_in: '',
      status: '', how: '', note: '',
    };
    const notes: string[] = [];
    if ((r.scope === 'function' || r.scope === 'hand-function') && r.addr) {
      const where = sorted(new Set(byaddr.get(r.addr) ?? []));
      if (!where.length) {
        out.status = 'fn-missing';
        res.push([r, out, null]);
        continue;
      }
      const rel = where.includes(e) ? e : where[0];
      if (where.length > 1) notes.push('function defined in ' + where.join(','));
      const f = tree.fn(rel, r.addr)!;
      let [st, , how] = statusIn(norm(tree.lines(rel).slice(f.start, f.end + 1)), r);
      if (where.length > 1 && st === 'present') st = 'duplicated';
      if (rel !== e) notes.push(`expected in ${e}`);
      // a move that left the hand text behind in the old file
      if (!where.includes(r.file) && !weak(r.added)) {
        const ol = norm(tree.lines(r.file));
        if (findAll(ol, norm([...r.ctx_before, ...r.added, ...r.ctx_after])).length) {
          st = 'duplicated';
          notes.push(`copy left in ${r.file}`);
        }
      }
      Object.assign(out, { found_in: rel, status: st, how });
    } else {
      const rel = exists(path.join(tree.root, e)) ? e : r.file;
      const hay = norm(tree.lines(rel));
      const [st, , how] = statusIn(hay, r);
      Object.assign(out, { found_in: hay.length ? rel : '', status: hay.length ? st : 'file-missing', how });
    }
    out.note = notes.join('; ');
    res.push([r, out, out.found_in || null]);
  }
  return res;
}

function writeReport(p: string, rows: Report[]): void {
  const cols: (keyof Report)[] = ['id', 'hash', 'scope', 'addr', 'fn', 'status', 'how', 'expected', 'found_in', 'note'];
  writeText(p, [cols.join('\t') + '\n', ...rows.map((o) => cols.map((c) => String(o[c])).join('\t') + '\n')].join(''));
}

export interface AuditArgs extends TreeArgs {
  name: string;
}

export function cmdAudit(a: AuditArgs, log: (s: string) => void): number {
  const inv = loadInventory(a.inventory);
  const rows = check(inv, new Tree(a.tree), expectedFiles(a)).map(([, o]) => o);
  fs.mkdirSync(a.out, { recursive: true });
  writeReport(path.join(a.out, a.name), rows);
  const bad = rows.filter((o) => o.status !== 'present');
  log(`audit ${a.tree}: ${rows.length} hunks: ` + counterLine(rows.map((o) => o.status)));
  for (const o of bad.slice(0, 40)) {
    log(`  ${o.id} ${ljust(o.status, 11)} ${ljust(o.scope, 8)} ${ljust(o.addr, 9)} ${ljust(headCp(o.fn, 40), 40)} ` +
      `${o.found_in || o.expected} ${o.note}`);
  }
  return bad.length ? 1 : 0;
}

export interface ReapplyArgs extends TreeArgs {
  apply: boolean;
}

export function cmdReapply(a: ReapplyArgs, log: (s: string) => void): number {
  const inv = loadInventory(a.inventory);
  const tree = new Tree(a.tree);
  const res = check(inv, tree, expectedFiles(a));
  const orig = new Map<string, string[]>();
  const done: [Report, string][] = [], skipped: [Report, string][] = [];
  for (const [r, o, rel] of res) {
    if (o.status === 'present') continue;
    if (r.scope !== 'function' || (o.status !== 'reverted' && o.status !== 'missing')) {
      skipped.push([o, r.scope === 'function' ? o.status : `${r.scope}-level, ${o.status}`]);
      continue;
    }
    const ls = tree.lines(rel!);
    const f = tree.fn(rel!, r.addr!)!;
    const hay = norm(ls.slice(f.start, f.end + 1));
    const [st, hits, how] = statusIn(hay, r);
    const cb = norm(r.ctx_before), rem = norm(r.removed);
    let k: number;
    if (st === 'reverted' && hits.length === 1) k = hits[0] + (how === 'ctx' ? cb.length : 0);
    else if (st === 'missing' && !rem.length && r.off_old !== null && cb.length && 0 < r.off_old &&
      r.off_old <= hay.length && hay[r.off_old - 1] === cb[cb.length - 1]) {
      k = r.off_old; // an insertion whose far context drifted; the near line holds
    } else {
      skipped.push([o, `${st}, ${hits.length} candidate(s), no unique anchor`]);
      continue;
    }
    if (!orig.has(rel!)) orig.set(rel!, [...ls]);
    const s = f.start + k;
    tree.put(rel!, [...ls.slice(0, s), ...r.added, ...ls.slice(s + rem.length)]);
    done.push([o, rel!]);
  }
  const patch = sorted(orig.keys()).map((p) => udiff(orig.get(p)!, tree.text.get(p)!, p)).join('');
  fs.mkdirSync(a.out, { recursive: true });
  write(path.join(a.out, 'drop.patch'), patch);
  const out = ['id\taddr\tfn\tresult\tfile\n'];
  for (const [o, rel] of done) out.push(`${o.id}\t${o.addr}\t${o.fn}\treapplied\t${rel}\n`);
  for (const [o, why] of skipped) out.push(`${o.id}\t${o.addr}\t${o.fn}\tleft for review: ${why}\t${o.found_in}\n`);
  writeText(path.join(a.out, 'reapply.tsv'), out.join(''));
  if (a.apply) for (const p of orig.keys()) write(path.join(a.tree, p), tree.text.get(p)!.join(''));
  log(`reapply: ${done.length} hunk(s) put back in ${orig.size} file(s), ${skipped.length} left for review` +
    (a.apply ? ' (written)' : ' (drop.patch only)'));
  for (const [o, why] of skipped) log(`  ${o.id} ${ljust(o.scope, 8)} ${ljust(o.addr, 9)} ${ljust(headCp(o.fn, 40), 40)} ${why}`);
  return 0;
}

// ---------------------------------------------------------------- simulate

export interface SimulateArgs extends MapArgs {
  plan: string;
  worktree: string;
  tag: string;
}

export function cmdSimulate(a: SimulateArgs, log: (s: string) => void): number {
  const inv = loadInventory(a.inventory);
  const wt = path.resolve(a.worktree);
  const br = strip(git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']));
  if (br.startsWith('source/') || br === 'master' || br === 'main') {
    throw new ExitError(`refusing: ${wt} is on ${br}; simulate needs a scratch worktree`);
  }
  if (strip(git(wt, ['status', '--porcelain', '--untracked-files=no']))) {
    throw new ExitError(`refusing: ${wt} has uncommitted changes`);
  }
  const tag = a.tag, out = path.resolve(a.out);
  fs.mkdirSync(out, { recursive: true });
  const logPath = path.join(out, 'simulate.log');
  fs.writeFileSync(logPath, '');
  const say = (s: string) => {
    log(s);
    fs.appendFileSync(logPath, encodeSE(s + '\n', 'strict'));
  };

  // Every function the maps place moves, not only hand-touched ones: the merge has to
  // see the whole TU change the codegen would make.
  const tracked = new Set(splitlines(git(wt, ['ls-tree', '-r', '--name-only', inv.base])));
  let fnmap = loadFnMap(a, inv);
  let [mv, merge] = loadPathMap(a, tracked);
  [fnmap, mv, merge] = canonMaps(new Canon(tracked), fnmap, mv, merge, tracked);

  git(wt, ['checkout', '-q', '-B', `scratch/hf-${tag}-regen`, inv.base]);
  const touched = new Set<string>();
  for (const [o, n] of merge) {
    if (tracked.has(o)) {
      for (const f of scan(linesOf(read(path.join(wt, o))))) if (!fnmap.has(f.addr)) fnmap.set(f.addr, [n, 'layout-merge', o]);
    }
  }
  // Renames first, through temporary names so a chain cannot clobber itself.
  const live = sorted(mv, (e) => e).filter(([o]) => exists(path.join(wt, o)));
  live.forEach(([o], i) => fs.renameSync(path.join(wt, o), path.join(wt, `.hf-tmp-${i}`)));
  live.forEach(([o, n], i) => {
    fs.mkdirSync(path.dirname(path.join(wt, n)), { recursive: true });
    fs.renameSync(path.join(wt, `.hf-tmp-${i}`), path.join(wt, n));
    touched.add(o).add(n);
  });
  if (mv.size) say(`[regen] renamed ${live.length} file(s) the way rsync does: delete + add`);
  const addAll = (paths: string[]) => {
    for (let i = 0; i < paths.length; i += 200) git(wt, ['add', '--', ...paths.slice(i, i + 200)]);
  };
  addAll(sorted(touched));
  if (fnmap.size) {
    const tree = new Tree(wt);
    const byaddr = tree.index(new Set(fnmap.keys()));
    let moved = 0;
    const written = new Set<string>();
    for (const [addr, [target]] of sorted(fnmap, (e) => e)) {
      const where = byaddr.get(addr) ?? [];
      if (where.length !== 1 || where[0] === target) continue;
      const src = where[0];
      const ls = tree.lines(src);
      const f = tree.fn(src, addr);
      if (f === null) continue;
      const body = ls.slice(f.start, f.end + 1);
      tree.put(src, [...ls.slice(0, f.start), ...ls.slice(f.end + 1)]);
      tree.put(target, [...tree.lines(target), '\n', ...body]);
      written.add(src).add(target);
      moved += 1;
    }
    for (const p of written) write(path.join(wt, p), tree.text.get(p)!.join(''));
    say(`[regen] moved ${moved} function(s) across ${written.size} file(s)`);
    addAll(sorted(written));
  }
  git(wt, ['commit', '-q', '-m', `test(hand-follow): simulated codegen for ${tag}`]);
  const regen = strip(git(wt, ['rev-parse', 'HEAD']));

  const mergeInto = (label: string, prep: () => void): string[] => {
    git(wt, ['checkout', '-q', '-B', `scratch/hf-${tag}-${label}`, inv.head]);
    prep();
    const r = run('git', ['-C', wt, 'merge', '-q', '--no-edit', regen], false);
    const un = splitWS(git(wt, ['diff', '--name-only', '--diff-filter=U']));
    say(`[${label}] merge exit ${r.code}, ${un.length} conflicted file(s)`);
    for (const p of un.slice(0, 30)) say(`    conflict: ${p}`);
    if (un.length) {
      // the resolution that has already lost hand fixes: take the generator's side
      for (const p of un) {
        if (run('git', ['-C', wt, 'checkout', '--theirs', '--', p]).code === 0) git(wt, ['add', '--', p]);
        else git(wt, ['rm', '-q', '--', p], false);
      }
      git(wt, ['commit', '-q', '--no-edit']);
      say(`[${label}] conflicts resolved with --theirs`);
    }
    return un;
  };

  const prepTool = () => {
    const sh = path.join(a.plan, 'git-mv.sh');
    if (mv.size) {
      const r = run('sh', [sh, wt], false);
      say(`[tool] git-mv.sh exit ${r.code} ${headCp(strip(r.stderr), 300)}`);
    }
    const lp = path.join(a.plan, 'lift.patch');
    if (fs.statSync(lp).size) {
      const r = run('git', ['-C', wt, 'apply', '--index', lp], false);
      say(`[tool] lift.patch exit ${r.code} ${headCp(strip(r.stderr), 300)}`);
      git(wt, ['commit', '-q', '-m', `test(hand-follow): lift hand hunks for ${tag}`]);
    }
  };

  const results: [string, number, Map<string, number>][] = [];
  for (const [label, prep] of [['control', () => {}], ['tool', prepTool]] as const) {
    const un = mergeInto(label, prep);
    if (label === 'tool') {
      cmdReapply({ inventory: a.inventory, tree: wt, plan: a.plan, apply: true, out: path.join(out, 'reapply') }, log);
      const changed = splitWS(git(wt, ['diff', '--name-only']));
      if (changed.length) {
        git(wt, ['add', '--', ...changed]);
        git(wt, ['commit', '-q', '-m', `test(hand-follow): reapply hand hunks for ${tag}`]);
      }
    }
    cmdAudit({ inventory: a.inventory, tree: wt, plan: a.plan, out, name: `audit-${label}.tsv` }, log);
    const rows = readTsv(path.join(out, `audit-${label}.tsv`));
    const c = new Map<string, number>();
    for (const r of rows) c.set(r.status, (c.get(r.status) ?? 0) + 1);
    results.push([label, un.length, c]);
  }
  for (const [k, u, c] of results) {
    say(`RESULT ${tag} ${k}: ${u} conflicted file(s); ` + sorted(c, (e) => e[0]).map(([s, n]) => `${s} ${n}`).join(', '));
  }
  git(wt, ['checkout', '-q', '--detach', inv.head]);
  return 0;
}

