/**
 * The original's arithmetic sites for a function, keyed by line of the text the body is parsed
 * from (extract/arith-sites.ts records them by line of the decompile).
 *
 * The body is parsed inside a one-line wrapper that opens with the function's `{`, so a
 * decompile line maps to `line - braceLine + 1` (as rotate-sites-spec.ts). The facts are
 * dropped whole when they cannot be the same text: another line count, or a preprocessing step
 * that changed the body's line count.
 */

import type { ArithSiteFacts } from '../extract/arith-sites.js';
import type { ArithFact } from '@ghidra-mcp/cpp-parser';

export function arithSiteLines(
  facts: ArithSiteFacts | undefined,
  decompiled: string,
  braceIndex: number,
  rawBody: string,
  preprocessedBody: string,
  wrapperPrefix: string,
): Map<number, ArithFact[]> | undefined {
  if (!facts || wrapperPrefix.includes('\n')) return undefined;
  const text = decompiled.split('\n');
  const count = decompiled.endsWith('\n') ? text.length - 1 : text.length;
  if (count !== facts.lineCount) return undefined;
  const lineCount = (s: string) => s.split('\n').length;
  if (lineCount(rawBody) !== lineCount(preprocessedBody)) return undefined;
  const braceLine = lineCount(decompiled.slice(0, braceIndex));
  const bodyEnd = braceLine + lineCount(rawBody) - 1;
  const out = new Map<number, ArithFact[]>();
  for (const [line, items] of facts.lines) {
    if (line <= braceLine || line > bodyEnd) continue;
    out.set(line - braceLine + 1, items);
  }
  return out.size > 0 ? out : undefined;
}
