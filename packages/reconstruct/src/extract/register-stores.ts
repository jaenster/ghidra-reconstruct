/**
 * The assignments of a constant to memory the original stores from a register.
 *
 * VC8 stores a constant with an immediate operand (`mov dword ptr [esi], 0`) unless the value
 * reaches the store in a register: then it loads the register first (`xor eax, eax`,
 * `or ecx, 0xffffffff`, `mov eax, 1`) and stores that. The register is the home of a value
 * the source merged before the store, `p->x = c ? E : 0` or a local set on two paths, which
 * VC8 copies into each tail with the store (MONSTER_SetMonStatsTxtAndType 004ae0a0,
 * SBIG_BigBuffer_GetFirstWord 00421510, Q04_SetRescueTrigger 00592f80). The decompiler
 * propagates the constant into each copy and prints `p->x = 0;`, the same text as an
 * immediate store; the instruction tells them apart.
 *
 * The walk is over the markup's `=` tokens. A token is a site when its op is a STORE (value
 * input 2) or a COPY (input 0) of a constant of at most 4 bytes, and the instruction behind
 * the op is a two-operand MOV whose destination is not a register. The row is
 *
 *   name:size:value:how;...
 *
 *   name   the variable or field token the left side ends in (`pMonStatsTxt` of
 *          `pDVar1->pMonStatsTxt`, `pOutWord` of `*pOutWord`); a site whose left side ends in
 *          anything else (`]`, `)`) is not recorded
 *   size   the constant's size in bytes
 *   value  the constant, hex, masked to its size
 *   how    `r` the MOV stores a register the nearest earlier write in straight-line code
 *          loaded with the constant (XOR/SUB r,r, OR r,-1, MOV r,imm), `k` a register holding
 *          the value otherwise (a pointer just tested for zero, ANIM_GetEventFrame 006634c0:
 *          VC8's own reuse, not the source's), `i` an immediate
 *
 * in text order. The row is kept only when it has an `r` site. The pass ties a store to its
 * site by name and value; where the original stores one name and value both ways
 * (SBIG_BigBuffer_GetFirstWord: `*pOutWord = 0` first as an immediate, then in the tail from
 * EAX), by their order among the stores of that name and value, and only when the body has
 * exactly as many.
 *
 * Read-only: part of the per-function facts script (function-facts.ts), no transaction. A
 * failure leaves the field unset, which is also what an older snapshot looks like; the pass
 * then changes nothing.
 */

export interface RegisterStore {
  /** The variable or field name the assignment's left side ends in. */
  name: string;
  /** The constant's size in bytes (1, 2 or 4). */
  size: number;
  /** The constant, masked to its size. */
  value: number;
  /** The original stores it from a register loaded with it (true), or otherwise (false). */
  register: boolean;
}

export type RegisterStoreFacts = RegisterStore[];

/**
 * Java fragment, run per function inside the facts script with `toks` (the flattened markup),
 * `ctext` and `L` (the listing) in scope. Leaves the row in `krow`; empty when the decompile
 * did not complete or no site stores a register.
 */
