/**
 * The publish step's link builds must not pile up.
 *
 * live-publish.sh left a ~1.3 GB d2link-live-<stamp> build dir per publish in
 * $TMPDIR; 255 of them filled the disk. The daemon prunes them after each publish.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkBuildRoot, linkBuildsKeep, pruneLinkBuilds } from '../link-builds.js';

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'link-builds-'));
  for (const name of ['d2link-live-20261104-121254', 'd2link-live-20261108-002209', 'd2link-live-20261107-235959']) {
    await mkdir(join(root, name, 'deps'), { recursive: true });
    await writeFile(join(root, name, 'd2.exe'), 'x');
  }
  // Not the daemon's: other link builds, a file with the pattern's name, a near miss.
  await mkdir(join(root, 'd2link-loud'));
  await mkdir(join(root, 'd2link-current'));
  await mkdir(join(root, 'd2link-live-20261108-0022'));
  await writeFile(join(root, 'd2link-live-20261109-000000'), 'a file');
  return root;
}

describe('pruneLinkBuilds', () => {
  it('keeps the newest build and nothing else of its kind', async () => {
    const root = await fixture();
    try {
      const removed = await pruneLinkBuilds(root, 1);
      assert.deepEqual(removed, ['d2link-live-20261104-121254', 'd2link-live-20261107-235959']);
      assert.deepEqual((await readdir(root)).sort(), [
        'd2link-current', 'd2link-live-20261108-0022', 'd2link-live-20261108-002209',
        'd2link-live-20261109-000000', 'd2link-loud',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keep 0 removes every one, keep 2 the older ones', async () => {
    const root = await fixture();
    try {
      assert.equal((await pruneLinkBuilds(root, 2)).length, 1);
      assert.equal((await pruneLinkBuilds(root, 0)).length, 2);
      assert.ok(!(await readdir(root)).some(n => /^d2link-live-\d{8}-\d{6}$/.test(n) && n !== 'd2link-live-20261109-000000'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a missing root is not an error', async () => {
    assert.deepEqual(await pruneLinkBuilds(join(tmpdir(), 'no-such-link-root-' + process.pid), 1), []);
  });

  it('reads the root and the count as live-publish.sh and the env say', () => {
    assert.equal(linkBuildRoot({ TMPDIR: '/var/folders/x/T/' }), '/var/folders/x/T/');
    assert.equal(linkBuildRoot({ TMPDIR: '' }), '/tmp');
    assert.equal(linkBuildRoot({}), '/tmp');
    assert.equal(linkBuildsKeep({}), 1);
    assert.equal(linkBuildsKeep({ D2_LIVE_LINK_BUILDS_KEEP: '2' }), 2);
    assert.equal(linkBuildsKeep({ D2_LIVE_LINK_BUILDS_KEEP: '-1' }), 1);
  });
});
