/**
 * The instructions behind three arithmetic spellings the decompiler normalises, per line.
 *
 *   `*`       Ghidra prints a left shift by a constant as a multiply (`(uint)b * 0x100`). VC8
 *             compiles the two spellings differently where it can: `b << 8` of a byte loads
 *             it into the high byte of a zeroed register (`xor edx, edx; mov dh, b`), `b * 0x100`
 *             zero-extends and shifts (OBJECT_ClientFn_OperateToOpened 004bde00). The instruction
 *             the op came from says which the original computed: a SHL by the constant's log2,
 *             or a byte MOV into a high-byte register the block zeroed, is a shift.
 *   `+`       Ghidra prints `x + (a + b)` as `x + a + b`: INT_ADD is associative to its printer,
 *             so the nesting is lost from the text while the p-code keeps it. The original's
 *             `add eax, ebx; add [ecx + 8], eax` (SKILLS_AddRandomSkillDamage 0056e170) sums `a`
 *             and `b` first. Recorded per `+` token: which other `+` token of the line takes its
 *             op's output as an input.
 *   CONCAT    a CONCATnm whose result the p-code only widens (an INT_ZEXT, or the high part of a
 *             larger PIECE), at an instruction that is no 16/8-bit zero-extension or mask: the
 *             original built the value in a full register and never truncated it
 *             (DRAW_SetTransparentColorRGB 00605320: `movzx ecx, ah; mov ch, al; ...; shl ecx, 8`).
 *
 * The row is `lineCount \t line:item|item;line:...`, the items in token order on the line:
 *
 *   m<k><e>   a binary `*` (INT_MULT/FLOAT_MULT) with the constant 2^k (k in hex); e is `s` (a SHL
 *             by k), `h` (a byte MOV into a high-byte register zeroed just before), `x` other
 *   m-        a binary `*` with no power-of-two constant
 *   a<j><w>[d<i>.<name>]
 *             a binary `+` (INT_ADD, PTRADD, FLOAT_ADD); j is the index, among the line's `+`
 *             tokens, of the one whose op reads this op's output directly, or `-`; w is `i` for a
 *             4-byte INT_ADD, `p` for a PTRADD, `f` other. `d` when the op is a two-operand ADD
 *             whose destination is the register its input i, the variable <name>, lives in:
 *             VC8 adds in place into a variable's register only when the source updated that
 *             variable (`a += b; x += a`), and makes the sum of a dead `a` in a fresh one
 *             (`lea edx, [eax + ebx]` for `x += a + b`)
 *   c<n><w>   a CONCAT token of n bytes; w is `w` (only widened, see above) or `n`
 *
 * Lines are the lines of the snapshot's decompile text (`DecompilerUtils.toLines`, as
 * extract/rotate-sites.ts); `lineCount` lets the consumer reject another text.
 *
 * Read-only: part of the per-function facts script (function-facts.ts), no transaction. A
 * failure leaves the field unset, which is also what an older snapshot looks like; the passes
 * then change nothing.
 */

export type ArithItem =
  | { kind: 'mul'; log2?: number; evidence?: 'shift' | 'highbyte' | 'other' }
  | { kind: 'add'; consumer?: number; width: 'int' | 'ptr' | 'other'; into?: { input: number; name: string } }
  | { kind: 'concat'; bytes: number; widened: boolean };

export interface ArithSiteFacts {
  lineCount: number;
  /** Decompile line -> its items, in token order. */
  lines: [number, ArithItem[]][];
}

/** Java fragment declared before the line loop of the facts script. */
export const ARITH_SITES_DECL_JAVA = `
          StringBuilder prow = new StringBuilder();
`;

/** Java fragment declared at the top of each line, before its tokens. */
export const ARITH_SITES_LINE_DECL_JAVA = `
            java.util.List<String> pItems = new java.util.ArrayList<>();
            java.util.List<ghidra.program.model.pcode.PcodeOp> pAddOps = new java.util.ArrayList<>();
            java.util.List<Integer> pAddItem = new java.util.ArrayList<>();
`;

