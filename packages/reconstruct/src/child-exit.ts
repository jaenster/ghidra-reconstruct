/**
 * The exit status of a re-executed child, and why it ended.
 *
 * The entry points re-exec themselves under a larger stack and exit with the child's
 * status. A child killed by a signal has no status: `execFileSync` throws with
 * `status: null` and `signal: 'SIGKILL'`, and `status ?? 1` turned that into a bare exit 1
 * with nothing printed - which is how a Linux run whose generation shards were taken by
 * the OOM killer looked: "rc=1, no message".
 */

import { constants } from 'node:os';

export interface ChildExit {
  /** The status to exit with: the child's own, or 128 + the signal number, as a shell reports it. */
  code: number;
  /** Set when the child did not exit by itself: what to print before exiting. */
  message?: string;
}

export function childExit(err: { status?: number | null; signal?: NodeJS.Signals | null }): ChildExit {
  if (typeof err.status === 'number') return { code: err.status };
  if (err.signal) {
    const n = (constants.signals as Record<string, number>)[err.signal] ?? 0;
    const hint = err.signal === 'SIGKILL'
      ? ' On Linux that is usually the OOM killer: every generation worker holds its own copy of the model, so try fewer --gen-workers.'
      : '';
    return { code: 128 + n, message: `the generator process was killed by ${err.signal}.${hint}` };
  }
  return { code: 1, message: `the generator process could not be run: ${String((err as { message?: string }).message ?? err)}` };
}
