/**
 * A red build gate must not stop the queue.
 *
 * v1860 retyped a callback to return BOOL and the gate went red; v1861 put it back.
 * With the gate blocking, the daemon refused the v1861 batch, and retry_merge could
 * only re-run the gate on the v1860 tree - the repair could never land without a
 * restart. Conflicts and errors still block: those leave a tree to look at.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { publishBlockReason } from '../publish-outcome.js';

describe('publishBlockReason', () => {
  it('does not block on success, a dirty merge tree or a red gate', () => {
    for (const code of [0, 4, 5]) assert.equal(publishBlockReason(code, '/m'), null, `exit ${code}`);
  });

  it('blocks on a merge conflict and names the tree', () => {
    assert.match(publishBlockReason(3, '/m') ?? '', /merge conflict in \/m/);
  });

  it('blocks on any other failure', () => {
    assert.match(publishBlockReason(1, '/m') ?? '', /publish failed \(exit 1\)/);
  });
});
