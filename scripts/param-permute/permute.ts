/**
 * permute.ts - find the parameter declaration order of register-parameter callees by compiling them.
 *
 *   tsx permute.ts --checkout DIR --snapshot SNAP --out OUT [--addrs A,B,...] [--jobs J]
 *                  [--cap N] [--chunk N] [--oracle-zig BIN] [--apply TREE]
 *
 * VC8 /O2 gives a file-static function's register parameters EBX, EDI, ESI in declaration order,
 * and a caller evaluates the arguments right to left by declared position. Where Ghidra's order is
 * not the original's, the registers or the argument order come out swapped. No tree-wide rule
 * gets the order right (sorted, reversed and caller-inferred orders each lose matches), so it is
 * searched per function:
 *
 *   1. Candidates: functions of SNAP (a codegen snapshot, functions.ndjson) with two or more
 *      parameters, at least one in a register its convention does not give it, file-static in
 *      their TU (only then does VC8 choose the registers; every caller is in the same TU), whose
 *      body or one of whose same-TU callers does not match (as the checkout's own build judges it).
 *   2. Orders (reorder.ts storageOrders): every order that keeps each parameter's storage, up
 *      to --cap (24); past it the register parameters among their own positions, then a few.
 *   3. Each order is one trial: the TU with the definition, every declaration and every call
 *      re-ordered (reorder.ts reorderFunction, on tokens), translated as the build translates,
 *      compiled beside the TU with the build's command line (`oracle-zig trial`, batched).
 *   4. Every function of the TU is judged (`oracle-zig judge`) against a base trial of the
 *      unchanged TU. The re-ordered function's decorated name changes with its parameter types,
 *      so the judge runs on a shadow of the oracle root whose funcmap also carries each trial's
 *      new name (read from the object's symbol table).
 *   5. An order is kept when it gains MATCH in the TU and loses none, or (tier `closer`) gains
 *      none, loses none, moves no function to a worse status or a lower similarity, and moves
 *      at least one to a better status or to the original's frame. Per function the order with
 *      the most MATCH wins, then the most status steps.
 *   6. The kept orders of one TU are compiled together, best first; one that loses a match or a
 *      gain there is dropped.
 *
 * OUT gets trials.tsv (every trial), results.json (the kept orders, with what each gained) and
 * final-spec.json ({address: order}, the shape the Ghidra apply step reads). --apply TREE writes
 * each TU with its kept orders into TREE (a checkout of the same commit) for a full-build bench.
 *
 * Run it with the oracle environment of a built checkout (oracle/env.sh). BIN defaults to the
 * checkout's oracle-zig or ORACLE_ZIG; a wrapper that takes a lock around `trial` is fine.
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { decodeFile, encodeFile, functionSpan, hex8 } from '../vc8form-permute/text.js';
import { Compiler, Oracle } from '../vc8form-permute/oracle.js';
import { isStaticAt, paramKinds, reorderFunction, storageOrders, type Kind } from './reorder.js';

interface Args { checkout: string; snapshot: string; out: string; addrs?: string; jobs: number; cap: number; chunk: number; zig: string; apply?: string }

interface Param { name: string; storage: string; type: string }
interface Cand {
  start: number; name: string; leaf: string; tu: string; symbol: string; cc: string; params: Param[]; kinds: Kind[];
  orders: number[][];
}
interface Fn { st: string; sim: number; fo: number; fr: number; calls: string[] }
type Judged = Map<number, Fn>;
interface Outcome { cand: Cand; perm: number[]; ok: boolean; note: string; gained: number[]; lost: number[]; better: number[]; worse: number[] }

function log(...a: unknown[]) {
  const d = new Date();
  process.stdout.write([[d.getHours(), d.getMinutes(), d.getSeconds()].map(x => String(x).padStart(2, '0')).join(':'), ...a].join(' ') + '\n');
}

function usage(code = 2): never {
  const doc = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  process.stderr.write(doc.slice(doc.indexOf('/**') + 3, doc.indexOf('*/')).split('\n').map(l => l.replace(/^ \* ?/, '')).join('\n') + '\n');
  process.exit(code);
}