/** Java fragment run per token of the line, with `t` and `L` in scope. */
export const ARITH_SITES_TOKEN_JAVA = `
              if (t instanceof ghidra.app.decompiler.ClangOpToken) {
                String ptx = t.getText();
                ghidra.program.model.pcode.PcodeOp pop = ((ghidra.app.decompiler.ClangOpToken) t).getPcodeOp();
                int pc = pop == null ? -1 : pop.getOpcode();
                if (ptx.equals("*") && pop != null && pop.getNumInputs() == 2
                    && (pc == ghidra.program.model.pcode.PcodeOp.INT_MULT || pc == ghidra.program.model.pcode.PcodeOp.FLOAT_MULT)) {
                  ghidra.program.model.pcode.Varnode pk = pop.getInput(1).isConstant() ? pop.getInput(1) : pop.getInput(0).isConstant() ? pop.getInput(0) : null;
                  long pv = pk == null || pc != ghidra.program.model.pcode.PcodeOp.INT_MULT ? 0 : pk.getOffset();
                  if (pv > 1 && (pv & (pv - 1)) == 0) {
                    int plog = Long.numberOfTrailingZeros(pv);
                    char pe = 'x';
                    ghidra.program.model.listing.Instruction pi = L.getInstructionAt(pop.getSeqnum().getTarget());
                    if (pi != null) {
                      String pm = pi.getMnemonicString().toUpperCase();
                      ghidra.program.model.lang.Register pr = pi.getNumOperands() == 2 ? pi.getRegister(0) : null;
                      if (pm.equals("SHL") && pr != null && pi.getScalar(1) != null && pi.getScalar(1).getUnsignedValue() == plog) pe = 's';
                      else if (pm.equals("MOV") && plog == 8 && pr != null && pr.getBitLength() == 8 && pr.getName().endsWith("H")) {
                        ghidra.program.model.listing.Instruction pz = L.getInstructionBefore(pi.getAddress());
                        ghidra.program.model.lang.Register pw = pr.getBaseRegister();
                        if (pz != null && pz.getFallThrough() != null && pz.getFallThrough().equals(pi.getAddress())
                            && pz.getMnemonicString().toUpperCase().equals("XOR") && pz.getNumOperands() == 2
                            && pz.getRegister(0) != null && pz.getRegister(0).equals(pz.getRegister(1))
                            && pz.getRegister(0).getBaseRegister().equals(pw)) pe = 'h';
                      }
                    }
                    pItems.add("m" + Integer.toHexString(plog) + pe);
                  } else pItems.add("m-");
                } else if (ptx.equals("+") && pop != null && pop.getNumInputs() >= 2
                    && (pc == ghidra.program.model.pcode.PcodeOp.INT_ADD || pc == ghidra.program.model.pcode.PcodeOp.PTRADD || pc == ghidra.program.model.pcode.PcodeOp.FLOAT_ADD)) {
                  char pw = pc == ghidra.program.model.pcode.PcodeOp.PTRADD ? 'p'
                    : pc == ghidra.program.model.pcode.PcodeOp.INT_ADD && pop.getOutput() != null && pop.getOutput().getSize() == 4 ? 'i' : 'f';
                  // A two-operand ADD into the register an input variable lives in: the sum
                  // overwrote that variable's register.
                  String pdst = "";
                  ghidra.program.model.listing.Instruction pai = L.getInstructionAt(pop.getSeqnum().getTarget());
                  if (pw == 'i' && pai != null && pai.getMnemonicString().toUpperCase().equals("ADD") && pai.getNumOperands() == 2
                      && pai.getRegister(0) != null && pai.getRegister(0).getBitLength() == 32) {
                    ghidra.program.model.lang.Register pdr = pai.getRegister(0);
                    for (int pin = 0; pin < 2 && pdst.length() == 0; pin++) {
                      ghidra.program.model.pcode.Varnode pv2 = pop.getInput(pin);
                      if (pv2.isRegister() && pv2.getSize() == 4 && pv2.getAddress().equals(pdr.getAddress())
                          && pv2.getHigh() != null && pv2.getHigh().getSymbol() != null && pv2.getHigh().getSymbol().getName().matches("[A-Za-z_][A-Za-z0-9_]*"))
                        pdst = "d" + pin + "." + pv2.getHigh().getSymbol().getName();
                    }
                  }
                  pAddOps.add(pop);
                  pAddItem.add(pItems.size());
                  pItems.add("a?" + pw + pdst);
                } else if (ptx.startsWith("CONCAT") && pop != null && pc == ghidra.program.model.pcode.PcodeOp.PIECE && pop.getOutput() != null) {
                  ghidra.program.model.pcode.Varnode po = pop.getOutput();
                  boolean pwide = po.getDescendants().hasNext();
                  java.util.Iterator<ghidra.program.model.pcode.PcodeOp> pd = po.getDescendants();
                  while (pd.hasNext()) {
                    ghidra.program.model.pcode.PcodeOp d = pd.next();
                    int dc = d.getOpcode();
                    boolean widens = d.getOutput() != null && d.getOutput().getSize() > po.getSize()
                      && (dc == ghidra.program.model.pcode.PcodeOp.INT_ZEXT || (dc == ghidra.program.model.pcode.PcodeOp.PIECE && d.getInput(0) == po));
                    ghidra.program.model.listing.Instruction di2 = L.getInstructionAt(d.getSeqnum().getTarget());
                    if (widens && di2 != null) {
                      String dm = di2.getMnemonicString().toUpperCase();
                      if (dm.equals("MOVZX") && di2.getNumOperands() == 2 && di2.getRegister(1) != null && di2.getRegister(1).getBitLength() < 32) widens = false;
                      if (dm.equals("AND") && di2.getNumOperands() == 2 && di2.getScalar(1) != null
                          && (di2.getScalar(1).getUnsignedValue() == 0xffff || di2.getScalar(1).getUnsignedValue() == 0xff)) widens = false;
                    }
                    if (!widens) pwide = false;
                  }
                  pItems.add("c" + po.getSize() + (pwide ? 'w' : 'n'));
                }
              }
`;

