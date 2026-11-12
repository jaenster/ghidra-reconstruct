/**
 * Two facts about the original's memory accesses, per decompile line, read by the combined
 * facts script (function-facts.ts, the `A` row):
 *
 *   args    each direct call with a stack argument a register loaded from memory through
 *           itself and pushed: `mov eax, [eax + 0xc]; push eax`. The parameter index and
 *           the register; the `base-register-load` pass reads them. A register parameter
 *           loaded through its own register (`mov ecx, [ecx + 3]` for a __fastcall) is the
 *           convention's choice and not recorded.
 *   stores  each `=` the line prints, in print order: the offset of the instruction that
 *           stores it (null when the decompiler's op does not name one), the stored size,
 *           for an 8-byte store which half the original wrote first, and how many bytes
 *           the instruction behind the op writes. The `store-order` pass reads the order;
 *           `scalar-piece-arithmetic` reads the width, which tells a piece store the
 *           decompiler prints (`x._0_1_ = v`) the original made as a whole-register or
 *           whole-slot write (`MOV EBX,[EDI]`, `LEA EBX,[EDI+6]`, `MOV dword ptr [EBP-4],6`)
 *           from one it made a byte or word at a time (`MOV byte ptr [EBP-0x20],1`).
 *
 * Lines are numbered as `DecompilerUtils.toLines` numbers them (as extract/call-order.ts),
 * so they are the lines of the snapshot's decompile text; `lineCount` lets the consumer
 * reject another text.
 */

export interface ArgLoadCall {
  /** The callee's name as the decompile prints it (last component). */
  name: string;
  /** The CALL instruction's offset from the function entry. */
  at: number;
  /** The callee's declared parameter count. */
  params: number;
  /** Parameter index -> the 32-bit register that loaded it through itself. */
  loads: { param: number; reg: string }[];
}

export interface StoreSite {
  /** Index of this `=` among the line's `=` tokens. */
  ord: number;
  /** Offset of the store instruction (the first of an 8-byte pair); null when unknown. */
  at: number | null;
  /** Bytes stored; 0 when unknown. */
  size: number;
  /** For an 8-byte store: 'h' when the high half was written first, 'l' when the low. */
  half: 'h' | 'l' | null;
  /**
   * Bytes the instruction behind the `=` writes: its destination register's width, or the
   * size of the memory it stores; 0 when unknown (a call, no instruction, an older
   * snapshot's four-field row).
   */
  width: number;
}

export interface AccessOrderFacts {
  lineCount: number;
  args: [number, ArgLoadCall[]][];
  stores: [number, StoreSite[]][];
}

function offset(s: string): number {
  return s.startsWith('-') ? -parseInt(s.slice(1), 16) : parseInt(s, 16);
}

/**
 * Parse an `A` row's fields after the tag: `entry \t lineCount \t args \t stores`, where
 * args is `line:name,at,paramCount,p@REG.p@REG|...;...` and stores
 * `line:ord,at,size,half,width|...;...` (an older row has no width).
 * Null when the row does not parse.
 */
export function parseAccessOrderRow(row: string): { entry: string; facts: AccessOrderFacts } | null {
  const c = row.replace(/\r$/, '').split('\t');
  if (c.length < 4 || !/^[0-9a-fA-F]{8}$/.test(c[0])) return null;
  const lineCount = Number(c[1]);
  if (!Number.isInteger(lineCount)) return null;
  const args: [number, ArgLoadCall[]][] = [];
  for (const part of c[2] ? c[2].split(';') : []) {
    const i = part.indexOf(':');
    const ln = Number(part.slice(0, i));
    if (!Number.isInteger(ln)) return null;
    const list: ArgLoadCall[] = [];
    for (const one of part.slice(i + 1).split('|')) {
      const f = one.split(',');
      if (f.length !== 4) return null;
      const loads = f[3].split('.').map(x => {
        const [p, reg] = x.split('@');
        return { param: Number(p), reg };
      });
      if (loads.some(l => !Number.isInteger(l.param) || !l.reg)) return null;
      list.push({ name: f[0], at: offset(f[1]), params: Number(f[2]), loads });
    }
    args.push([ln, list]);
  }
  const stores: [number, StoreSite[]][] = [];
  for (const part of c[3] ? c[3].split(';') : []) {
    const i = part.indexOf(':');
    const ln = Number(part.slice(0, i));
    if (!Number.isInteger(ln)) return null;
    const list: StoreSite[] = [];
    for (const one of part.slice(i + 1).split('|')) {
      const f = one.split(',');
      if (f.length !== 4 && f.length !== 5) return null;
      const width = f.length === 5 ? Number(f[4]) : 0;
      list.push({
        ord: Number(f[0]),
        at: f[1] === '?' ? null : offset(f[1]),
        size: Number(f[2]),
        half: f[3] === 'h' || f[3] === 'l' ? f[3] : null,
        width: Number.isInteger(width) && width > 0 ? width : 0,
      });
    }
    stores.push([ln, list]);
  }
  return { entry: c[0].toLowerCase(), facts: { lineCount, args, stores } };
}

