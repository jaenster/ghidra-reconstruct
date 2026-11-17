import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { mapDrive, oracleDrive } from './vc8-verify.js';

/** A checkout with an oracle root whose env.sh maps drive `r` the way the real one does. */
function fixture(): { root: string; repo: string; prefix: string; link: string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vc8-drive-')));
  const repo = path.join(dir, 'checkout');
  const root = path.join(repo, 'asm_matching', 'msvc8');
  const prefix = path.join(dir, 'wine');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(prefix, 'dosdevices'), { recursive: true });
  // map_drive as asm_matching/msvc8/scripts/env.sh has it.
  fs.writeFileSync(path.join(root, 'scripts', 'env.sh'), `
ORACLE_ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$ORACLE_ROOT/../.." && pwd)"
export WINEPREFIX="${prefix}"
: "\${ORACLE_DRIVE:=r}"
map_drive() {
    local link="$WINEPREFIX/dosdevices/\${ORACLE_DRIVE}:"
    if [ -L "$link" ]; then
        [ "$(readlink -f "$link")" = "$REPO_ROOT" ] && return 0
        return 1
    fi
    ln -s "$REPO_ROOT" "$link"
}
`);
  return { root, repo, prefix, link: path.join(prefix, 'dosdevices', 'r:') };
}

/** n vc8.sh-style compiles at once: each maps the drive under set -e first. */
function compiles(root: string, n: number): Promise<number[]> {
  const env = path.join(root, 'scripts', 'env.sh');
  return Promise.all(Array.from({ length: n }, () => new Promise<number>(res => {
    const p = spawn('bash', ['-c', 'set -euo pipefail; . "$1"; map_drive', 'vc8', env], { stdio: 'ignore', env: { ...process.env, ORACLE_DRIVE: '' } });
    p.on('exit', code => res(code ?? -1));
  })));
}

// Wine's dosdevices links use POSIX paths and filenames ending in a colon.
// Native Windows cannot create those fixture links, even with Git Bash installed.
describe('vc8-verify drive', {
  skip: process.platform === 'win32' ? 'Wine drive links require POSIX filesystem semantics' : false,
}, () => {
  it('reads the drive link and checkout from the oracle env.sh', () => {
    const f = fixture();
    const saved = process.env.ORACLE_DRIVE;
    delete process.env.ORACLE_DRIVE;
    try {
      assert.deepStrictEqual(oracleDrive(f.root), { link: f.link, repo: f.repo });
    } finally {
      if (saved !== undefined) process.env.ORACLE_DRIVE = saved;
    }
  });

  it('maps an unmapped drive, so parallel compiles find it in place', async () => {
    const f = fixture();
    mapDrive(f.link, f.repo);
    assert.strictEqual(fs.realpathSync(f.link), f.repo);
    mapDrive(f.link, f.repo);
    // The 1175 failure: each loser's `ln -s` followed the new link and failed under set -e.
    process.env.ORACLE_DRIVE = 'r';
    try {
      assert.deepStrictEqual(await compiles(f.root, 8), Array(8).fill(0));
    } finally {
      delete process.env.ORACLE_DRIVE;
    }
    assert.deepStrictEqual(fs.readdirSync(f.repo).sort(), ['asm_matching'], 'no self-link left in the checkout');
  });

  it('refuses a drive that maps another tree, and leaves it', () => {
    const f = fixture();
    const other = path.join(path.dirname(f.repo), 'other');
    fs.mkdirSync(other);
    fs.symlinkSync(other, f.link);
    assert.throws(() => mapDrive(f.link, f.repo), /maps .*other, not .*checkout/u);
    assert.strictEqual(fs.readlinkSync(f.link), other);
  });

  it('accepts a link to the checkout through another path', () => {
    const f = fixture();
    const alias = path.join(path.dirname(f.repo), 'alias');
    fs.symlinkSync(f.repo, alias);
    fs.symlinkSync(alias, f.link);
    mapDrive(f.link, f.repo);
    assert.strictEqual(fs.readlinkSync(f.link), alias);
  });
});
