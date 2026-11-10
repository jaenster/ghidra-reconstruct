#!/usr/bin/env python3
"""permute.py - find vc8form tags for VC8 near-miss functions by compiling them.

    permute.py --checkout DIR --snapshot SNAP --out OUT [--pool AUDIT] [--sample N] [--seed S]
               [--addrs A,B,...] [--jobs J] [--max-insns K] [--no-pairs] [--no-phase]

For each target function (the near-miss pool of an audit.tsv, a sample of it, or --addrs):

  1. candidates.ts lists every vc8form applyVc8Forms implements at every site of the
     function and of its same-TU callees that VC8 inlines into it (the helpers), each
     with the body that form's tag text prints. Nothing else is ever edited.
  2. Each candidate is one trial: the TU's translated source with that one body swapped
     in, compiled beside the TU (same directory, so includes resolve the same) into a
     scratch object directory, with the oracle's own command line and precompiled
     header. Trials of many TUs go through one cl.exe in batches, J at a time; the
     checkout's tracked files and build/obj are never written.
  3. Every function of the TU is judged against the original as the audit judges it.
     A candidate is kept when its target reaches MATCH and no function of the TU that
     matched before stops matching. A form that declares a local is also put against
     the same number of dummy externs before that function, without the form: when
     that alone matches, the gain is the front end's symbol phase, not the form.
  4. Targets whose only difference is a register tie are scanned for phase first:
     0..63 dummy externs before the definition; a target that matches at some count is
     phase noise and is skipped (memory: vc8-declaration-phase-is-noise).
  5. Targets no single form matches get pairs: each of the best singles (by
     similarity) with every other single of the same target, applied in the order
     the generator sorts a function's tags (same-op pairs get `ord`).
  6. The accepted tags of each TU are compiled together; a tag that loses another
     function or its own target there is dropped, the rest compiled again.

OUT gets tags.tsv (the tag data exactly as Ghidra stores it: dh is the generator's hash
of the snapshot's decompile, bh the original's size and masked bytes, ev the hash of the
evidence row in evidence.tsv), evidence.tsv, combined.tsv, trials.tsv (every trial) and
summary.txt.

Run it with the checkout's oracle environment (recon/runs/vc8form-permute.sh does).
"""
import argparse
import collections
import concurrent.futures as cf
import fcntl
import hashlib
import json
import os
import random
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REGS = set('eax ebx ecx edx esi edi ebp esp ax bx cx dx si di bp sp al ah bl bh cl ch dl dh'.split())
NEAR = re.compile(r'^(INSN_COUNT_MATCH|INSN_MATCH|OUR[-+][12])$')


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


