/**
 * The `/` and `%` operators of a decompile whose instruction is a signed divide (IDIV).
 *
 * The decompiler prints a division of a zero-extended byte or word as unsigned whichever way
 * the original divided it: once the dividend's sign bit is known clear, INT_SDIV and INT_SREM
 * become INT_DIV and INT_REM, and the input prints with its `(uint)` cast. Compiled as
 * printed, VC8 divides unsigned (`xor edx, edx; div`); where the source divided the promoted
 * int, the original has `cdq; idiv` (OpenLogFileWithTimestamp 0040ebd0: `movzx eax, word ptr
 * [esi]; cdq; mov ecx, 0x64; idiv ecx`). The instruction the operator's p-code op came from
 * tells them apart; the `promoted-dividend` pass ties each site to its operation and
 * `arith-idioms` writes the division of the promoted value.
 *
 * The walk is over the markup's operator tokens, in text order, per operator text. A token is
 * a site when its op's instruction is IDIV. The row is
 *
 *   c0,c1;i:ord;...
 *
 *   cN    how many tokens print operator N of SIGNED_DIVIDE_OPERATORS: the pass ties by
 *         position only where the body has exactly as many operations of that spelling
 *   i     the operator's index in SIGNED_DIVIDE_OPERATORS
 *   ord   the token's position among the tokens of that operator
 *
 * Read-only: part of the per-function facts script (function-facts.ts), no transaction. A
 * failure leaves the field unset, which is also what an older snapshot looks like; the pass
 * then changes nothing. Positions in text order are only meaningful for the exact decompile
 * text they were read from, so the row is attached behind the compare-sites text-hash gate.
 */

/** The operator spellings the walk counts, by index. */
export const SIGNED_DIVIDE_OPERATORS = ['/', '%'] as const;

export interface SignedDivideSite {
  /** The operator, one of SIGNED_DIVIDE_OPERATORS. */
  operator: string;
  /** The token's position among the decompile's tokens of that operator. */
  ord: number;
}

export interface SignedDivideFacts {
  /** Per operator of SIGNED_DIVIDE_OPERATORS, how many tokens print it. */
  counts: Record<string, number>;
  sites: SignedDivideSite[];
}

/**
 * Java fragment, run per function inside the facts script with `toks` (the flattened markup),
 * `ctext` and the listing `L` in scope. Leaves the row in `irow`; empty when the decompile did
 * not complete or has no such operator.
 */
export const SIGNED_DIVIDES_JAVA = `
          StringBuilder irow = new StringBuilder();
          try {
            if (ctext != null) {
              final String[] iops = { ${SIGNED_DIVIDE_OPERATORS.map(o => `"${o}"`).join(', ')} };
              int[] icount = new int[iops.length];
              StringBuilder isites = new StringBuilder();
              for (ghidra.app.decompiler.ClangNode n : toks) {
                if (!(n instanceof ghidra.app.decompiler.ClangOpToken)) continue;
                ghidra.app.decompiler.ClangOpToken t = (ghidra.app.decompiler.ClangOpToken) n;
                int ii = -1;
                for (int k = 0; k < iops.length; k++) if (iops[k].equals(t.getText())) ii = k;
                if (ii < 0) continue;
                int iord = icount[ii]++;
                ghidra.program.model.pcode.PcodeOp op = t.getPcodeOp();
                if (op == null || op.getSeqnum() == null) continue;
                ghidra.program.model.listing.Instruction ins = L.getInstructionAt(op.getSeqnum().getTarget());
                if (ins != null && ins.getMnemonicString().equalsIgnoreCase("IDIV")) isites.append(';').append(ii).append(':').append(iord);
              }
              if (isites.length() > 0) {
                for (int k = 0; k < iops.length; k++) irow.append(k > 0 ? "," : "").append(icount[k]);
                irow.append(isites);
              }
            }
          } catch (Exception ie) { irow.setLength(0); }
`;

/**
 * Whether a decompile prints a division of a cast value by a constant, the only shape the
 * facts serve: `(uint)p->wYear % 100`.
 */
export function printsCastDividend(decompiled: string): boolean {
  return /\((?:uint|uint32_t|UINT|DWORD|dword|undefined4)\)\s*[\w.>\-[\]]+\s*[/%]\s*(?:0x[0-9a-f]+|\d+)\b/i.test(decompiled);
}

/** One function's row, parsed; null when malformed. */
export function parseSignedDivideRow(row: string): SignedDivideFacts | null {
  const parts = row.split(';');
  const raw = parts[0].split(',');
  if (raw.length !== SIGNED_DIVIDE_OPERATORS.length || !raw.every(c => /^\d+$/.test(c))) return null;
  const counts: Record<string, number> = {};
  SIGNED_DIVIDE_OPERATORS.forEach((o, k) => { counts[o] = Number(raw[k]); });
  const sites: SignedDivideSite[] = [];
  for (const p of parts.slice(1)) {
    const m = /^(\d+):(\d+)$/.exec(p);
    if (!m) return null;
    const operator = SIGNED_DIVIDE_OPERATORS[Number(m[1])];
    const ord = Number(m[2]);
    if (operator === undefined || ord >= counts[operator]) return null;
    sites.push({ operator, ord });
  }
  return sites.length > 0 ? { counts, sites } : null;
}
