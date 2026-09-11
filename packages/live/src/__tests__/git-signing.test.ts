import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The daemon commits without a terminal. A signer backed by an interactive
 * agent fails the commit, the batch is retried, and the loop spins forever
 * emitting trees it can never land - which is exactly what happened, silently,
 * for fifteen minutes.
 */
test('every git invocation forces signing off', () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'git.ts'), 'utf8',
  );
  assert.match(src, /run\('git', \['-c', 'commit\.gpgsign=false', \.\.\.args\]/);
});
