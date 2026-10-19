/**
 * `warnings.tsv`: every Ghidra WARNING comment of the emitted functions, as rows.
 *
 * The comments never reach the tree (the `warning-comment-strip` pass removes them
 * from bodies, and function-header comments are not emitted at all). This file is
 * where they go instead: one row per warning, classified by Ghidra's message
 * template as `informational` or `defect`.
 *
 * Read from the decompiled text of each function, not from the transformed AST,
 * because two passes consume some of these comments on the way (jumptable warnings,
 * noreturn warnings) and the record must not depend on what a pass did. That also
 * makes the file a property of the snapshot alone: a sharded run and a serial run
 * write the same bytes, since only the coordinator's stage 2 builds it.
 */

import { collectWarningFacts, type WarningClass } from '@ghidra-mcp/cpp-parser';
import type { ExtractedFunction } from '../types.js';

export interface WarningRow {
  address: string;
  function: string;
  kind: string;
  class: WarningClass;
  detail: string;
}

export const WARNINGS_TSV = 'warnings.tsv';

/** The rows for these functions, ordered by address, then by position in the text. */
export function warningRows(functions: readonly ExtractedFunction[]): WarningRow[] {
  const ordered = [...functions].sort((a, b) => {
    const d = parseInt(a.address, 16) - parseInt(b.address, 16);
    return d !== 0 ? d : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const rows: WarningRow[] = [];
  for (const f of ordered) {
    if (!f.decompiled) continue;
    const name = f.namespace ? `${f.namespace}::${f.name}` : f.name;
    for (const w of collectWarningFacts(f.decompiled)) {
      rows.push({
        address: f.address,
        function: name,
        kind: w.kind,
        class: w.class,
        detail: w.callee !== undefined ? `${w.detail} -> ${w.callee}` : w.detail,
      });
    }
  }
  return rows;
}

/** A TSV cell cannot hold a tab or a newline. */
function cell(s: string): string {
  return s.split('\t').join(' ').split('\n').join(' ');
}

export function formatWarningsTsv(rows: readonly WarningRow[]): string {
  const lines = ['address\tfunction\tkind\tclass\tdetail'];
  for (const r of rows) {
    lines.push([r.address, r.function, r.kind, r.class, r.detail].map(cell).join('\t'));
  }
  return lines.join('\n') + '\n';
}
