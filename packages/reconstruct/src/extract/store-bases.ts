/**
 * The register each store of the original is addressed off, and the register each address
 * the original computes with an LEA lands in, per `=` of a decompile line.
 *
 * An inlined member function of a sub-object addresses the sub-object's members off its
 * `this`, the sub-object's address in a register: `lea edx, [eax + 4]` then `mov [edx], 0`,
 * `mov [edx + 4], 0` (TSExplicitList<CELLIST>::CopyConstructor 006023b0). The decompiler
 * hands the address back as a local, `pLink = &this->m_terminator`, but prints some of the
 * members through the outer object again, `(this->m_terminator).m_next = 0`, and the same
 * function stores another member of the same object off the outer one (`mov [eax + 8], edx`,
 * the final `m_next`). Which spelling each store needs is in the store's instruction only.
 *
 * The walk is over the line's `=` tokens, numbered in print order as access-order.ts numbers
 * them. A token is recorded when its op is a STORE whose instruction is a MOV to memory
 * addressed off one register (`s`, that register and the displacement), or when its
 * instruction is an LEA (`l`, the LEA's destination register). The row is
 *
 *   lineCount \t line:ord.s.REG.disp|ord.l.REG;line:...
 *
 * with disp in signed hex. Lines are the lines of the snapshot's decompile text
 * (`DecompilerUtils.toLines`); `lineCount` lets the consumer reject another text.
 *
 * Read-only: part of the per-function facts script (function-facts.ts), no transaction. A
 * failure leaves the field unset, which is also what an older snapshot looks like; the pass
 * then changes nothing.
 */

export interface StoreBase {
  /** Index of the `=` among the line's `=` tokens. */
  ord: number;
  /** `s`: a MOV to memory off `reg` + `disp`; `l`: an LEA into `reg`. */
  kind: 's' | 'l';
  /** The 32-bit register's name, upper case. */
  reg: string;
  /** For `s`, the memory operand's displacement; 0 for `l`. */
  disp: number;
}

export interface StoreBaseFacts {
  lineCount: number;
  /** Decompile line -> its recorded `=` tokens, in print order. */
  lines: [number, StoreBase[]][];
}

/** Java fragment declared before the line loop of the facts script. */
export const STORE_BASES_DECL_JAVA = `
          StringBuilder wrow = new StringBuilder();
`;

/** Java fragment declared at the top of each line of the line loop. */
export const STORE_BASES_LINE_DECL_JAVA = `
            StringBuilder wone = new StringBuilder();
            int wOrd = 0;
`;

/** Java fragment run per token of the line loop, with `t`, `L` and `base` in scope. */
export const STORE_BASES_TOKEN_JAVA = `
              if (t instanceof ghidra.app.decompiler.ClangOpToken && t.getText().equals("=")) {
                int word = wOrd++;
                ghidra.program.model.pcode.PcodeOp wop = ((ghidra.app.decompiler.ClangOpToken) t).getPcodeOp();
                ghidra.program.model.listing.Instruction wi = wop == null ? null : L.getInstructionAt(wop.getSeqnum().getTarget());
                if (wi != null && wi.getNumOperands() == 2) {
                  String wm = wi.getMnemonicString().toUpperCase();
                  if (wop.getOpcode() == ghidra.program.model.pcode.PcodeOp.STORE && wm.equals("MOV")
                      && !ghidra.program.model.lang.OperandType.isRegister(wi.getOperandType(0))) {
                    ghidra.program.model.lang.Register wr = null;
                    int wn = 0;
                    long wd = 0;
                    for (Object wx : wi.getOpObjects(0)) {
                      if (wx instanceof ghidra.program.model.lang.Register) { wr = (ghidra.program.model.lang.Register) wx; wn++; }
                      else if (wx instanceof ghidra.program.model.scalar.Scalar) wd = ((ghidra.program.model.scalar.Scalar) wx).getSignedValue();
                    }
                    if (wn == 1 && wr.getBitLength() == 32) {
                      wone.append(wone.length() > 0 ? "|" : "").append(word).append(".s.").append(wr.getName()).append('.')
                        .append(wd < 0 ? "-" + Long.toHexString(-wd) : Long.toHexString(wd));
                    }
                  } else if (wm.equals("LEA") && wi.getRegister(0) != null && wi.getRegister(0).getBitLength() == 32) {
                    wone.append(wone.length() > 0 ? "|" : "").append(word).append(".l.").append(wi.getRegister(0).getName());
                  }
                }
              }
`;

/** Java fragment run once per line after its tokens, with `l` in scope. */
export const STORE_BASES_LINE_JAVA = `
            if (wone.length() > 0) wrow.append(wrow.length() > 0 ? ";" : "").append(l.getLineNumber()).append(':').append(wone);
`;

/** Whether a decompile takes the address of a member, the only shape the facts serve. */
export function printsMemberAddress(decompiled: string): boolean {
  return /=\s*(?:\([\w\s*<>,:]+\)\s*)?&\(?\w+(?:->|\.)/.test(decompiled);
}

/** A `W` row's fields after the entry, parsed; null when malformed or empty. */
export function parseStoreBaseRow(row: string): StoreBaseFacts | null {
  const c = row.replace(/\r$/, '').split('\t');
  if (c.length !== 2 || !/^\d+$/.test(c[0]) || !c[1]) return null;
  const lines: [number, StoreBase[]][] = [];
  for (const part of c[1].split(';')) {
    const m = /^(\d+):(.+)$/.exec(part);
    if (!m) return null;
    const sites: StoreBase[] = [];
    for (const s of m[2].split('|')) {
      const r = /^(\d+)\.(?:s\.([A-Z]{2,3})\.(-?[0-9a-f]+)|l\.([A-Z]{2,3}))$/.exec(s);
      if (!r) return null;
      if (r[2]) {
        const d = r[3].startsWith('-') ? -Number.parseInt(r[3].slice(1), 16) : Number.parseInt(r[3], 16);
        sites.push({ ord: Number(r[1]), kind: 's', reg: r[2], disp: d });
      } else sites.push({ ord: Number(r[1]), kind: 'l', reg: r[4], disp: 0 });
    }
    lines.push([Number(m[1]), sites]);
  }
  return { lineCount: Number(c[0]), lines };
}
