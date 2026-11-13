/**
 * hand-follow golden tests. The goldens under fixtures/hand-follow/scenario were written by
 * the Python tools/hand-follow.py this module replaces (redivivus 3f584b7fb), over the
 * fixture repository of hand-follow-fixture.ts; the TypeScript port must reproduce every
 * file and every line of output byte for byte. difflib-cases.json holds CPython's
 * difflib.unified_diff output for the cases the lift and drop patches depend on.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '../hand-follow/cli.js';
import { unifiedDiff } from '../hand-follow/difflib.js';
import { ExitError, scan } from '../hand-follow/hand-follow.js';
import { decodeSE, encodeSE, pyJson, splitlines, strip } from '../hand-follow/pystr.js';
import { runScenario, withGitEnv } from './hand-follow-fixture.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hand-follow');

function goldens(dir: string, rel = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const p = path.join(rel, e.name);
    if (e.isDirectory()) for (const [k, v] of goldens(dir, p)) out.set(k, v);
    else out.set(p, fs.readFileSync(path.join(dir, p)).toString('latin1'));
  }
  return out;
}

test('every subcommand matches the Python goldens byte for byte', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-test-'));
  try {
    const res = withGitEnv(() =>
      runScenario(root, (argv) => {
        const lines: string[] = [];
        let code: number;
        try {
          code = main(argv, (s) => lines.push(s));
        } catch (e) {
          if (!(e instanceof ExitError)) throw e;
          return { code: e.code, stdout: lines.map((l) => l + '\n').join('') + `[stderr]\n${e.message}\n` };
        }
        // the log carries decoded text; the goldens are raw bytes read as latin1
        return { code, stdout: encodeSE(lines.map((l) => l + '\n').join('')).toString('latin1') };
      }),
    );
    const want = goldens(path.join(FIX, 'scenario'));
    assert.deepEqual([...res.keys()].sort(), [...want.keys()].sort());
    for (const [k, v] of want) assert.equal(res.get(k), v, k);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unified_diff matches CPython difflib, autojunk included', () => {
  const cases = JSON.parse(fs.readFileSync(path.join(FIX, 'difflib-cases.json'), 'utf8')) as
    { a: string[]; b: string[]; diff: string }[];
  for (const [i, c] of cases.entries()) assert.equal(unifiedDiff(c.a, c.b, 'a/x', 'b/x', 3), c.diff, `case ${i}`);
});

test('surrogateescape round-trips bytes that are not UTF-8', () => {
  const raw = Buffer.from([0x61, 0xe9, 0x74, 0xc3, 0xa9, 0xe2, 0x82, 0x41, 0xf0, 0x9f, 0x98, 0x80, 0xff]);
  const s = decodeSE(raw);
  assert.equal(s, 'a\udce9té\udce2\udc82A\u{1f600}\udcff');
  assert.deepEqual(encodeSE(s), raw);
  assert.throws(() => encodeSE(s, 'strict'));
  assert.equal(pyJson(s), '"a\\udce9t\\u00e9\\udce2\\udc82A\\ud83d\\ude00\\udcff"');
});

test('splitlines and strip follow str, not JavaScript', () => {
  assert.deepEqual(splitlines('a\r\nb\x0cc\rd\x1ce\n', true), ['a\r\n', 'b\x0c', 'c\r', 'd\x1c', 'e\n']);
  assert.deepEqual(splitlines('a\n\nb'), ['a', '', 'b']);
  assert.equal(strip('\x1f﻿x \x85'), '﻿x');
});

test('scan finds bodies, declarations and plate comments', () => {
  const src = [
    'namespace N {', '// plate', '// 1.14d: 401000', 'int F() {', '  const char* s = "}";', '}',
    '// 1.14d: 00401010', 'int G();', 'extern "C" {', '// 1.14d: 00401020', 'void H()', '{', '#if A',
    '  if (x) {', '#else', '  if (y) {', '#endif', '  }', '}', '}', '}',
  ].map((l) => l + '\n');
  const fns = scan(src).map((f) => [f.addr, f.start, f.marker, f.body, f.end, f.ns, f.name]);
  assert.deepEqual(fns, [
    ['00401000', 1, 2, 3, 5, 'N', 'F'],
    ['00401010', 6, 6, null, 7, 'N', ''],
    ['00401020', 9, 9, 11, 18, 'N', 'H'],
  ]);
});
