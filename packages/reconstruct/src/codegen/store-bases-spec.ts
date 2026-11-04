/**
 * The registers the original's stores are addressed off and its LEAs write, keyed by line of
 * the text the body is parsed from (extract/store-bases.ts records them by line of the
 * decompile).
 *
 * The body is parsed inside a one-line wrapper that opens with the function's `{`, so a
 * decompile line maps to `line - braceLine + 1` (as access-order-spec.ts). The facts are
 * dropped whole when they cannot be the same text: another line count, a preprocessing step
 * that changed the body's line count, or more `=` recorded on a line than it prints.
 */

import type { StoreBaseFacts } from '../extract/store-bases.js';
import type { StoreBaseFact } from '@ghidra-mcp/cpp-parser';

export function storeBaseLines(
  facts: StoreBaseFacts | undefined,
  decompiled: string,
  braceIndex: number,
  rawBody: string,
  preprocessedBody: string,
  wrapperPrefix: string,
): Map<number, StoreBaseFact[]> | undefined {
  if (!facts || wrapperPrefix.includes('\n')) return undefined;
  const text = decompiled.split('\n');
  const count = decompiled.endsWith('\n') ? text.length - 1 : text.length;
  if (count !== facts.lineCount) return undefined;
  const lineCount = (s: string) => s.split('\n').length;
  if (lineCount(rawBody) !== lineCount(preprocessedBody)) return undefined;
  const braceLine = lineCount(decompiled.slice(0, braceIndex));
  const bodyEnd = braceLine + lineCount(rawBody) - 1;
  const out = new Map<number, StoreBaseFact[]>();
  for (const [line, sites] of facts.lines) {
    if (line <= braceLine || line > bodyEnd) continue;
    const printed = (text[line - 1] ?? '').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
    const assigns = printed.match(/(?<![=!<>+\-*/%&|^])=(?!=)/g)?.length ?? 0;
    if (sites.some(s => s.ord >= assigns)) return undefined;
    out.set(line - braceLine + 1, sites.map(s => ({ ...s })));
  }
  return out.size > 0 ? out : undefined;
}
