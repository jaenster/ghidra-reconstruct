/**
 * The oracle side of the VC8 tooling: oracle-zig's `judge` for objects and `trial` for
 * compiles of translated trial sources beside a built checkout's TUs, with the tree's own
 * translation (packages/reconstruct/src/vc8). Shared by the form permuter (permute.ts) and the
 * proposal re-check (scripts/proposal-recheck/recheck.ts).
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { loadQuarantine, loadTree, type Tree } from '../../packages/reconstruct/src/vc8/tree.js';
import { translate } from '../../packages/reconstruct/src/vc8/translate.js';
import { encodeFile } from './text.js';

export class CheckoutChanged extends Error {}

/** start -> [status, similarity (as judged, 4 places), register-only, calls, our frame and the
 * original's (`sub esp, N`; undefined from an oracle-zig that does not report them)] */
export type Judged = Map<number, { st: string; sim: number; simText: string; reg: boolean; calls: string[]; fo?: number; fr?: number }>;

export class Oracle {
  readonly root: string;
  readonly repo: string;
  build = '';
  src = '';
  /** start, end, name, tu, symbol, method, detail */
  rows: string[][] = [];
  private tree!: Tree;
  private quarantine!: Map<string, Set<number>>;
  private child!: ReturnType<typeof spawn>;
  private replies: string[] = [];
  private waiting: Array<(s: string) => void> = [];

  constructor(readonly checkout: string, readonly zig: string) {
    this.root = join(checkout, 'asm_matching', 'msvc8');
    this.repo = checkout;
  }

  async start() {
    const st = this.zigRun(['trial', '--root', this.root, '--state']);
    this.build = st.split('\t')[1].trim();
    this.src = join(this.build, 'src');
    for (const line of readFileSync(join(this.root, 'evidence', 'funcmap.tsv'), 'utf8').split('\n')) {
      if (!line || line.startsWith('start\t')) continue;
      this.rows.push(line.split('\t'));
    }
    this.tree = loadTree(this.repo);
    this.quarantine = loadQuarantine(join(this.build, 'quarantine.tsv'));
    this.child = spawn(this.zig, ['judge', '--root', this.root], { stdio: ['pipe', 'pipe', 'inherit'] });
    const rl = createInterface({ input: this.child.stdout! });
    rl.on('line', l => { const w = this.waiting.shift(); if (w) w(l); else this.replies.push(l); });
    this.child.on('exit', code => { if (code) { process.stderr.write(`oracle-zig judge exited ${code}\n`); process.exit(1); } });
    if (await this.next() !== 'ready') throw new Error('oracle-zig judge did not start');
  }

  zigRun(args: string[], input?: string): string {
    const p = spawnSync(this.zig, args, { input, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'inherit'] });
    if (p.status === 3) throw new CheckoutChanged('the checkout changed under the run (a build or an update): start again');
    if (p.status !== 0) throw new Error(`oracle-zig ${args[0]} failed (${p.status ?? p.signal})`);
    return p.stdout;
  }

  private next(): Promise<string> {
    const r = this.replies.shift();
    if (r !== undefined) return Promise.resolve(r);
    return new Promise(res => this.waiting.push(res));
  }

  private async ask(req: object): Promise<any> {
    this.child.stdin!.write(JSON.stringify(req) + '\n');
    return JSON.parse(await this.next());
  }

  /** The translation of a TU's text (as decodeFile read it), as bytes. */
  translate(tu: string, text: string): Buffer {
    const rel = tu + '.cpp';
    return Buffer.from(translate(encodeFile(text).toString('latin1'), rel, this.tree.state, this.quarantine.get(rel)), 'latin1');
  }

  async judge(tu: string, obj: string | null): Promise<Judged> {
    const r = await this.ask({ tu, obj });
    const out: Judged = new Map();
    for (const [s, st, sim, reg, calls, fo, fr] of r.fns) out.set(s, { st, sim: Number(sim), simText: sim, reg, calls, fo, fr });
    return out;
  }

  async bh(start: number, size: number): Promise<string> {
    return (await this.ask({ bh: [[start, size]] })).bh[0];
  }

  close() { this.child.stdin!.end(); }
}

export function checkoutState(orc: Oracle): string {
  return orc.zigRun(['trial', '--root', orc.root, '--state']).split('\t')[0];
}

export class Compiler {
  n = 0;
  readonly tree: string;

  constructor(readonly o: Oracle, readonly jobs: number, readonly scratch: string) {
    mkdirSync(scratch, { recursive: true });
    this.tree = checkoutState(o);
  }

  changed() { return checkoutState(this.o) !== this.tree; }

  /** trials: [tu, translated text] -> [object path or null], in order. */
  run(trials: Array<[string, Buffer]>): Array<string | null> {
    const srcs: string[] = [];
    try {
      const lines: string[] = [];
      for (const [tu, text] of trials) {
        this.n++;
        const src = join(this.o.src, dirname(tu), `${basename(tu)}__fp${this.n}.cpp`);
        writeFileSync(src, text);
        srcs.push(src);
        lines.push(`${tu}\t${src}\n`);
      }
      const out = this.o.zigRun(['trial', '--root', this.o.root, '--out', this.scratch, '-j', String(this.jobs), '--expect', this.tree], lines.join(''));
      return out.split('\n').slice(0, trials.length).map(l => {
        const path = l.replace(/\r$/, '');
        return path === '-' ? null : path;
      });
    } finally {
      // The trial sources never outlive the round, whatever happened in it.
      for (const s of srcs) rmSync(s, { force: true });
    }
  }

  drop(objs: Array<string | null>) {
    for (const p of objs) if (p) rmSync(p, { force: true });
  }

  clean() {
    // The compile logs of failed batches stay, for the report.
    for (const n of readdirSync(this.scratch)) if (n.endsWith('.obj')) rmSync(join(this.scratch, n), { force: true });
  }
}

export function splice(text: string, spans: Array<[[number, number], string]>): string {
  const sorted = [...spans].sort((x, y) => x[0][0] - y[0][0] || x[0][1] - y[0][1] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
  let out = '', at = 0;
  for (const [[a, b], neu] of sorted) { out += text.slice(at, a) + neu; at = b; }
  return out + text.slice(at);
}

/** new spread over old's line count where it can be: a quarantine names lines. */
export function fit(neu: string, old: string): string {
  const want = old.split('\n').length - 1;
  const lines = neu.split('\n');
  if (lines.length - 1 < want) return neu + '\n'.repeat(want - lines.length + 1);
  while (lines.length - 1 > want && lines.length > 1) {
    const tail = lines.pop()!;
    if (lines[lines.length - 1].includes('//') || lines[lines.length - 1].trimStart().startsWith('#') || tail.trimStart().startsWith('#')) {
      lines.push(tail);
      break;
    }
    lines[lines.length - 1] = lines[lines.length - 1] + ' ' + tail.trim();
  }
  return lines.join('\n');
}
