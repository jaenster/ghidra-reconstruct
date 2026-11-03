/**
 * Why a global keeps external linkage.
 *
 * Several passes decide a global's scope, in sequence, and each one can only
 * widen what the one before it narrowed. When a symbol that only one translation
 * unit uses ends up in globals.h, the question is WHICH pass kept it there; this
 * records, per symbol, the first reason a pass gave for leaving or making it
 * `global`, and writes them out when `GHIDRA_GLOBAL_SCOPE_REPORT` names a file.
 *
 * Recording is unconditional and cheap (one map entry per decision); only the
 * report is opt-in.
 */
import * as fs from 'node:fs';
import type { AnalyzedDataSymbol } from '../types.js';

const reasons = new Map<AnalyzedDataSymbol, string>();
let implOf: ReadonlyMap<string, string> | undefined;

/** Forget everything recorded: one generation run, one trace. */
export function resetGlobalScopeTrace(): void {
  reasons.clear();
  implOf = undefined;
}

/** The function -> impl-file map the scope decisions were taken against. */
export function setGlobalScopeTraceImplMap(map: ReadonlyMap<string, string>): void {
  implOf = map;
}

/**
 * Record why `g` is (still) `global`. The first reason wins: a later pass that
 * also widens it would not have had anything to widen.
 */
export function noteGlobalScopeReason(g: AnalyzedDataSymbol, reason: string): void {
  if (!reasons.has(g)) reasons.set(g, reason);
}

/** A later pass narrowed `g` again; its earlier reason no longer applies. */
export function clearGlobalScopeReason(g: AnalyzedDataSymbol): void {
  reasons.delete(g);
}

export function globalScopeReason(g: AnalyzedDataSymbol): string | undefined {
  return reasons.get(g);
}

/** The impl files `g`'s referencing functions map to, or null when one does not map. */
export function userImplFiles(g: AnalyzedDataSymbol, map: ReadonlyMap<string, string>): Set<string> | null {
  const files = new Set<string>();
  for (const fn of g.referencingFunctions ?? []) {
    const p = map.get(fn);
    if (!p) return null;
    files.add(p);
  }
  return files;
}

/**
 * Counts of reasons over the root (un-namespaced) globals that stayed external
 * although every referencing function maps to one impl file, and, when the env
 * names a file, one TSV row per such global.
 */
export function reportGlobalScopeTrace(globals: readonly AnalyzedDataSymbol[]): Map<string, number> | undefined {
  if (!implOf) return undefined;
  const counts = new Map<string, number>();
  const rows: string[] = ['address\tname\tnamespace\tscope\tuser_file\tfunctions\treason'];
  for (const g of globals) {
    if (g.scope !== 'global') continue;
    const files = userImplFiles(g, implOf);
    if (!files || files.size !== 1) continue;
    const reason = reasons.get(g) ?? 'unrecorded';
    // `@<symbol>` names the member that held a run back; the count is per reason.
    const base = reason.replace(/@.*$/, '');
    const key = g.namespace ? `namespaced:${base}` : base;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    rows.push([g.address, g.suggestedName || g.name, g.namespace ?? '', g.scope, [...files][0],
      String(g.referencingFunctions?.length ?? 0), reason].join('\t'));
  }
  const out = process.env.GHIDRA_GLOBAL_SCOPE_REPORT;
  if (out) fs.writeFileSync(out, rows.join('\n') + '\n');
  return counts;
}
