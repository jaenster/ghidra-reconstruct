import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
const cwd = fileURLToPath(new URL('../../../../', import.meta.url));

function run(args: string[]) {
  const child = spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], {
    cwd, encoding: 'utf8', timeout: 30_000, windowsHide: true,
  });
  assert.ifError(child.error);
  return child;
}

describe('ratchet CLI process entry', () => {
  it('runs the command and propagates its nonzero exit status', () => {
    const child = run(['not-a-command']);
    assert.equal(child.status, 2, child.stderr);
    assert.match(child.stderr, /usage: ratchet/);
  });

  it('captures a pin when invoked with native paths containing spaces', () => {
    const root = mkdtempSync(join(tmpdir(), 'ratchet CLI '));
    try {
      const tree = join(root, 'source tree');
      const store = join(root, 'body store');
      mkdirSync(join(tree, 'Source'), { recursive: true });
      writeFileSync(join(tree, 'Source', 'Unit.cpp'), `namespace Game {
// 1.14d: 00401000
int Increment(int nValue) { return nValue + 1; }
}
`);
      const child = run(['pin', '--tree', tree, '--store', store, '00401000', '--note', 'CLI fixture']);
      assert.equal(child.status, 0, child.stderr);
      assert.match(child.stdout, /pinned\t00401000\tGame::Increment/);
      const record = JSON.parse(readFileSync(join(store, 'fn', '00401000.json'), 'utf8'));
      assert.equal(record.kind, 'pin');
      assert.equal(record.address, '00401000');
      assert.equal(record.note, 'CLI fixture');
      assert.match(record.members[0].text, /return nValue \+ 1/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('can be imported without starting a command', () => {
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval',
      `const cli = await import(${JSON.stringify(new URL('./cli.ts', import.meta.url).href)}); console.log(typeof cli.main);`,
    ], { cwd, encoding: 'utf8', timeout: 30_000, windowsHide: true });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), 'function');
    assert.equal(child.stderr, '');
  });
});
