/**
 * The calls whose result the original divides by a power of two right after they return,
 * per decompile line.
 *
 * VC8 divides a signed int by 2^n as `cdq; sub eax, edx; sar eax, 1` (n = 1) or
 * `cdq; and edx, 2^n - 1; add eax, edx; sar eax, n`. Where the source divides a call's
 * result in its assignment (`w = DRAW_text0(s) / 2;`), the division follows the CALL at once;
 * where it divides at a later use, VC8 schedules it among that statement's argument pushes
 * (`call; cdq; push 0; sub eax, edx`). The decompiler prints both as `w = f(s);` and `w / 2`
 * at the use (DRAW_UI_HelpXpac 00495410); the instructions after the CALL tell them apart.
 *
 * The walk is over the line's call tokens, as the access-order row reads them: a CALL whose
 * next instruction is CDQ and whose one after is SUB EAX,EDX (k = 2) or AND EDX,imm (k = imm +
 * 1, a power of two). The row is
 *
 *   lineCount \t line:name,k|...;line:...
 *
 * with name the callee as the decompile prints it and k in hex. Lines are the lines of the
 * snapshot's decompile text (`DecompilerUtils.toLines`, as extract/access-order.ts).
 *
 * Read-only: part of the per-function facts script (function-facts.ts), no transaction. A
 * failure leaves the field unset, which is also what an older snapshot looks like; the pass
 * then changes nothing.
 */

export interface CallDivide {
  /** The callee's name as the decompile prints it. */
  name: string;
  /** The divisor, a power of two from 2. */
  k: number;
}

export interface CallDivideFacts {
  lineCount: number;
  /** Decompile line -> its calls divided at once. */
  lines: [number, CallDivide[]][];
}

/** Java fragment declared before the line loop of the facts script. */
export const CALL_DIVIDES_DECL_JAVA = `
          StringBuilder vrow = new StringBuilder();
`;

/** Java fragment declared at the start of each line of the line loop. */
export const CALL_DIVIDES_LINE_DECL_JAVA = `
            StringBuilder vone = new StringBuilder();
`;

/** Java fragment run per token of a line, with `t`, `L` and `fn` in scope. */
export const CALL_DIVIDES_TOKEN_JAVA = `
              if (t instanceof ghidra.app.decompiler.ClangFuncNameToken && t.getPcodeOp() != null
                  && t.getPcodeOp().getOpcode() == ghidra.program.model.pcode.PcodeOp.CALL) {
                ghidra.program.model.listing.Instruction vci = L.getInstructionAt(t.getPcodeOp().getSeqnum().getTarget());
                ghidra.program.model.listing.Instruction vc = vci == null ? null : vci.getNext();
                ghidra.program.model.listing.Instruction vd = vc == null ? null : vc.getNext();
                if (vci != null && vci.getFlowType().isCall() && vc != null && vd != null
                    && fn.getBody().contains(vd.getAddress()) && vc.getMnemonicString().equalsIgnoreCase("CDQ")
                    && vd.getNumOperands() == 2) {
                  String vm = vd.getMnemonicString().toUpperCase();
                  ghidra.program.model.lang.Register v0 = vd.getRegister(0), v1 = vd.getRegister(1);
                  long vk = 0;
                  if (vm.equals("SUB") && v0 != null && v1 != null && v0.getName().equals("EAX") && v1.getName().equals("EDX")) vk = 2;
                  else if (vm.equals("AND") && v0 != null && v0.getName().equals("EDX") && v1 == null && vd.getScalar(1) != null) vk = vd.getScalar(1).getUnsignedValue() + 1;
                  if (vk >= 2 && (vk & (vk - 1)) == 0) vone.append(vone.length() > 0 ? "|" : "").append(t.getText()).append(',').append(Long.toHexString(vk));
                }
              }
`;

/** Java fragment run once per line after its tokens. */
export const CALL_DIVIDES_LINE_JAVA = `
            if (vone.length() > 0) vrow.append(vrow.length() > 0 ? ";" : "").append(l.getLineNumber()).append(':').append(vone);
`;

/** Whether a decompile prints a division by a power of two, the only use the facts serve. */
export function printsHalvedValue(decompiled: string): boolean {
  return /\/\s*(?:0x[0-9a-f]+|\d+)\b/i.test(decompiled) && decompiled.includes('(');
}

/** A `V` row's fields after the entry, parsed; null when malformed or empty. */
export function parseCallDivideRow(row: string): CallDivideFacts | null {
  const c = row.replace(/\r$/, '').split('\t');
  if (c.length !== 2 || !/^\d+$/.test(c[0]) || !c[1]) return null;
  const lines: [number, CallDivide[]][] = [];
  for (const part of c[1].split(';')) {
    const m = /^(\d+):(.+)$/.exec(part);
    if (!m) return null;
    const sites: CallDivide[] = [];
    for (const s of m[2].split('|')) {
      const r = /^([A-Za-z_~][\w~<>:,]*?),([0-9a-f]+)$/.exec(s);
      if (!r) return null;
      const k = Number.parseInt(r[2], 16);
      if (k < 2 || (k & (k - 1)) !== 0) return null;
      sites.push({ name: r[1], k });
    }
    lines.push([Number(m[1]), sites]);
  }
  return { lineCount: Number(c[0]), lines };
}
