/**
 * The jump tables of a function, as the decompiler recovered them, and where each one's
 * bound check sends a value it does not cover.
 *
 * VC8 compiles a dense `switch` to `cmp ecx, MAX; ja DEFAULT; jmp [table + ecx*4]`: the
 * bound is the largest case the source wrote, and the table has one entry per value up to
 * it. The decompiler folds every entry whose target is the default's (or the code after the
 * switch) into that default, so a case the source wrote with the same body as what follows
 * the switch (`case 5: return 0;` before a trailing `return 0;`) disappears from the decompile,
 * and VC8 then compiles a table one entry shorter. The `jump-table-case` pass puts that case
 * back from here:
 *
 *   at       the BRANCHIND's offset from the function entry
 *   fallback the offset the bound check's conditional jump goes to (the value is out of
 *            range); absent when no such jump falls into the BRANCHIND
 *   bound    the immediate of the CMP right before that jump; absent otherwise
 *   entries  per table entry, the case value (the decompiler's label, in terms of the
 *            switch variable it prints) and the target's offset; `labelled` is false when
 *            the decompiler gave no label per entry and the value is the entry's index
 *
 * Read-only: part of the per-function facts script (function-facts.ts), no transaction. A
 * failure leaves the field unset, which is also what an older snapshot looks like; the pass
 * then changes nothing.
 */

export interface JumpTableEntry {
  value: number;
  target: number;
}

export interface JumpTable {
  at: number;
  fallback?: number;
  bound?: number;
  labelled: boolean;
  entries: JumpTableEntry[];
}

export type JumpTableFacts = JumpTable[];

/**
 * Java fragment, run per function inside the facts script with `r` (the decompile results),
 * `L` (the listing) and `base` (the entry offset) in scope. Leaves the row in `jrow`:
 * `at:fallback:bound:l|i:value=target,...;...` (offsets and the bound in hex, values decimal).
 */
export const JUMP_TABLES_JAVA = `
          StringBuilder jrow = new StringBuilder();
          try {
            ghidra.program.model.pcode.HighFunction jh = r.getHighFunction();
            ghidra.program.model.pcode.JumpTable[] jts = jh == null ? null : jh.getJumpTables();
            for (int ji = 0; jts != null && ji < jts.length; ji++) {
              ghidra.program.model.pcode.JumpTable jt = jts[ji];
              ghidra.program.model.address.Address jsw = jt.getSwitchAddress();
              ghidra.program.model.address.Address[] jcs = jt.getCases();
              if (jsw == null || jcs == null || jcs.length == 0) continue;
              Integer[] jlv = jt.getLabelValues();
              boolean labelled = jlv != null && jlv.length == jcs.length;
              String jfb = "-", jbd = "-";
              ghidra.program.model.listing.Instruction jq = L.getInstructionAt(jsw);
              for (int s = 0; s < 6 && jq != null; s++) {
                ghidra.program.model.listing.Instruction jp = L.getInstructionBefore(jq.getAddress());
                if (jp == null || jp.getFallThrough() == null || !jp.getFallThrough().equals(jq.getAddress())) break;
                if (jp.getFlowType().isConditional() && jp.getFlowType().isJump()) {
                  ghidra.program.model.address.Address[] jfl = jp.getFlows();
                  if (jfl != null && jfl.length == 1) jfb = Long.toHexString(jfl[0].getOffset() - base);
                  ghidra.program.model.listing.Instruction jc = L.getInstructionBefore(jp.getAddress());
                  if (jc != null && jc.getMnemonicString().equals("CMP") && jc.getFallThrough() != null
                      && jc.getFallThrough().equals(jp.getAddress()) && jc.getScalar(1) != null) {
                    jbd = Long.toHexString(jc.getScalar(1).getUnsignedValue());
                  }
                  break;
                }
                if (jp.getFlowType().isJump() || jp.getFlowType().isCall()) break;
                jq = jp;
              }
              jrow.append(jrow.length() > 0 ? ";" : "").append(Long.toHexString(jsw.getOffset() - base)).append(':')
                .append(jfb).append(':').append(jbd).append(':').append(labelled ? 'l' : 'i').append(':');
              for (int k = 0; k < jcs.length; k++) {
                if (k > 0) jrow.append(',');
                jrow.append(labelled ? jlv[k].intValue() : k).append('=').append(Long.toHexString(jcs[k].getOffset() - base));
              }
            }
          } catch (Exception je) { jrow.setLength(0); }
`;

/** Whether a decompile prints a switch: the functions whose tables are read. */
export function printsSwitch(decompiled: string): boolean {
  return /\bswitch\s*\(/.test(decompiled);
}

/** One function's row, parsed; malformed tables are dropped. */
export function parseJumpTableRow(row: string): JumpTableFacts {
  const out: JumpTableFacts = [];
  const hex = /^[0-9a-f]+$/i;
  for (const item of row.split(';')) {
    const c = item.split(':');
    if (c.length !== 5 || !hex.test(c[0]) || (c[3] !== 'l' && c[3] !== 'i')) continue;
    const entries: JumpTableEntry[] = [];
    let ok = true;
    for (const e of c[4] ? c[4].split(',') : []) {
      const m = /^(-?\d+)=([0-9a-f]+)$/i.exec(e);
      if (!m) { ok = false; break; }
      entries.push({ value: Number(m[1]), target: Number.parseInt(m[2], 16) });
    }
    if (!ok || entries.length === 0) continue;
    const t: JumpTable = { at: Number.parseInt(c[0], 16), labelled: c[3] === 'l', entries };
    if (hex.test(c[1])) t.fallback = Number.parseInt(c[1], 16);
    if (hex.test(c[2])) t.bound = Number.parseInt(c[2], 16);
    out.push(t);
  }
  return out;
}
