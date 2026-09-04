/**
 * Git plumbing for the live loop, over `execFile` rather than a library.
 *
 * The regen/modified split means every automated commit lands next to work a
 * human may have in flight, so these wrappers are deliberately timid: they
 * refuse rather than guess, they never take a directory implicitly, and an
 * empty commit is a normal outcome instead of an error. A library would add a
 * dependency and hide exactly the exit codes this needs to read.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

interface GitOutput {
  stdout: string;
  stderr: string;
  /** Non-zero exit. Null when git ran to completion. */
  code: number | null;
}

/**
 * Run git in `dir` and hand back the exit code instead of throwing.
 *
 * Half of what this module does is branch on a non-zero exit (nothing to
 * commit, merge conflict), so a rejected promise would mean try/catch around
 * the normal path.
 */
async function git(dir: string, args: string[]): Promise<GitOutput> {
  try {
    const { stdout, stderr } = await run('git', args, {
      cwd: dir,
      maxBuffer: 64 * 1024 * 1024,
      // A commit hook or merge driver must never sit waiting on a terminal.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { stdout, stderr, code: null };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number; message?: string };
    if (typeof err.code !== 'number') {
      // git itself is missing, or the directory does not exist — not a git
      // outcome this module is meant to interpret.
      throw e;
    }
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? '', code: err.code };
  }
}

export interface CommitResult {
  committed: boolean;
  sha?: string;
}

/**
 * Stage everything and commit.
 *
 * `committed: false` when the tree was already clean. That is the common case
 * on a regen that changed nothing, and treating it as failure would abort a
 * loop that is in fact working correctly.
 */
export async function commitRegen(dir: string, message: string): Promise<CommitResult> {
  await git(dir, ['add', '-A']);

  const staged = await git(dir, ['diff', '--cached', '--name-only']);
  if (staged.stdout.trim().length === 0) {
    return { committed: false };
  }

  const commit = await git(dir, ['commit', '-m', message]);
  if (commit.code !== null) {
    throw new Error(`git commit failed in ${dir}: ${commit.stderr.trim() || commit.stdout.trim()}`);
  }

  const head = await git(dir, ['rev-parse', 'HEAD']);
  return { committed: true, sha: head.stdout.trim() || undefined };
}

export interface MergeResult {
  state: 'clean' | 'dirty' | 'conflict' | 'uptodate' | 'error';
  /** Populated only for state 'conflict'. Paths still carrying markers. */
  conflictFiles?: string[];
  message?: string;
}

/**
 * Merge `branch` into the worktree at `modifiedDir`.
 *
 * Refuses outright when the worktree is dirty. A merge over uncommitted work
 * mixes someone's edits into the merge commit with no way to tell them apart
 * afterwards, and the loop has no business deciding that on their behalf.
 *
 * A conflict is reported, NOT aborted: the markers are left in the tree so the
 * conflict can be resolved where it happened.
 */
export async function mergeIntoModified(modifiedDir: string, branch: string): Promise<MergeResult> {
  const status = await git(modifiedDir, ['status', '--porcelain']);
  if (status.stdout.trim().length > 0) {
    return {
      state: 'dirty',
      message: `${modifiedDir} has uncommitted changes; refusing to merge ${branch} over them.`,
    };
  }

  const merge = await git(modifiedDir, ['merge', '--no-edit', branch]);
  if (merge.code === null) {
    const said = `${merge.stdout}${merge.stderr}`;
    return {
      state: /already up to date/i.test(said) ? 'uptodate' : 'clean',
      message: said.trim() || undefined,
    };
  }

  const unmerged = await git(modifiedDir, ['diff', '--name-only', '--diff-filter=U']);
  const conflictFiles = unmerged.stdout.split('\n').map(l => l.trim()).filter(Boolean);
  const said = (merge.stderr || merge.stdout).trim() || undefined;

  // A failed merge is not automatically a conflict. `git merge` also fails when the
  // ref does not exist, when the worktree is mid-merge, or when it refuses to
  // overwrite untracked files - and none of those leave markers to resolve.
  // Reporting them as conflicts sends whoever reads `status` looking for markers
  // that are not there, which is a worse error than the original.
  if (conflictFiles.length === 0) {
    return { state: 'error', message: said ?? 'git merge failed without reporting why' };
  }

  return { state: 'conflict', conflictFiles, message: said };
}

/** Branch the worktree is on, or null on a detached HEAD. */
export async function currentBranch(dir: string): Promise<string | null> {
  const result = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (result.code !== null) {
    throw new Error(`git rev-parse failed in ${dir}: ${result.stderr.trim()}`);
  }
  const name = result.stdout.trim();
  return name && name !== 'HEAD' ? name : null;
}

/**
 * Throw unless the worktree is on some branch other than `branch`.
 *
 * `master` is the integration branch and carries no worktree by design; a loop
 * that finds itself there is pointed at the wrong checkout, and writing before
 * noticing is what makes it expensive.
 */
export async function assertNotBranch(dir: string, branch: string): Promise<void> {
  const on = await currentBranch(dir);
  if (on === branch) {
    throw new Error(`${dir} is on '${branch}'; refusing to write there.`);
  }
}