class Oracle:
    """The checkout's oracle, loaded once: map rows, the decoded original, symbols."""

    def __init__(self, checkout):
        self.scripts = os.path.join(checkout, 'asm_matching', 'msvc8', 'scripts')
        sys.path.insert(0, self.scripts)
        import audit, build, compare, objfuncs, ours, oracle_config  # noqa: E401
        self.audit, self.build, self.compare, self.objfuncs, self.ours = audit, build, compare, objfuncs, ours
        self.BUILD = oracle_config.BUILD
        self.SRC = os.path.join(self.BUILD, 'src')
        self.rows = audit.load_funcmap(os.path.join(oracle_config.ORACLE, 'evidence', 'funcmap.tsv'))
        self.ref, self.model = audit.load_context()
        self.syms = audit.sym_map(self.rows)
        self.quarantined = audit.load_quarantine(os.path.join(self.BUILD, 'quarantine.tsv'))
        # Trials are written as the tree spells them and translated as build.py translates
        # them (vc8_translate, with the per-tree state the last build left).
        import pickle
        import vc8_translate
        self.vt = vc8_translate
        state = pickle.load(open(os.path.join(self.BUILD, 'mirror.state.pkl'), 'rb'))[1]
        for name, value in zip(('THISCALL_FUNCS', 'THISCALL_PTRS', 'STRIP_CTORS', 'CONSTRUCT', 'THISCALL_DIRECT'), state):
            getattr(vc8_translate, name).clear()
            getattr(vc8_translate, name).update(value)
        vc8_translate.load_quarantine(os.path.join(self.BUILD, 'quarantine.tsv'))
        self.REPO = oracle_config.REPO
        self.by_tu = collections.defaultdict(list)
        for r in self.rows:
            self.by_tu[r[3]].append(r)
        self.rsp = os.path.join(self.BUILD, 'cl.rsp')

    def translate(self, tu, text):
        return self.vt.translate(text, tu + '.cpp')

    def judge(self, tu, objpath):
        """start -> (status, similarity) for every mapped function of tu, from one object."""
        fns = {}
        if objpath and os.path.exists(objpath):
            for k, f in enumerate(self.objfuncs.functions(objpath)):
                o = self.ours.OurFunc(tu, k, f)
                fns.setdefault(o.symbol, o)
        by_name = collections.defaultdict(list)
        for o in fns.values():
            by_name[o.name].append(o)
        out = {}
        for s, _e, name, _tu, sym, _m, _d in self.by_tu[tu]:
            f = fns.get(sym)
            if f is None and len(by_name.get(name, ())) == 1:
                f = by_name[name][0]
            if f is None:
                out[s] = ('MISSING', 0.0, None)
            elif self.quarantined.get((tu, name.rsplit('::', 1)[-1])) is not None:
                out[s] = ('QUARANTINE', 0.0, None)
            else:
                ov, rv = self.compare.our_view(f, self.syms), self.compare.ref_view(s, self.model[s])
                r = self.compare.compare(ov, rv)
                out[s] = (r.status, round(r.similarity, 4), (f, ov, rv))
        return out

    def register_only(self, judged):
        """An INSN_MATCH whose differing instructions differ in register names alone."""
        st, _sim, views = judged
        if st != 'INSN_MATCH' or views is None:
            return False
        _f, ov, rv = views
        for x, y in zip(ov, rv):
            if x.masked == y.masked:
                continue
            a, b = re.findall(r'\w+', x.text.lower()), re.findall(r'\w+', y.text.lower())
            if len(a) != len(b) or any(p != q and not (p in REGS and q in REGS) for p, q in zip(a, b)):
                return False
        return True

    def bh(self, start, size):
        b = bytearray(self.ref.pe.read(start, size))
        for ia, off, n, _kind, _t in self.model[start][1]:
            k = ia - start + off
            if 0 <= k < size:
                b[k:k + n] = b'\0' * n
        return '%d-%s' % (size, hashlib.sha256(bytes(b)).hexdigest()[:8])