function parseArgs(argv: string[]): Args {
  const a: Record<string, string | number | undefined> = { jobs: 8, cap: 24, chunk: 256 };
  const names: Record<string, string> = {
    '--checkout': 'checkout', '--snapshot': 'snapshot', '--out': 'out', '--addrs': 'addrs', '--jobs': 'jobs', '--cap': 'cap',
    '--chunk': 'chunk', '--oracle-zig': 'zig', '--apply': 'apply',
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-h' || argv[i] === '--help') usage(0);
    const k = names[argv[i]];
    if (!k || argv[i + 1] === undefined) { process.stderr.write(`bad argument: ${argv[i]}\n`); usage(); }
    const v = argv[++i];
    a[k] = ['jobs', 'cap', 'chunk'].includes(k) ? parseInt(v, 10) : v;
  }
  if (!a.checkout || !a.snapshot || !a.out) usage();
  a.checkout = resolve(String(a.checkout));
  a.zig ??= process.env.ORACLE_ZIG || join(String(a.checkout), 'asm_matching', 'msvc8', 'zig', 'zig-out', 'bin', 'oracle-zig');
  return a as unknown as Args;
}

// ---------------------------------------------------------------------------------------
// Status order: the judge's statuses from worst to best.

export function rank(st: string): number {
  if (st === 'MATCH') return 5;
  if (st === 'REF_DIFF') return 4;
  if (st === 'INSN_MATCH') return 3;
  if (st === 'INSN_COUNT_MATCH') return 2;
  if (st.startsWith('OUR')) return 1;
  return 0;
}

/** What a trial did to the TU against its base: MATCH gained and lost, status steps up and down. */
export function compareTu(base: Judged, trial: Judged | null): { gained: number[]; lost: number[]; better: number[]; worse: number[] } {
  const gained: number[] = [], lost: number[] = [], better: number[] = [], worse: number[] = [];
  for (const [s, b] of base) {
    const t = trial?.get(s);
    const st = t?.st ?? 'MISSING';
    if (b.st === 'MATCH' && st !== 'MATCH') lost.push(s);
    if (b.st !== 'MATCH' && st === 'MATCH') gained.push(s);
    if (b.st === 'QUARANTINE' || b.st === 'MISSING') continue;
    const frameB = b.fo === b.fr, frameT = t !== undefined && t.fo === t.fr;
    if (rank(st) < rank(b.st) || (t && t.sim < b.sim) || (frameB && !frameT)) worse.push(s);
    else if (rank(st) > rank(b.st) || (!frameB && frameT)) better.push(s);
  }
  return { gained, lost, better, worse };
}

// ---------------------------------------------------------------------------------------
// COFF: the defined function symbols of an object, to find a trial's new decorated name.

export function coffFunctionSymbols(obj: Buffer): string[] {
  if (obj.length < 20) return [];
  const symPtr = obj.readUInt32LE(8), nsym = obj.readUInt32LE(12);
  const strtab = symPtr + nsym * 18;
  const out: string[] = [];
  for (let i = 0; i < nsym; i++) {
    const o = symPtr + i * 18;
    if (o + 18 > obj.length) break;
    let name: string;
    if (obj.readUInt32LE(o) === 0) {
      const at = strtab + obj.readUInt32LE(o + 4);
      const end = obj.indexOf(0, at);
      name = obj.toString('latin1', at, end < 0 ? obj.length : end);
    } else {
      const raw = obj.subarray(o, o + 8);
      const end = raw.indexOf(0);
      name = raw.toString('latin1', 0, end < 0 ? 8 : end);
    }
    const section = obj.readInt16LE(o + 12), type = obj.readUInt16LE(o + 14);
    if (section > 0 && (type & 0xf0) === 0x20) out.push(name);
    i += obj[o + 17];
  }
  return out;
}

/** `?Leaf@Scope@@<signature>` -> `?Leaf@Scope@@`: what a re-order keeps of the decorated name. */
const scopeOf = (sym: string) => { const k = sym.indexOf('@@'); return k < 0 ? sym : sym.slice(0, k + 2); };

// ---------------------------------------------------------------------------------------
// The judge, on a shadow of the oracle root whose funcmap carries extra rows: each trial's new
// decorated name for its re-ordered function (same start, same TU).

class Judge {
  private child?: ReturnType<typeof spawn>;
  private waiting: Array<(s: string) => void> = [];
  private replies: string[] = [];
  private extra = new Map<string, string[]>();   // new symbol -> funcmap row
  private dirty = true;
  readonly shadow: string;

  constructor(readonly root: string, readonly zig: string, out: string, readonly rows: string[][]) {
    this.shadow = join(out, 'shadow-root');
    rmSync(this.shadow, { recursive: true, force: true });
    mkdirSync(join(this.shadow, 'evidence'), { recursive: true });
    for (const d of ['reference', 'build']) symlinkSync(join(root, d), join(this.shadow, d));
    for (const f of ['libmap.tsv', 'crtmap.tsv']) if (existsSync(join(root, 'evidence', f))) symlinkSync(join(root, 'evidence', f), join(this.shadow, 'evidence', f));
  }

