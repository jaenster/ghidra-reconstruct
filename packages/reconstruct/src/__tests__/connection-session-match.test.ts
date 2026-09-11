import { describe, it } from 'node:test';
import assert from 'node:assert';
import { samePrograms } from '../connection.js';

describe('samePrograms', () => {
  it('matches a repo-first path against the path a session reports', () => {
    assert.ok(samePrograms('/windows/lod/1.14d/Game.exe',
                           'Diablo2Lod/windows/lod/1.14d/Game.exe'));
  });

  it('does not match a different program', () => {
    assert.ok(!samePrograms('/mac/intel/1.14d/DiabloII_macho',
                            'Diablo2Lod/windows/lod/1.14d/Game.exe'));
  });

  // A repo session has no programPath. Scanning the session list used to throw
  // out of here and abort the regen before it had connected to anything.
  it('skips a session that carries no program path', () => {
    assert.ok(!samePrograms(null, 'Diablo2Lod/windows/lod/1.14d/Game.exe'));
    assert.ok(!samePrograms(undefined, 'Diablo2Lod/windows/lod/1.14d/Game.exe'));
    assert.ok(!samePrograms('/windows/lod/1.14d/Game.exe', undefined));
    assert.ok(!samePrograms('', ''));
  });
});
