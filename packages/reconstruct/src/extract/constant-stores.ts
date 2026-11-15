/** Native constant writes hidden by the decompiler's later overwrite of the same field. */
import { parseZeroStoreTrace, type TraceInsn, type ZeroStoreTrace } from './zero-stores.js';

export interface ConstantStoreWindow {
  name: string;
  /** The aggregate's Ghidra frame slot and complete size. */
  offset: number;
  size: number;
  /** One four-byte field, relative to the aggregate. */
  fieldOffset: number;
  value: number;
  at: number;
  /** The named native call immediately before the constant write. */
  afterCall: { at: number; name: string };
  /** Disjoint field writes between the constant and its overwrite, in native order. */
  between: { offset: number; size: number; at: number }[];
  finalAt: number;
}
export type ConstantStoreFacts = ConstantStoreWindow[];

/**
 * A narrow native shape: a positive int32 MOV, disjoint writes to the same aggregate,
 * then a full MOV overwriting that field. No calls, entries, jumps, field reads or
 * unknown stores may intervene. The emitter still has to match the corresponding
 * field statements and the final OR of this constant; this trace does not add code.
 */
export function constantStoresFromTrace(trace: ZeroStoreTrace): ConstantStoreFacts {
  if (!trace.ebpFrame) return [];
  const { insns } = trace;
  if (insns.some((i, n) => !Number.isSafeInteger(i.at) || (n > 0 && i.at <= insns[n - 1].at))) return [];
  const refsOf = (i: TraceInsn): TraceInsn['refs'] => {
    if (i.refs.length || i.ebpDisp === null) return i.refs;
    return [{ offset: i.ebpDisp - 4, kind: i.mnemonic === 'LEA' ? 'a' : i.store ? (i.mnemonic === 'MOV' ? 'w' : 'x') : 'r' }];
  };
  const out: ConstantStoreFacts = [];
  for (let n = 0; n < insns.length; n++) {
    const first = insns[n], store = first.store;
    const previous = insns[n - 1];
    if (!previous?.call || !previous.target || !/^[A-Za-z_]\w*$/.test(previous.target) || first.entered) continue;
    if (first.mnemonic !== 'MOV' || first.call || !store || store.size !== 4 || !store.value || !('imm' in store.value)) continue;
    const value = store.value.imm;
    if (!Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff) continue;
    const refs = refsOf(first);
    if (refs.length !== 1 || refs[0].kind !== 'w') continue;
    const offset = refs[0].offset;
    const locals = trace.locals.filter(l => Number.isSafeInteger(l.offset) && l.size >= 4 && offset >= l.offset && offset + 4 <= l.offset + l.size);
    if (locals.length !== 1) continue;
    const local = locals[0];
    const between: ConstantStoreWindow['between'] = [];
    for (let k = n + 1; k < Math.min(n + 17, insns.length); k++) {
      const i = insns[k];
      if (i.entered || i.call || /^(?:J|RET|LOOP|PUSH|POP)/.test(i.mnemonic)) break;
      const rs = refsOf(i);
      if (i.store) {
        if (rs.length !== 1 || !['w', 'x'].includes(rs[0].kind)) break;
        const r = rs[0], width = i.store.size;
        if (![1, 2, 4].includes(width) || r.offset < local.offset || r.offset + width > local.offset + local.size) break;
        if (r.offset < offset + 4 && offset < r.offset + width) {
          if (r.offset === offset && width === 4 && r.kind === 'w' && i.mnemonic === 'MOV' && between.length > 0) {
            out.push({ name: local.name, offset: local.offset, size: local.size, fieldOffset: offset - local.offset, value, at: first.at, afterCall: { at: previous.at, name: previous.target }, between, finalAt: i.at });
          }
          break;
        }
        between.push({ offset: r.offset - local.offset, size: width, at: i.at });
      } else if (rs.length > 0) break;
    }
  }
  return out;
}

export function parseConstantStoreRow(row: string): ConstantStoreFacts {
  const trace = parseZeroStoreTrace(row);
  return trace ? constantStoresFromTrace(trace) : [];
}
