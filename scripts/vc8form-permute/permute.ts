/**
 * permute.ts - find vc8form tags for VC8 near-miss functions by compiling them.
 *
 *   tsx permute.ts --checkout DIR --snapshot SNAP --out OUT [--pool AUDIT] [--sample N] [--seed S]
 *                  [--addrs A,B,...] [--jobs J] [--max-insns K] [--no-pairs] [--no-phase] [--called-helpers]
 *                  [--resume [--group G]] [--oracle-zig BIN] [--ops OP,OP,...] [--accept match|frame]
 *
 * For each target function (the near-miss pool of an audit.tsv, a sample of it, or --addrs):
 *
 *   1. candidates.ts lists every vc8form applyVc8Forms implements at every site of the
 *      function and of its same-TU callees that VC8 inlines into it (the helpers), each
 *      with the body that form's tag text prints. Nothing else is ever edited.
 *   2. Each candidate is one trial: the TU's translated source with that one body swapped
 *      in, compiled beside the TU (same directory, so includes resolve the same) into a
 *      scratch object directory, with the oracle's own command line and precompiled
 *      header (`oracle-zig trial`). Trials of many TUs go through one cl.exe in batches,
 *      J at a time; the checkout's tracked files and build/obj are never written.
 *   3. Every function of the TU is judged against the original as the audit judges it
 *      (`oracle-zig judge`). A candidate is kept when its target reaches MATCH and no
 *      function of the TU that matched before stops matching. A form that declares a local
 *      is also put against the same number of dummy externs before that function, without
 *      the form: when that alone matches, the gain is the front end's symbol phase, not the
 *      form.
 *   4. Targets whose only difference is a register tie are scanned for phase first:
 *      1..63 dummy externs before the definition; a target that matches at some count is
 *      phase noise and is skipped (memory: vc8-declaration-phase-is-noise).
 *   5. Targets no single form matches get pairs: each of the best singles (by
 *      similarity) with every other single of the same target, applied in the order
 *      the generator sorts a function's tags (same-op pairs get `ord`).
 *   6. The accepted tags of each TU are compiled together; a tag that loses another
 *      function or its own target there is dropped, the rest compiled again.
 *
 * --accept frame keeps a tag that does not reach MATCH: its target's frame (`sub esp, N`) differs
 * from the original's in the checkout and equals it with the tag, its similarity strictly rises,
 * and no function of the TU gets further: none stops matching, none loses similarity, none
 * whose frame was equal stops being equal. The same rule holds the phase control (dummy externs
 * that alone do the same reject the tag) and the combined compile of a TU's tags. Targets whose
 * frame already equals the original's are skipped. The default, --accept match, is MATCH only.
 *
 * --ops keeps only the candidates of the named ops (`--ops nest,merge-tail,cache`): one family of
 * forms asked about, at a fraction of the trials.
 *
 * OUT gets tags.tsv (the tag data exactly as Ghidra stores it: dh is the generator's hash
 * of the snapshot's decompile, bh the original's size and masked bytes, ev the hash of the
 * evidence row in evidence.tsv), evidence.tsv, combined.tsv, trials.tsv (every trial) and
 * summary.txt.
 *
 * --resume is the long run: the targets smallest first, --group at a time, each recorded in
 * OUT/done.tsv and skipped when the run starts again; OUT/tags.tsv, evidence.tsv and
 * bodies.json collect what each step found. It stops cleanly (exit 3) when the checkout
 * moves, or between steps when OUT/STOP exists.
 *
 * The trials are translated by packages/reconstruct/src/vc8 with the per-tree state of the
 * checkout, as `oracle-zig build` translates it; a TU whose translation is not the one in
 * build/src is skipped. BIN is the oracle-zig with `trial` and `judge` (default the
 * checkout's asm_matching/msvc8/zig/zig-out/bin/oracle-zig, or ORACLE_ZIG). Run it with the
 * checkout's oracle environment (recon/runs/vc8form-permute.sh does). --forms is another
 * name for --ops (`--forms boolflag,retwiden`).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync,
  renameSync, writeFileSync, writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { PyRandom, decodeFile, fixed, dedupeTwins, functionSpan, hex8, jsonDumps } from './text.js';
import { CheckoutChanged, Compiler, Oracle, fit, splice, type Judged } from './oracle.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GR = dirname(dirname(HERE));
const NEAR = /^(INSN_COUNT_MATCH|INSN_MATCH|OUR[-+][12])$/;
const PHASE = 63;

function log(...a: unknown[]) {
  const d = new Date();
  const t = [d.getHours(), d.getMinutes(), d.getSeconds()].map(x => String(x).padStart(2, '0')).join(':');
  process.stdout.write([t, ...a].join(' ') + '\n');
}

const now = () => performance.now() / 1000;

// ---------------------------------------------------------------------------------------

function tsx(args: string[], cwd: string) {
  const p = process.platform === 'win32'
    ? spawnSync(process.execPath, [join(GR, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(HERE, 'candidates.ts'), ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 30 })
    : spawnSync(join(GR, 'node_modules', '.bin', 'tsx'), [join(HERE, 'candidates.ts'), ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 30 });
  if (p.status !== 0) throw new Error(`candidates.ts failed: ${(p.stderr ?? '').slice(-2000)}`);
}

const externs = (n: number) => Array.from({ length: n }, (_, k) => `extern int fperm_phase_${k}; `).join('');

const pyStrip = (s: string) => s.replace(/^[ \t\n\r\f\v\x1c-\x1f\x85\xa0]+|[ \t\n\r\f\v\x1c-\x1f\x85\xa0]+$/g, '');
const fid = (tu: string, s: number) => `${tu}|${hex8(s)}`;
const sortNum = (xs: Iterable<number>) => [...xs].sort((a, b) => a - b);
const hexList = (xs: Iterable<number>) => sortNum(xs).map(hex8).join(',');
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type Target = [number, string, string, string];      // start, name, tu, status
interface Job {
  start: number; name: string; tu: string; status: string; span: [number, number]; helpers: number[];
  skip?: string; base?: Base;
  ord?: Map<string, Record<string, number>>; phase_scanned?: boolean;
}
type Form = string | string[];
type Bodies = Map<number, string>;
type Item = [Job, number, Form, Bodies];
type Res = [Item, string, number, Set<number>, Set<number>, Base | undefined];
interface Accepted { job: Job; on: number; forms: string[]; gained: Set<number>; bodies: Bodies; sim: number; reject?: string; after?: string }
type Base = { st: string; sim: number; simText: string; reg: boolean; calls: string[]; fo?: number; fr?: number };

interface Args {
  checkout: string; snapshot: string; out: string; pool?: string; addrs?: string; ops?: string; sample: number; seed: number;
  max_insns: number; jobs: number; max_anchors: number; pair_top: number; no_pairs: boolean; no_phase: boolean; called_helpers: boolean;
  resume: boolean; group: number; zig: string; ops?: string; accept: 'match' | 'frame';
}

function usage(code = 2): never {
  const doc = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  process.stderr.write(doc.slice(doc.indexOf('/**') + 3, doc.indexOf('*/')).split('\n').map(l => l.replace(/^ \* ?/, '')).join('\n') + '\n');
  process.exit(code);
}

