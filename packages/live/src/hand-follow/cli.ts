#!/usr/bin/env node
/**
 * hand-follow: carry source/modified's hand delta through regens that move functions.
 *
 *   hand-follow inventory [--base source/regen] [--head HEAD] [--tree DIR] [--exclude SPEC]... -o OUT
 *       Every hunk of `git diff -U0 base head` over generated files, attributed to the
 *       function it sits in (plate comment + marker + body), or file-level, or
 *       multi-function. Writes OUT/hand-inventory.tsv and OUT/hand-inventory.json.
 *       --tree defaults to the current directory.
 *
 *   hand-follow plan --inventory J [--clusters TSV] [--fn-map TSV] [--fn-map-tree DIR]
 *                    [--layout TSV] [--path-map TSV] -o OUT
 *       Where every hunk goes. Writes OUT/move-plan.tsv, OUT/review.tsv, OUT/git-mv.sh (pure
 *       renames, one commit, no content), OUT/lift.patch (the hand hunks of functions that
 *       change TU, taken out of their old file; applies after git-mv.sh and before the regen
 *       merge) and OUT/summary.txt.
 *
 *   hand-follow reapply --inventory J --tree DIR [--plan OUT] [--apply] -o OUT
 *       After the merge: every function-level hunk that is no longer in its function is put
 *       back at the same spot of that function, wherever the function now lives. Writes
 *       OUT/drop.patch and OUT/reapply.tsv; --apply also writes the files.
 *
 *   hand-follow audit --inventory J --tree DIR [--plan OUT] [--name audit.tsv] -o OUT
 *       Per hunk: present / missing / reverted / duplicated, checked inside the function it
 *       belongs to, by content. Exit 1 when anything is not present.
 *
 *   hand-follow simulate --inventory J --plan OUT --worktree WT [--tag sim] [maps] -o OUT
 *       Rehearsal on a scratch worktree: fakes the codegen side of the moves on a branch
 *       cut from the inventory base, runs git-mv.sh and lift.patch on a branch cut from the
 *       inventory head, merges, reapplies and audits; and the same merge without the tool
 *       as the control. Refuses a worktree on a source/* or master branch.
 *
 * Deploy order with a real regen that carries moves:
 *   inventory, plan, git-mv.sh, git apply --index lift.patch + commit, merge the regen,
 *   reapply --apply + commit, audit.
 */
import { fileURLToPath } from 'node:url';
import { encodeSE } from './pystr.js';
import { ExitError, cmdAudit, cmdInventory, cmdPlan, cmdReapply, cmdSimulate } from './hand-follow.js';

type Spec = Record<string, { kind: 'value' | 'flag' | 'append'; required?: boolean; def?: string }>;

const MAPS: Spec = {
  inventory: { kind: 'value', required: true },
  clusters: { kind: 'value' },
  'fn-map': { kind: 'value' },
  layout: { kind: 'value' },
  'path-map': { kind: 'value' },
  out: { kind: 'value', required: true },
};

function specs(): Record<string, Spec> {
  return {
    inventory: {
      tree: { kind: 'value', def: process.cwd() },
      base: { kind: 'value', def: 'source/regen' },
      head: { kind: 'value', def: 'HEAD' },
      exclude: { kind: 'append' },
      out: { kind: 'value', required: true },
    },
    plan: { ...MAPS, 'fn-map-tree': { kind: 'value' } },
    simulate: {
      ...MAPS,
      plan: { kind: 'value', required: true },
      worktree: { kind: 'value', required: true },
      tag: { kind: 'value', def: 'sim' },
    },
    reapply: {
      inventory: { kind: 'value', required: true },
      tree: { kind: 'value', required: true },
      plan: { kind: 'value' },
      apply: { kind: 'flag' },
      out: { kind: 'value', required: true },
    },
    audit: {
      inventory: { kind: 'value', required: true },
      tree: { kind: 'value', required: true },
      plan: { kind: 'value' },
      name: { kind: 'value', def: 'audit.tsv' },
      out: { kind: 'value', required: true },
    },
  };
}

/** argparse-style options: --name value, --name=value, -o value, unique prefixes. */
export function parseArgs(argv: string[]): { cmd: string; opts: Record<string, unknown> } {
  const all = specs();
  const cmd = argv[0];
  const spec = all[cmd];
  if (!spec) throw new ExitError(`usage: hand-follow {${Object.keys(all).join(',')}} ...`, 2);
  const opts: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(spec)) {
    if (s.kind === 'flag') opts[k] = false;
    else if (s.def !== undefined) opts[k] = s.def;
  }
  for (let i = 1; i < argv.length; i++) {
    let arg = argv[i];
    let val: string | undefined;
    let name: string;
    if (arg === '-o' || (arg.startsWith('-o') && !arg.startsWith('--'))) {
      name = 'out';
      if (arg.length > 2) val = arg.slice(2);
    } else if (arg.startsWith('--')) {
      arg = arg.slice(2);
      const eq = arg.indexOf('=');
      if (eq >= 0) (val = arg.slice(eq + 1)), (arg = arg.slice(0, eq));
      const hits = Object.keys(spec).filter((k) => k === arg || k.startsWith(arg));
      const exact = hits.includes(arg) ? [arg] : hits;
      if (exact.length !== 1) throw new ExitError(`hand-follow ${cmd}: unrecognized or ambiguous option --${arg}`, 2);
      name = exact[0];
    } else throw new ExitError(`hand-follow ${cmd}: unexpected argument ${arg}`, 2);
    const s = spec[name];
    if (s.kind === 'flag') {
      opts[name] = true;
      continue;
    }
    if (val === undefined) {
      if (i + 1 >= argv.length) throw new ExitError(`hand-follow ${cmd}: --${name} expects a value`, 2);
      val = argv[++i];
    }
    if (s.kind === 'append') ((opts[name] ??= []) as string[]).push(val);
    else opts[name] = val;
  }
  for (const [k, s] of Object.entries(spec)) {
    if (s.required && opts[k] === undefined) throw new ExitError(`hand-follow ${cmd}: --${k} is required`, 2);
  }
  // fn-map -> fn_map, path-map -> path_map, fn-map-tree -> fn_map_tree
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(opts)) out[k.split('-').join('_')] = v;
  return { cmd, opts: out };
}

export function main(argv: string[], log: (s: string) => void = (s) => process.stdout.write(encodeSE(s + '\n'))): number {
  const { cmd, opts } = parseArgs(argv);
  const o = opts as never;
  switch (cmd) {
    case 'inventory':
      return cmdInventory(o, log);
    case 'plan':
      return cmdPlan(o, log);
    case 'reapply':
      return cmdReapply(o, log);
    case 'audit':
      return cmdAudit(o, log);
    default:
      return cmdSimulate(o, log);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // under `pnpm hand-follow`, paths are relative to where the command was typed
  if (process.env.INIT_CWD) process.chdir(process.env.INIT_CWD);
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof ExitError)) throw e;
    process.stderr.write(e.message + '\n');
    process.exitCode = e.code;
  }
}