/** Whether the decompile prints anything the facts describe: a call or an assignment. */
export function printsAccess(decompiled: string): boolean {
  return /[^=!<>+\-*/%&|^]=[^=]/.test(decompiled) || /\w\s*\(/.test(decompiled);
}

/**
 * Java, spliced into the combined script's per-token loop over a line (function-facts.ts).
 * Uses `t`, `l`, `L`, `rm`, `fm`, `fn`, `base`; appends to `oneArg` and `oneSt` and counts
 * `storeOrd`.
 */
export const ACCESS_ORDER_TOKEN_JAVA = `
              if (t instanceof ghidra.app.decompiler.ClangFuncNameToken && t.getPcodeOp() != null
                  && t.getPcodeOp().getOpcode() == ghidra.program.model.pcode.PcodeOp.CALL) {
                ghidra.program.model.pcode.PcodeOp aop = t.getPcodeOp();
                ghidra.program.model.listing.Instruction aci = L.getInstructionAt(aop.getSeqnum().getTarget());
                ghidra.program.model.listing.Function acallee = aop.getNumInputs() > 0 && aop.getInput(0).isAddress()
                  ? fm.getFunctionAt(aop.getInput(0).getAddress()) : null;
                if (acallee != null && acallee.isThunk()) acallee = acallee.getThunkedFunction(true);
                if (aci != null && aci.getFlowType().isCall() && acallee != null && !acallee.hasVarArgs()) {
                  // The straight-line instructions before the CALL, nearest first.
                  java.util.List<ghidra.program.model.listing.Instruction> aseq = new java.util.ArrayList<>();
                  ghidra.program.model.listing.Instruction acur = aci;
                  for (int ag = 0; ag < 200; ag++) {
                    boolean aent = false;
                    for (ghidra.program.model.symbol.Reference aref : rm.getReferencesTo(acur.getAddress())) if (aref.getReferenceType().isFlow()) { aent = true; break; }
                    if (aent || acur.getAddress().equals(fn.getEntryPoint())) break;
                    ghidra.program.model.listing.Instruction ap = L.getInstructionBefore(acur.getAddress());
                    if (ap == null || ap.getFallThrough() == null || !ap.getFallThrough().equals(acur.getAddress())) break;
                    if (!fn.getBody().contains(ap.getAddress())) break;
                    if (ap.getFlowType().isCall() || ap.getFlowType().isJump() || ap.getFlowType().isTerminal()) break;
                    aseq.add(ap);
                    acur = ap;
                  }
                  java.util.List<Integer> apush = new java.util.ArrayList<>();
                  for (int ak = 0; ak < aseq.size(); ak++) if (aseq.get(ak).getMnemonicString().equals("PUSH")) apush.add(ak);
                  StringBuilder ara = new StringBuilder();
                  int aslot = 0, api = -1;
                  boolean aok = true;
                  for (ghidra.program.model.listing.Parameter aprm : acallee.getParameters()) {
                    api++;
                    ghidra.program.model.listing.VariableStorage avs = aprm.getVariableStorage();
                    ghidra.program.model.lang.Register awant = null;
                    int afrom = 0;
                    // A register parameter's register is the convention's choice, not a reuse.
                    if (avs.isRegisterStorage()) continue;
                    if (avs.isStackStorage()) {
                      int an = (avs.size() + 3) / 4;
                      int aat = aslot;
                      aslot += an;
                      if (an != 1 || aat >= apush.size()) continue;
                      ghidra.program.model.listing.Instruction aps = aseq.get(apush.get(aat));
                      if (!ghidra.program.model.lang.OperandType.isRegister(aps.getOperandType(0)) || aps.getRegister(0) == null) continue;
                      awant = aps.getRegister(0);
                      afrom = apush.get(aat) + 1;
                    } else { aok = false; break; }
                    if (awant == null || awant.getBitLength() != 32) continue;
                    // The nearest write of the register: a load through that same register.
                    for (int ak = afrom; ak < aseq.size(); ak++) {
                      ghidra.program.model.listing.Instruction ad = aseq.get(ak);
                      boolean aw = false;
                      for (Object ro : ad.getResultObjects()) if (ro instanceof ghidra.program.model.lang.Register
                          && (((ghidra.program.model.lang.Register) ro).contains(awant) || awant.contains((ghidra.program.model.lang.Register) ro))) aw = true;
                      if (!aw) continue;
                      String adm = ad.getMnemonicString();
                      if ((adm.equals("MOV") || adm.equals("MOVZX") || adm.equals("MOVSX")) && ad.getNumOperands() == 2
                          && awant.equals(ad.getRegister(0)) && !ghidra.program.model.lang.OperandType.isRegister(ad.getOperandType(1))) {
                        for (Object x : ad.getOpObjects(1)) if (awant.equals(x)) {
                          ara.append(ara.length() > 0 ? "." : "").append(api).append('@').append(awant.getName());
                          break;
                        }
                      }
                      break;
                    }
                  }
                  if (aok && ara.length() > 0) {
                    long aoff = aop.getSeqnum().getTarget().getOffset() - base;
                    oneArg.append(oneArg.length() > 0 ? "|" : "").append(t.getText()).append(',')
                      .append(aoff < 0 ? "-" + Long.toHexString(-aoff) : Long.toHexString(aoff)).append(',')
                      .append(acallee.getParameterCount()).append(',').append(ara);
                  }
                }
              }
              if (t instanceof ghidra.app.decompiler.ClangOpToken && t.getText().equals("=")) {
                int sord = storeOrd++;
                ghidra.program.model.pcode.PcodeOp sop = ((ghidra.app.decompiler.ClangOpToken) t).getPcodeOp();
                String soff = "?", shalf = "-";
                int ssize = 0, swid = 0;
                if (sop != null) {
                  ghidra.program.model.address.Address sat = sop.getSeqnum().getTarget();
                  // The bytes the op's instruction writes: a written destination register's
                  // width, else the size of what it stores. A call's STORE is its return
                  // address, not the value.
                  ghidra.program.model.listing.Instruction swi = L.getInstructionAt(sat);
                  if (swi != null && !swi.getFlowType().isCall() && swi.getNumOperands() >= 1) {
                    ghidra.program.model.lang.Register swr = ghidra.program.model.lang.OperandType.isRegister(swi.getOperandType(0)) ? swi.getRegister(0) : null;
                    boolean swrote = false;
                    if (swr != null) for (Object sro : swi.getResultObjects()) if (swr.equals(sro)) swrote = true;
                    if (swrote) swid = swr.getBitLength() / 8;
                    else if (swr == null) {
                      for (ghidra.program.model.pcode.PcodeOp swp : swi.getPcode()) {
                        if (swp.getOpcode() == ghidra.program.model.pcode.PcodeOp.STORE) swid = swp.getInput(2).getSize();
                      }
                    }
                  }
                  ghidra.program.model.pcode.Varnode sout = sop.getOutput();
                  ghidra.program.model.address.Address gaddr = null;
                  if (sop.getOpcode() == ghidra.program.model.pcode.PcodeOp.STORE) {
                    ghidra.program.model.listing.Instruction si = L.getInstructionAt(sat);
                    ssize = sop.getInput(2).getSize();
                    if (si != null && si.getNumOperands() == 2 && !ghidra.program.model.lang.OperandType.isRegister(si.getOperandType(0))) {
                      soff = Long.toHexString(sat.getOffset() - base);
                      if (ssize == 8) {
                        // Two MOVs to [base] and [base + 4] near it: which half went first.
                        ghidra.program.model.listing.Instruction[] near = new ghidra.program.model.listing.Instruction[6];
                        ghidra.program.model.listing.Instruction sq = si;
                        for (int sk = 0; sk < 3 && sq != null; sk++) { sq = sq.getPrevious(); near[sk] = sq; }
                        sq = si;
                        for (int sk = 3; sk < 6 && sq != null; sk++) { sq = sq.getNext(); near[sk] = sq; }
                        Object[] so = si.getOpObjects(0);
                        for (ghidra.program.model.listing.Instruction sj : near) {
                          if (sj == null || !sj.getMnemonicString().equals("MOV") || sj.getNumOperands() != 2
                              || ghidra.program.model.lang.OperandType.isRegister(sj.getOperandType(0))) continue;
                          Object[] jo = sj.getOpObjects(0);
                          String rs = "", rj = "";
                          long ds = 0, dj = 0;
                          for (Object x : so) if (x instanceof ghidra.program.model.lang.Register) rs += x + "/"; else if (x instanceof ghidra.program.model.scalar.Scalar) ds = ((ghidra.program.model.scalar.Scalar) x).getSignedValue();
                          for (Object x : jo) if (x instanceof ghidra.program.model.lang.Register) rj += x + "/"; else if (x instanceof ghidra.program.model.scalar.Scalar) dj = ((ghidra.program.model.scalar.Scalar) x).getSignedValue();
                          if (!rs.equals(rj) || Math.abs(ds - dj) != 4) continue;
                          boolean jHigh = dj > ds;
                          boolean jFirst = sj.getAddress().compareTo(si.getAddress()) < 0;
                          shalf = jHigh == jFirst ? "h" : "l";
                          if (jFirst) soff = Long.toHexString(sj.getAddress().getOffset() - base);
                          break;
                        }
                      }
                    }
                  } else if (sout != null && sout.getAddress().isStackAddress()) {
                    ghidra.program.model.listing.Instruction si = L.getInstructionAt(sat);
                    ssize = sout.getSize();
                    if (si != null && si.getMnemonicString().startsWith("MOV") && si.getNumOperands() == 2
                        && !ghidra.program.model.lang.OperandType.isRegister(si.getOperandType(0))) soff = Long.toHexString(sat.getOffset() - base);
                  } else if (sout != null) {
                    ssize = sout.getSize();
                    if (sout.getAddress().isMemoryAddress()) gaddr = sout.getAddress();
                    else {
                      // The left side's global, when the copy went through a temporary.
                      ghidra.app.decompiler.ClangToken lt = null;
                      for (ghidra.app.decompiler.ClangToken u : l.getAllTokens()) {
                        if (u == t) break;
                        if (u instanceof ghidra.app.decompiler.ClangVariableToken) lt = u;
                        else if (!(u instanceof ghidra.app.decompiler.ClangSyntaxToken) || u.getText().trim().length() > 0) lt = null;
                      }
                      ghidra.program.model.pcode.HighVariable hv = lt == null ? null : ((ghidra.app.decompiler.ClangVariableToken) lt).getHighVariable();
                      if (hv instanceof ghidra.program.model.pcode.HighGlobal && hv.getRepresentative() != null && hv.getRepresentative().getAddress().isMemoryAddress())
                        gaddr = hv.getRepresentative().getAddress();
                      // A field of a stack aggregate (sArg.pOwner = pUnit): the write to its
                      // frame offset in the block the copy sits in.
                      ghidra.app.decompiler.ClangVariableToken sv = null;
                      long sacc = 0;
                      boolean sdot = false;
                      for (ghidra.app.decompiler.ClangToken u : l.getAllTokens()) {
                        if (u == t) break;
                        String ut = u.getText().trim();
                        if (u instanceof ghidra.app.decompiler.ClangVariableToken) { sv = (ghidra.app.decompiler.ClangVariableToken) u; sacc = 0; sdot = false; }
                        else if (u instanceof ghidra.app.decompiler.ClangFieldToken && sv != null && sdot) { sacc += ((ghidra.app.decompiler.ClangFieldToken) u).getOffset(); sdot = false; }
                        else if (ut.equals(".") && sv != null) sdot = true;
                        else if (ut.length() > 0) sv = null;
                      }
                      ghidra.program.model.pcode.HighVariable shv = sv == null || sdot ? null : sv.getHighVariable();
                      ghidra.program.model.pcode.HighSymbol shs = shv == null ? null : shv.getSymbol();
                      if (gaddr == null && shs != null && shs.getStorage() != null && shs.getStorage().isStackStorage()) {
                        long want = shs.getStorage().getStackOffset() + sacc;
                        try {
                          ghidra.program.model.block.CodeBlock sb = new ghidra.program.model.block.SimpleBlockModel(prog).getFirstCodeBlockContaining(sat, mon);
                          ghidra.program.model.address.Address pick = null;
                          int hits = 0;
                          if (sb != null) {
                            ghidra.program.model.listing.InstructionIterator sit = L.getInstructions(sb, true);
                            while (sit.hasNext()) {
                              ghidra.program.model.listing.Instruction si = sit.next();
                              for (ghidra.program.model.symbol.Reference rf : si.getReferencesFrom()) {
                                if (rf instanceof ghidra.program.model.symbol.StackReference && rf.getReferenceType().isWrite()
                                    && ((ghidra.program.model.symbol.StackReference) rf).getStackOffset() == want) { pick = si.getAddress(); hits++; }
                              }
                            }
                          }
                          if (hits == 1) soff = Long.toHexString(pick.getOffset() - base);
                        } catch (Exception e) { }
                      }
                    }
                    if (gaddr != null) {
                      java.util.List<ghidra.program.model.address.Address> sw = new java.util.ArrayList<>();
                      for (ghidra.program.model.symbol.Reference rf : rm.getReferencesTo(gaddr)) {
                        if (rf.getReferenceType().isWrite() && fn.getBody().contains(rf.getFromAddress())) sw.add(rf.getFromAddress());
                      }
                      ghidra.program.model.address.Address pick = sw.size() == 1 ? sw.get(0) : sw.contains(sat) ? sat : null;
                      if (pick != null) soff = Long.toHexString(pick.getOffset() - base);
                    }
                  }
                }
                oneSt.append(oneSt.length() > 0 ? "|" : "").append(sord).append(',').append(soff).append(',').append(ssize).append(',').append(shalf).append(',').append(swid);
              }
`;
