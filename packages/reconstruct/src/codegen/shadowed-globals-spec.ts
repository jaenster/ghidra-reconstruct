/**
 * The global references a parameter or local's name shadows, keyed by line of the text the
 * body is parsed from (extract/shadowed-globals.ts records them by line of the decompile),
 * each with the spelling that reaches the global from inside the function.
 *
 * The body is parsed inside a one-line wrapper that opens with the function's `{`, so a
 * decompile line maps to `line - braceLine + 1` (as call-divides-spec.ts). The facts are
 * dropped whole when they cannot be the same text: another line count, or a preprocessing
 * step that changed the body's line count. A reference is dropped when its line does not
 * print its name, and when the global is not one the generator emits as a variable of
 * namespace scope under that name: a root-scope global is spelled `::name`, a namespaced one
 * `::Ns::name`, the path it is emitted in.
 */

import type { ShadowedGlobalFacts } from '../extract/shadowed-globals.js';
import type { AnalyzedDataSymbol } from '../types.js';
import type { ShadowedGlobalFact } from '@ghidra-mcp/cpp-parser';
import { emittedNamespaceOf } from './globals-header.js';

const byAddressCache = new WeakMap<AnalyzedDataSymbol[], Map<string, AnalyzedDataSymbol>>();

function globalsByAddress(globals: AnalyzedDataSymbol[]): Map<string, AnalyzedDataSymbol> {
  let m = byAddressCache.get(globals);
  if (!m) {
    m = new Map();
    for (const g of globals) m.set(g.address.toLowerCase().replace(/^0x/, '').padStart(8, '0'), g);
    byAddressCache.set(globals, m);
  }
  return m;
}

/** The qualifier that reaches `g` from any scope, or undefined when it is not emitted as a namespace-scope variable named `name`. */
export function shadowedGlobalQualifier(
  g: AnalyzedDataSymbol,
  name: string,
  namespaceOf: (g: AnalyzedDataSymbol) => readonly string[] = s => emittedNamespaceOf(s).segments,
): string[] | undefined {
  if (g.scope !== 'global' && g.scope !== 'file-local') return undefined;
  if (g.compilerOutput) return undefined;
  if ((g.suggestedName || g.name) !== name) return undefined;
  const segments = namespaceOf(g);
  if (segments.some(s => !/^[A-Za-z_]\w*$/.test(s))) return undefined;
  return [...segments];
}

export function shadowedGlobalLines(
  facts: ShadowedGlobalFacts | undefined,
  globals: AnalyzedDataSymbol[] | undefined,
  decompiled: string,
  braceIndex: number,
  rawBody: string,
  preprocessedBody: string,
  wrapperPrefix: string,
  namespaceOf?: (g: AnalyzedDataSymbol) => readonly string[],
): Map<number, ShadowedGlobalFact[]> | undefined {
  if (!facts || !globals || wrapperPrefix.includes('\n')) return undefined;
  const text = decompiled.split('\n');
  const count = decompiled.endsWith('\n') ? text.length - 1 : text.length;
  if (count !== facts.lineCount) return undefined;
  const lineCount = (s: string) => s.split('\n').length;
  if (lineCount(rawBody) !== lineCount(preprocessedBody)) return undefined;
  const braceLine = lineCount(decompiled.slice(0, braceIndex));
  const bodyEnd = braceLine + lineCount(rawBody) - 1;
  const byAddress = globalsByAddress(globals);
  const out = new Map<number, ShadowedGlobalFact[]>();
  for (const [line, refs] of facts.lines) {
    if (line <= braceLine || line > bodyEnd) continue;
    const printed = text[line - 1] ?? '';
    const kept: ShadowedGlobalFact[] = [];
    for (const r of refs) {
      if (!printed.includes(r.name)) continue;
      const g = byAddress.get(r.address);
      const qualifier = g && shadowedGlobalQualifier(g, r.name, namespaceOf);
      if (!qualifier) continue;
      kept.push({ name: r.name, ord: r.ord, total: r.total, qualifier });
    }
    if (kept.length > 0) out.set(line - braceLine + 1, kept);
  }
  return out.size > 0 ? out : undefined;
}
