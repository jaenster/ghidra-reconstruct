/**
 * The rotates by an immediate count the original performs, per decompile line.
 *
 * Ghidra's p-code has no rotate: `rol ecx, 0x1e` is decompiled as the shift pair
 * `x << 0x1e | x >> 2`. VC8 compiles that pair back as the rotate with the smaller count,
 * `ror ecx, 2`, so a rotate the original wrote with a count above 16 (`_rotl(x, 30)`, which
 * VC8 keeps as it is) cannot come back from the printed text: the instruction is the only
 * place the direction survives (Storm SHA1_Round1 00425730). The pair also stands for
 * unrelated code (two shifts of a signed value, Bnclient XSHA1_Transform 005206b0), which a
 * rotate spelling must leave alone; that is what the instruction tells apart.
 *
 * The walk is over the line's tokens, as the branch-layout row collects their offsets: each
 * instruction a token of the line points at that is ROL or ROR of a 32-bit register by an
 * immediate. The row is
 *
 *   lineCount \t line:dc,dc|...;line:...
 *
 * with d `l` (ROL) or `r` (ROR) and c the count in hex, masked to 5 bits as the CPU does, in
 * instruction order. Lines are the lines of the snapshot's decompile text
 * (`DecompilerUtils.toLines`, as extract/access-order.ts); `lineCount` lets the consumer
 * reject another text.
 *
 * Read-only: part of the per-function facts script (function-facts.ts), no transaction. A
 * failure leaves the field unset, which is also what an older snapshot looks like; the pass
 * then changes nothing.
 */

export interface RotateSite {
  /** ROL (true) or ROR (false). */
  left: boolean;
  /** The immediate count, 0..31. */
  count: number;
}

export interface RotateSiteFacts {
  lineCount: number;
  /** Decompile line -> its rotates, in instruction order. */
  lines: [number, RotateSite[]][];
}

/** Java fragment declared before the line loop of the facts script. */
export const ROTATE_SITES_DECL_JAVA = `
          StringBuilder qrow = new StringBuilder();
`;

/**
 * Java fragment, run once per line inside the facts script's line loop after its tokens,
 * with `offs` (the line's token offsets from the entry), `base`, `fn` and `L` in scope.
 */
export const ROTATE_SITES_LINE_JAVA = `
            StringBuilder qone = new StringBuilder();
            for (Long qo : offs) {
              ghidra.program.model.listing.Instruction qi = L.getInstructionAt(fn.getEntryPoint().getNewAddress(base + qo));
              if (qi == null || qi.getNumOperands() != 2) continue;
              String qm = qi.getMnemonicString().toUpperCase();
              if (!qm.equals("ROL") && !qm.equals("ROR")) continue;
              ghidra.program.model.lang.Register qr = qi.getRegister(0);
              ghidra.program.model.scalar.Scalar qs = qi.getScalar(1);
              if (qr == null || qr.getBitLength() != 32 || qs == null || qi.getRegister(1) != null) continue;
              qone.append(qone.length() > 0 ? "|" : "").append(qm.equals("ROL") ? 'l' : 'r').append(Long.toHexString(qs.getUnsignedValue() & 0x1f));
            }
            if (qone.length() > 0) qrow.append(qrow.length() > 0 ? ";" : "").append(l.getLineNumber()).append(':').append(qone);
`;

/** Whether a decompile prints a shift by a constant, the only text a rotate decompiles to. */
export function printsShiftPair(decompiled: string): boolean {
  return /<<\s*(?:0x[0-9a-f]+|\d+)/i.test(decompiled) && />>\s*(?:0x[0-9a-f]+|\d+)/i.test(decompiled);
}

/** A `Q` row's fields after the entry, parsed; null when malformed or empty. */
export function parseRotateSiteRow(row: string): RotateSiteFacts | null {
  const c = row.replace(/\r$/, '').split('\t');
  if (c.length !== 2 || !/^\d+$/.test(c[0]) || !c[1]) return null;
  const lines: [number, RotateSite[]][] = [];
  for (const part of c[1].split(';')) {
    const m = /^(\d+):(.+)$/.exec(part);
    if (!m) return null;
    const sites: RotateSite[] = [];
    for (const s of m[2].split('|')) {
      const r = /^([lr])([0-9a-f]{1,2})$/.exec(s);
      if (!r) return null;
      const count = Number.parseInt(r[2], 16);
      if (count > 31) return null;
      sites.push({ left: r[1] === 'l', count });
    }
    lines.push([Number(m[1]), sites]);
  }
  return { lineCount: Number(c[0]), lines };
}