class Compiler:
    """Trials compiled beside their TU's translated source, objects in a scratch directory."""

    def __init__(self, orc, jobs, scratch, batch=16):
        self.o, self.jobs, self.batch = orc, jobs, batch
        self.n = 0
        # Objects go outside the checkout, through wine's z: (the host's root).
        self.scratch = scratch
        os.makedirs(scratch, exist_ok=True)
        self.lock = open(os.path.join(orc.BUILD, '.build.lock'), 'w')
        self.tree = self.state()

    def state(self):
        """What every trial compiles against: the command line, the precompiled header, the
        translation. A checkout moved meanwhile (vc8-measure.sh update) makes the baselines
        stale, so the run stops rather than compare objects of two trees."""
        h = hashlib.sha256()
        for p in ('cl.rsp', os.path.join('pch', 'oracle.' + 'key'), 'mirror.' + 'key'):
            try:
                h.update(open(os.path.join(self.o.BUILD, p), 'rb').read())
            except OSError:
                h.update(b'-')
        return h.hexdigest()

    def run(self, trials):
        """trials: [(tu, text)] -> [object path or None], in order."""
        b = self.o.build
        groups = collections.defaultdict(list)
        paths = []
        for k, (tu, text) in enumerate(trials):
            self.n += 1
            src = os.path.join(self.o.SRC, os.path.dirname(tu), '%s__fp%d.cpp' % (os.path.basename(tu), self.n))
            with open(src, 'w', encoding='utf-8', errors='surrogateescape') as fh:
                fh.write(text)
            obj = os.path.join(self.scratch, os.path.basename(src)[:-4] + '.obj')
            paths.append((src, obj))
            groups[b.extra_flags(tu + '.cpp')].append(k)
        work = []
        for flags, ks in groups.items():
            for i in range(0, len(ks), self.batch):
                work.append((ks[i:i + self.batch], trials[ks[i]][0]))
        fcntl.flock(self.lock, fcntl.LOCK_EX)   # build.py's lock: no oracle build of this checkout meanwhile
        try:
            if self.state() != self.tree:
                raise SystemExit('the checkout changed under the run (a build or an update): start again')

            def one(item):
                ks, tu = item
                out = 'Z:' + os.path.realpath(self.scratch).replace('/', '\\') + '\\'
                cmd = b.cl_command(self.o.rsp, tu + '.cpp', out, [paths[k][0] for k in ks])
                try:
                    p = subprocess.run(cmd, capture_output=True, text=True, encoding='latin1', timeout=300 * len(ks))
                    if p.returncode not in (0, 137, -9) or 'error' in p.stdout:
                        name = os.path.basename(paths[ks[0]][0])[:-4]
                        with open(os.path.join(self.scratch, name + '.log'), 'w') as fh:
                            fh.write(p.stdout + p.stderr)
                except subprocess.TimeoutExpired:
                    pass
            with cf.ThreadPoolExecutor(self.jobs) as ex:
                list(ex.map(one, work))
        finally:
            fcntl.flock(self.lock, fcntl.LOCK_UN)
            # The trial sources never outlive the round, whatever happened in it.
            for src, _obj in paths:
                if os.path.exists(src):
                    os.remove(src)
        return [obj if os.path.exists(obj) and b.valid_object(obj) else None for _src, obj in paths]

    def drop(self, objs):
        for p in objs:
            if p and os.path.exists(p):
                os.remove(p)

    def close(self):
        # The compile logs of failed batches stay, for the report.
        for n in os.listdir(self.scratch):
            if n.endswith('.obj'):
                os.remove(os.path.join(self.scratch, n))


# ---------------------------------------------------------------------------------------

def function_span(text, start):
    """(def start, end) offsets of the definition after `// 1.14d: <start>` in a TU, or None."""
    m = re.search(r'^// 1\.14d: %08x\s*$' % start, text, re.M)
    if not m:
        return None
    i = text.index('\n', m.end() - 1) + 1 if text[m.end() - 1] != '\n' else m.end()
    j, depth, n = i, 0, len(text)
    while j < n:                                    # the body's opening brace, outside parentheses
        c = text[j]
        if text.startswith('//', j):
            j = text.find('\n', j)
            j = n if j < 0 else j
            continue
        if text.startswith('/*', j):
            j = text.find('*/', j) + 2
            continue
        if c in '"\'':
            j = skip_literal(text, j)
            continue
        if c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
        elif c == ';' and depth == 0:
            return None
        elif c == '{' and depth == 0:
            break
        j += 1
    k, level = j, 0
    while k < n:
        c = text[k]
        if text.startswith('//', k):
            k = text.find('\n', k)
            k = n if k < 0 else k
            continue
        if text.startswith('/*', k):
            k = text.find('*/', k) + 2
            continue
        if c in '"\'':
            k = skip_literal(text, k)
            continue
        if c == '{':
            level += 1
        elif c == '}':
            level -= 1
            if level == 0:
                return i, k + 1
        k += 1
    return None


def skip_literal(s, i):
    q, j = s[i], i + 1
    while j < len(s) and s[j] != q and s[j] != '\n':
        j += 2 if s[j] == '\\' else 1
    return j + 1


