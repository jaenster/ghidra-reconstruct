/**
 * Include paths whose letter case disagrees with the tree.
 *
 * macOS resolves `#include "D2Client/GAME/Draw.h"` against a directory spelled `Game`;
 * Linux does not, and a single such include in globals.h is a fatal error in every
 * translation unit. The macOS build cannot see it, so this check asks the question the
 * case-sensitive compiler will: does every quoted include name a file of the tree byte for
 * byte, and does the tree spell every path one way?
 *
 * The tree's paths are git's index when the root is a repository (Tree.paths): on a
 * case-insensitive disk the generator renames a directory, git keeps the old spelling, and
 * a clone gets the index's. One finding per distinct include path, at its first site; and one
 * per path the tree spells two ways.
 *
 * An include that resolves to nothing at all, in any case, is not this check's business: it
 * names a system or SDK header found through the include path, or is a different defect.
 */

import type { Check, Finding } from '../context.js';
import { resolveQuotedInclude } from '../../codegen/path-case.js';

export const INCLUDE_PATH_CASE_CHECK_ID = 'include-path-case';

export const includePathCase: Check = {
  id: INCLUDE_PATH_CASE_CHECK_ID,
  blurb: 'quoted #include that resolves only case-insensitively, or a path spelled two ways - must be 0',
  run(ctx) {
    const out: Finding[] = [];
    const { paths, pathSource } = ctx.tree;
    const exact = new Set(paths);
    const folded = new Map<string, string>();
    for (const p of paths) if (!folded.has(p.toLowerCase())) folded.set(p.toLowerCase(), p);

    // Every directory and file, by case-folded path: more than one spelling is two
    // directories on Linux and one on macOS, whichever spelling the includes use.
    const spellings = new Map<string, Set<string>>();
    for (const p of paths) {
      const parts = p.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const sub = parts.slice(0, i).join('/');
        const key = sub.toLowerCase();
        let set = spellings.get(key);
        if (!set) spellings.set(key, (set = new Set()));
        set.add(sub);
      }
    }
    for (const [, set] of [...spellings].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (set.size < 2) continue;
      const names = [...set].sort();
      out.push({
        check: INCLUDE_PATH_CASE_CHECK_ID, subject: names[0],
        detail: `${pathSource} spells one path ${set.size} ways: ${names.join(', ')}`,
        sig: `twin ${names.join(' ')}`,
      });
    }

    const sites = new Map<string, { file: string; line: number; target: string; count: number }>();
    for (const file of ctx.tree.files) {
      for (const inc of file.includes) {
        if (resolveQuotedInclude(file.path, inc.path, p => exact.has(p))) continue;
        const hit = resolveQuotedInclude(file.path, inc.path, p => folded.has(p.toLowerCase()));
        if (!hit) continue;
        const prior = sites.get(inc.path);
        if (prior) { prior.count++; continue; }
        sites.set(inc.path, { file: file.path, line: inc.line, target: folded.get(hit.target.toLowerCase())!, count: 1 });
      }
    }
    for (const [inc, s] of [...sites].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      out.push({
        check: INCLUDE_PATH_CASE_CHECK_ID, file: s.file, line: s.line, subject: inc,
        detail: `${pathSource} has ${s.target}; ${s.count} include site(s) spell it ${inc}`,
        sig: `include ${inc}`,
      });
    }
    return out;
  },
};
