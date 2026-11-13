/**
 * A small generated-plus-hand repository for the hand-follow golden tests: source/regen holds
 * the "generator output", source/modified adds a hand delta of every hunk shape, and branch
 * `work` sits on source/modified for simulate. Commits use fixed identities and dates, so the
 * SHAs in the inventory are the same on every machine.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'commit.gpgsign',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'core.autocrlf',
  GIT_CONFIG_VALUE_1: 'false',
};

/** process.env with GIT_ENV applied, for the git commands the tool itself runs. */
export function withGitEnv<T>(fn: () => T): T {
  const saved = new Map(Object.keys(GIT_ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, GIT_ENV);
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** e-acute, kept out of the source as a literal */
const E = String.fromCharCode(0xe9);

function git(repo: string, ...args: string[]): void {
  const r = spawnSync('git', ['-C', repo, ...args], { env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

const ALPHA_BASE = `#include "Alpha.h"

namespace D2 {
namespace Alpha {

// Plate comment for One
// that spans two lines
// 1.14d: 00401000
int __stdcall One(int a)
{
    const char* s = "{ not a brace";
    if (a > 0) {
        return a + 1;
    }
    return 0;
}

// 1.14d: 00401020
static int Two(int b);

// 1.14d: 0x401040
int Three(int c)
{
#if defined(X)
    if (c) {
#else
    if (!c) {
#endif
        c += 2;
    }
    auto r = R"x(}{)x";
    return c * 3;
}

// Plate with a raw byte: \xe9t\xe9
// 1.14d: 00401080
void Four()
{
    /* { block */
    char q = '{';
    Two(1);
    Two(2);
    Two(3);
    Two(4);
}

}  // namespace Alpha
}  // namespace D2
`;

const ALPHA_HEAD = ALPHA_BASE
  .replace('#include "Alpha.h"\n', '#include "Alpha.h"\n#include <cstring>\n')
  .replace('    if (a > 0) {\n', `    a ^= 1; // hand fix ${E}\n    if (a > 0) {\n`)
  .replace('    return 0;\n}\n\n// 1.14d: 00401020', '    return 0;\n} // end of One\n// 1.14d: 00401020')
  .replace('    return c * 3;\n', '    return c * 3 + kHandBias;\n')
  .replace('    Two(3);\n', '')
  .replace('}  // namespace Alpha', '// 1.14d: 00401100\nint Five() { return 5; }\n\n}  // namespace Alpha');

const BETA_BASE = `#include "Beta.h"

namespace D2 {
namespace Beta {

static int s_counter;

// 1.14d: 00402000
int Six(int x)
{
    s_counter += x;
    return s_counter;
}

// 1.14d: 00402040
int Seven(int y)
{
    int t = y * 2;
    t += 1;
    t += 2;
    t += 3;
    t += 4;
    t += 5;
    t += 6;
    t += 7;
    t += 8;
    t += 9;
    return t;
}

}  // namespace Beta
}  // namespace D2
`;

const BETA_HEAD = BETA_BASE
  .replace('#include "Beta.h"\n', '#include "Beta.h"\n#include "Hand.h"\n')
  .replace('    t += 5;\n', '    t += 5 + s_counter + Alpha::kHandBias;\n')
  .replace('    t += 9;\n', '    t += HandHelper(t);\n');

const CRLF_BASE = [
  '#include "Crlf.h"',
  '\x0c',
  'namespace D2 {',
  '',
  '// 1.14d: 00403000',
  'int Eight()',
  '{',
  '    int v = 8;',
  '    return v;',
  '}',
  '',
  '}  // namespace D2',
  '',
].join('\r\n');

const CRLF_HEAD = CRLF_BASE.replace('    return v;', '    v += 1; // hand\r\n    return v;');

const FILES_BASE: Record<string, string | Buffer> = {
  'Source/A/Alpha.cpp': Buffer.from(ALPHA_BASE, 'latin1'),
  'Source/A/Alpha.h': '#pragma once\n',
  'Source/B/Beta.cpp': BETA_BASE,
  'Source/B/Beta.h': '#pragma once\n',
  'Source/C/Crlf.cpp': CRLF_BASE,
  'Source/C/Crlf.h': '#pragma once\r\n',
  'README.md': 'generated\n',
};

const FILES_HEAD: Record<string, string | Buffer> = {
  'Source/A/Alpha.cpp': Buffer.concat(ALPHA_HEAD.split(`${E}t${E}`).flatMap((p, i) =>
    i ? [Buffer.from('\xe9t\xe9', 'latin1'), Buffer.from(p, 'utf8')] : [Buffer.from(p, 'utf8')])),
  'Source/B/Beta.cpp': BETA_HEAD,
  'Source/C/Crlf.cpp': CRLF_HEAD,
  'Source/B/Hand.h': '#pragma once\nint HandHelper(int);\n',
  'README.md': 'generated, and a hand note\n',
};

function put(repo: string, files: Record<string, string | Buffer>): void {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
  }
  git(repo, 'add', '--', ...Object.keys(files));
}

/** Builds the fixture repository in an empty directory `repo`. */
export function buildFixture(repo: string): void {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'source/regen');
  put(repo, FILES_BASE);
  git(repo, 'commit', '-q', '-m', 'regen: fixture');
  git(repo, 'checkout', '-q', '-b', 'source/modified');
  put(repo, FILES_HEAD);
  git(repo, 'commit', '-q', '-m', 'fix: hand delta');
  git(repo, 'checkout', '-q', '-b', 'work');
}

/** The maps the plan and simulate goldens use: a function move and a case-mismatched rename. */
export function writeMaps(dir: string): { fnMap: string; pathMap: string } {
  fs.mkdirSync(dir, { recursive: true });
  const fnMap = path.join(dir, 'fn-map.tsv');
  const pathMap = path.join(dir, 'path-map.tsv');
  fs.writeFileSync(fnMap, '00402040\tSource/A/Alpha.cpp\n0x403000\tsource/c/Crlf.cpp\n');
  fs.writeFileSync(pathMap, 'old\tnew\nSource/C/Crlf.cpp\tsource/c/Gamma.cpp\n');
  return { fnMap, pathMap };
}

export type Exec = (argv: string[]) => { code: number; stdout: string };

/**
 * Every subcommand once over a fresh fixture: inventory, plan from maps, plan from a tree,
 * audit, reapply, simulate. Returns published path -> content, with the temp paths replaced
 * by <TREE> and <OUT> so the result compares across machines.
 */
export function runScenario(root: string, exec: Exec): Map<string, string> {
  const repo = path.join(root, 'repo');
  const out = path.join(root, 'out');
  buildFixture(repo);
  const { fnMap, pathMap } = writeMaps(path.join(root, 'maps'));
  const inv = path.join(out, 'inv', 'hand-inventory.json');
  const plan = path.join(out, 'plan');
  const maps = ['--fn-map', fnMap, '--path-map', pathMap];
  const steps: [string, string[]][] = [
    ['inventory', ['inventory', '--tree', repo, '--base', 'source/regen', '--head', 'source/modified', '-o', path.join(out, 'inv')]],
    ['plan', ['plan', '--inventory', inv, ...maps, '-o', plan]],
    ['plan-tree', ['plan', '--inventory', inv, '--fn-map-tree', repo, '-o', path.join(out, 'plan-tree')]],
    ['audit', ['audit', '--inventory', inv, '--tree', repo, '--plan', plan, '-o', path.join(out, 'audit')]],
    ['reapply', ['reapply', '--inventory', inv, '--tree', repo, '-o', path.join(out, 'reapply')]],
    ['simulate', ['simulate', '--inventory', inv, '--plan', plan, '--worktree', repo, ...maps, '--tag', 'gold', '-o', path.join(out, 'sim')]],
  ];
  const res = new Map<string, string>();
  const clean = (s: string) => {
    for (const [dir, label] of [[repo, '<TREE>'], [out, '<OUT>'], [root, '<ROOT>']]) {
      // JSON doubles Windows backslashes; match that spelling before the raw path.
      s = s.split(JSON.stringify(dir).slice(1, -1)).join(label).split(dir).join(label);
    }
    return s;
  };
  for (const [name, argv] of steps) {
    const r = exec(argv);
    res.set(`${name}.stdout`, clean(`exit ${r.code}\n${r.stdout}`));
  }
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else res.set(path.relative(out, p), clean(fs.readFileSync(p).toString('latin1')));
    }
  };
  walk(out);
  return res;
}
