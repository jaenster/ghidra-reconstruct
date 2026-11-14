/**
 * The VC8 oracle as members.ts's TrialCompiler: a measured checkout's unit, edited, translated
 * the way `oracle-zig build` translates it, compiled with the build's command line and
 * precompiled header (`oracle-zig trial`), and every function of the unit judged against the
 * original as the audit judges it (`oracle-zig judge`). The same mechanism as the form
 * permuter's (scripts/vc8form-permute/oracle.ts).
 *
 * The checkout's tracked files and build/obj are never written: trial sources go beside their
 * unit in build/src (or into `trialDir`) and are removed after the compile, objects go to
 * `scratch`. A unit whose translation is not the one in build/src is not compiled: the trial
 * would measure another tree than the audit did.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline';

import { loadQuarantine, loadTree, type Tree } from '../vc8/tree.js';
import { translate } from '../vc8/translate.js';
import type { TrialCompiler, TrialResult, UnitTrial } from './members.js';

export interface Vc8Options {
  /** oracle-zig with `trial` and `judge` (default: the checkout's, or ORACLE_ZIG). */
  zig?: string;
  jobs?: number;
  /** Where objects go (default build/scratch/ratchet-members). */
  scratch?: string;
  /** Where trial sources go (default beside their unit in build/src). */
  trialDir?: string;
  /**
   * A command the compiling `trial` runs under, e.g. a lock shared with other compiles
   * (`lockf -t 3600 <lock> timeout 1800`). Judging and `trial --state` run without it.
   */
  wrap?: string[];
}

const hex8 = (n: number) => n.toString(16).padStart(8, '0');

/** Text as the vc8 tree reads it (latin1 code units for bytes). */
const asLatin1 = (s: string) => Buffer.from(s, 'utf8').toString('latin1');

/** new spread over old's line count where it can be: a quarantine names lines. */
function fitLines(neu: string, old: string): string {
  const want = old.split('\n').length - 1;
  const lines = neu.split('\n');
  if (lines.length - 1 < want) return neu + '\n'.repeat(want - lines.length + 1);
  while (lines.length - 1 > want && lines.length > 1) {
    const tail = lines.pop()!;
    if (lines[lines.length - 1].includes('//') || lines[lines.length - 1].trimStart().startsWith('#') || tail.trimStart().startsWith('#')) {
      lines.push(tail);
      break;
    }
    lines[lines.length - 1] = `${lines[lines.length - 1]} ${tail.trim()}`;
  }
  return lines.join('\n');
}

export class Vc8TrialCompiler implements TrialCompiler {
  readonly root: string;
  readonly zig: string;
  private build = '';
  private key = '';
  private tree?: Tree;
  private quarantine = new Map<string, Set<number>>();
  private judgeProc?: ChildProcess;
  private replies: string[] = [];
  private waiting: Array<(s: string) => void> = [];
  private n = 0;

  constructor(readonly checkout: string, readonly opts: Vc8Options = {}) {
    this.root = path.join(checkout, 'asm_matching', 'msvc8');
    this.zig = opts.zig ?? process.env.ORACLE_ZIG ?? path.join(this.root, 'zig', 'zig-out', 'bin', 'oracle-zig');
  }

