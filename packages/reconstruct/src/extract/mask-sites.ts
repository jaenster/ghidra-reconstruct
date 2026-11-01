/**
 * The byte and word masks of a decompile, tied to the instruction that computed each one.
 *
 * VC8 compiles a cast to a narrow unsigned type, `(WORD)nPacked`, to `movzx ecx, cx`, and the
 * mask `nPacked & 0xffff` to `and ecx, 0xffff`. The decompiler prints both as the mask: it
 * folds the zero extension of a register's low part into an INT_AND, which keeps the
 * address of the MOVZX. DRLGPATH_GetDirectionLookupFromPacked @0067bbc0:
 *
 *   printed                                      instruction at the op
 *   ... - (nSrcPacked & 0xffff) + (nDstPacked & 0xffff)   movzx ecx, cx / movzx edx, dx
 *
 * The `zero-extend-cast` passes write the cast back where the instruction is a MOVZX.
 *
 * The walk is over the markup's `&` operator tokens whose PcodeOp is an INT_AND, in text
 * order. The row is
 *
 *   count;ord:k:mnemonic:width;...
 *
 *   count     the number of such tokens: the pass ties by position only when the body has
 *             exactly as many binary `&`
 *   ord       the token's position among them
 *   k         the constant input, 0xff or 0xffff (only those are listed), in hex
 *   mnemonic  the instruction at the op's address
 *   width     for a MOVZX, its source operand's size in bytes (`0` for a memory source);
 *             for anything else 0
 *
 * Read-only: part of the per-function facts script (function-facts.ts), no transaction. A
 * failure leaves the field unset, which is also what an older snapshot looks like; the pass
 * then changes nothing. The row is only meaningful for the exact decompile text it was read
 * from, so it is attached behind the same text-hash gate as the compare sites.
 */

export interface MaskSite {
  ord: number;
  /** 0xff or 0xffff. */
  k: number;
  mnemonic: string;
  /** A MOVZX's register source size in bytes; 0 otherwise. */
  width: number;
}

export interface MaskSiteFacts {
  /** The decompile's INT_AND `&` tokens, masked or not. */
  count: number;
  sites: MaskSite[];
}

/**
 * Java fragment, run per function inside the facts script with `toks` (the flattened
 * markup), `L` (the listing) and `ctext` in scope. Leaves the row in `mrow`; empty when the
 * decompile did not complete or prints no byte/word mask.
 */
export const MASK_SITES_JAVA = `
          StringBuilder mrow = new StringBuilder();
          try {
            if (ctext != null) {
              int mord = -1;
              StringBuilder msites = new StringBuilder();
              for (ghidra.app.decompiler.ClangNode n : toks) {
                if (!(n instanceof ghidra.app.decompiler.ClangOpToken)) continue;
                ghidra.app.decompiler.ClangOpToken t = (ghidra.app.decompiler.ClangOpToken) n;
                if (!t.getText().equals("&")) continue;
                ghidra.program.model.pcode.PcodeOp op = t.getPcodeOp();
                if (op == null || op.getOpcode() != ghidra.program.model.pcode.PcodeOp.INT_AND || op.getNumInputs() != 2) continue;
                mord++;
                ghidra.program.model.pcode.Varnode mk = op.getInput(1).isConstant() ? op.getInput(1) : op.getInput(0).isConstant() ? op.getInput(0) : null;
                if (mk == null || (mk.getOffset() != 0xffL && mk.getOffset() != 0xffffL)) continue;
                ghidra.program.model.listing.Instruction mi = L.getInstructionAt(op.getSeqnum().getTarget());
                String mmn = mi == null ? "-" : mi.getMnemonicString();
                int mw = 0;
                if (mi != null && mmn.equals("MOVZX") && mi.getNumOperands() == 2) {
                  ghidra.program.model.lang.Register mrg = mi.getRegister(1);
                  if (mrg != null) mw = mrg.getMinimumByteSize();
                }
                msites.append(';').append(mord).append(':').append(Long.toHexString(mk.getOffset())).append(':').append(mmn).append(':').append(mw);
              }
              if (msites.length() > 0) mrow.append(mord + 1).append(msites);
            }
          } catch (Exception me) { mrow.setLength(0); }
`;

/** Whether a decompile prints a byte or word mask: the functions whose sites are read. */
export function printsByteWordMask(decompiled: string): boolean {
  return /&\s*0xff(?:ff)?\b/.test(decompiled);
}

/** One function's row, parsed; null when malformed. */
export function parseMaskSiteRow(row: string): MaskSiteFacts | null {
  const parts = row.split(';');
  if (!/^\d+$/.test(parts[0])) return null;
  const count = Number(parts[0]);
  const sites: MaskSite[] = [];
  for (const p of parts.slice(1)) {
    const m = /^(\d+):(ff|ffff):([A-Z0-9.-]+):(\d)$/i.exec(p);
    if (!m) return null;
    const ord = Number(m[1]);
    if (ord >= count) return null;
    sites.push({ ord, k: Number.parseInt(m[2], 16), mnemonic: m[3].toUpperCase(), width: Number(m[4]) });
  }
  return sites.length > 0 ? { count, sites } : null;
}
