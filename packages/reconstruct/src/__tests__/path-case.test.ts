/**
 * Every emitted path is spelled on disk the way the project spells it.
 *
 * recon/diablo-2 holds `D2Client/Game/RosterPets.h` while every include says
 * `D2Client/GAME/RosterPets.h`: the generator writes GAME, but on the case-insensitive
 * macOS disk the write landed in the `Game` directory an older run had created, and that
 * spelling is what got committed. A case-sensitive checkout then fails every such include.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alignPathCase, assertNoCaseCollidingFiles, canonicalSpellings } from '../codegen/path-case.js';

function withDir(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'path-case-'));
    try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}

describe('path case', () => {
  it('renames a stale directory and file spelling to the emitted one', withDir(async dir => {
    mkdirSync(join(dir, 'D2Client', 'Game'), { recursive: true });
    writeFileSync(join(dir, 'D2Client', 'Game', 'rosterpets.h'), '');
    const renames = await alignPathCase(dir, ['D2Client/GAME/RosterPets.h', 'D2Client/GAME/Draw.h']);
    assert.deepStrictEqual(renames, ['D2Client/Game -> D2Client/GAME', 'D2Client/GAME/rosterpets.h -> D2Client/GAME/RosterPets.h']);
    assert.deepStrictEqual(readdirSync(join(dir, 'D2Client')), ['GAME']);
    assert.deepStrictEqual(readdirSync(join(dir, 'D2Client', 'GAME')), ['RosterPets.h']);
  }));

  it('leaves a directory the project spells two ways', withDir(async dir => {
    mkdirSync(join(dir, 'D2Client', 'Game'), { recursive: true });
    const paths = ['D2Client/GAME/A.h', 'D2Client/Game/B.h'];
    assert.ok(!canonicalSpellings(paths).has('d2client/game'));
    assert.deepStrictEqual(await alignPathCase(dir, paths), []);
  }));

  it('refuses two files that differ only in case', () => {
    assert.throws(() => assertNoCaseCollidingFiles(['A/x.h', 'a/X.h']), /only in case/);
    assert.doesNotThrow(() => assertNoCaseCollidingFiles(['A/x.h', 'a/y.h', 'A/x.h']));
  });
});
