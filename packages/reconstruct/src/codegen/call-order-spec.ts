/**
 * The original's call order for a function, keyed by line of the text the body is parsed
 * from (extract/call-order.ts records it by line of the decompile).
 *
 * The body is parsed inside a one-line wrapper that opens with the function's `{`, so a
 * decompile line maps to `line - braceLine + 1`. The facts are dropped whole when they
 * cannot be the same text: another line count, a preprocessing step that changed the
 * body's line count, or a call recorded on a line that does not print its name.
 */

import type { CallOrderFacts } from '../extract/call-order.js';
import type { CallOrderEvidence, CallSiteFact } from '@ghidra-mcp/cpp-parser';

/**
 * `braceIndex`: the index in `decompiled` of the `{` that opens the body; `wrapperPrefix`:
 * the text before the body in the parsed wrapper, which must end on the brace's line.
 */
export function callOrderLines(
  facts: CallOrderFacts | undefined,
  decompiled: string,
  braceIndex: number,
  rawBody: string,
  preprocessedBody: string,
  wrapperPrefix: string,
): CallOrderEvidence | undefined {
  if (!facts || wrapperPrefix.includes('\n')) return undefined;
  const text = decompiled.split('\n');
  const count = decompiled.endsWith('\n') ? text.length - 1 : text.length;
  if (count !== facts.lineCount) return undefined;
  const lineCount = (s: string) => s.split('\n').length;
  if (lineCount(rawBody) !== lineCount(preprocessedBody)) return undefined;
  const braceLine = lineCount(decompiled.slice(0, braceIndex));
  const bodyEnd = braceLine + lineCount(rawBody) - 1;

  const lines = new Map<number, CallSiteFact[]>();
  for (const [line, calls] of facts.calls) {
    if (line <= braceLine || line > bodyEnd) continue;
    const printed = text[line - 1] ?? '';
    for (const c of calls) if (!printed.includes(c.name)) return undefined;
    lines.set(line - braceLine + 1, calls);
  }
  return { lines };
}