export const REGISTER_STORES_JAVA = `
          StringBuilder krow = new StringBuilder();
          try {
            if (ctext != null) {
              boolean kreg = false;
              for (int ki = 0; ki < toks.size(); ki++) {
                ghidra.app.decompiler.ClangNode kn = toks.get(ki);
                if (!(kn instanceof ghidra.app.decompiler.ClangOpToken)) continue;
                if (!"=".equals(((ghidra.app.decompiler.ClangOpToken) kn).getText())) continue;
                ghidra.program.model.pcode.PcodeOp kop = ((ghidra.app.decompiler.ClangOpToken) kn).getPcodeOp();
                if (kop == null) continue;
                ghidra.program.model.pcode.Varnode kv = null;
                if (kop.getOpcode() == ghidra.program.model.pcode.PcodeOp.STORE && kop.getNumInputs() == 3) kv = kop.getInput(2);
                else if (kop.getOpcode() == ghidra.program.model.pcode.PcodeOp.COPY && kop.getNumInputs() == 1) kv = kop.getInput(0);
                if (kv == null || !kv.isConstant() || kv.getSize() > 4) continue;
                ghidra.program.model.listing.Instruction kins = L.getInstructionAt(kop.getSeqnum().getTarget());
                if (kins == null || !kins.getMnemonicString().equalsIgnoreCase("MOV") || kins.getNumOperands() != 2) continue;
                if (kins.getRegister(0) != null) continue;
                String khow;
                ghidra.program.model.lang.Register ksrc = kins.getRegister(1);
                if (ksrc != null) {
                  // r only when the register was loaded with the constant: the nearest earlier
                  // write to it in straight-line code is XOR/SUB r,r, OR r,-1 or MOV r,imm.
                  // A register VC8 knows to hold the value (a pointer it just tested for zero,
                  // ANIM_GetEventFrame 006634c0) is k.
                  khow = "k";
                  ghidra.program.model.lang.Register kbase = ksrc.getBaseRegister();
                  ghidra.program.model.listing.Instruction kp = kins;
                  for (int kd = 0; kd < 8; kd++) {
                    if (kp.getReferenceIteratorTo().hasNext()) break;
                    kp = kp.getPrevious();
                    if (kp == null || !fn.getBody().contains(kp.getAddress())) break;
                    if (kp.getFlowType().isJump() || kp.getFlowType().isCall() || kp.getFlowType().isTerminal()) break;
                    ghidra.program.model.lang.Register kw = kp.getNumOperands() > 0 ? kp.getRegister(0) : null;
                    if (kw == null || !kw.getBaseRegister().equals(kbase)) continue;
                    String km = kp.getMnemonicString().toUpperCase();
                    ghidra.program.model.lang.Register kw1 = kp.getNumOperands() > 1 ? kp.getRegister(1) : null;
                    ghidra.program.model.scalar.Scalar ks = kp.getNumOperands() > 1 ? kp.getScalar(1) : null;
                    if ((km.equals("XOR") || km.equals("SUB")) && kw1 != null && kw1.equals(kw)) khow = "r";
                    else if (km.equals("OR") && ks != null && ks.getSignedValue() == -1) khow = "r";
                    else if (km.equals("MOV") && ks != null) khow = "r";
                    break;
                  }
                }
                else if (kins.getScalar(1) != null) khow = "i";
                else continue;
                String kname = null;
                for (int kj = ki - 1; kj >= 0; kj--) {
                  ghidra.app.decompiler.ClangNode kp = toks.get(kj);
                  if (!(kp instanceof ghidra.app.decompiler.ClangToken)) continue;
                  String kt = ((ghidra.app.decompiler.ClangToken) kp).getText();
                  if (kt == null || kt.trim().isEmpty()) continue;
                  if (kp instanceof ghidra.app.decompiler.ClangVariableToken || kp instanceof ghidra.app.decompiler.ClangFieldToken) kname = kt;
                  break;
                }
                if (kname == null || kname.indexOf(':') >= 0 || kname.indexOf(';') >= 0) continue;
                long kc = kv.getOffset() & ((1L << (8 * kv.getSize())) - 1);
                if (khow.equals("r")) kreg = true;
                krow.append(krow.length() > 0 ? ";" : "").append(kname).append(':').append(kv.getSize()).append(':')
                  .append(Long.toHexString(kc)).append(':').append(khow);
              }
              if (!kreg) krow.setLength(0);
            }
          } catch (Exception ke) { krow.setLength(0); }
`;

/** Whether a decompile prints an assignment of an integer literal, possibly cast. */
export function printsConstantStore(decompiled: string): boolean {
  return /[^=!<>]=\s*(?:\([\w\s*]+\)\s*)?-?(?:0x[0-9a-f]+|\d+)\s*;/i.test(decompiled);
}

/** One function's row, parsed; empty when malformed or without a register store. */
export function parseRegisterStoreRow(row: string): RegisterStoreFacts {
  const out: RegisterStoreFacts = [];
  for (const part of row.split(';')) {
    const m = /^([A-Za-z_]\w*):([124]):([0-9a-f]+):([rik])$/.exec(part);
    if (!m) return [];
    out.push({ name: m[1], size: Number(m[2]), value: Number.parseInt(m[3], 16), register: m[4] === 'r' });
  }
  return out.some(s => s.register) ? out : [];
}
