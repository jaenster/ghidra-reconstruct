/**
 * The publish step's link builds.
 *
 * live-publish.sh links source/modified into `${TMPDIR:-/tmp}/d2link-live-<stamp>`
 * (link.sh's build dir: every object, libd2.a and d2.exe, about 1.3 GB) and never
 * removes it. The gate reads only link.sh's output and the logs it writes beside the
 * publish script; nothing reads the build dir afterwards. One per publish filled the
 * disk (255 of them, ~330 GB), so the daemon removes them after each publish, on
 * every exit path, keeping only the newest `keep` for a person to look at.
 */

import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** live-publish.sh's `d2link-$STAMP` with `STAMP=live-YYYYmmdd-HHMMSS`. */
const LINK_BUILD = /^d2link-live-\d{8}-\d{6}$/;

/** Where live-publish.sh puts them: `${TMPDIR:-/tmp}`, read from the env it inherits. */
export function linkBuildRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.TMPDIR || '/tmp';
}

/** How many to keep: `D2_LIVE_LINK_BUILDS_KEEP`, default 1 (the last publish's). */
export function linkBuildsKeep(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.D2_LIVE_LINK_BUILDS_KEEP ?? '1');
  return Number.isInteger(n) && n >= 0 ? n : 1;
}

/**
 * Remove every `d2link-live-<stamp>` directory in `root` but the newest `keep`
 * (stamps sort by time). Anything else in `root` is left alone, other link builds
 * (`d2link-loud`, `d2link-current`) included. Returns the names removed.
 */
export async function pruneLinkBuilds(root: string, keep: number): Promise<string[]> {
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter(d => d.isDirectory() && LINK_BUILD.test(d.name))
      .map(d => d.name)
      .sort();
  } catch {
    return [];
  }
  const doomed = names.slice(0, Math.max(0, names.length - keep));
  for (const name of doomed) await rm(join(root, name), { recursive: true, force: true });
  return doomed;
}