/** Java fragment run once per line after its tokens, with `l` in scope. */
export const ARITH_SITES_LINE_JAVA = `
            if (!pItems.isEmpty()) {
              for (int pa = 0; pa < pAddOps.size(); pa++) {
                ghidra.program.model.pcode.Varnode pout = pAddOps.get(pa).getOutput();
                String pj = "-";
                for (int pb = 0; pb < pAddOps.size() && pout != null; pb++) {
                  if (pb == pa) continue;
                  ghidra.program.model.pcode.PcodeOp q = pAddOps.get(pb);
                  for (int qi = 0; qi < q.getNumInputs(); qi++) if (q.getInput(qi) == pout) pj = Integer.toString(pb);
                }
                int at = pAddItem.get(pa);
                pItems.set(at, "a" + pj + pItems.get(at).substring(2));
              }
              prow.append(prow.length() > 0 ? ";" : "").append(l.getLineNumber()).append(':').append(String.join("|", pItems));
            }
`;

/** Whether a decompile prints one of the spellings the row is about. */
export function printsArithSite(decompiled: string): boolean {
  return /\*\s*(?:0x[0-9a-f]+|\d+)\b/i.test(decompiled) || /\bCONCAT\d/.test(decompiled) || /\+[^;\n]*\+/.test(decompiled);
}

/** A `P` row's fields after the entry, parsed; null when malformed or empty. */
export function parseArithSiteRow(row: string): ArithSiteFacts | null {
  const c = row.replace(/\r$/, '').split('\t');
  if (c.length !== 2 || !/^\d+$/.test(c[0]) || !c[1]) return null;
  const lines: [number, ArithItem[]][] = [];
  for (const part of c[1].split(';')) {
    const m = /^(\d+):(.+)$/.exec(part);
    if (!m) return null;
    const items: ArithItem[] = [];
    for (const s of m[2].split('|')) {
      let r: RegExpExecArray | null;
      if (s === 'm-') items.push({ kind: 'mul' });
      else if ((r = /^m([0-9a-f]{1,2})([shx])$/.exec(s))) {
        const log2 = Number.parseInt(r[1], 16);
        if (log2 < 1 || log2 > 63) return null;
        items.push({ kind: 'mul', log2, evidence: r[2] === 's' ? 'shift' : r[2] === 'h' ? 'highbyte' : 'other' });
      } else if ((r = /^a(-|\d+)([ipf])(?:d([01])\.([A-Za-z_]\w*))?$/.exec(s))) {
        items.push({
          kind: 'add', ...(r[1] !== '-' ? { consumer: Number(r[1]) } : {}), width: r[2] === 'i' ? 'int' : r[2] === 'p' ? 'ptr' : 'other',
          ...(r[3] !== undefined ? { into: { input: Number(r[3]), name: r[4] } } : {}),
        });
      } else if ((r = /^c(\d+)([wn])$/.exec(s))) {
        items.push({ kind: 'concat', bytes: Number(r[1]), widened: r[2] === 'w' });
      } else return null;
    }
    lines.push([Number(m[1]), items]);
  }
  return { lineCount: Number(c[0]), lines };
}
