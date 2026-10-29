/**
 * The REP STOS/MOVS instructions `rep-string-form` may write as source, from a function's
 * `stringOps` (extract/string-ops.ts).
 *
 * Only an instruction whose count the block sets as an immediate (`mov ecx, K`) has a source
 * form of a constant size; a fill also needs the EAX it stores. Anything else gets no entry,
 * and the pass leaves its loop as printed.
 */

import type { RepStringOp } from '@ghidra-mcp/cpp-parser';
import type { ExtractedFunction } from '../types.js';

export function repStringOps(func: Pick<ExtractedFunction, 'stringOps' | 'address'>): RepStringOp[] | undefined {
  const out: RepStringOp[] = [];
  const entry = Number.parseInt(String(func.address).replace(/^0x/i, ''), 16);
  for (const s of func.stringOps ?? []) {
    if (s.ecx === undefined || s.ecx === 0) continue;
    if (s.op === 'stos' && s.eax === undefined) continue;
    out.push({
      op: s.op,
      unit: s.unit,
      count: s.ecx,
      ...(s.op === 'stos' ? { fill: s.eax } : {}),
      names: s.names,
      ...(Number.isFinite(entry) ? { address: (entry + s.at).toString(16).padStart(8, '0') } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}
