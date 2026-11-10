#!/usr/bin/env python3
"""verify_gen.py - does the real generator print what the permuter measured?

    verify_gen.py --snapshot SNAP --run OUT [--gr GR] [--project-json PATH] [--overrides DIR]

permute.py applies each form to the function as the tree prints it. The generator applies
a tag to its own AST of the snapshot's decompile, with the function's other tags, in its
own order. This adds OUT/tags.tsv to a copy of the snapshot (a tag of the same form text
already there is replaced), runs one offline codegen of it (packages/live codegen-run.js,
the daemon's child process), and compares every tagged function's generated body with
OUT/bodies.json in the namespace-free token form `dh` hashes. A function that differs
means the tag does not reproduce the measured body under the generator: drop it, or
measure it again on a tree the generator printed with it.

One codegen is a heavy job (minutes, several cores): one at a time on the machine.
Writes OUT/verify-gen.tsv: addr, name, same|differs|missing.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def token_form(text):
    """Tokens one space apart, qualifiers dropped, comments gone: what decides equal bodies."""
    text = re.sub(r'//[^\n]*|/\*.*?\*/', ' ', text, flags=re.S)
    toks = re.findall(r'"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'|[A-Za-z_$][\w$]*|\d[\w.]*|::|\S', text)
    out, k = [], 0
    while k < len(toks):
        if k + 1 < len(toks) and toks[k + 1] == '::' and re.match(r'[A-Za-z_]', toks[k]):
            k += 2
            continue
        if toks[k] == '::':
            k += 1
            continue
        out.append(toks[k])
        k += 1
    return ' '.join(out)


def body_at(tree, addr):
    """The definition after `// 1.14d: addr` in any .cpp of the generated tree."""
    pat = re.compile(r'^// 1\.14d: %s\s*$' % addr, re.M)
    sys.path.insert(0, HERE)
    from permute import function_span
    for root, _d, files in os.walk(tree):
        for f in files:
            if not f.endswith('.cpp'):
                continue
            text = open(os.path.join(root, f), encoding='utf-8', errors='surrogateescape').read()
            if pat.search(text):
                sp = function_span(text, int(addr, 16))
                if sp:
                    return text[sp[0]:sp[1]]
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--snapshot', required=True)
    ap.add_argument('--run', required=True, help='a permute.py output directory')
    ap.add_argument('--gr', default='/Users/jaenster/code/ts/gr-daemon', help='ghidra-reconstruct checkout with packages/live built')
    ap.add_argument('--project-json', default='/Users/jaenster/code/re/diablo2/recon/project.json')
    ap.add_argument('--overrides', default='/Users/jaenster/code/ts/gr-daemon/overrides')
    args = ap.parse_args()
    run = os.path.abspath(args.run)
    tags = {}
    for line in open(os.path.join(run, 'tags.tsv')).read().split('\n')[1:]:
        p = line.split('\t')
        if len(p) > 2:
            tags.setdefault(p[0], []).append(p[2][len('vc8form:'):])
    bodies = json.load(open(os.path.join(run, 'bodies.json')))
    work = os.path.join(run, 'verify-gen')
    snap, proj, tree = os.path.join(work, 'snap'), os.path.join(work, 'genproj', 'project'), os.path.join(work, 'tree')
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(snap)
    os.makedirs(proj)
    os.symlink(args.overrides, os.path.join(work, 'genproj', 'overrides'))
    os.symlink(args.project_json, os.path.join(proj, 'project.json'))
    for f in os.listdir(args.snapshot):
        if f != 'functions.ndjson':
            shutil.copy(os.path.join(args.snapshot, f), snap)
    pending = dict(tags)
    with open(os.path.join(args.snapshot, 'functions.ndjson')) as src, open(os.path.join(snap, 'functions.ndjson'), 'w') as out:
        for line in src:
            i = line.find('"address":"')
            a = line[i + 11:i + 19] if i >= 0 else None
            if a in pending:
                d = json.loads(line)
                t = d.setdefault('tags', [])
                for data in pending.pop(a):
                    form = data.split(';ev=')[0]
                    t[:] = [x for x in t if not (x.get('type') == 'vc8form' and x.get('data', '').split(';ev=')[0] == form)]
                    t.append({'type': 'vc8form', 'data': data})
                line = json.dumps(d, separators=(',', ':')) + '\n'
            out.write(line)
    if pending:
        print('not in the snapshot:', ' '.join(sorted(pending)))
    env = dict(os.environ, RECON_CHILD_PROJECT_DIR=proj, RECON_CHILD_OUTPUT_DIR=tree, RECON_CHILD_SNAPSHOT_DIR=snap)
    with open(os.path.join(work, 'codegen.log'), 'w') as lg:
        rc = subprocess.run(['node', '--stack-size=8192', os.path.join(args.gr, 'packages', 'live', 'dist', 'codegen-run.js')],
                            env=env, stdout=lg, stderr=subprocess.STDOUT).returncode
    if rc != 0:
        raise SystemExit('codegen failed (%d): %s' % (rc, os.path.join(work, 'codegen.log')))
    same = 0
    with open(os.path.join(run, 'verify-gen.tsv'), 'w') as fh:
        fh.write('addr\tverdict\n')
        for a, want in sorted(bodies.items()):
            got = body_at(tree, a)
            # Bodies only: the measured one is the oracle's translation (a __thiscall
            # signature gains a parameter there), the body is line for line the tree's.
            v = 'missing' if got is None else 'same' if token_form(got[got.find('{'):]) == token_form(want[want.find('{'):]) else 'differs'
            same += v == 'same'
            fh.write('%s\t%s\n' % (a, v))
    print('%d of %d tagged bodies as measured' % (same, len(bodies)))


if __name__ == '__main__':
    main()
