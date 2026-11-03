import { test } from 'node:test';
import assert from 'node:assert';
import { isNeverTouch, isTreeMetadata } from '../paths.js';

// full_regen diffs a scratch generation against the regen checkout; the checkout's
// .git and .idea were reported as differences on every run (v1864 proof).
test('checkout metadata is not output, at any depth', () => {
  for (const p of ['.git', '.git/HEAD', '.idea', '.idea/workspace.xml', 'D2Client/.DS_Store']) {
    assert.ok(isTreeMetadata(p), p);
  }
  for (const p of ['D2Client/UI/Button/ButtonWrapper.h', 'gitignore.txt', 'D2Client/.gitkeep']) {
    assert.ok(!isTreeMetadata(p), p);
  }
  assert.ok(!isNeverTouch('.git'));
});
