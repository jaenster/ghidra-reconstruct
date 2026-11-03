/**
 * Foreign sources (hand-written code built beside the tree) are read from the
 * committed HEAD of the work tree that holds them, and named by a fingerprint.
 *
 * Before, the working tree was read: a half-finished edit in recon/modified/support
 * reached a generation, a batch regen and the live daemon could read different
 * inputs, and nothing recorded which input a tree was generated from.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readForeignSources, readForeignSourcesAt, foreignSourcesFingerprint } from '../codegen/file-static-functions.js';

function repo(): { dir: string; git: (...args: string[]) => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-head-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(dir, 'support'));
  fs.writeFileSync(path.join(dir, 'support', 'control.cpp'), 'void f() { ENGINE_Step(); }\n');
  fs.writeFileSync(path.join(dir, 'support', 'notes.txt'), 'not source\n');
  fs.writeFileSync(path.join(dir, 'README'), 'outside\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'one');
  return { dir, git };
}

test('the committed text is read, not an edit in the working tree', () => {
  const { dir } = repo();
  fs.writeFileSync(path.join(dir, 'support', 'control.cpp'), 'void f() { ENGINE_Other(); }\n');
  fs.writeFileSync(path.join(dir, 'support', 'untracked.cpp'), 'void g() { ENGINE_New(); }\n');
  const read = readForeignSources([{ path: path.join(dir, 'support') }], dir);
  assert.deepStrictEqual(read.map(r => path.basename(r.path)), ['control.cpp']);
  assert.match(read[0].text, /ENGINE_Step/);
});

test('the fingerprint moves with a commit to the sources and not with any other commit', () => {
  const { dir, git } = repo();
  const entries = [{ path: path.join(dir, 'support') }];
  const first = foreignSourcesFingerprint(entries, dir);
  assert.equal(readForeignSourcesAt(entries, dir).fingerprint, first);

  // Elsewhere in the tree - the daemon's own merge commit is this case.
  fs.writeFileSync(path.join(dir, 'README'), 'changed\n');
  git('commit', '-q', '-am', 'elsewhere');
  assert.equal(foreignSourcesFingerprint(entries, dir), first);

  // An uncommitted edit is not an input.
  fs.writeFileSync(path.join(dir, 'support', 'control.cpp'), 'void f() { ENGINE_Other(); }\n');
  assert.equal(foreignSourcesFingerprint(entries, dir), first);

  git('commit', '-q', '-am', 'support');
  const second = foreignSourcesFingerprint(entries, dir);
  assert.notEqual(second, first);
  assert.equal(readForeignSourcesAt(entries, dir).fingerprint, second);
  assert.match(readForeignSources(entries, dir)[0].text, /ENGINE_Other/);
});

test('a single committed file is read as given', () => {
  const { dir } = repo();
  const read = readForeignSources([{ path: path.join(dir, 'support', 'control.cpp'), addressBase: '0x400000' }], dir);
  assert.equal(read.length, 1);
  assert.equal(read[0].addressBase, 0x400000);
});

test('a path not committed at HEAD is an error, not an empty input', () => {
  const { dir } = repo();
  fs.mkdirSync(path.join(dir, 'later'));
  fs.writeFileSync(path.join(dir, 'later', 'x.cpp'), 'int x;\n');
  assert.throws(() => readForeignSources([{ path: path.join(dir, 'later') }], dir), /not committed/);
});
