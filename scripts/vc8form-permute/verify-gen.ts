/**
 * verify-gen.ts - does the real generator print what the permuter measured?
 *
 *   tsx verify-gen.ts --snapshot SNAP --run OUT [--gr GR] [--project-json PATH] [--overrides DIR]
 *
 * permute.ts applies each form to the function as the tree prints it. The generator applies
 * a tag to its own AST of the snapshot's decompile, with the function's other tags, in its
 * own order. This adds OUT/tags.tsv to a copy of the snapshot (a tag of the same form text
 * already there is replaced), runs one offline codegen of it (packages/live codegen-run.js,
 * the daemon's child process), and compares every tagged function's generated body with
 * OUT/bodies.json in the namespace-free token form `dh` hashes. A function that differs
 * means the tag does not reproduce the measured body under the generator: drop it, or
 * measure it again on a tree the generator printed with it.
 *
 * One codegen is a heavy job (minutes, several cores): one at a time on the machine.
 * Writes OUT/verify-gen.tsv: addr, same|differs|missing.
 */
import { spawnSync } from 'node:child_process';
import {
  closeSync, copyFileSync, createReadStream, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync,
  symlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { decodeFile, functionSpan, tokenForm } from './text.js';

/** The definition after `// 1.14d: addr` in any .cpp of the generated tree. */
function bodyAt(tree: string, addr: string): string | null {
  const marker = new RegExp(`(?:(?<=\\n)|(?<![\\s\\S]))// 1\\.14d: ${addr}[ \\t\\n\\r\\f\\v]*(?=\\n|(?![\\s\\S]))`);
  const visit = (dir: string): string | null => {
    const names = readdirSync(dir).sort();
    for (const n of names) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) continue;
      if (!n.endsWith('.cpp')) continue;
      const text = decodeFile(readFileSync(p));
      if (marker.test(text)) {
        const sp = functionSpan(text, parseInt(addr, 16));
        if (sp) return text.slice(sp[0], sp[1]);
      }
    }
    for (const n of names) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) { const r = visit(p); if (r !== null) return r; }
    }
    return null;
  };
  return visit(tree);
}