  /** Carry `symbol` as another name of `row`'s function. */
  alias(symbol: string, row: string[]) {
    if (this.extra.has(symbol) || this.rows.some(r => r[4] === symbol)) return;
    const r = row.slice(); r[4] = symbol;
    this.extra.set(symbol, r);
    this.dirty = true;
  }

  private async restart() {
    if (this.child) { this.child.stdin!.end(); this.child = undefined; }
    const head = 'start\tend\tname\ttu\tsymbol\tmethod\tdetail';
    writeFileSync(join(this.shadow, 'evidence', 'funcmap.tsv'), [head, ...this.rows.map(r => r.join('\t')), ...[...this.extra.values()].map(r => r.join('\t'))].join('\n') + '\n');
    this.waiting = []; this.replies = [];
    const child = spawn(this.zig, ['judge', '--root', this.shadow], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.child = child;
    createInterface({ input: child.stdout! }).on('line', l => { const w = this.waiting.shift(); if (w) w(l); else this.replies.push(l); });
    child.on('exit', code => { if (code && this.child === child) { process.stderr.write(`oracle-zig judge exited ${code}\n`); process.exit(1); } });
    if (await this.next() !== 'ready') throw new Error('oracle-zig judge did not start');
    this.dirty = false;
  }

  private next(): Promise<string> {
    const r = this.replies.shift();
    return r !== undefined ? Promise.resolve(r) : new Promise(res => this.waiting.push(res));
  }

  async judge(tu: string, obj: string | null): Promise<Judged> {
    if (this.dirty) await this.restart();
    this.child!.stdin!.write(JSON.stringify({ tu, obj }) + '\n');
    const r = JSON.parse(await this.next());
    const out: Judged = new Map();
    for (const [s, st, sim, , calls, fo, fr] of r.fns) {
      const prev = out.get(s);
      if (prev && prev.st !== 'MISSING') continue;     // an alias row of a function judged already
      out.set(s, { st, sim: Number(sim), fo: fo ?? 0, fr: fr ?? 0, calls });
    }
    return out;
  }

  close() { this.child?.stdin!.end(); }
}

// ---------------------------------------------------------------------------------------

async function readSnapshot(path: string, want: (addr: string) => boolean) {
  const out = new Map<number, { leaf: string; cc: string; params: Param[] }>();
  for await (const line of createInterface({ input: createReadStream(join(path, 'functions.ndjson')) })) {
    const i = line.indexOf('"address":"');
    if (i < 0 || !want(line.slice(i + 11, i + 19))) continue;
    const r = JSON.parse(line);
    const ps = r.parameters ?? [];
    if (ps.length < 2 || r.hasVarArgs || r.isThunk) continue;
    out.set(parseInt(r.address, 16), {
      leaf: r.name, cc: r.callingConvention ?? '',
      params: ps.map((p: { name: string; storage?: string; dataType?: string }) => ({ name: p.name, storage: p.storage ?? '', type: p.dataType ?? '' })),
    });
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = resolve(args.out);
  mkdirSync(out, { recursive: true });
  const orc = new Oracle(args.checkout, args.zig);
  await orc.start();
  orc.close();                                      // its judge reads the plain funcmap; ours reads the shadow
  const judge = new Judge(orc.root, args.zig, out, orc.rows);
  const comp = new Compiler(orc, args.jobs, join(out, 'obj'));
  const rowOf = new Map<number, string[]>();
  const leafCount = new Map<string, number>();
  for (const r of orc.rows) {
    rowOf.set(parseInt(r[0], 16), r);
    const leaf = r[2].slice(r[2].lastIndexOf('::') + 2);
    leafCount.set(leaf, (leafCount.get(leaf) ?? 0) + 1);
  }
  const only = args.addrs ? new Set(args.addrs.split(',').map(x => x.trim().toLowerCase().padStart(8, '0'))) : undefined;
  const snap = await readSnapshot(args.snapshot, a => rowOf.has(parseInt(a, 16)) && (!only || only.has(a)));

  // -- candidates: a register parameter its convention does not give it, file-static, a definition we can edit
  const skipped = new Map<string, number>();
  const skip = (why: string) => skipped.set(why, (skipped.get(why) ?? 0) + 1);
  const texts = new Map<string, string | null>();
  const textOf = (tu: string): string | null => {
    if (!texts.has(tu)) {
      texts.set(tu, null);
      const path = join(orc.repo, tu + '.cpp');
      if (existsSync(path)) {
        const text = decodeFile(readFileSync(path));
        if (orc.translate(tu, text).equals(readFileSync(join(orc.src, tu + '.cpp')))) texts.set(tu, text);
      }
    }
    return texts.get(tu)!;
  };
  const pre: Cand[] = [];
  for (const [start, f] of snap) {
    const row = rowOf.get(start)!;
    const kinds = paramKinds(f.cc, f.params.map(p => p.storage));
    if (!kinds) { skip('a parameter without plain storage'); continue; }
    if (!kinds.includes('R')) continue;
    if ((leafCount.get(f.leaf) ?? 0) !== 1) { skip('its name is not unique in the funcmap'); continue; }
    const tu = row[3];
    const text = textOf(tu);
    if (!text) { skip('its TU is not the one built'); continue; }
    const span = functionSpan(text, start);
    if (!span) { skip('no definition in its TU'); continue; }
    if (!isStaticAt(text, span[0], f.leaf)) { skip('not file-static'); continue; }
    const probe = reorderFunction(text, f.leaf, kinds.map((_, i) => i));
    if (probe.errors.length) { skip(`not re-orderable: ${probe.errors[0].replace(/^line \d+: /, '')}`); continue; }
    pre.push({ start, name: row[2], leaf: f.leaf, tu, symbol: row[4], cc: f.cc, params: f.params, kinds, orders: storageOrders(kinds, args.cap, f.params.map(p => p.storage)).slice(1) });
  }
  const tus = [...new Set(pre.map(c => c.tu))].sort();
  log(`${pre.length} register-parameter candidates in ${tus.length} TUs; skipped: ${JSON.stringify(Object.fromEntries(skipped))}`);

  // -- the base: every TU compiled unchanged through the same trial path
  const base = new Map<string, Judged>();
  for (let k = 0; k < tus.length; k += args.chunk) {
    const part = tus.slice(k, k + args.chunk);
    const objs = comp.run(part.map(tu => [tu, orc.translate(tu, textOf(tu)!)]));
    for (let n = 0; n < part.length; n++) base.set(part[n], await judge.judge(part[n], objs[n]));
    comp.drop(objs);
  }
  const cands = pre.filter(c => {
    const b = base.get(c.tu)!;
    if (b.get(c.start)?.st === undefined || b.get(c.start)!.st === 'MISSING') return false;
    if (b.get(c.start)!.st !== 'MATCH') return true;
    for (const [, f] of b) if (f.st !== 'MATCH' && f.calls.includes(c.symbol)) return true;
    return false;
  });
  const total = cands.reduce((n, c) => n + c.orders.length, 0);
  log(`${cands.length} with a body or a same-TU caller that does not match; ${total} trials`);

  // -- the trials
  const items: Array<[Cand, number[]]> = cands.flatMap(c => c.orders.map(p => [c, p] as [Cand, number[]]));
  const outcomes: Outcome[] = [];
  const trialsTsv = ['address\tname\torder\tok\tgained\tlost\tbetter\tworse\tnote'];
  const t0 = performance.now();
  for (let k = 0; k < items.length; k += args.chunk) {
    const part = items.slice(k, k + args.chunk);
    const sources = part.map(([c, p]) => reorderFunction(textOf(c.tu)!, c.leaf, p));
    const objs = comp.run(part.map(([c], n) => [c.tu, orc.translate(c.tu, sources[n].text)]));
    for (let n = 0; n < part.length; n++) {
      const [c, p] = part[n], o = objs[n];
      if (o) for (const sym of coffFunctionSymbols(readFileSync(o))) {
        if (sym !== c.symbol && sym.startsWith(`?${c.leaf}@`) && scopeOf(sym) === scopeOf(c.symbol)) judge.alias(sym, rowOf.get(c.start)!);
      }
    }
    for (let n = 0; n < part.length; n++) {
      const [c, p] = part[n], o = objs[n];
      const r = o ? compareTu(base.get(c.tu)!, await judge.judge(c.tu, o)) : { gained: [], lost: [], better: [], worse: [] };
      const strict = r.gained.length > 0 && r.lost.length === 0;
      const closer = r.gained.length === 0 && r.lost.length === 0 && r.worse.length === 0 && r.better.length > 0;
      const note = !o ? 'compile failed' : strict ? 'match' : closer ? 'closer' : '';
      outcomes.push({ cand: c, perm: p, ok: strict || closer, note, ...r });
      trialsTsv.push([hex8(c.start), c.name, p.join(','), strict || closer ? 1 : 0, r.gained.map(hex8).join(','), r.lost.map(hex8).join(','), r.better.map(hex8).join(','), r.worse.map(hex8).join(','), note].join('\t'));
    }
    comp.drop(objs);
    log(`trials ${Math.min(k + args.chunk, items.length)}/${items.length}, ${outcomes.filter(o => o.ok).length} kept so far, ${((performance.now() - t0) / 1000).toFixed(0)}s`);
    writeFileSync(join(out, 'trials.tsv'), trialsTsv.join('\n') + '\n');
  }

  // -- the best order per function
  const better = (x: Outcome, y: Outcome) => x.gained.length - y.gained.length || x.better.length - y.better.length;
  const best = new Map<number, Outcome>();
  for (const o of outcomes) {
    if (!o.ok) continue;
    const cur = best.get(o.cand.start);
    if (!cur || better(o, cur) > 0) best.set(o.cand.start, o);
  }

  // -- each TU's kept orders together, best first; one that costs a match or a gain is dropped
  const byTu = new Map<string, Outcome[]>();
  for (const o of best.values()) { if (!byTu.has(o.cand.tu)) byTu.set(o.cand.tu, []); byTu.get(o.cand.tu)!.push(o); }
  for (const l of byTu.values()) l.sort((x, y) => -better(x, y) || x.cand.start - y.cand.start);
  const kept = new Map<string, { set: Outcome[]; gained: Set<number>; better: Set<number> }>();
  for (const [tu, l] of byTu) kept.set(tu, { set: [l[0]], gained: new Set(l[0].gained), better: new Set(l[0].better) });
  const apply = (tu: string, set: Outcome[]) => set.reduce((t, o) => reorderFunction(t, o.cand.leaf, o.perm).text, textOf(tu)!);
  const dropped: Array<[Outcome, string]> = [];
  for (let step = 1; ; step++) {
    const tries = [...byTu].filter(([, l]) => l.length > step).map(([tu, l]) => [tu, l[step]] as [string, Outcome]);
    if (!tries.length) break;
    const objs = comp.run(tries.map(([tu, o]) => [tu, orc.translate(tu, apply(tu, [...kept.get(tu)!.set, o]))]));
    for (let n = 0; n < tries.length; n++) {
      const [tu, o] = tries[n], k = kept.get(tu)!;
      const r = objs[n] ? compareTu(base.get(tu)!, await judge.judge(tu, objs[n])) : null;
      const keepsGains = r !== null && [...k.gained, ...o.gained].every(s => r.gained.includes(s));
      if (r && r.lost.length === 0 && keepsGains) {
        k.set.push(o); k.gained = new Set(r.gained); k.better = new Set(r.better);
      } else dropped.push([o, r ? `together with the TU's others: lost ${r.lost.map(hex8)}${keepsGains ? '' : ', a gain gone'}` : 'compile failed together']);
    }
    comp.drop(objs);
  }
  comp.clean();
  judge.close();

  // -- the outputs
  const results = [...kept.values()].flatMap(k => k.set).sort((x, y) => x.cand.start - y.cand.start).map(o => ({
    address: hex8(o.cand.start), name: o.cand.name, tu: o.cand.tu, convention: o.cand.cc, kinds: o.cand.kinds.join(''),
    perm: o.perm,
    ghidraOrder: o.cand.params.map(p => `${p.name}:${p.storage}`),
    proposedOrder: o.perm.map(i => `${o.cand.params[i].name}:${o.cand.params[i].storage}`),
    tier: o.gained.length ? 'match' : 'closer',
    gainedMatch: o.gained.map(hex8), closer: o.better.map(hex8),
    baseStatus: base.get(o.cand.tu)!.get(o.cand.start)!.st,
    trials: o.cand.orders.length,
  }));
  writeFileSync(join(out, 'results.json'), JSON.stringify({
    checkout: args.checkout, snapshot: resolve(args.snapshot), candidates: cands.length, trials: total, skipped: Object.fromEntries(skipped),
    kept: results, dropped: dropped.map(([o, why]) => ({ address: hex8(o.cand.start), perm: o.perm, gainedMatch: o.gained.map(hex8), why })),
  }, null, 1) + '\n');
  writeFileSync(join(out, 'final-spec.json'), JSON.stringify(Object.fromEntries(results.map(r => [r.address, r.perm])), null, 1) + '\n');
  log(`kept ${results.length} orders: ${results.filter(r => r.tier === 'match').length} gain MATCH (${results.reduce((n, r) => n + r.gainedMatch.length, 0)} functions), ${results.filter(r => r.tier === 'closer').length} closer; dropped together ${dropped.length}`);

  if (args.apply) {
    for (const [tu, k] of kept) writeFileSync(join(resolve(args.apply), tu + '.cpp'), encodeFile(apply(tu, k.set)));
    log(`wrote ${kept.size} TUs into ${args.apply}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(1); });
}
