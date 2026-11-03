/**
 * The binary operators of a decompile whose 32-bit result the decompiler zero-extends to 64
 * bits and prints as a cast: `(ulonglong)(nRadius * 2 + 1)`.
 *
 * The decompiler prints an INT_ZEXT as a cast only when its own type for the input is
 * unsigned. That type belongs to a temporary the text never declares; in C the expression has
 * the type of its operands, and with a signed `nRadius` the cast is a SIGN extension.
 * MISSILE_CreateRandomSubInRadius @004cea00 and D2Win Draw @005005b0 compile so: a negative
 * value becomes 2^64 - n where the original divided 2^32 - n, and VC8 calls `_aullrem` where
 * the original's `xor edx, edx; div` is 32-bit. The `zext-site` pass tags each such operator
 * and `arith-idioms` writes the cast as `(uint64_t)(uint32_t)(expr)`, the p-code's own value.
 *
 * The walk is over the markup's binary operator tokens, in text order, per operator text. A
 * token is a site when its op's output is a 4-byte temporary (a HighOther, printed inline)
 * read by an INT_ZEXT to 8 bytes. The row is
 *
 *   c0,c1,...,c9;i:ord;...
 *
 *   cN    how many tokens print operator N of ZEXT_OPERATORS: the pass ties by position only
 *         where the body has exactly as many binary operators of that spelling
 *   i     the operator's index in ZEXT_OPERATORS
 *   ord   the token's position among the tokens of that operator
 *
 * Read-only: part of the per-function facts script (function-facts.ts), no transaction. A
 * failure leaves the field unset, which is also what an older snapshot looks like; the pass
 * then changes nothing. Positions in text order are only meaningful for the exact decompile
 * text they were read from, so the row is attached behind the compare-sites text-hash gate.
 */

/** The operator spellings the walk counts, by index. */
export const ZEXT_OPERATORS = ['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>'] as const;

export interface ZextSite {
  /** The operator, one of ZEXT_OPERATORS. */
  operator: string;
  /** The token's position among the decompile's tokens of that operator. */
  ord: number;
}

export interface ZextSiteFacts {
  /** Per operator of ZEXT_OPERATORS, how many tokens print it. */
  counts: Record<string, number>;
  sites: ZextSite[];
}

/**
 * Java fragment, run per function inside the facts script with `toks` (the flattened markup)
 * and `ctext` in scope. Leaves the row in `xrow`; empty when the decompile did not complete or
 * has no such operator.
 */
export const ZEXT_SITES_JAVA = `
          StringBuilder xrow = new StringBuilder();
          try {
            if (ctext != null) {
              final String[] xops = { ${ZEXT_OPERATORS.map(o => `"${o}"`).join(', ')} };
              int[] xcount = new int[xops.length];
              StringBuilder xsites = new StringBuilder();
              for (ghidra.app.decompiler.ClangNode n : toks) {
                if (!(n instanceof ghidra.app.decompiler.ClangOpToken)) continue;
                ghidra.app.decompiler.ClangOpToken t = (ghidra.app.decompiler.ClangOpToken) n;
                int xi = -1;
                for (int k = 0; k < xops.length; k++) if (xops[k].equals(t.getText())) xi = k;
                if (xi < 0) continue;
                int xord = xcount[xi]++;
                ghidra.program.model.pcode.PcodeOp op = t.getPcodeOp();
                if (op == null || op.getNumInputs() != 2) continue;
                ghidra.program.model.pcode.Varnode xo = op.getOutput();
                if (xo == null || xo.getSize() != 4) continue;
                if (!(xo.getHigh() instanceof ghidra.program.model.pcode.HighOther)) continue;
                boolean zext = false;
                java.util.Iterator<ghidra.program.model.pcode.PcodeOp> xd = xo.getDescendants();
                while (xd.hasNext()) {
                  ghidra.program.model.pcode.PcodeOp d = xd.next();
                  if (d.getOpcode() == ghidra.program.model.pcode.PcodeOp.INT_ZEXT && d.getOutput() != null && d.getOutput().getSize() == 8) zext = true;
                }
                if (zext) xsites.append(';').append(xi).append(':').append(xord);
              }
              if (xsites.length() > 0) {
                for (int k = 0; k < xops.length; k++) xrow.append(k > 0 ? "," : "").append(xcount[k]);
                xrow.append(xsites);
              }
            }
          } catch (Exception xe) { xrow.setLength(0); }
`;

/** Whether a decompile prints a cast to an 8-byte integer of a parenthesised expression. */
export function printsZextCast(decompiled: string): boolean {
  return /\((?:u?longlong|U?LONGLONG|u?int64_t|QWORD|undefined8)\)\s*\(/.test(decompiled);
}

/** One function's row, parsed; null when malformed. */
export function parseZextSiteRow(row: string): ZextSiteFacts | null {
  const parts = row.split(';');
  const raw = parts[0].split(',');
  if (raw.length !== ZEXT_OPERATORS.length || !raw.every(c => /^\d+$/.test(c))) return null;
  const counts: Record<string, number> = {};
  ZEXT_OPERATORS.forEach((o, k) => { counts[o] = Number(raw[k]); });
  const sites: ZextSite[] = [];
  for (const p of parts.slice(1)) {
    const m = /^(\d+):(\d+)$/.exec(p);
    if (!m) return null;
    const operator = ZEXT_OPERATORS[Number(m[1])];
    const ord = Number(m[2]);
    if (operator === undefined || ord >= counts[operator]) return null;
    sites.push({ operator, ord });
  }
  return sites.length > 0 ? { counts, sites } : null;
}