  private run(args: string[], input?: string, wrapped = false): string {
    const [cmd, ...argv] = wrapped && this.opts.wrap?.length ? [...this.opts.wrap, this.zig, ...args] : [this.zig, ...args];
    const p = spawnSync(cmd, argv, { input, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'inherit'] });
    if (p.status === 3) throw new Error('the checkout changed under the trial (a build or an update)');
    if (p.status !== 0) throw new Error(`oracle-zig ${args[0]} failed (${p.status ?? p.signal})`);
    return p.stdout;
  }

  private async start(): Promise<void> {
    if (this.judgeProc) return;
    const [key, build] = this.run(['trial', '--root', this.root, '--state']).split('\t');
    this.key = key.trim();
    this.build = build.trim();
    this.tree = loadTree(this.checkout);
    this.quarantine = loadQuarantine(path.join(this.build, 'quarantine.tsv'));
    this.judgeProc = spawn(this.zig, ['judge', '--root', this.root], { stdio: ['pipe', 'pipe', 'inherit'] });
    createInterface({ input: this.judgeProc.stdout! }).on('line', l => {
      const w = this.waiting.shift();
      if (w) w(l); else this.replies.push(l);
    });
    if (await this.next() !== 'ready') throw new Error('oracle-zig judge did not start');
  }

  private next(): Promise<string> {
    const r = this.replies.shift();
    return r !== undefined ? Promise.resolve(r) : new Promise(res => this.waiting.push(res));
  }

  private async judge(tu: string, obj: string): Promise<Map<string, string>> {
    this.judgeProc!.stdin!.write(`${JSON.stringify({ tu, obj })}\n`);
    const r = JSON.parse(await this.next()) as { fns: Array<[number, string]> };
    return new Map(r.fns.map(([start, st]) => [hex8(start), st]));
  }

  /** The unit's text with the edits applied, or why not. */
  private edited(t: UnitTrial): { text?: string; error?: string } {
    let text: string;
    try { text = fs.readFileSync(path.join(this.checkout, t.file), 'latin1'); } catch { return { error: `${t.file} is not in the checkout` }; }
    const built = path.join(this.build, 'src', t.file);
    const q = this.quarantine.get(t.file);
    if (!fs.existsSync(built) || translate(text, t.file, this.tree!.state, q) !== fs.readFileSync(built, 'latin1')) {
      return { error: `the translation of ${t.file} is not the one built` };
    }
    for (const e of t.edits) {
      const from = asLatin1(e.from);
      const at = text.indexOf(from);
      if (at < 0 || text.indexOf(from, at + 1) >= 0) return { error: `the kept body is not in ${t.file} exactly once` };
      const to = asLatin1(e.to);
      text = text.slice(0, at) + (q?.size ? fitLines(to, from) : to) + text.slice(at + from.length);
    }
    return { text: translate(text, t.file, this.tree!.state, q) };
  }

  async compile(trials: UnitTrial[]): Promise<TrialResult[]> {
    await this.start();
    const scratch = this.opts.scratch ?? path.join(this.build, 'scratch', 'ratchet-members');
    fs.mkdirSync(scratch, { recursive: true });
    const out: TrialResult[] = trials.map(() => ({}));
    const srcs: Array<{ k: number; tu: string; src: string }> = [];
    try {
      trials.forEach((t, k) => {
        const e = this.edited(t);
        if (!e.text) { out[k] = { error: e.error }; return; }
        const tu = t.file.replace(/\.cpp$/u, '');
        const dir = this.opts.trialDir ?? path.join(this.build, 'src', path.dirname(t.file));
        fs.mkdirSync(dir, { recursive: true });
        const src = path.join(dir, `${path.basename(tu)}__rm${process.pid}_${++this.n}.cpp`);
        fs.writeFileSync(src, e.text, 'latin1');
        srcs.push({ k, tu, src });
      });
      if (srcs.length === 0) return out;
      const objs = this.run(['trial', '--root', this.root, '--out', scratch, '-j', String(this.opts.jobs ?? 4), '--expect', this.key],
        srcs.map(s => `${s.tu}\t${s.src}\n`).join(''), true).split('\n');
      for (let i = 0; i < srcs.length; i++) {
        const obj = objs[i]?.replace(/\r$/u, '');
        const s = srcs[i];
        if (!obj || obj === '-') {
          const log = path.join(scratch, `${path.basename(s.src, '.cpp')}.log`);
          out[s.k] = { error: `no object${fs.existsSync(log) ? ` (${log})` : ''}` };
          continue;
        }
        out[s.k] = { statuses: await this.judge(s.tu, obj) };
        fs.rmSync(obj, { force: true });
      }
      return out;
    } finally {
      for (const s of srcs) fs.rmSync(s.src, { force: true });
    }
  }

  close(): void {
    this.judgeProc?.stdin?.end();
  }
}