def tsx(args, cwd):
    p = subprocess.run(['npx', 'tsx', os.path.join(HERE, 'candidates.ts')] + args, cwd=cwd,
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit('candidates.ts failed: %s' % (p.stderr[-2000:]))


def splice(text, spans):
    """text with each (start, end) -> new text replaced (non-overlapping)."""
    out, at = [], 0
    for (a, b), new in sorted(spans.items()):
        out.append(text[at:a])
        out.append(new)
        at = b
    out.append(text[at:])
    return ''.join(out)


def externs(n):
    return ''.join('extern int fperm_phase_%d; ' % k for k in range(n))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--checkout', required=True)
    ap.add_argument('--snapshot', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--pool', help='audit.tsv the near-miss pool is read from (default: the checkout\'s)')
    ap.add_argument('--addrs', help='comma-separated targets instead of a pool sample')
    ap.add_argument('--sample', type=int, default=0)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--max-insns', type=int, default=100)
    ap.add_argument('--jobs', type=int, default=4)
    ap.add_argument('--max-anchors', type=int, default=16)
    ap.add_argument('--pair-top', type=int, default=3)
    ap.add_argument('--no-pairs', action='store_true')
    ap.add_argument('--no-phase', action='store_true')
    args = ap.parse_args()
    t0 = time.time()
    os.makedirs(args.out, exist_ok=True)
    gr = os.path.dirname(os.path.dirname(HERE))
    orc = Oracle(args.checkout)
    comp = Compiler(orc, args.jobs, os.path.join(os.path.abspath(args.out), 'obj'))
    trials_log = open(os.path.join(args.out, 'trials.tsv'), 'w')
    trials_log.write('target\ton\tform\ttarget_status\tsim\tgained\tlost\tnote\n')

    # -- the targets
    pool_path = args.pool or os.path.join(args.checkout, 'asm_matching', 'msvc8', 'evidence', 'audit.tsv')
    pool = []
    for line in open(pool_path).read().split('\n')[1:]:
        p = line.split('\t')
        if len(p) < 10 or p[4].startswith('lib') or p[3].startswith('libcmt') or not NEAR.match(p[9]):
            continue
        if int(p[5]) >= args.max_insns:
            continue
        pool.append((int(p[0], 16), p[2], p[3], p[9]))
    if args.addrs:
        want = {int(a, 16) for a in args.addrs.split(',')}
        targets = [x for x in pool if x[0] in want]
    else:
        targets = sorted(random.Random(args.seed).sample(pool, min(args.sample or len(pool), len(pool))))
    log('pool %d, targets %d' % (len(pool), len(targets)))

    # -- per target: its TU, its body and its helpers' bodies
    srcs = {}
    jobs = []           # one per target
    names = {s: (name, tu) for s, _e, name, tu, _sym, _m, _d in orc.rows}
    by_leaf = collections.defaultdict(dict)
    for s, _e, name, tu, _sym, _m, _d in orc.rows:
        by_leaf[tu].setdefault(name.rsplit('::', 1)[-1], s)
    snap_calls = {}
    want_addrs = {'%08x' % t[0] for t in targets}
    with open(os.path.join(args.snapshot, 'functions.ndjson')) as fh:
        for line in fh:
            i = line.find('"address":"')
            if i >= 0 and line[i + 11:i + 19] in want_addrs:
                r = json.loads(line)
                snap_calls[int(r['address'], 16)] = r.get('calledFunctions', [])
    for start, name, tu, status in targets:
        if tu not in srcs:
            srcs[tu] = None
            path = os.path.join(orc.REPO, tu + '.cpp')
            if os.path.exists(path):
                tree = open(path, encoding='utf-8', errors='surrogateescape').read()
                built = open(os.path.join(orc.SRC, tu + '.cpp'), encoding='utf-8', errors='surrogateescape').read()
                if orc.translate(tu, tree) == built:
                    srcs[tu] = tree
                else:
                    log('skip %s: its translation is not the one built' % tu)
        text = srcs[tu]
        span = function_span(text, start) if text else None
        if not span:
            log('skip %08x %s: no definition in %s' % (start, name, tu))
            continue
        helpers = []
        for callee in snap_calls.get(start, []):
            h = by_leaf[tu].get(callee)
            if h is not None and h != start and function_span(text, h):
                helpers.append(h)
        jobs.append(dict(start=start, name=name, tu=tu, status=status, span=span, helpers=sorted(set(helpers))))

    def fit(new, old):
        """new spread over old's line count where it can be: a quarantine names lines."""
        want, lines = old.count('\n'), new.split('\n')
        if len(lines) - 1 < want:
            return new + '\n' * (want - len(lines) + 1)
        while len(lines) - 1 > want and len(lines) > 1:
            tail = lines.pop()
            if '//' in lines[-1] or lines[-1].lstrip().startswith('#') or tail.lstrip().startswith('#'):
                lines.append(tail)
                break
            lines[-1] = lines[-1] + ' ' + tail.strip()
        return '\n'.join(lines)

    def trial_text(tu, bodies, prefix=None):
        """The TU with bodies {start: text} swapped in, prefix (start, text) put on the line
        of a definition, translated for VC8."""
        text = srcs[tu]
        spans = {}
        for st, b in bodies.items():
            sp = function_span(text, st)
            spans[sp] = fit(b, text[sp[0]:sp[1]])
        if prefix:
            a, _b = function_span(text, prefix[0])
            spans[(a, a)] = prefix[1]
        return orc.translate(tu, splice(text, spans))

    tus = sorted({j['tu'] for j in jobs})
    base_objs = comp.run([(tu, trial_text(tu, {})) for tu in tus])
    base = {tu: orc.judge(tu, o) for tu, o in zip(tus, base_objs)}
    comp.drop(base_objs)
    # Helpers count only where VC8 inlines them: a callee our object still calls keeps
    # its own body, and no form of it can change the target's bytes.
    sym_of = {s: sym for s, _e, _n, _tu, sym, _m, _d in orc.rows}
    for j in jobs:
        bt = base[j['tu']].get(j['start'])
        calls = set(bt[2][0].calls) if bt and bt[2] else set()
        j['helpers'] = [h for h in j['helpers'] if sym_of.get(h) not in calls]

    # -- candidates, and the bodies printed back unchanged
    on_fns = sorted({(j['tu'], s) for j in jobs for s in [j['start']] + j['helpers']})
    inp = [{'id': '%s|%08x' % (tu, s), 'text': srcs[tu][slice(*function_span(srcs[tu], s))]} for tu, s in on_fns]
    json.dump(inp, open(os.path.join(args.out, 'cand-in.json'), 'w'))
    t1 = time.time()
    tsx(['singles', os.path.join(args.out, 'cand-in.json'), os.path.join(args.out, 'cand-out.json'),
         '--types', os.path.join(args.snapshot, 'dataTypes.ndjson'),
         '--globals', os.path.join(args.snapshot, 'globals.ndjson'), '--max-anchors', str(args.max_anchors)], gr)
    cands = {r['id']: r for r in json.load(open(os.path.join(args.out, 'cand-out.json')))}
    log('candidates: %d functions, %d forms (%.0fs)' % (len(cands), sum(len(r['candidates']) for r in cands.values()),
                                                       time.time() - t1))

    rt_items, rt_jobs = [], []
    for j in jobs:
        ids = ['%s|%08x' % (j['tu'], s) for s in [j['start']] + j['helpers']]
        if any(cands[i].get('error') for i in ids):
            j['skip'] = 'parse: ' + '; '.join(cands[i]['error'] for i in ids if cands[i].get('error'))
            continue
        bodies = {s: cands['%s|%08x' % (j['tu'], s)]['roundtrip'] for s in [j['start']] + j['helpers']}
        rt_items.append((j['tu'], trial_text(j['tu'], bodies)))
        rt_jobs.append(j)
    rt_objs = comp.run(rt_items)
    for j, o in zip(rt_jobs, rt_objs):
        rt = orc.judge(j['tu'], o)
        b = base[j['tu']]
        diff = [s for s in b if (b[s][0], b[s][1]) != (rt.get(s, ('?', 0))[0], rt.get(s, ('?', 0))[1])]
        if diff:
            j['skip'] = 'printing the bodies back changes %d function(s), e.g. %08x' % (len(diff), diff[0])
        j['base'] = b[j['start']]
        if j['base'][0] == 'MATCH':
            j['skip'] = 'already MATCH in this checkout'
    comp.drop(rt_objs)

    # -- phase noise: register-tie-only targets, 1..63 dummy externs before the definition
    if not args.no_phase:
        scan = [j for j in jobs if 'skip' not in j and orc.register_only(j['base'])]
        items = [(j['tu'], trial_text(j['tu'], {}, (j['start'], externs(n)))) for j in scan for n in range(1, 64)]
        objs = comp.run(items)
        for k, j in enumerate(scan):
            hit = [n for n in range(1, 64) if orc.judge(j['tu'], objs[k * 63 + n - 1])[j['start']][0] == 'MATCH']
            if hit:
                j['skip'] = 'phase noise: MATCH with %d dummy externs' % hit[0]
            j['phase_scanned'] = True
        comp.drop(objs)
        log('phase scan: %d register-only, %d phase noise' % (len(scan), sum('phase noise' in j.get('skip', '') for j in scan)))

    live = [j for j in jobs if 'skip' not in j]
    for j in jobs:
        if 'skip' in j:
            log('skip %08x %s: %s' % (j['start'], j['name'], j['skip']))

    def run_trials(items):
        """items: [(job, on, form, bodies)] -> [(item, target status, sim, gained, lost)]"""
        objs = comp.run([(j['tu'], trial_text(j['tu'], bodies)) for j, _on, _f, bodies in items])
        res = []
        for it, o in zip(items, objs):
            j = it[0]
            b = base[j['tu']]
            if o is None:
                res.append((it, 'FAIL', 0.0, set(), set()))
                continue
            st = orc.judge(j['tu'], o)
            gained = {s for s in st if st[s][0] == 'MATCH' and b[s][0] != 'MATCH'}
            lost = {s for s in b if b[s][0] == 'MATCH' and st.get(s, ('MISSING',))[0] != 'MATCH'}
            lost |= {s for s in b if b[s][0] not in ('MISSING', 'QUARANTINE') and st.get(s, ('MISSING',))[0] in ('MISSING', 'QUARANTINE')}
            res.append((it, st[j['start']][0], st[j['start']][1], gained, lost))
        comp.drop(objs)
        return res

    def note(r, extra=''):
        (j, on, form, _b), ts, sim, gained, lost = r
        trials_log.write('%08x\t%08x\t%s\t%s\t%.4f\t%s\t%s\t%s\n' % (
            j['start'], on, '+'.join(form) if isinstance(form, tuple) else form, ts, sim,
            ','.join('%08x' % s for s in sorted(gained)), ','.join('%08x' % s for s in sorted(lost)), extra))

    # -- singles
    items = []
    for j in live:
        for on in [j['start']] + j['helpers']:
            for c in cands['%s|%08x' % (j['tu'], on)]['candidates']:
                items.append((j, on, c['form'], {on: c['text']}))
    t2 = time.time()
    res = run_trials(items)
    log('singles: %d trials (%.0fs)' % (len(items), time.time() - t2))
    accepted = []       # (job, on, forms tuple, gained, sim)
    best = collections.defaultdict(list)
    adds = {('%s|%08x' % (j['tu'], on), c['form']): c['adds'] for j in live for on in [j['start']] + j['helpers']
            for c in cands['%s|%08x' % (j['tu'], on)]['candidates']}
    for r in res:
        (j, on, form, bodies), ts, sim, gained, lost = r
        note(r)
        if ts == 'MATCH' and not lost:
            accepted.append(dict(job=j, on=on, forms=(form,), gained=gained, bodies=bodies))
        elif ts != 'FAIL' and not lost:
            best[j['start']].append((sim, on, form, bodies))

    # -- pairs, for targets no single form matched
    if not args.no_pairs:
        done = {a['job']['start'] for a in accepted}
        pair_items, apply_in = [], []
        for j in live:
            if j['start'] in done:
                continue
            singles = sorted(best[j['start']], key=lambda x: -x[0])
            top = [x for x in singles if x[0] > j['base'][1]][:args.pair_top]
            seen = set()
            for sim, on, form, bodies in top:
                for sim2, on2, form2, bodies2 in singles:
                    if (on2, form2) == (on, form) or frozenset([(on, form), (on2, form2)]) in seen:
                        continue
                    seen.add(frozenset([(on, form), (on2, form2)]))
                    if on2 != on:
                        pair_items.append((j, on, (form, form2), {**bodies, **bodies2}))
                    else:
                        fid = '%s|%08x' % (j['tu'], on)
                        apply_in.append(dict(id='%d|%s' % (len(apply_in), fid), text=srcs[j['tu']][slice(*function_span(srcs[j['tu']], on))],
                                             forms=[form, form2], job=j, on=on))
        if apply_in:
            json.dump([{k: v for k, v in a.items() if k in ('id', 'text', 'forms')} for a in apply_in],
                      open(os.path.join(args.out, 'apply-in.json'), 'w'))
            tsx(['apply', os.path.join(args.out, 'apply-in.json'), os.path.join(args.out, 'apply-out.json')], gr)
            for a, r in zip(apply_in, json.load(open(os.path.join(args.out, 'apply-out.json')))):
                if r['refused'] or len(r['applied']) != 2:
                    continue
                a['job'].setdefault('ord', {})[tuple(a['forms'])] = r['ord']
                pair_items.append((a['job'], a['on'], tuple(r['order']), {a['on']: r['text']}))
        t3 = time.time()
        res = run_trials(pair_items)
        log('pairs: %d trials (%.0fs)' % (len(pair_items), time.time() - t3))
        for r in res:
            (j, on, forms, bodies), ts, sim, gained, lost = r
            note(r, 'pair')
            if ts == 'MATCH' and not lost and j['start'] not in {a['job']['start'] for a in accepted}:
                accepted.append(dict(job=j, on=on, forms=forms, gained=gained, bodies=bodies))

    # -- phase control for forms that declare a name
    ctl = []
    for a in accepted:
        j = a['job']
        n = sum(adds.get(('%s|%08x' % (j['tu'], a['on']), f), 0) for f in a['forms'])
        if n:
            ctl.append((a, (j['tu'], trial_text(j['tu'], {}, (a['on'], externs(n))))))
    if ctl:
        objs = comp.run([x[1] for x in ctl])
        for (a, _t), o in zip(ctl, objs):
            st = orc.judge(a['job']['tu'], o) if o else {}
            if st.get(a['job']['start'], ('?',))[0] == 'MATCH':
                a['reject'] = 'phase: MATCH with dummy externs alone'
        comp.drop(objs)
    for a in accepted:
        if 'reject' in a:
            log('reject %08x %s: %s' % (a['job']['start'], a['forms'], a['reject']))
    accepted = [a for a in accepted if 'reject' not in a]
    # One tag set per target: the one with the most gains, singles before pairs, then fewest forms.
    pick = {}
    for a in accepted:
        k = a['job']['start']
        if k not in pick or (len(a['gained']), -len(a['forms'])) > (len(pick[k]['gained']), -len(pick[k]['forms'])):
            pick[k] = a
    accepted = sorted(pick.values(), key=lambda a: a['job']['start'])

    # -- all accepted tags of a TU together; drop the ones that conflict
    final, combined_gain = [], 0
    work = collections.defaultdict(list)
    for a in accepted:
        work[a['job']['tu']].append(a)
    for tu, al in work.items():
        # Two tag sets on one function cannot both be: the one with more gains stays.
        al.sort(key=lambda a: (-len(a['gained']), a['job']['start']))
        keep, on = [], set()
        for a in al:
            if not set(a['bodies']) & on:
                keep.append(a)
                on |= set(a['bodies'])
        work[tu] = keep
    done = {}
    for _round in range(6):
        todo = [tu for tu in work if tu not in done and work[tu]]
        if not todo:
            break
        objs = comp.run([(tu, trial_text(tu, {s: b for a in work[tu] for s, b in a['bodies'].items()})) for tu in todo])
        for tu, o in zip(todo, objs):
            b = base[tu]
            st = orc.judge(tu, o) if o else {}
            lost = {s for s in b if b[s][0] == 'MATCH' and st.get(s, ('MISSING',))[0] != 'MATCH'}
            miss = [a for a in work[tu] if st.get(a['job']['start'], ('?',))[0] != 'MATCH']
            if lost or miss:
                drop = miss[-1] if miss else work[tu][-1]
                work[tu].remove(drop)
                log('combined: %s drops %08x %s' % (tu, drop['job']['start'], drop['forms']))
            else:
                done[tu] = {s for s in st if st[s][0] == 'MATCH' and b[s][0] != 'MATCH'}
        comp.drop(objs)
    with open(os.path.join(args.out, 'combined.tsv'), 'w') as fh:
        fh.write('tu\ttag_sets\tgained\n')
        for tu, gained in sorted(done.items()):
            final += work[tu]
            combined_gain += len(gained)
            fh.write('%s\t%d\t%d\n' % (tu, len(work[tu]), len(gained)))

    # -- the tags, as Ghidra stores them
    tagged = sorted({a['on'] for a in final})
    json.dump(['%08x' % s for s in tagged], open(os.path.join(args.out, 'dh-in.json'), 'w'))
    tsx(['dh', args.snapshot, os.path.join(args.out, 'dh-in.json'), os.path.join(args.out, 'dh-out.json')], gr)
    dh = json.load(open(os.path.join(args.out, 'dh-out.json')))
    ev_out = open(os.path.join(args.out, 'evidence.tsv'), 'w')
    ev_out.write('addr\tname\tform\ttarget\tbefore\tafter\tgained\tlost\tcompiler\n')
    tags_out = open(os.path.join(args.out, 'tags.tsv'), 'w')
    tags_out.write('addr\tname\ttag\tgain\tlosses\tform\ttarget\tevidence\texisting\n')
    for a in final:
        j, on = a['job'], a['on']
        d = dh.get('%08x' % on)
        if d is None:
            log('no snapshot function at %08x' % on)
            continue
        ords = j.get('ord', {}).get(tuple(a['forms']), {}) if len(a['forms']) > 1 else {}
        for f in a['forms']:
            row = '%08x\t%s\t%s\t%08x\t%s\t%s\t%s\t%s\t%s' % (
                on, d['name'], f, j['start'], j['base'][0], 'MATCH',
                ','.join('%08x' % s for s in sorted(a['gained'])), '', 'vc8-sp1 ' + os.path.basename(args.checkout))
            ev_out.write(row + '\n')
            ev = hashlib.sha256(row.encode()).hexdigest()[:10]
            data = '%s;ev=%s;bh=%s;dh=%s' % (f, ev, orc.bh(on, d['size']), d['dh'])
            if f in ords:
                data += ';ord=%d' % ords[f]
            tags_out.write('%08x\t%s\tvc8form:%s\t%d\t0\t%s\t%08x\t%s->MATCH\t%s\n' % (
                on, d['name'], data, len(a['gained']), f.split('(')[0], j['start'], j['base'][0], len(d['tags'])))
    tags_out.close()
    ev_out.close()
    # The bodies the accepted tags printed, for verify_gen.py to hold the generator's against.
    json.dump({'%08x' % s: b for a in final for s, b in a['bodies'].items()},
              open(os.path.join(args.out, 'bodies.json'), 'w'), indent=0)
    trials_log.close()
    comp.close()

    n_single = sum(1 for a in final if len(a['forms']) == 1)
    lines = [
        'targets %d, skipped %d (%s)' % (len(jobs), len(jobs) - len(live),
                                          ', '.join('%s %d' % kv for kv in collections.Counter(
                                              j['skip'].split(':')[0] for j in jobs if 'skip' in j).items())),
        'targets reaching MATCH alone: %d (singles %d, pairs %d)' % (len(accepted), sum(len(a['forms']) == 1 for a in accepted),
                                                                    sum(len(a['forms']) > 1 for a in accepted)),
        'kept together: %d tag sets (%d single), MATCH gained together %d' % (len(final), n_single, combined_gain),
        'wall %.0fs, %.1fs per target, %d compiles' % (time.time() - t0, (time.time() - t0) / max(1, len(jobs)), comp.n),
    ]
    open(os.path.join(args.out, 'summary.txt'), 'w').write('\n'.join(lines) + '\n')
    for l in lines:
        log(l)


if __name__ == '__main__':
    main()
