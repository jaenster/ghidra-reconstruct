/**
 * recheck.ts - measure the oracle evidence of redivivus.app proposals again, on the current head.
 *
 *   tsx recheck.ts --checkout DIR --proposals FILE --out FILE [--snapshot SNAP] [--oracle-zig BIN] [--jobs J]
 *
 * A proposal may carry `oracle` evidence: {function, before, after}, the function's VC8 audit
 * status on the head its author measured and with the proposal applied. Before the maintainer
 * applies it, this measures each such function on the checkout (a built VC8 measurement
 * checkout, as recon/runs/vc8form-permute.sh takes) with oracle-zig:
 *
 *   head     the function's status as the checkout's TU compiles now (`oracle-zig trial` of its
 *            translation untouched, `judge`)
 *   with op  for a function the proposal gives a vc8form tag: its definition as the tree prints it
 *            with the new forms applied (candidates.ts apply, the generator's applyVc8Forms in its
 *            tag order), compiled and judged the same way; the tag's bh is checked against the
 *            original's masked bytes (`judge` bh)
 *
 * The verdict per item:
 *
 *   gains      the op was measured and moves the function closer to MATCH than the head
 *   no_gain    refuse: the function is MATCH on the head already, or the measured op does not move
 *              it closer to MATCH, or (op not measurable here) the head is already at or past the
 *              claimed `after`, or the tag's bh is not the original's
 *   unmeasured the op is one a trial cannot apply (a name, a type, a prototype, a linkage or a
 *              refile changes the regenerated tree, not one body): the head is reported, the gain
 *              needs a regen to prove
 *
 * A proposal with any no_gain item is flagged `refuse`, with a comment for its author. FILE is a
 * list of proposals or an MCP answer with `proposals` (list_approved, admin_queue, get_proposal).
 * --out gets {checkout, head, proposals: [{id, refuse, comment?, items: [...]}]}; a summary goes
 * to stdout. SNAP (a codegen snapshot: dataTypes.ndjson, globals.ndjson) gives the forms that
 * declare a local their types; without it such a form may be refused and its item reads unmeasured.
 * Run it with the checkout's oracle environment (oracle/env.sh, ORACLE_DRIVE), one heavy job at a
 * time on the machine.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeFile, dedupeTwins, functionSpan, hex8 } from '../vc8form-permute/text.js';
import { Compiler, Oracle, fit, splice, type Judged } from '../vc8form-permute/oracle.js';
import { verdictOf, type ItemResult, type Measured, type OracleItem } from '../../packages/live/src/proposal-apply/verdict.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GR = dirname(dirname(HERE));

interface Op { op: string; program?: string; address?: string; tag?: string; replace?: string[] }
interface Proposal { id: number; ops: Op[]; evidence?: Array<Record<string, unknown>> }

const num = (a: string) => parseInt(a.replace(/^0x/i, ''), 16);
const formOf = (tag: string) => tag.slice(0, tag.lastIndexOf(';ev='));
const bhOf = (tag: string) => /;bh=(\d+-[0-9a-f]{8})/.exec(tag)?.[1];

function readProposals(path: string): Proposal[] {
  const v = JSON.parse(readFileSync(path, 'utf8'));
  const list = Array.isArray(v) ? v : Array.isArray(v?.proposals) ? v.proposals : v?.id ? [v] : null;
  if (!list) throw new Error(`${path}: no proposals in it`);
  return list;
}

interface Args { checkout: string; proposals: string; out: string; snapshot?: string; zig: string; jobs: number }

function parseArgs(argv: string[]): Args {
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '-h' || k === '--help') usage(0);
    if (!k.startsWith('--') || argv[i + 1] === undefined) usage();
    a[k.slice(2)] = argv[++i];
  }
  if (!a.checkout || !a.proposals || !a.out) usage();
  const checkout = resolve(a.checkout);
  return {
    checkout, proposals: a.proposals, out: a.out, snapshot: a.snapshot, jobs: Number(a.jobs ?? 4),
    zig: a['oracle-zig'] ?? process.env.ORACLE_ZIG ?? join(checkout, 'asm_matching', 'msvc8', 'zig', 'zig-out', 'bin', 'oracle-zig'),
  };
}

function usage(code = 2): never {
  const doc = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  process.stderr.write(doc.slice(doc.indexOf('/**') + 3, doc.indexOf('*/')).split('\n').map((l) => l.replace(/^ \* ?/, '')).join('\n') + '\n');
  process.exit(code);
}

