import { test } from 'node:test';
import assert from 'node:assert';
import { samePrograms } from './connection.js';

test('samePrograms matches a repo-first path against a session repo-relative one', () => {
  assert.equal(
    samePrograms('/windows/lod/1.14d/Game.exe', 'Diablo2Lod/windows/lod/1.14d/Game.exe'),
    true,
  );
  assert.equal(
    samePrograms('Diablo2Lod/windows/lod/1.14d/Game.exe', '/windows/lod/1.14d/Game.exe'),
    true,
  );
});

test('samePrograms matches identical paths regardless of leading slash', () => {
  assert.equal(samePrograms('/a/b/Game.exe', 'a/b/Game.exe'), true);
  assert.equal(samePrograms('/a//b/Game.exe', '/a/b/Game.exe'), true);
});

test('samePrograms does not match a different program', () => {
  assert.equal(
    samePrograms('/windows/lod/1.14d/Game.exe', '/mac/intel/1.14d/DiabloII_macho'),
    false,
  );
  // A suffix must fall on a path-segment boundary, or "d2Game.exe" would match
  // "Game.exe".
  assert.equal(samePrograms('/lod/d2Game.exe', 'Game.exe'), false);
});
