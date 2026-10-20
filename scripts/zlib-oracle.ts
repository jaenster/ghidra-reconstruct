/**
 * zlib shape oracle (design 7.4): the tree's zlib functions against the library's own source.
 *
 *   npx tsx scripts/zlib-oracle.ts --census <goto-census out dir> [--zlib <refs/zlib-1.2.8>] [--json <file>]
 *
 * Game.exe links zlib 1.2.8. For every zlib function the tree holds (the Storm/3rdparty/zlib
 * files, and the ZLIB_* functions Ghidra placed in SSComp), the source's gotos are counted
 * after macro expansion (`gcc -E`, so PULLBYTE's `goto inf_leave` counts once per use), by
 * label. The tree's gotos come from the census (keyed by address); a tree label the library
 * evidence names (library-evidence.ts `sourceLabel`) counts as that source label.
 *
 * Verdict per function:
 *   match    every tree goto targets a source label, and no label has more tree gotos than
 *            the expanded source writes (the compiler may merge expansions, never add jumps)
 *   excess   anything else - a goto the source does not have
 * Exit code 1 when a deflate.c or trees.c function has any goto (acceptance metric 3).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { LIBRARY_LABELS } from '../packages/cpp-parser/src/transform/plugins/builtins/goto-cleanup/library-evidence.js';

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const census = opt('--census');
const zlib = opt('--zlib') ?? '/Users/jaenster/code/re/diablo2/refs/zlib-1.2.8';
if (!census) { console.error('usage: zlib-oracle.ts --census <dir> [--zlib <dir>] [--json <file>]'); process.exit(2); }

/** Source gotos per function after macro expansion: fn -> label -> count. */
export function sourceGotos(dir: string, file: string): Map<string, Map<string, number>> {
  const text = execFileSync('gcc', ['-E', '-P', '-I', dir, join(dir, file)], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const out = new Map<string, Map<string, number>>();
  let depth = 0, headerStart = 0, fn: string | null = null, bodyStart = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") { // skip literals
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
      continue;
    }
    if (c === '{') {
      if (depth === 0) {
        // The name is the last `name(params)` followed only by K&R parameter declarations.
        const header = text.slice(headerStart, i);
        fn = null;
        for (const m of header.matchAll(/\b(\w+)\s*\(([^()]*)\)/g)) {
          const rest = header.slice(m.index! + m[0].length);
          if (/^\s*([^;{}()=]*;\s*)*$/.test(rest)) fn = m[1];
        }
        bodyStart = i;
      }
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        if (fn) {
          const counts = new Map<string, number>();
          for (const g of text.slice(bodyStart, i).matchAll(/\bgoto\s+(\w+)\s*;/g)) counts.set(g[1], (counts.get(g[1]) ?? 0) + 1);
          out.set(fn, counts);
        }
        fn = null;
        headerStart = i + 1;
      }
    }
  }
  return out;
}

const FILES = ['adler32.c', 'crc32.c', 'deflate.c', 'inffast.c', 'inflate.c', 'inftrees.c', 'trees.c', 'zutil.c', 'uncompr.c', 'compress.c'];
const source = new Map<string, { file: string; gotos: Map<string, number> }>();
for (const f of FILES) {
  if (!existsSync(join(zlib, f))) continue;
  for (const [fn, g] of sourceGotos(zlib, f)) if (!source.has(fn)) source.set(fn, { file: f, gotos: g });
}

/** Ghidra/tree names that differ from the library's. */
const ALIASES: Record<string, string> = {
  ZLIB_InflateFast: 'inflate_fast', ZLIB_InflateTable: 'inflate_table', ZLIB_Adler32: 'adler32',
};

interface Row { address: string; fn: string; lib: string; file: string; src: Record<string, number>; tree: Record<string, number>; verdict: string }
const fnRows = readFileSync(join(census, 'functions.tsv'), 'utf8').trim().split('\n').slice(1).map(l => l.split('\t'));
const gotoRows = readFileSync(join(census, 'gotos.tsv'), 'utf8').trim().split('\n').slice(1).map(l => l.split('\t'));
const inScope = (file: string, name: string) => file.startsWith('Storm/3rdparty/zlib/') || name in ALIASES;
const rows: Row[] = [];
const seen = new Set<string>();
for (const r of fnRows) {
  const [address, name, file] = r;
  if (!inScope(file, name)) continue;
  seen.add(address);
}
// Functions with a goto on either side are in functions.tsv; the zlib ones with none on
// either side match trivially and are not listed.
for (const address of seen) {
  const g = gotoRows.filter(x => x[0] === address);
  const r = fnRows.find(x => x[0] === address)!;
  const lib = ALIASES[r[1]] ?? r[1];
  const src = source.get(lib);
  const tree: Record<string, number> = {};
  for (const x of g) {
    const lab = LIBRARY_LABELS[x[4]]?.sourceLabel ?? x[4];
    tree[lab] = (tree[lab] ?? 0) + 1;
  }
  const s = Object.fromEntries(src?.gotos ?? []);
  const ok = Object.entries(tree).every(([l, n]) => (s[l] ?? 0) >= n);
  rows.push({ address, fn: r[1], lib, file: src?.file ?? '?', src: s, tree, verdict: !src ? 'no-source' : ok ? 'match' : 'excess' });
}
rows.sort((a, b) => a.address.localeCompare(b.address));
const fmt = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k}:${v}`).join(' ') || '-';
for (const r of rows) console.log(`${r.address}\t${r.lib}\t${r.file}\t${r.verdict}\tsource ${fmt(r.src)}\ttree ${fmt(r.tree)}`);
const gate = rows.filter(r => (r.file === 'deflate.c' || r.file === 'trees.c') && Object.keys(r.tree).length);
console.log(`\n${rows.length} zlib functions with gotos left in the tree; ${rows.filter(r => r.verdict === 'match').length} match the source; deflate.c/trees.c with gotos: ${gate.length}`);
const json = opt('--json');
if (json) writeFileSync(json, JSON.stringify(rows, null, 2));
process.exit(gate.length ? 1 : 0);