/** The definitions with the forms applied, by candidates.ts apply (the generator's pass and order). */
function applyForms(items: Array<{ id: string; text: string; forms: string[] }>, snapshot: string | undefined, scratch: string): Map<string, { text: string; refused: Array<{ form: string; why: string }> }> {
  const inp = join(scratch, 'apply-in.json');
  const out = join(scratch, 'apply-out.json');
  writeFileSync(inp, JSON.stringify(items));
  const extra = snapshot ? ['--types', join(snapshot, 'dataTypes.ndjson'), '--globals', join(snapshot, 'globals.ndjson')] : [];
  const p = spawnSync(join(GR, 'node_modules', '.bin', 'tsx'), [join(GR, 'scripts', 'vc8form-permute', 'candidates.ts'), 'apply', inp, out, ...extra], { cwd: GR, encoding: 'utf8', maxBuffer: 1 << 30 });
  if (p.status !== 0) throw new Error(`candidates.ts apply failed: ${(p.stderr ?? '').slice(-2000)}`);
  const res = new Map<string, { text: string; refused: Array<{ form: string; why: string }> }>();
  for (const r of JSON.parse(readFileSync(out, 'utf8'))) res.set(r.id, { text: r.text, refused: r.refused ?? [] });
  return res;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const proposals = readProposals(args.proposals);
  const want = new Map<number, { item: OracleItem; proposal: number; forms: string[]; bh?: string }[]>();
  const perProposal = new Map<number, Array<{ item: OracleItem; key: number }>>();
  for (const p of proposals) {
    for (const e of p.evidence ?? []) {
      if (e.kind !== 'oracle') continue;
      const item = { function: String(e.function), before: String(e.before), after: String(e.after) };
      const start = num(item.function);
      const tags = p.ops.filter((o) => o.op === 'vc8form' && (o.program ?? 'win') === 'win' && o.address && num(o.address) === start).map((o) => o.tag!);
      const list = want.get(start) ?? [];
      list.push({ item, proposal: p.id, forms: tags.map(formOf), bh: tags.length ? bhOf(tags[0]) : undefined });
      want.set(start, list);
      perProposal.set(p.id, [...(perProposal.get(p.id) ?? []), { item, key: start }]);
    }
  }
  if (!want.size) {
    writeFileSync(args.out, JSON.stringify({ checkout: args.checkout, proposals: [] }, null, 1));
    process.stdout.write('no oracle evidence in these proposals\n');
    return 0;
  }

  const orc = new Oracle(args.checkout, args.zig);
  await orc.start();
  const scratch = mkdtempSync(join(tmpdir(), 'proposal-recheck-'));
  const comp = new Compiler(orc, args.jobs, join(scratch, 'obj'));
  const measured = new Map<string, Measured>();
  const key = (start: number, proposal: number) => `${start}:${proposal}`;
  try {
    const rowOf = new Map<number, string[]>();
    for (const r of orc.rows) rowOf.set(parseInt(r[0], 16), r);
    const texts = new Map<string, string | null>();
    const textOf = (tu: string): string | null => {
      if (!texts.has(tu)) {
        const path = join(orc.repo, `${tu}.cpp`);
        let text: string | null = null;
        if (existsSync(path)) {
          const tree = decodeFile(readFileSync(path));
          if (orc.translate(tu, tree).equals(readFileSync(join(orc.src, `${tu}.cpp`)))) text = tree;
        }
        texts.set(tu, text);
      }
      return texts.get(tu)!;
    };

    // The head: each TU as it compiles now.
    const tus = new Map<string, number[]>();
    for (const start of want.keys()) {
      const r = rowOf.get(start);
      if (!r) { for (const w of want.get(start)!) measured.set(key(start, w.proposal), { note: `${hex8(start)} is not in the oracle's function map` }); continue; }
      const tu = r[3];
      if (!textOf(tu)) { for (const w of want.get(start)!) measured.set(key(start, w.proposal), { note: `${tu}: the checkout's translation is not the one built; build it first` }); continue; }
      tus.set(tu, [...(tus.get(tu) ?? []), start]);
    }
    const tuList = [...tus.keys()].sort();
    const baseObjs = comp.run(tuList.map((tu) => [tu, orc.translate(tu, textOf(tu)!)]));
    const base = new Map<string, Judged>();
    for (let k = 0; k < tuList.length; k++) base.set(tuList[k], await orc.judge(tuList[k], baseObjs[k]));
    comp.drop(baseObjs);

    // With the op: the vc8form ones, each proposal on its own.
    const applyItems: Array<{ id: string; text: string; forms: string[] }> = [];
    for (const [tu, starts] of tus) {
      const text = textOf(tu)!;
      for (const start of starts) {
        const head = base.get(tu)!.get(start)?.st;
        for (const w of want.get(start)!) {
          const m: Measured = { head, note: w.forms.length ? undefined : 'the proposal gives this function no vc8form tag; its ops change the regenerated tree, which a trial does not build' };
          if (w.bh) {
            const [size] = w.bh.split('-');
            m.bh = { tag: w.bh, original: await orc.bh(start, Number(size)) };
          }
          measured.set(key(start, w.proposal), m);
          const sp = functionSpan(text, start);
          if (w.forms.length && sp) applyItems.push({ id: key(start, w.proposal), text: text.slice(sp[0], sp[1]), forms: w.forms });
          else if (w.forms.length) m.note = `no definition of ${hex8(start)} in ${tu}`;
        }
      }
    }
    if (applyItems.length) {
      const applied = applyForms(applyItems, args.snapshot, scratch);
      const trials: Array<[string, Buffer]> = [];
      const trialKeys: string[] = [];
      for (const it of applyItems) {
        const [startS] = it.id.split(':');
        const start = Number(startS);
        const r = applied.get(it.id)!;
        if (r.refused.length) { measured.get(it.id)!.note = `the generator's pass refuses ${r.refused.map((x) => `${x.form} (${x.why})`).join(', ')}`; continue; }
        const tu = rowOf.get(start)![3];
        const text = textOf(tu)!;
        const sp = functionSpan(text, start)!;
        trials.push([tu, orc.translate(tu, dedupeTwins(splice(text, [[sp, fit(r.text, text.slice(sp[0], sp[1]))]])))]);
        trialKeys.push(it.id);
      }
      const objs = comp.run(trials);
      for (let k = 0; k < trials.length; k++) {
        const start = Number(trialKeys[k].split(':')[0]);
        const j = objs[k] ? await orc.judge(trials[k][0], objs[k]) : null;
        const st = j?.get(start)?.st;
        const m = measured.get(trialKeys[k])!;
        if (st === undefined) m.note = 'the trial with the tag did not compile';
        else m.withOp = st;
      }
      comp.drop(objs);
    }
  } finally {
    orc.close();
    rmSync(scratch, { recursive: true, force: true });
  }

  const out = [];
  let refused = 0;
  for (const p of proposals) {
    const items = perProposal.get(p.id);
    if (!items) continue;
    const results: ItemResult[] = items.map(({ item, key: start }) => {
      const m = measured.get(key(start, p.id)) ?? { note: 'not measured' };
      return { ...item, ...m, ...verdictOf(item, m) };
    });
    const refuse = results.some((r) => r.verdict === 'no_gain');
    if (refuse) refused++;
    const comment = refuse
      ? `Re-measured on the current head with the VC8 oracle: ${results.filter((r) => r.verdict === 'no_gain').map((r) => r.why).join('; ')}. Something else probably landed first; if you measure a gain on the new head, send it again with the new figures.`
      : undefined;
    out.push({ id: p.id, refuse, ...(comment ? { comment } : {}), items: results });
    for (const r of results) process.stdout.write(`${p.id}\t${r.function}\t${r.before}->${r.after}\thead ${r.head ?? '-'}\twith op ${r.withOp ?? '-'}\t${r.verdict}\t${r.why}\n`);
  }
  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  writeFileSync(args.out, JSON.stringify({ checkout: args.checkout, proposals: out }, null, 1));
  process.stdout.write(`${out.length} proposals with oracle evidence, ${refused} to refuse\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().then((c) => process.exit(c), (e) => { process.stderr.write(`${e instanceof Error ? e.stack : e}\n`); process.exit(1); });
