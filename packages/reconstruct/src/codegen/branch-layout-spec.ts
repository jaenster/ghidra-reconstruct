/**
 * The original's addresses for a function's ifs, keyed by line of the text the body is
 * parsed from (extract/branch-layout.ts records them by line of the decompile).
 *
 * The body is parsed inside a one-line wrapper that opens with the function's `{`, so a
 * decompile line maps to `line - braceLine + 1`. The facts are dropped whole when they
 * cannot be the same text: another line count, an `if` keyword on a line without one,
 * a different number of `if` lines in the body, or a preprocessing step that changed the
 * body's line count.
 */

import type { BranchLayoutFacts, EqualityTest } from '../extract/branch-layout.js';

export interface BranchLayoutLines {
  lines: Map<number, number[]>;
  ifs: Map<number, number>;
  /** Equality tokens per line, in text order; absent when the facts predate them. */
  tests?: Map<number, EqualityTest[]>;
}

const IF_LINE = /^\s*(?:\}\s*)?(?:else\s+)?if\s*\(/;

/**
 * `braceIndex`: the index in `decompiled` of the `{` that opens the body; `wrapperPrefix`:
 * the text before the body in the parsed wrapper, which must end on the brace's line.
 */
export function branchLayoutLines(
  facts: BranchLayoutFacts | undefined,
  decompiled: string,
  braceIndex: number,
  rawBody: string,
  preprocessedBody: string,
  wrapperPrefix: string,
): BranchLayoutLines | undefined {
  if (!facts || wrapperPrefix.includes('\n')) return undefined;
  const text = decompiled.split('\n');
  const count = decompiled.endsWith('\n') ? text.length - 1 : text.length;
  if (count !== facts.lineCount) return undefined;
  const lineCount = (s: string) => s.split('\n').length;
  if (lineCount(rawBody) !== lineCount(preprocessedBody)) return undefined;
  const braceLine = lineCount(decompiled.slice(0, braceIndex));
  const bodyEnd = braceLine + lineCount(rawBody) - 1;

  let ifLines = 0;
  for (let l = braceLine + 1; l <= bodyEnd; l++) if (IF_LINE.test(text[l - 1] ?? '')) ifLines++;
  const ifs = new Map<number, number>();
  let bodyIfs = 0;
  for (const [line, off] of facts.ifs) {
    if (line <= braceLine || line > bodyEnd) continue;
    if (!/\bif\b/.test(text[line - 1] ?? '')) return undefined;
    bodyIfs++;
    ifs.set(line - braceLine + 1, off);
  }
  if (bodyIfs !== ifLines) return undefined;

  const lines = new Map<number, number[]>();
  for (const [line, offs] of facts.lines) {
    if (line <= braceLine || line > bodyEnd) continue;
    lines.set(line - braceLine + 1, offs);
  }
  if (!facts.tests) return { lines, ifs };
  const tests = new Map<number, EqualityTest[]>();
  for (const [line, t] of facts.tests) {
    if (line <= braceLine || line > bodyEnd) continue;
    const l = line - braceLine + 1;
    const list = tests.get(l);
    if (list) list.push(t); else tests.set(l, [t]);
  }
  return { lines, ifs, tests };
}