/** Offsets of the value of top-level key `key` in a one-line JSON object, or null. */
function topLevelValue(line: string, key: string): [number, number] | null {
  let depth = 0, i = 0;
  const n = line.length;
  const skipString = (j: number) => { j++; while (j < n && line[j] !== '"') j += line[j] === '\\' ? 2 : 1; return j + 1; };
  while (i < n) {
    const c = line[i];
    if (c === '"') {
      const end = skipString(i);
      if (depth === 1 && line.slice(i, end) === JSON.stringify(key)) {
        let j = end;
        while (/\s/.test(line[j])) j++;
        if (line[j] === ':') {
          j++;
          while (/\s/.test(line[j])) j++;
          const start = j;
          let d = 0;
          while (j < n) {
            const ch = line[j];
            if (ch === '"') { j = skipString(j); if (d === 0) break; continue; }
            if (ch === '{' || ch === '[') d++;
            else if (ch === '}' || ch === ']') { if (d === 0) break; d--; if (d === 0) { j++; break; } }
            else if (ch === ',' && d === 0) break;
            j++;
          }
          return [start, j];
        }
      }
      i = end;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    i++;
  }
  return null;
}

function usage(code = 2): never {
  const doc = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  process.stderr.write(doc.slice(doc.indexOf('/**') + 3, doc.indexOf('*/')).split('\n').map(l => l.replace(/^ \* ?/, '')).join('\n') + '\n');
  process.exit(code);
}

async function main(): Promise<number> {
  const opt: Record<string, string> = {
    '--gr': '/Users/jaenster/code/ts/gr-daemon',
    '--project-json': '/Users/jaenster/code/re/diablo2/recon/project.json',
    '--overrides': '/Users/jaenster/code/ts/gr-daemon/overrides',
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    let k = argv[i], v: string | undefined;
    if (k === '-h' || k === '--help') usage(0);
    const eq = k.indexOf('=');
    if (k.startsWith('--') && eq > 0) { v = k.slice(eq + 1); k = k.slice(0, eq); }
    if (!['--snapshot', '--run', '--gr', '--project-json', '--overrides'].includes(k)) usage();
    opt[k] = v ?? argv[++i] ?? usage();
  }
  if (!opt['--snapshot'] || !opt['--run']) usage();
  const snapshot = opt['--snapshot'];
  const run = resolve(opt['--run']);
  const tags = new Map<string, string[]>();
  for (const line of readFileSync(join(run, 'tags.tsv'), 'utf8').split('\n').slice(1)) {
    const p = line.split('\t');
    if (p.length > 2) {
      if (!tags.has(p[0])) tags.set(p[0], []);
      tags.get(p[0])!.push(p[2].slice('vc8form:'.length));
    }
  }
  const bodies: Record<string, string> = JSON.parse(readFileSync(join(run, 'bodies.json'), 'utf8'));
  const work = join(run, 'verify-gen');
  const snap = join(work, 'snap'), proj = join(work, 'genproj', 'project'), tree = join(work, 'tree');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(snap, { recursive: true });
  mkdirSync(proj, { recursive: true });
  symlinkSync(opt['--overrides'], join(work, 'genproj', 'overrides'));
  symlinkSync(opt['--project-json'], join(proj, 'project.json'));
  for (const f of readdirSync(snapshot)) if (f !== 'functions.ndjson') copyFileSync(join(snapshot, f), join(snap, f));
  // Every row is copied as it is; a tagged function's row gets its `tags` replaced in place.
  const pending = new Map(tags);
  const o = openSync(join(snap, 'functions.ndjson'), 'w');
  for await (let line of createInterface({ input: createReadStream(join(snapshot, 'functions.ndjson')), crlfDelay: Infinity })) {
    const i = line.indexOf('"address":"');
    const a = i >= 0 ? line.slice(i + 11, i + 19) : null;
    if (a !== null && pending.has(a)) {
      const d = JSON.parse(line);
      let t: Array<{ type?: string; data?: string }> = d.tags ?? [];
      for (const data of pending.get(a)!) {
        const form = data.split(';ev=')[0];
        t = t.filter(x => !(x.type === 'vc8form' && (x.data ?? '').split(';ev=')[0] === form));
        t.push({ type: 'vc8form', data });
      }
      pending.delete(a);
      const span = topLevelValue(line, 'tags');
      const value = JSON.stringify(t);
      line = span ? line.slice(0, span[0]) + value + line.slice(span[1])
        : line.slice(0, line.lastIndexOf('}')) + `,"tags":${value}` + line.slice(line.lastIndexOf('}'));
    }
    writeSync(o, line + '\n');
  }
  closeSync(o);
  if (pending.size) process.stdout.write(`not in the snapshot: ${[...pending.keys()].sort().join(' ')}\n`);
  const logFd = openSync(join(work, 'codegen.log'), 'w');
  const rc = spawnSync('node', ['--stack-size=8192', join(opt['--gr'], 'packages', 'live', 'dist', 'codegen-run.js')], {
    env: { ...process.env, RECON_CHILD_PROJECT_DIR: proj, RECON_CHILD_OUTPUT_DIR: tree, RECON_CHILD_SNAPSHOT_DIR: snap },
    stdio: ['ignore', logFd, logFd],
  }).status;
  closeSync(logFd);
  if (rc !== 0) { process.stderr.write(`codegen failed (${rc}): ${join(work, 'codegen.log')}\n`); return 1; }
  let same = 0;
  let out = 'addr\tverdict\n';
  const entries = Object.entries(bodies).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  for (const [a, want] of entries) {
    const got = bodyAt(tree, a);
    // Bodies only: the measured one is the oracle's translation (a __thiscall signature
    // gains a parameter there), the body is line for line the tree's.
    const from = (s: string) => s.slice(s.indexOf('{') >= 0 ? s.indexOf('{') : s.length - 1);
    const v = got === null ? 'missing' : tokenForm(from(got)) === tokenForm(from(want)) ? 'same' : 'differs';
    if (v === 'same') same++;
    out += `${a}\t${v}\n`;
  }
  writeFileSync(join(run, 'verify-gen.tsv'), out);
  process.stdout.write(`${same} of ${entries.length} tagged bodies as measured\n`);
  return 0;
}

main().then(code => process.exit(code), e => {
  process.stderr.write(`${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