function parseArgs(argv: string[]): Args {
  const a: Partial<Args> & Record<string, unknown> = { accept: 'match', sample: 0, seed: 1, max_insns: 100, jobs: 4, max_anchors: 16, pair_top: 3, no_pairs: false, no_phase: false, called_helpers: false, resume: false, group: 1 };
  const str: Record<string, keyof Args> = { '--checkout': 'checkout', '--snapshot': 'snapshot', '--out': 'out', '--pool': 'pool', '--addrs': 'addrs', '--oracle-zig': 'zig', '--ops': 'ops', '--forms': 'ops', '--accept': 'accept' };
  const int: Record<string, keyof Args> = { '--sample': 'sample', '--seed': 'seed', '--max-insns': 'max_insns', '--jobs': 'jobs', '--max-anchors': 'max_anchors', '--pair-top': 'pair_top', '--group': 'group' };
  const flag: Record<string, keyof Args> = { '--no-pairs': 'no_pairs', '--no-phase': 'no_phase', '--called-helpers': 'called_helpers', '--resume': 'resume' };
  for (let i = 0; i < argv.length; i++) {
    let k = argv[i], v: string | undefined;
    const eq = k.indexOf('=');
    if (k.startsWith('--') && eq > 0) { v = k.slice(eq + 1); k = k.slice(0, eq); }
    if (k === '-h' || k === '--help') usage(0);
    if (flag[k]) { a[flag[k]] = true as never; continue; }
    if (!str[k] && !int[k]) { process.stderr.write(`unrecognized argument: ${argv[i]}\n`); usage(); }
    if (v === undefined) { v = argv[++i]; if (v === undefined) usage(); }
    if (str[k]) a[str[k]] = v as never;
    else { if (!/^[-+]?\d+$/.test(v.trim())) usage(); a[int[k]] = parseInt(v, 10) as never; }
  }
  if (!a.checkout || !a.snapshot || !a.out) usage();
  if (a.accept !== 'match' && a.accept !== 'frame') { process.stderr.write(`--accept is match or frame, not ${a.accept}\n`); usage(); }
  a.zig ??= process.env.ORACLE_ZIG || join(a.checkout, 'asm_matching', 'msvc8', 'zig', 'zig-out', 'bin', 'oracle-zig');
  return a as Args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  const orc = new Oracle(args.checkout, args.zig);
  await orc.start();
  const comp = new Compiler(orc, args.jobs, join(resolve(args.out), 'obj'));

  // -- the targets
  const poolPath = args.pool ?? join(args.checkout, 'asm_matching', 'msvc8', 'evidence', 'audit.tsv');
  const pool: Array<[number, string, string, string, number]> = [];
  for (const line of readFileSync(poolPath, 'utf8').split('\n').slice(1)) {
    const p = line.split('\t');
    // --addrs names its targets whatever their status (MATCH aside); the pool is the near misses.
    if (p.length < 10 || p[4].startsWith('lib') || p[3].startsWith('libcmt') || (args.addrs ? p[9] === 'MATCH' : !NEAR.test(p[9]))) continue;
    if (parseInt(p[5], 10) >= args.max_insns) continue;
    pool.push([parseInt(p[0], 16), p[2], p[3], p[9], parseInt(p[5], 10)]);
  }
  let full: Array<[number, string, string, string, number]>;
  if (args.addrs) {
    const want = new Set(args.addrs.split(',').map(x => parseInt(x, 16)));
    full = pool.filter(x => want.has(x[0]));
  } else {
    full = new PyRandom(args.seed).sample(pool, Math.min(args.sample || pool.length, pool.length)).sort(cmpTuple);
  }
  if (args.resume) full.sort((x, y) => x[4] - y[4] || x[0] - y[0]);   // smallest first
  const targets: Target[] = full.map(t => [t[0], t[1], t[2], t[3]]);
  log(`pool ${pool.length}, targets ${targets.length}`);

  if (args.resume) args.snapshot = await smallSnapshot(args.snapshot, join(args.out, 'snap-small'), targets, orc);
  const snapCalls = new Map<number, string[]>();
  const wantAddrs = new Set(targets.map(t => hex8(t[0])));
  for await (const line of createInterface({ input: createReadStream(join(args.snapshot, 'functions.ndjson')) })) {
    const i = line.indexOf('"address":"');
    if (i >= 0 && wantAddrs.has(line.slice(i + 11, i + 19))) {
      const r = JSON.parse(line);
      snapCalls.set(parseInt(r.address, 16), r.calledFunctions ?? []);
    }
  }

  const run = async (targets: Target[], out: string) => {
    /** Steps 1-6 over targets, every output into out. */
    const t0 = now();
    mkdirSync(out, { recursive: true });
    const trialsLog = openSync(join(out, 'trials.tsv'), 'w');
    writeSync(trialsLog, 'target\ton\tform\ttarget_status\tsim\tgained\tlost\tnote\n');
    const srcs = new Map<string, string | null>();
    const jobs: Job[] = [];
    const byLeaf = new Map<string, Map<string, number>>();
    for (const [s, , name, tu] of orc.rows) {
      if (!byLeaf.has(tu)) byLeaf.set(tu, new Map());
      const leaf = name.slice(name.lastIndexOf('::') >= 0 ? name.lastIndexOf('::') + 2 : 0);
      if (!byLeaf.get(tu)!.has(leaf)) byLeaf.get(tu)!.set(leaf, parseInt(s, 16));
    }
    for (const [start, name, tu, status] of targets) {
      if (!srcs.has(tu)) {
        srcs.set(tu, null);
        const path = join(orc.repo, tu + '.cpp');
        if (existsSync(path)) {
          const tree = decodeFile(readFileSync(path));
          const built = readFileSync(join(orc.src, tu + '.cpp'));
          if (orc.translate(tu, tree).equals(built)) srcs.set(tu, tree);
          else log(`skip ${tu}: its translation is not the one built`);
        }
      }
      const text = srcs.get(tu);
      const span = text ? functionSpan(text, start) : null;
      if (!span) { log(`skip ${hex8(start)} ${name}: no definition in ${tu}`); continue; }
      const helpers: number[] = [];
      for (const callee of snapCalls.get(start) ?? []) {
        const h = byLeaf.get(tu)?.get(callee);
        if (h !== undefined && h !== start && functionSpan(text!, h)) helpers.push(h);
      }
      jobs.push({ start, name, tu, status, span, helpers: sortNum(new Set(helpers)) });
    }
    const textOf = (tu: string) => srcs.get(tu)!;

    const trialText = (tu: string, bodies: Bodies, prefix?: [number, string]): Buffer => {
      /** The TU with bodies {start: text} swapped in, prefix (start, text) put on the line
       * of a definition, translated for VC8. */
      const text = textOf(tu);
      const spans: Array<[[number, number], string]> = [];
      for (const [st, b] of bodies) {
        const sp = functionSpan(text, st)!;
        spans.push([sp, fit(b, text.slice(sp[0], sp[1]))]);
      }
      if (prefix) {
        const [a] = functionSpan(text, prefix[0])!;
        spans.push([[a, a], prefix[1]]);
      }
      return orc.translate(tu, dedupeTwins(splice(text, spans)));
    };

    const tus = [...new Set(jobs.map(j => j.tu))].sort(cmpStr);
    const frameMode = args.accept === 'frame';
    const frameEq = (x?: Base) => x !== undefined && x.fo !== undefined && x.fo === x.fr;
    /** The target as tried is kept: it matches, or under --accept frame its frame now equals
     * the original's and it is strictly closer than in the checkout. */
    const wins = (j: Job, t?: Base) => t !== undefined && (frameMode
      ? !['MISSING', 'QUARANTINE', 'FAIL'].includes(t.st) && frameEq(t) && t.sim > j.base!.sim
      : t.st === 'MATCH');
    /** What a trial costs the TU: every match it loses or function it drops, and under
     * --accept frame every function that gets further (less similar, or a frame that was
     * equal and no longer is). */
    const losses = (b: Judged, st: Judged): Set<number> => {
      const stOf = (s: number) => st.get(s)?.st ?? 'MISSING';
      const lost = new Set([...b.keys()].filter(s => b.get(s)!.st === 'MATCH' && stOf(s) !== 'MATCH'));
      for (const s of b.keys()) if (!['MISSING', 'QUARANTINE'].includes(b.get(s)!.st) && ['MISSING', 'QUARANTINE'].includes(stOf(s))) lost.add(s);
      if (frameMode) for (const [s, x] of b) {
        const y = st.get(s);
        if (!y || ['MISSING', 'QUARANTINE'].includes(x.st)) continue;
        if (y.sim < x.sim || (frameEq(x) && !frameEq(y))) lost.add(s);
      }
      return lost;
    };
    const baseObjs = comp.run(tus.map(tu => [tu, trialText(tu, new Map())]));
    const base = new Map<string, Judged>();
    for (let k = 0; k < tus.length; k++) base.set(tus[k], await orc.judge(tus[k], baseObjs[k]));
    comp.drop(baseObjs);
    if (frameMode && [...base.values()].some(b => [...b.values()].some(x => x.fo === undefined))) {
      throw new Error(`--accept frame: ${args.zig} judges no frames (an oracle-zig whose judge reports them is needed)`);
    }
    // Helpers count only where VC8 inlines them: a callee our object still calls keeps
    // its own body. --called-helpers keeps the called ones too: VC8 fits a static callee's
    // register use into its callers, so its body can change theirs (UI_ConfigHandleMouseClick
    // 004a5e60, whose seven element stores make INPUT_ConfigMouseDown 004a5f10 match).
    const symOf = new Map<number, string>();
    for (const r of orc.rows) symOf.set(parseInt(r[0], 16), r[4]);
    for (const j of jobs) {
      const bt = base.get(j.tu)!.get(j.start);
      const calls = new Set(bt && bt.st !== 'MISSING' && bt.st !== 'QUARANTINE' ? bt.calls : []);
      if (!args.called_helpers) j.helpers = j.helpers.filter(h => !calls.has(symOf.get(h)!));
    }

    // -- candidates, and the bodies printed back unchanged
    const onSet = new Map<string, [string, number]>();
    for (const j of jobs) for (const s of [j.start, ...j.helpers]) onSet.set(`${j.tu}\0${s}`, [j.tu, s]);
    const onFns = [...onSet.values()].sort((x, y) => cmpStr(x[0], y[0]) || x[1] - y[1]);
    const inp = onFns.map(([tu, s]) => { const sp = functionSpan(textOf(tu), s)!; return { id: fid(tu, s), text: textOf(tu).slice(sp[0], sp[1]) }; });
    writeFileSync(join(out, 'cand-in.json'), jsonDumps(inp));
    const t1 = now();
    tsx(['singles', join(out, 'cand-in.json'), join(out, 'cand-out.json'),
      '--types', join(args.snapshot, 'dataTypes.ndjson'),
      '--globals', join(args.snapshot, 'globals.ndjson'), '--max-anchors', String(args.max_anchors), ...(args.ops ? ['--ops', args.ops] : [])], GR);
    const cands = new Map<string, any>();
    // --ops: only the forms of the named ops are tried (a question about one family of forms).
    const ops = args.ops ? new Set(args.ops.split(',')) : null;
    for (const r of JSON.parse(readFileSync(join(out, 'cand-out.json'), 'utf8'))) {
      if (ops) r.candidates = r.candidates.filter((c: { form: string }) => ops.has(c.form.replace(/\(.*$/s, '')));
      cands.set(r.id, r);
    }
    let nForms = 0;
    for (const r of cands.values()) nForms += r.candidates.length;
    log(`candidates: ${cands.size} functions, ${nForms} forms (${fixed(now() - t1, 0)}s)`);

    const rtItems: Array<[string, Buffer]> = [], rtJobs: Job[] = [];
    for (const j of jobs) {
      const ids = [j.start, ...j.helpers].map(s => fid(j.tu, s));
      if (ids.some(i => cands.get(i).error)) {
        j.skip = 'parse: ' + ids.filter(i => cands.get(i).error).map(i => cands.get(i).error).join('; ');
        continue;
      }
      const bodies: Bodies = new Map([j.start, ...j.helpers].map(s => [s, cands.get(fid(j.tu, s)).roundtrip]));
      rtItems.push([j.tu, trialText(j.tu, bodies)]);
      rtJobs.push(j);
    }
    const rtObjs = comp.run(rtItems);
    for (let k = 0; k < rtJobs.length; k++) {
      const j = rtJobs[k];
      const rt = await orc.judge(j.tu, rtObjs[k]);
      const b = base.get(j.tu)!;
      const diff = [...b.keys()].filter(s => {
        const x = rt.get(s);
        return b.get(s)!.st !== (x ? x.st : '?') || b.get(s)!.sim !== (x ? x.sim : 0);
      });
      if (diff.length) j.skip = `printing the bodies back changes ${diff.length} function(s), e.g. ${hex8(diff[0])}`;
      j.base = b.get(j.start);
      if (j.base!.st === 'MATCH') j.skip = 'already MATCH in this checkout';
      else if (frameMode && frameEq(j.base)) j.skip = 'frame already equal in this checkout';
    }
    comp.drop(rtObjs);

    // -- phase noise: register-tie-only targets, 1..63 dummy externs before the definition
    if (!args.no_phase) {
      const scan = jobs.filter(j => j.skip === undefined && j.base!.reg);
      const items: Array<[string, Buffer]> = [];
      for (const j of scan) for (let n = 1; n <= PHASE; n++) items.push([j.tu, trialText(j.tu, new Map(), [j.start, externs(n)])]);
      const objs = comp.run(items);
      for (let k = 0; k < scan.length; k++) {
        const j = scan[k];
        const hit: number[] = [];
        for (let n = 1; n <= PHASE; n++) if ((await orc.judge(j.tu, objs[k * PHASE + n - 1])).get(j.start)!.st === 'MATCH') hit.push(n);
        if (hit.length) j.skip = `phase noise: MATCH with ${hit[0]} dummy externs`;
        j.phase_scanned = true;
      }
      comp.drop(objs);
      log(`phase scan: ${scan.length} register-only, ${scan.filter(j => (j.skip ?? '').includes('phase noise')).length} phase noise`);
    }

    const live = jobs.filter(j => j.skip === undefined);
    for (const j of jobs) if (j.skip !== undefined) log(`skip ${hex8(j.start)} ${j.name}: ${j.skip}`);

    const runTrials = async (items: Item[]): Promise<Res[]> => {
      /** items: [(job, on, form, bodies)] -> [(item, target status, sim, gained, lost)] */
      const objs = comp.run(items.map(([j, , , bodies]) => [j.tu, trialText(j.tu, bodies)]));
      const res: Res[] = [];
      for (let k = 0; k < items.length; k++) {
        const it = items[k], o = objs[k];
        const j = it[0];
        const b = base.get(j.tu)!;
        if (o === null) { res.push([it, 'FAIL', 0, new Set(), new Set(), undefined]); continue; }
        const st = await orc.judge(j.tu, o);
        const gained = new Set([...st.keys()].filter(s => st.get(s)!.st === 'MATCH' && b.get(s)!.st !== 'MATCH'));
        res.push([it, st.get(j.start)!.st, st.get(j.start)!.sim, gained, losses(b, st), st.get(j.start)]);
      }
      comp.drop(objs);
      return res;
    };

    const note = (r: Res, extra = '') => {
      const [[j, on, form], ts, sim, gained, lost] = r;
      writeSync(trialsLog, `${hex8(j.start)}\t${hex8(on)}\t${Array.isArray(form) ? form.join('+') : form}\t${ts}\t${sim.toFixed(4)}\t${hexList(gained)}\t${hexList(lost)}\t${extra}\n`);
    };

    // -- singles
    const items: Item[] = [];
    for (const j of live) for (const on of [j.start, ...j.helpers]) for (const c of cands.get(fid(j.tu, on)).candidates) items.push([j, on, c.form, new Map([[on, c.text]])]);
    const t2 = now();
    let res = await runTrials(items);
    log(`singles: ${items.length} trials (${fixed(now() - t2, 0)}s)`);
    let accepted: Accepted[] = [];
    const best = new Map<number, Array<[number, number, string, Bodies]>>();
    const adds = new Map<string, number>();
    for (const j of live) for (const on of [j.start, ...j.helpers]) for (const c of cands.get(fid(j.tu, on)).candidates) adds.set(`${fid(j.tu, on)}\0${c.form}`, c.adds);
    for (const r of res) {
      const [[j, on, form, bodies], ts, sim, gained, lost, tb] = r;
      note(r);
      if (wins(j, tb) && !lost.size) accepted.push({ job: j, on, forms: [form as string], gained, bodies, sim });
      else if (ts !== 'FAIL' && !lost.size) {
        if (!best.has(j.start)) best.set(j.start, []);
        best.get(j.start)!.push([sim, on, form as string, bodies]);
      }
    }

    // -- pairs, for targets no single form matched
    if (!args.no_pairs) {
      const done = new Set(accepted.map(a => a.job.start));
      const pairItems: Item[] = [];
      const applyIn: Array<{ id: string; text: string; forms: string[]; job: Job; on: number }> = [];
      for (const j of live) {
        if (done.has(j.start)) continue;
        const singles = [...(best.get(j.start) ?? [])].sort((x, y) => y[0] - x[0]);
        const top = singles.filter(x => x[0] > j.base!.sim).slice(0, args.pair_top);
        const seen = new Set<string>();
        for (const [, on, form, bodies] of top) {
          for (const [, on2, form2, bodies2] of singles) {
            const a = `${on}\0${form}`, b = `${on2}\0${form2}`;
            const pk = a < b ? `${a}\x01${b}` : `${b}\x01${a}`;
            if (a === b || seen.has(pk)) continue;
            seen.add(pk);
            if (on2 !== on) pairItems.push([j, on, [form, form2], new Map([...bodies, ...bodies2])]);
            else {
              const sp = functionSpan(textOf(j.tu), on)!;
              applyIn.push({ id: `${applyIn.length}|${fid(j.tu, on)}`, text: textOf(j.tu).slice(sp[0], sp[1]), forms: [form, form2], job: j, on });
            }
          }
        }
      }
      if (applyIn.length) {
        writeFileSync(join(out, 'apply-in.json'), jsonDumps(applyIn.map(a => ({ id: a.id, text: a.text, forms: a.forms }))));
        tsx(['apply', join(out, 'apply-in.json'), join(out, 'apply-out.json'), '--globals', join(args.snapshot, 'globals.ndjson'), '--types', join(args.snapshot, 'dataTypes.ndjson')], GR);
        const outs = JSON.parse(readFileSync(join(out, 'apply-out.json'), 'utf8'));
        for (let k = 0; k < applyIn.length; k++) {
          const a = applyIn[k], r = outs[k];
          if (r.refused.length || r.applied.length !== 2) continue;
          (a.job.ord ??= new Map()).set(a.forms.join('\0'), r.ord);
          pairItems.push([a.job, a.on, [...r.order], new Map([[a.on, r.text]])]);
        }
      }
      const t3 = now();
      res = await runTrials(pairItems);
      log(`pairs: ${pairItems.length} trials (${fixed(now() - t3, 0)}s)`);
      for (const r of res) {
        const [[j, on, forms, bodies], , sim, gained, lost, tb] = r;
        note(r, 'pair');
        if (wins(j, tb) && !lost.size && !accepted.some(a => a.job.start === j.start)) accepted.push({ job: j, on, forms: forms as string[], gained, bodies, sim });
      }
    }

    // -- phase control for forms that declare a name
    const ctl: Array<[Accepted, [string, Buffer]]> = [];
    for (const a of accepted) {
      const j = a.job;
      const n = a.forms.reduce((t, f) => t + (adds.get(`${fid(j.tu, a.on)}\0${f}`) ?? 0), 0);
      if (n) ctl.push([a, [j.tu, trialText(j.tu, new Map(), [a.on, externs(n)])]]);
    }
    if (ctl.length) {
      const objs = comp.run(ctl.map(x => x[1]));
      for (let k = 0; k < ctl.length; k++) {
        const a = ctl[k][0], o = objs[k];
        const st = o ? await orc.judge(a.job.tu, o) : new Map();
        if (wins(a.job, st.get(a.job.start))) a.reject = `phase: ${frameMode ? 'frame and similarity' : 'MATCH'} with dummy externs alone`;
      }
      comp.drop(objs);
    }
    for (const a of accepted) if (a.reject) log(`reject ${hex8(a.job.start)} ${pyTuple(a.forms)}: ${a.reject}`);
    accepted = accepted.filter(a => !a.reject);
    // One tag set per target: the one with the most gains, then the most similar (every
    // MATCH is 1), singles before pairs, then fewest forms.
    const pick = new Map<number, Accepted>();
    for (const a of accepted) {
      const k = a.job.start, p = pick.get(k);
      if (!p || a.gained.size > p.gained.size || (a.gained.size === p.gained.size && (a.sim > p.sim || (a.sim === p.sim && -a.forms.length > -p.forms.length)))) pick.set(k, a);
    }
    accepted = [...pick.values()].sort((x, y) => x.job.start - y.job.start);

    // -- all accepted tags of a TU together; drop the ones that conflict
    const final: Accepted[] = [];
    let combinedGain = 0;
    const work = new Map<string, Accepted[]>();
    for (const a of accepted) { if (!work.has(a.job.tu)) work.set(a.job.tu, []); work.get(a.job.tu)!.push(a); }
    for (const [tu, al] of work) {
      // Two tag sets on one function cannot both be: the one with more gains stays.
      al.sort((x, y) => y.gained.size - x.gained.size || x.job.start - y.job.start);
      const keep: Accepted[] = [];
      const on = new Set<number>();
      for (const a of al) if (![...a.bodies.keys()].some(s => on.has(s))) { keep.push(a); for (const s of a.bodies.keys()) on.add(s); }
      work.set(tu, keep);
    }
    const done = new Map<string, Set<number>>();
    for (let round = 0; round < 6; round++) {
      const todo = [...work.keys()].filter(tu => !done.has(tu) && work.get(tu)!.length);
      if (!todo.length) break;
      const objs = comp.run(todo.map(tu => {
        const bodies: Bodies = new Map();
        for (const a of work.get(tu)!) for (const [s, b] of a.bodies) bodies.set(s, b);
        return [tu, trialText(tu, bodies)];
      }));
      for (let k = 0; k < todo.length; k++) {
        const tu = todo[k], o = objs[k];
        const b = base.get(tu)!;
        const st: Judged = o ? await orc.judge(tu, o) : new Map();
        // A tag's own target may get further only by not winning, which drops it anyway.
        const targets = new Set(work.get(tu)!.map(a => a.job.start));
        const lost = [...losses(b, st)].filter(s => !targets.has(s) || b.get(s)!.st === 'MATCH');
        const miss = work.get(tu)!.filter(a => !wins(a.job, st.get(a.job.start)));
        if (lost.length || miss.length) {
          const list = work.get(tu)!;
          const drop = miss.length ? miss[miss.length - 1] : list[list.length - 1];
          list.splice(list.indexOf(drop), 1);
          log(`combined: ${tu} drops ${hex8(drop.job.start)} ${pyTuple(drop.forms)}`);
        } else {
          done.set(tu, new Set([...st.keys()].filter(s => st.get(s)!.st === 'MATCH' && b.get(s)!.st !== 'MATCH')));
          for (const a of work.get(tu)!) { const t = st.get(a.job.start)!; a.after = frameMode ? `${t.st}@${t.simText}` : t.st; }
        }
      }
      comp.drop(objs);
    }
    {
      let o = 'tu\ttag_sets\tgained\n';
      for (const [tu, gained] of [...done.entries()].sort((x, y) => cmpStr(x[0], y[0]))) {
        final.push(...work.get(tu)!);
        combinedGain += gained.size;
        o += `${tu}\t${work.get(tu)!.length}\t${gained.size}\n`;
      }
      writeFileSync(join(out, 'combined.tsv'), o);
    }

    // -- the tags, as Ghidra stores them
    const tagged = sortNum(new Set(final.map(a => a.on)));
    writeFileSync(join(out, 'dh-in.json'), jsonDumps(tagged.map(hex8)));
    if (tagged.length) tsx(['dh', args.snapshot, join(out, 'dh-in.json'), join(out, 'dh-out.json')], GR);
    else writeFileSync(join(out, 'dh-out.json'), '{}');
    const dh = JSON.parse(readFileSync(join(out, 'dh-out.json'), 'utf8'));
    let ev = 'addr\tname\tform\ttarget\tbefore\tafter\tgained\tlost\tcompiler\n';
    let tags = 'addr\tname\ttag\tgain\tlosses\tform\ttarget\tevidence\texisting\n';
    for (const a of final) {
      const j = a.job, on = a.on;
      const d = dh[hex8(on)];
      if (d === undefined) { log(`no snapshot function at ${hex8(on)}`); continue; }
      const ords: Record<string, number> = a.forms.length > 1 ? (j.ord?.get(a.forms.join('\0')) ?? {}) : {};
      for (const f of a.forms) {
        const before = frameMode ? `${j.base!.st}@${j.base!.simText}` : j.base!.st;
        const row = `${hex8(on)}\t${d.name}\t${f}\t${hex8(j.start)}\t${before}\t${a.after ?? 'MATCH'}\t${hexList(a.gained)}\t\tvc8-sp1 ${args.checkout.endsWith('/') ? '' : basename(args.checkout)}`;
        ev += row + '\n';
        const evh = createHash('sha256').update(row, 'utf8').digest('hex').slice(0, 10);
        let data = `${f};ev=${evh};bh=${await orc.bh(on, d.size)};dh=${d.dh}`;
        if (Object.prototype.hasOwnProperty.call(ords, f)) data += `;ord=${ords[f]}`;
        tags += `${hex8(on)}\t${d.name}\tvc8form:${data}\t${a.gained.size}\t0\t${f.split('(')[0]}\t${hex8(j.start)}\t${before}->${a.after ?? 'MATCH'}\t${d.tags.length}\n`;
      }
    }
    writeFileSync(join(out, 'tags.tsv'), tags);
    writeFileSync(join(out, 'evidence.tsv'), ev);
    // The bodies the accepted tags printed, for verify-gen.ts to hold the generator's against.
    const bodiesOut = new Map<string, string>();
    for (const a of final) for (const [s, b] of a.bodies) bodiesOut.set(hex8(s), b);
    writeFileSync(join(out, 'bodies.json'), jsonDumps(bodiesOut, 0));
    closeSync(trialsLog);
    comp.clean();

    const nSingle = final.filter(a => a.forms.length === 1).length;
    const skips = new Map<string, number>();
    for (const j of jobs) if (j.skip !== undefined) { const k = j.skip.split(':')[0]; skips.set(k, (skips.get(k) ?? 0) + 1); }
    const wall = now() - t0;
    const lines = [
      `targets ${jobs.length}, skipped ${jobs.length - live.length} (${[...skips].map(([k, v]) => `${k} ${v}`).join(', ')})`,
      `targets ${frameMode ? 'whose frame equals the original\'s, closer,' : 'reaching MATCH'} alone: ${accepted.length} (singles ${accepted.filter(a => a.forms.length === 1).length}, pairs ${accepted.filter(a => a.forms.length > 1).length})`,
      `kept together: ${final.length} tag sets (${nSingle} single), MATCH gained together ${combinedGain}`,
      `wall ${fixed(wall, 0)}s, ${fixed(wall / Math.max(1, jobs.length), 1)}s per target, ${comp.n} compiles`,
    ];
    writeFileSync(join(out, 'summary.txt'), lines.join('\n') + '\n');
    for (const l of lines) log(l);
    return { jobs, final };
  };

  try {
    if (!args.resume) {
      await run(targets, args.out);
      comp.clean();
      return 0;
    }
    return await resumeRun(args, targets, run, comp);
  } catch (e) {
    if (e instanceof CheckoutChanged && !args.resume) { process.stderr.write(`${e.message}\n`); return 1; }
    throw e;
  } finally {
    orc.close();
  }
}

/** Python's repr of a tuple of strings, as the log has always printed a tag set. */
function pyTuple(forms: string[]): string {
  const r = (s: string) => (s.includes("'") && !s.includes('"') ? `"${s}"` : `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
  return forms.length === 1 ? `(${r(forms[0])},)` : `(${forms.map(r).join(', ')})`;
}

function cmpTuple(x: [number, string, string, string, number], y: [number, string, string, string, number]): number {
  return x[0] - y[0] || cmpStr(x[1], y[1]) || cmpStr(x[2], y[2]) || cmpStr(x[3], y[3]) || x[4] - y[4];
}

async function smallSnapshot(snap: string, dest: string, targets: Target[], orc: Oracle): Promise<string> {
  /** The part of a snapshot a long run reads, written once: the functions of the targets'
   * TUs (the targets and every helper they can have) and the header inlines, with their rows unchanged, each
   * global's name and type, the types. Each step reads it instead of the whole model. */
  const tus = new Set(targets.map(t => t[2]));
  const want = new Set(orc.rows.filter(r => tus.has(r[3])).map(r => hex8(parseInt(r[0], 16))));
  mkdirSync(dest, { recursive: true });
  {
    const o = openSync(join(dest, 'functions.ndjson'), 'w');
    for await (const line of createInterface({ input: createReadStream(join(snap, 'functions.ndjson')), crlfDelay: Infinity })) {
      const i = line.indexOf('"address":"');
      // The header inlines too: the accessors `acc` candidates call (accessor-twins.ts).
      if (i >= 0 && (want.has(line.slice(i + 11, i + 19)) || line.includes('"inline-host"'))) writeSync(o, line + '\n');
    }
    closeSync(o);
  }
  {
    const o = openSync(join(dest, 'globals.ndjson'), 'w');
    for await (const line of createInterface({ input: createReadStream(join(snap, 'globals.ndjson')), crlfDelay: Infinity })) {
      if (!pyStrip(line)) continue;
      const g = JSON.parse(line);
      if (g.name && g.dataType) writeSync(o, jsonDumps({ name: g.name, dataType: g.dataType }) + '\n');
    }
    closeSync(o);
  }
  writeFileSync(join(dest, 'dataTypes.ndjson'), readFileSync(join(snap, 'dataTypes.ndjson')));
  return dest;
}

type RunFn = (targets: Target[], out: string) => Promise<{ jobs: Job[]; final: Accepted[] }>;

async function resumeRun(args: Args, targets: Target[], run: RunFn, comp: Compiler): Promise<number> {
  /** The long run: OUT/done.tsv holds every finished target with its outcome; OUT/tags.tsv,
   * evidence.tsv and bodies.json collect what each step found; each step's own outputs stay
   * in OUT/t/<first target>/. A step that did not finish is not recorded, and is run again. */
  const out = args.out;
  const donePath = join(out, 'done.tsv');
  const done = new Set<number>();
  if (existsSync(donePath)) {
    for (const line of readFileSync(donePath, 'utf8').split('\n').slice(1)) if (line) done.add(parseInt(line.split('\t')[0], 16));
  } else writeFileSync(donePath, 'addr\tname\tstatus\toutcome\tsecs\tat\n');
  for (const [name, header] of [['tags.tsv', 'addr\tname\ttag\tgain\tlosses\tform\ttarget\tevidence\texisting\n'],
    ['evidence.tsv', 'addr\tname\tform\ttarget\tbefore\tafter\tgained\tlost\tcompiler\n']]) {
    if (!existsSync(join(out, name))) writeFileSync(join(out, name), header);
  }
  const bodiesPath = join(out, 'bodies.json');
  const bodies = new Map<string, string>(existsSync(bodiesPath) ? Object.entries(JSON.parse(readFileSync(bodiesPath, 'utf8'))) : []);
  const todo = targets.filter(t => !done.has(t[0]));
  log(`resume: ${targets.length} targets, ${done.size} done, ${todo.length} to go, ${args.group} per step`);
  const stopFile = join(out, 'STOP');
  let nSteps = 0;
  for (let k = 0; k < todo.length; k += args.group) {
    if (existsSync(stopFile)) { log(`stopped: ${stopFile} exists`); break; }
    if (comp.changed()) {
      log('stopped: the checkout changed (a build, an update or a commit); the run cannot go on against it');
      return 3;
    }
    const step = todo.slice(k, k + args.group);
    const d = join(out, 't', hex8(step[0][0]));
    const t = now();
    let r;
    try {
      r = await run(step, d);
    } catch (e) {
      if (e instanceof CheckoutChanged) { log(`stopped: ${e.message}`); return 3; }
      throw e;
    }
    const secs = now() - t;
    for (const name of ['tags.tsv', 'evidence.tsv']) {
      const rows = readFileSync(join(d, name), 'utf8').split('\n').slice(1);
      appendFileSync(join(out, name), rows.filter(l => l).map(l => l + '\n').join(''));
    }
    for (const [a, b] of Object.entries(JSON.parse(readFileSync(join(d, 'bodies.json'), 'utf8')))) bodies.set(a, b as string);
    const tmp = bodiesPath + '.tmp';
    writeFileSync(tmp, jsonDumps(bodies, 0));
    renameSync(tmp, bodiesPath);
    const won = new Map(r.final.map(a => [a.job.start, a.forms.join('+')]));
    const byStart = new Map(r.jobs.map(j => [j.start, j]));
    const at = stamp();
    let o = '';
    for (const [start, name, , status] of step) {
      const j = byStart.get(start);
      const outcome = won.has(start) ? (args.accept === 'frame' ? 'FRAME ' : 'MATCH ') + won.get(start) : j && j.skip !== undefined ? 'skip: ' + j.skip : j ? 'none' : 'skip: no definition';
      o += `${hex8(start)}\t${name}\t${status}\t${outcome.replace(/\t/g, ' ')}\t${fixed(secs / step.length, 0)}\t${at}\n`;
    }
    appendFileSync(donePath, o);
    nSteps++;
  }
  comp.clean();
  log(`resume: ${nSteps} steps this run`);
  return 0;
}

function stamp(): string {
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

main().then(code => process.exit(code), e => {
  process.stderr.write(`${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
