/**
 * Which publish exit codes stop the queue.
 *
 * A conflict (3) or an unexpected error leaves the merge tree in a state a person
 * has to look at, so the next batch must not land on it. A red build gate (4) does
 * not: the merge is committed and the tree is clean. Its cause is nearly always in
 * Ghidra - a retyped return, a deleted type - and the fix arrives as the next
 * check-in. Blocking there refused exactly the batch that repairs it, and
 * retry_merge only re-ran the gate on the same broken tree. So a red gate is
 * reported and kept until a later publish passes, but batches keep flowing.
 */
export function publishBlockReason(code: number, modifiedDir: string | null | undefined): string | null {
  if (code === 0 || code === 4 || code === 5) return null;
  if (code === 3) {
    return `merge conflict in ${modifiedDir}: markers left, nothing resolved. Resolve and commit there, then call retry_merge.`;
  }
  return `publish failed (exit ${code}); see the log, then call retry_merge.`;
}
