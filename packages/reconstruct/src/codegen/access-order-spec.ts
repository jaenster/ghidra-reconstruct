/**
 * The original's memory accesses for a function, keyed by line of the text the body is
 * parsed from (extract/access-order.ts records them by line of the decompile).
 *
 * The body is parsed inside a one-line wrapper that opens with the function's `{`, so a
 * decompile line maps to `line - braceLine + 1` (as call-order-spec.ts). The facts are
 * dropped whole when they cannot be the same text: another line count, a preprocessing
 * step that changed the body's line count, a call recorded on a line that does not print
 * its name, or more `=` recorded on a line than it prints.
 */

import type { AccessOrderFacts } from '../extract/access-order.js';
import type { AccessOrderEvidence, ArgLoadFact, StoreFact } from '@ghidra-mcp/cpp-parser';

export function accessOrderLines(
  facts: AccessOrderFacts | undefined,
  decompiled: string,
  braceIndex: number,
  rawBody: string,
  preprocessedBody: string,
  wrapperPrefix: string,
): AccessOrderEvidence | undefined {
  if (!facts || wrapperPrefix.includes('\n')) return undefined;
  const text = decompiled.split('\n');
  const count = decompiled.endsWith('\n') ? text.length - 1 : text.length;
  if (count !== facts.lineCount) return undefined;
  const lineCount = (s: string) => s.split('\n').length;
  if (lineCount(rawBody) !== lineCount(preprocessedBody)) return undefined;
  const braceLine = lineCount(decompiled.slice(0, braceIndex));
  const bodyEnd = braceLine + lineCount(rawBody) - 1;

  const args = new Map<number, ArgLoadFact[]>();
  for (const [line, calls] of facts.args) {
    if (line <= braceLine || line > bodyEnd) continue;
    const printed = text[line - 1] ?? '';
    for (const c of calls) if (!printed.includes(c.name)) return undefined;
    args.set(line - braceLine + 1, calls);
  }
  const stores = new Map<number, StoreFact[]>();
  for (const [line, sites] of facts.stores) {
    if (line <= braceLine || line > bodyEnd) continue;
    const printed = (text[line - 1] ?? '').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
    const assigns = printed.match(/(?<![=!<>+\-*/%&|^])=(?!=)/g)?.length ?? 0;
    if (sites.length > assigns) return undefined;
    stores.set(line - braceLine + 1, sites);
  }
  return { args, stores };
}
